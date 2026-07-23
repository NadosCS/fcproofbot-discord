import { setDefaultResultOrder } from 'node:dns';

import {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';

import {
  AppsScriptApiError,
  applyLocalProofMutation,
  callAppsScript,
  callProofMutation,
  getAutocompleteCatalogStatus,
  searchPlayers,
  searchSongs,
  synchronizeAutocompleteCatalog,
  resolveSongReference,
} from './apps-script-api.js';
import { config } from './config.js';
import {
  startHealthServer,
  stopHealthServer,
} from './health-server.js';
import { createDiscordMultipartBody } from './discord-multipart.js';
import {
  createProofImageStorage,
} from './proof-image-storage.js';
import { createProofPreviewResolver } from './proof-preview.js';

// Wispbyte's outbound IPv6 route can intermittently stall while the Discord
// Gateway remains connected. Prefer IPv4 for Discord/Google HTTPS lookups.
setDefaultResultOrder('ipv4first');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  rest: {
    timeout: config.discordRestTimeoutMs,
    retries: 0,
  },
});

const proofImageStorage = createProofImageStorage(
  config.proofImageStorage,
  {
    maxBytes: config.proofImageMaxBytes,
    downloadTimeoutMs: config.proofImageDownloadTimeoutMs,
    uploadTimeoutMs: config.proofImageUploadTimeoutMs,
  },
);

const proofPreviewResolver = createProofPreviewResolver();

let catalogSyncTimer = null;
let catalogSyncRunPromise = null;
let catalogSyncFailureCount = 0;
let catalogSynchronizerStopped = false;
let healthServer = null;
let shutdownStarted = false;

// Tracks the newest autocomplete request for each user/command/option. Discord
// can emit a new request for every keystroke, so older requests should not send
// a response after a newer one has already replaced them.
const latestAutocompleteRequests = new Map();

// Interaction callbacks are sent directly instead of through discord.js' shared
// REST queue. On some shared hosting nodes, one stalled callback can otherwise
// block every later autocomplete response and slash-command acknowledgement.
const acknowledgedInteractions = new WeakSet();
const respondedAutocompleteInteractions = new WeakSet();

class DiscordHttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DiscordHttpError';
    this.code = options.code ?? 'DISCORD_HTTP_ERROR';
    this.status = options.status ?? null;
    this.details = options.details ?? null;
    this.cause = options.cause;
  }
}

function discordApiPayload(payload = {}) {
  if (typeof payload === 'string') {
    return { content: payload };
  }

  const data = {};

  if (payload.content !== undefined) {
    data.content = payload.content;
  }

  if (Array.isArray(payload.embeds)) {
    data.embeds = payload.embeds.map((embed) =>
      typeof embed?.toJSON === 'function'
        ? embed.toJSON()
        : embed
    );
  }

  if (Array.isArray(payload.components)) {
    data.components = payload.components.map((component) =>
      typeof component?.toJSON === 'function'
        ? component.toJSON()
        : component
    );
  }

  if (payload.allowedMentions) {
    const allowed = payload.allowedMentions;
    const normalized = {};

    if (Array.isArray(allowed.parse)) {
      normalized.parse = allowed.parse;
    }

    if (Array.isArray(allowed.users)) {
      normalized.users = allowed.users.map(String);
    }

    if (Array.isArray(allowed.roles)) {
      normalized.roles = allowed.roles.map(String);
    }

    if (typeof allowed.repliedUser === 'boolean') {
      normalized.replied_user = allowed.repliedUser;
    }

    data.allowed_mentions = normalized;
  }

  if (payload.flags !== undefined) {
    data.flags = Number(payload.flags);
  }

  if (payload.tts !== undefined) {
    data.tts = Boolean(payload.tts);
  }

  return data;
}

function discordRequestTimeoutError(timeoutMs, label) {
  return new DiscordHttpError(
    `${label} exceeded ${timeoutMs} ms.`,
    {
      code: 'DISCORD_REQUEST_TIMEOUT',
      details: { timeoutMs, label },
    },
  );
}

async function directDiscordRequest(
  url,
  {
    method = 'POST',
    body,
    headers = {},
    timeoutMs,
    label,
  },
) {
  const controller = new AbortController();
  const timeoutError = discordRequestTimeoutError(timeoutMs, label);
  let timeoutHandle;
  const multipart =
    typeof FormData !== 'undefined' &&
    body instanceof FormData;
  const requestHeaders = {
    accept: 'application/json',
    ...headers,
  };

  if (!multipart && body !== undefined) {
    requestHeaders['content-type'] =
      'application/json; charset=utf-8';
  }

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  const requestPromise = (async () => {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined
        ? undefined
        : multipart
          ? body
          : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let result = null;

    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        result = { message: text.slice(0, 500) };
      }
    }

    if (!response.ok) {
      throw new DiscordHttpError(
        result?.message ||
          `${label} returned HTTP ${response.status}.`,
        {
          code: result?.code ?? 'DISCORD_HTTP_ERROR',
          status: response.status,
          details: result,
        },
      );
    }

    return result;
  })();

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof DiscordHttpError) {
      throw error;
    }

    if (
      error?.name === 'AbortError' ||
      error?.code === 'ABORT_ERR'
    ) {
      const wrapped = discordRequestTimeoutError(timeoutMs, label);
      wrapped.cause = error;
      throw wrapped;
    }

    throw new DiscordHttpError(
      `${label} failed: ${error?.message || String(error)}`,
      {
        code: 'DISCORD_REQUEST_FAILED',
        cause: error,
      },
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function interactionCallbackUrl(interaction) {
  return (
    `https://discord.com/api/v10/interactions/` +
    `${interaction.id}/${interaction.token}/callback`
  );
}

function originalInteractionMessageUrl(interaction) {
  return (
    `https://discord.com/api/v10/webhooks/` +
    `${config.discordClientId}/${interaction.token}/messages/@original`
  );
}

async function deferInteraction(interaction, flags) {
  const startedAt = Date.now();
  const data = flags ? { flags: Number(flags) } : {};

  await directDiscordRequest(interactionCallbackUrl(interaction), {
    method: 'POST',
    body: {
      type: 5,
      data,
    },
    timeoutMs: config.discordAckTimeoutMs,
    label: `Discord acknowledgement for /${interaction.commandName}`,
  });

  acknowledgedInteractions.add(interaction);

  console.log(
    `Command acknowledged: /${interaction.commandName} ` +
      `(${interaction.id}) in ${Date.now() - startedAt} ms.`,
  );
}

async function replyToInteraction(interaction, payload) {
  await directDiscordRequest(interactionCallbackUrl(interaction), {
    method: 'POST',
    body: {
      type: 4,
      data: discordApiPayload(payload),
    },
    timeoutMs: config.discordAckTimeoutMs,
    label: `Discord initial reply for /${interaction.commandName}`,
  });

  acknowledgedInteractions.add(interaction);
}

async function editInteractionReply(
  interaction,
  payload,
  attachment = null,
) {
  if (!acknowledgedInteractions.has(interaction)) {
    throw new DiscordHttpError(
      'Cannot edit a Discord interaction before it has been acknowledged.',
      {
        code: 'INTERACTION_NOT_ACKNOWLEDGED',
      },
    );
  }

  const apiPayload = discordApiPayload(payload);

  return directDiscordRequest(originalInteractionMessageUrl(interaction), {
    method: 'PATCH',
    body: attachment
      ? createDiscordMultipartBody(apiPayload, attachment)
      : apiPayload,
    timeoutMs: config.discordResponseTimeoutMs,
    label: `Discord response for /${interaction.commandName}`,
  });
}

async function respondToAutocomplete(interaction, choices) {
  await directDiscordRequest(interactionCallbackUrl(interaction), {
    method: 'POST',
    body: {
      type: 8,
      data: {
        choices,
      },
    },
    timeoutMs: config.discordAckTimeoutMs,
    label:
      `Discord autocomplete response for ` +
      `${interaction.commandName}`,
  });

  respondedAutocompleteInteractions.add(interaction);
}

async function sendDirectChannelMessage(channelId, payload) {
  if (!channelId) {
    throw new DiscordHttpError(
      'A Discord channel ID is required for the fallback response.',
      { code: 'MISSING_CHANNEL_ID' },
    );
  }

  return directDiscordRequest(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: 'POST',
      body: discordApiPayload(payload),
      headers: {
        authorization: `Bot ${config.discordToken}`,
      },
      timeoutMs: config.discordResponseTimeoutMs,
      label: 'Discord fallback channel message',
    },
  );
}

function discordUserLabel(interaction) {
  const displayName =
    interaction.user.globalName || interaction.user.username;

  return `${displayName} (${interaction.user.id})`;
}

function truncate(value, maxLength) {
  const text = String(value ?? '');

  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function discordErrorCode(error) {
  const rawCode = error?.code ?? error?.rawError?.code;
  const parsed = Number(rawCode);

  return Number.isInteger(parsed) ? parsed : null;
}

function isExpiredInteractionError(error) {
  return [10015, 10062, 50027].includes(discordErrorCode(error));
}

function isIgnorableAutocompleteError(error) {
  return (
    isExpiredInteractionError(error) ||
    error?.code === 'DISCORD_REQUEST_TIMEOUT'
  );
}

function autocompleteRequestKey(interaction, focused) {
  return [
    interaction.guildId || 'direct-message',
    interaction.user.id,
    interaction.commandName,
    focused.name,
  ].join(':');
}

async function sendCommandError(interaction, error) {
  if (!interaction.isRepliable()) return;

  const content = errorMessage(error);
  const responsePayload = {
    content,
    embeds: [],
    allowedMentions: { parse: [] },
  };

  try {
    if (acknowledgedInteractions.has(interaction)) {
      await editInteractionReply(interaction, responsePayload);
    } else {
      await replyToInteraction(interaction, {
        ...responsePayload,
        flags: MessageFlags.Ephemeral,
      });
    }

    return;
  } catch (replyError) {
    console.error(
      `Failed to deliver the interaction error for ` +
        `/${interaction.commandName} (${interaction.id}):`,
      replyError,
    );
  }

  // If Discord has invalidated the interaction webhook, fall back to a normal
  // channel message so the command never remains on "Bot is thinking..."
  // without any visible explanation.
  if (interaction.channelId) {
    try {
      await sendDirectChannelMessage(interaction.channelId, {
        content: `<@${interaction.user.id}> ${content}`,
        allowedMentions: {
          parse: [],
          users: [interaction.user.id],
        },
      });
    } catch (channelError) {
      console.error(
        `Failed to send the fallback channel error for ` +
          `/${interaction.commandName} (${interaction.id}):`,
        channelError,
      );
    }
  }
}

function validHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function isDiscordProofUrl(value) {
  try {
    const hostname = new URL(value).hostname
      .toLowerCase()
      .replace(/\.$/, '');

    const blockedDiscordHosts = [
      'discord.com',
      'discordapp.com',
      'discordapp.net',
      'discord.gg',
      'discordcdn.com',
    ];

    return blockedDiscordHosts.some(
      (blockedHost) =>
        hostname === blockedHost ||
        hostname.endsWith(`.${blockedHost}`),
    );
  } catch {
    return false;
  }
}

function discordProofRejectedMessage() {
  return (
    '❌ Discord-hosted proof links are not accepted because they may expire. ' +
    'For /addproof, attach the file with proof_image instead. You can also ' +
    'submit a permanent HTTPS image or video link.'
  );
}

/**
 * Discord autocomplete displays player choices as:
 *   Player Name — 20 FCs
 *
 * The actual choice value is only the player name. This extra normalization is
 * a safety measure for manually typed labels and rare Discord/client cases
 * where the visible label is submitted.
 */
function normalizeSubmittedPlayerName(value) {
  const raw = String(value ?? '').trim();

  return raw
    .replace(/\s+[—–-]\s+\d+\s+FCs?$/iu, '')
    .trim();
}

function replyVisibilityFlags() {
  return config.ephemeralReplies
    ? MessageFlags.Ephemeral
    : undefined;
}

async function deferCommand(interaction) {
  const flags = replyVisibilityFlags();

  console.log(
    `Acknowledging command: /${interaction.commandName} ` +
      `(${interaction.id}).`,
  );

  await deferInteraction(interaction, flags);
}

function successEmbed(title, data) {
  const embed = new EmbedBuilder()
    .setTitle(truncate(title, 256))
    .setColor(0x57f287)
    .setTimestamp();

  if (data?.song) {
    embed.addFields({
      name: 'Song',
      value: truncate(data.song, 1_024),
    });
  }

  if (data?.setlist) {
    embed.addFields({
      name: 'Setlist',
      value: truncate(data.setlist, 1_024),
    });
  }

  if (data?.player) {
    embed.addFields({
      name: 'Player',
      value: truncate(data.player, 1_024),
    });
  }

  if (data?.proofUrl) {
    embed.addFields({
      name: 'Proof',
      value: `[Open proof](${data.proofUrl})`,
    });
  }

  return embed;
}

async function addProofPreview(embed, proofUrl) {
  if (!proofUrl) return;

  const previewUrl = await proofPreviewResolver.resolve(proofUrl);
  if (previewUrl) embed.setImage(previewUrl);
}

function errorMessage(error) {
  if (error instanceof AppsScriptApiError) {
    const code = error.code ? ` (${error.code})` : '';
    return truncate(`❌ ${error.message}${code}`, 1_900);
  }

  return truncate(
    `❌ ${error?.message || 'An unexpected error occurred.'}`,
    1_900,
  );
}

function formatCatalogTime(value) {
  if (!value) return 'Never';

  const date = value instanceof Date
    ? value
    : new Date(value);

  if (Number.isNaN(date.getTime())) return 'Unknown';

  return `<t:${Math.floor(date.getTime() / 1_000)}:R>`;
}

function catalogRetryDelayMs() {
  const exponent = Math.max(0, catalogSyncFailureCount - 1);
  const delay =
    config.autocompleteRetryBaseMs * (2 ** exponent);

  return Math.min(delay, config.autocompleteRetryMaxMs);
}

function scheduleCatalogSynchronization(
  delayMs,
  reason = 'scheduled',
  force = false,
) {
  if (catalogSynchronizerStopped) return;

  if (catalogSyncTimer) {
    clearTimeout(catalogSyncTimer);
  }

  catalogSyncTimer = setTimeout(() => {
    catalogSyncTimer = null;
    void runCatalogSynchronization(reason, force);
  }, Math.max(0, delayMs));

  catalogSyncTimer.unref?.();
}

async function runCatalogSynchronization(reason, force = false) {
  if (catalogSyncRunPromise) return catalogSyncRunPromise;

  catalogSyncRunPromise = runCatalogSynchronizationOnce(reason, force)
    .finally(() => {
      catalogSyncRunPromise = null;
    });

  return catalogSyncRunPromise;
}

async function runCatalogSynchronizationOnce(reason, force = false) {
  try {
    const result = await synchronizeAutocompleteCatalog({
      force,
      logProgress: force || !getAutocompleteCatalogStatus().ready,
      reason,
    });

    catalogSyncFailureCount = 0;

    if (result.deferred) {
      console.log(
        'Autocomplete synchronization deferred because the backend index is busy.',
      );

      scheduleCatalogSynchronization(
        getAutocompleteCatalogStatus().ready
          ? config.autocompleteSyncCheckMs
          : config.autocompleteRetryBaseMs,
        'backend-busy',
      );
      return;
    }

    if (result.changed) {
      console.log(
        `Autocomplete synchronized to revision ${result.revision}: ` +
          `${result.songs} songs, ${result.players} players.`,
      );
    }

    scheduleCatalogSynchronization(
      config.autocompleteSyncCheckMs,
      'scheduled',
    );
  } catch (error) {
    catalogSyncFailureCount += 1;
    const retryDelay = catalogRetryDelayMs();

    console.error(
      `Autocomplete synchronization failed; retrying in ` +
        `${Math.round(retryDelay / 1_000)} seconds:`,
      error,
    );

    scheduleCatalogSynchronization(
      retryDelay,
      'retry',
    );
  }
}

function applyProofMutationAndScheduleSync(data) {
  const localUpdate = applyLocalProofMutation(data);

  // A mutation whose exact revision was applied already leaves the local
  // catalog current, so it needs only the normal periodic check. If another
  // change raced ahead, perform one near-term reconciliation instead.
  scheduleCatalogSynchronization(
    localUpdate.revisionApplied
      ? config.autocompleteSyncCheckMs
      : 2_000,
    'proof-mutation',
  );
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value || '').trim();
  const requestKey = autocompleteRequestKey(interaction, focused);

  latestAutocompleteRequests.set(requestKey, interaction.id);

  // Discord sends an autocomplete event as soon as the option receives focus.
  // Returning without an HTTP callback for the empty value avoids generating
  // a burst of disposable requests before the user has typed anything.
  if (!query) {
    return;
  }

  try {
    let choices = [];

    if (focused.name === 'song') {
        const onlyUnfcd =
          interaction.commandName === 'addproof';

        choices = await searchSongs(query, onlyUnfcd);
    } else if (focused.name === 'player') {
      choices = await searchPlayers(query);
    }

    // A newer keystroke has already produced another autocomplete interaction.
    // Do not waste time responding to this stale request.
    if (
      latestAutocompleteRequests.get(requestKey) !== interaction.id
    ) {
      return;
    }

    await respondToAutocomplete(
      interaction,
      choices
        .filter((choice) => choice?.name && choice?.value)
        .slice(0, 25)
        .map((choice) => ({
          name: truncate(choice.name, 100),
          value: truncate(choice.value, 100),
        })),
    );
  } catch (error) {
    // Discord invalidates autocomplete interactions very quickly. An expired
    // request is expected when a newer keystroke supersedes it, so do not flood
    // the console or attempt a second response for these known codes.
    if (isIgnorableAutocompleteError(error)) {
      return;
    }

    console.warn(
      `Autocomplete failed for ` +
        `${interaction.commandName}/${focused.name}:`,
      error,
    );

    if (
      !respondedAutocompleteInteractions.has(interaction) &&
      latestAutocompleteRequests.get(requestKey) === interaction.id
    ) {
      try {
        await respondToAutocomplete(interaction, []);
      } catch (fallbackError) {
        if (!isIgnorableAutocompleteError(fallbackError)) {
          console.warn(
            `Autocomplete fallback failed for ` +
              `${interaction.commandName}/${focused.name}:`,
            fallbackError,
          );
        }
      }
    }
  }
}

async function handleAddProof(interaction) {
  const songInput =
    interaction.options.getString('song', true);
  const rawPlayer =
    interaction.options.getString('player', true);
  const player = normalizeSubmittedPlayerName(rawPlayer);

  if (player !== String(rawPlayer).trim()) {
    console.warn(
      `Normalized autocomplete player label "${String(rawPlayer).trim()}" ` +
        `to "${player}".`,
    );
  }
  const proofOption = interaction.options.getString('proof');
  const proofAttachment =
    interaction.options.getAttachment('proof_image');

  if (proofOption === null && proofAttachment === null) {
    await replyToInteraction(interaction, {
      content: '❌ Attach a proof image or provide an HTTPS proof URL.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (proofOption !== null && proofAttachment !== null) {
    await replyToInteraction(interaction, {
      content: '❌ Provide either a proof image or a proof URL, not both.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let proofUrl = proofOption?.trim() ?? null;
  let replyAttachment = null;

  if (proofUrl !== null && !validHttpsUrl(proofUrl)) {
    await replyToInteraction(interaction, {
      content: '❌ The proof must be a valid HTTPS URL.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (proofUrl !== null && isDiscordProofUrl(proofUrl)) {
    await replyToInteraction(interaction, {
      content: discordProofRejectedMessage(),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (proofAttachment !== null && !proofImageStorage.enabled) {
    await replyToInteraction(interaction, {
      content:
        '❌ Image uploads are not configured yet. Submit a proof URL ' +
        'instead or ask an administrator to configure Backblaze B2.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await deferCommand(interaction);

  const songRef = await resolveSongReference(
    songInput,
    { onlyUnfcd: true },
  );

  if (proofAttachment !== null) {
    const uploadedImage = await proofImageStorage.upload(proofAttachment);
    proofUrl = uploadedImage.url;
    replyAttachment = {
      bytes: uploadedImage.bytes,
      contentType: uploadedImage.contentType,
      filename: uploadedImage.filename,
      description: `Proof for ${songInput}`,
    };
    console.log(
      `Stored proof image ${uploadedImage.objectKey} ` +
        `(${uploadedImage.size} bytes).`,
    );
  }

  const data = await callProofMutation('addProof', {
    songRef,
    player,
    proofUrl,
    discordUser: discordUserLabel(interaction),
  });

  applyProofMutationAndScheduleSync(data);

  const embed = successEmbed('Proof added', data);
  if (replyAttachment) {
    embed.setImage(`attachment://${replyAttachment.filename}`);
  } else {
    await addProofPreview(embed, data.proofUrl);
  }

  await editInteractionReply(interaction, {
    embeds: [embed],
    allowedMentions: { parse: [] },
  }, replyAttachment);
}

async function handleSongInfo(interaction) {
  const songInput =
    interaction.options.getString('song', true);

  await deferCommand(interaction);

  const songRef = await resolveSongReference(songInput);
  const data = await callAppsScript(
    'song',
    { songRef },
    { timeoutMs: config.songInfoTimeoutMs },
  );

  const embed = new EmbedBuilder()
    .setTitle(truncate(data.song || 'Song information', 256))
    .setColor(data.isFcd ? 0x57f287 : 0xfee75c)
    .addFields(
      {
        name: 'Setlist',
        value: truncate(data.setlist || 'Unknown', 1_024),
      },
      {
        name: 'Status',
        value: data.isFcd ? 'FC’d' : 'Not FC’d',
        inline: true,
      },
      {
        name: 'Player',
        value: truncate(data.fcPlayer || '—', 1_024),
        inline: true,
      },
    )
    .setTimestamp();

  if (data.proofUrl) {
    embed.addFields({
      name: 'Proof',
      value: `[Open proof](${data.proofUrl})`,
    });

    await addProofPreview(embed, data.proofUrl);
  }

  await editInteractionReply(interaction, {
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleEditProof(interaction) {
  const songInput =
    interaction.options.getString('song', true);
  const playerOption =
    interaction.options.getString('player');
  const proofOption =
    interaction.options.getString('proof');

  if (playerOption === null && proofOption === null) {
    await replyToInteraction(interaction, {
      content:
        '❌ Supply a replacement player, a replacement proof URL, or both.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    proofOption !== null &&
    !validHttpsUrl(proofOption.trim())
  ) {
    await replyToInteraction(interaction, {
      content: '❌ The proof must be a valid HTTPS URL.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    proofOption !== null &&
    isDiscordProofUrl(proofOption.trim())
  ) {
    await replyToInteraction(interaction, {
      content: discordProofRejectedMessage(),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await deferCommand(interaction);

  const songRef = await resolveSongReference(songInput);
  const payload = {
    songRef,
    discordUser: discordUserLabel(interaction),
  };

  if (playerOption !== null) {
    const normalizedPlayer =
      normalizeSubmittedPlayerName(playerOption);

    if (normalizedPlayer !== playerOption.trim()) {
      console.warn(
        `Normalized autocomplete player label "${playerOption.trim()}" ` +
          `to "${normalizedPlayer}".`,
      );
    }

    payload.player = normalizedPlayer;
  }

  if (proofOption !== null) {
    payload.proofUrl = proofOption.trim();
  }

  const data = await callProofMutation('editProof', payload);

  applyProofMutationAndScheduleSync(data);

  const embed = successEmbed('Proof updated', data);
  await addProofPreview(embed, data.proofUrl);

  await editInteractionReply(interaction, {
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleRemoveProof(interaction) {
  const songInput =
    interaction.options.getString('song', true);

  await deferCommand(interaction);

  const songRef = await resolveSongReference(songInput);

  const data = await callProofMutation('removeProof', {
    songRef,
    discordUser: discordUserLabel(interaction),
  });

  applyProofMutationAndScheduleSync(data);

  const embed = new EmbedBuilder()
    .setTitle('Proof removed')
    .setColor(0xed4245)
    .addFields(
      {
        name: 'Song',
        value: truncate(data.song || 'Unknown', 1_024),
      },
      {
        name: 'Setlist',
        value: truncate(data.setlist || 'Unknown', 1_024),
      },
    )
    .setTimestamp();

  await editInteractionReply(interaction, {
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleBotStatus(interaction) {
  await deferCommand(interaction);

  const localCatalog = getAutocompleteCatalogStatus();
  let data = null;
  let backendError = null;

  try {
    data = await callAppsScript(
      'health',
      {},
      { timeoutMs: config.botStatusTimeoutMs },
    );
  } catch (error) {
    backendError = error;

    console.warn(
      `Backend health check failed after at most ` +
        `${config.botStatusTimeoutMs} ms:`,
      error,
    );
  }

  const backend = data?.backend || {};
  const songIndex = data?.songIndexRebuild || {};
  const remoteCatalog = data?.autocompleteCatalog || {};

  const remoteRevision =
    remoteCatalog.revision ||
    localCatalog.remoteRevision ||
    'Unknown';

  const healthy =
    !backendError &&
    backend.ok !== false &&
    backend.spreadsheetAccessible !== false;

  let autocompleteState = 'Loading';

  if (localCatalog.refreshing) {
    autocompleteState = 'Refreshing';
  } else if (localCatalog.ready) {
    if (backendError) {
      autocompleteState = 'Ready locally';
    } else {
      autocompleteState =
        localCatalog.token === String(remoteCatalog.catalogToken || '')
          ? 'Synchronized'
          : 'Update pending';
    }
  } else if (localCatalog.lastError) {
    autocompleteState = 'Load failed';
  }

  let spreadsheetState = 'Unavailable';

  if (backendError) {
    spreadsheetState =
      backendError.code === 'API_TIMEOUT'
        ? 'Check timed out'
        : 'Check failed';
  } else if (backend.spreadsheetAccessible) {
    spreadsheetState = 'Connected';
  }

  const embed = new EmbedBuilder()
    .setTitle('FCBot status')
    .setColor(healthy ? 0x57f287 : 0xfee75c)
    .addFields(
      {
        name: 'Discord',
        value: 'Online',
        inline: true,
      },
      {
        name: 'Spreadsheet',
        value: spreadsheetState,
        inline: true,
      },
      {
        name: 'Setlists',
        value: String(backend.setlistCount ?? 'Unknown'),
        inline: true,
      },
      {
        name: 'Indexed songs',
        value: String(
          songIndex.indexedSongs ??
          localCatalog.songs ??
          'Unknown'
        ),
        inline: true,
      },
      {
        name: 'Index state',
        value: backendError
          ? 'Remote check unavailable'
          : (songIndex.dirty ? 'Needs rebuild' : 'Ready'),
        inline: true,
      },
      {
        name: 'API version',
        value: String(data?.version || 'Unknown'),
        inline: true,
      },
      {
        name: 'Autocomplete',
        value: autocompleteState,
        inline: true,
      },
      {
        name: 'Catalog revision',
        value:
          `${localCatalog.revision || 'None'} / ` +
          `${remoteRevision}`,
        inline: true,
      },
      {
        name: 'Cached records',
        value:
          `${localCatalog.songs} songs\n` +
          `${localCatalog.players} players`,
        inline: true,
      },
      {
        name: 'Last catalog check',
        value: formatCatalogTime(localCatalog.lastCheckedAt),
        inline: true,
      },
      {
        name: 'Last full load',
        value: formatCatalogTime(localCatalog.loadedAt),
        inline: true,
      },
    )
    .setTimestamp();

  if (backendError) {
    embed.addFields({
      name: 'Backend health check',
      value: truncate(
        `${backendError.code || 'ERROR'}: ${backendError.message}`,
        1_024,
      ),
    });
  }

  if (localCatalog.lastError) {
    embed.addFields({
      name: 'Last catalog error',
      value: truncate(
        `${localCatalog.lastError.code}: ` +
          `${localCatalog.lastError.message}`,
        1_024,
      ),
    });
  }

  await editInteractionReply(interaction, {
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleRefreshCatalog(interaction) {
  await deferCommand(interaction);

  const result = await synchronizeAutocompleteCatalog({
    force: true,
    logProgress: true,
    reason: 'manual-command',
  });

  catalogSyncFailureCount = 0;
  scheduleCatalogSynchronization(
    config.autocompleteSyncCheckMs,
    'scheduled',
  );

  if (result.deferred) {
    await editInteractionReply(interaction, {
      content:
        'The backend index is currently busy. The bot will retry automatically.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Autocomplete catalog refreshed')
    .setColor(0x57f287)
    .addFields(
      {
        name: 'Revision',
        value: String(result.revision || 'Unknown'),
        inline: true,
      },
      {
        name: 'Songs',
        value: String(result.songs),
        inline: true,
      },
      {
        name: 'Players',
        value: String(result.players),
        inline: true,
      },
    )
    .setTimestamp();

  await editInteractionReply(interaction, {
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'addproof':
      await handleAddProof(interaction);
      return;

    case 'songinfo':
      await handleSongInfo(interaction);
      return;

    case 'editproof':
      await handleEditProof(interaction);
      return;

    case 'removeproof':
      await handleRemoveProof(interaction);
      return;

    case 'botstatus':
      await handleBotStatus(interaction);
      return;

    case 'refreshcatalog':
      await handleRefreshCatalog(interaction);
      return;

    default:
      await replyToInteraction(interaction, {
        content: 'Unknown command.',
        flags: MessageFlags.Ephemeral,
      });
  }
}

function getPublicHealthStatus() {
  const catalog = getAutocompleteCatalogStatus();
  const discordReady = client.isReady();

  return {
    ok: discordReady,
    service: 'ultimate-clone-hero-fc-proof-bot',
    discord: {
      ready: discordReady,
      user: client.user?.tag || null,
      guilds: client.guilds.cache.size,
      interactionTransport: 'direct-http',
      ipv4First: true,
    },
    autocomplete: {
      ready: catalog.ready,
      refreshing: catalog.refreshing,
      songs: catalog.songs,
      players: catalog.players,
      revision: catalog.revision || null,
      lastCheckedAt: catalog.lastCheckedAt || null,
      loadedAt: catalog.loadedAt || null,
      lastError: catalog.lastError
        ? {
            code: catalog.lastError.code,
            message: catalog.lastError.message,
          }
        : null,
    },
  };
}

client.once('clientReady', (readyClient) => {
  console.log(`FCBot logged in as ${readyClient.user.tag}.`);
  console.log(
    `Connected to ${readyClient.guilds.cache.size} guild(s).`,
  );

  scheduleCatalogSynchronization(
    0,
    'startup',
    true,
  );
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const startedAt = Date.now();

  console.log(
    `Command received: /${interaction.commandName} ` +
      `(${interaction.id}) from ${discordUserLabel(interaction)}.`,
  );

  try {
    await handleCommand(interaction);

    console.log(
      `Command completed: /${interaction.commandName} ` +
        `(${interaction.id}) in ${Date.now() - startedAt} ms.`,
    );
  } catch (error) {
    console.error(
      `Command failed: /${interaction.commandName} ` +
        `(${interaction.id}) after ${Date.now() - startedAt} ms:`,
      error,
    );

    await sendCommandError(interaction, error);
  }
});

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  console.log(`Received ${signal}; shutting down.`);

  catalogSynchronizerStopped = true;

  if (catalogSyncTimer) {
    clearTimeout(catalogSyncTimer);
    catalogSyncTimer = null;
  }

  client.destroy();
  await stopHealthServer(healthServer);
  process.exitCode = 0;
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

healthServer = await startHealthServer({
  port: config.port,
  getStatus: getPublicHealthStatus,
});

await client.login(config.discordToken);
