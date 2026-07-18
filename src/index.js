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

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let catalogSyncTimer = null;
let catalogSyncFailureCount = 0;
let catalogSynchronizerStopped = false;
let healthServer = null;
let shutdownStarted = false;

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

function validHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function replyVisibilityFlags() {
  return config.ephemeralReplies
    ? MessageFlags.Ephemeral
    : undefined;
}

async function deferCommand(interaction) {
  const flags = replyVisibilityFlags();

  if (flags) {
    await interaction.deferReply({ flags });
  } else {
    await interaction.deferReply();
  }
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
        config.autocompleteRetryBaseMs,
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

  // When another sheet/index change happened before this proof command, the
  // local revision cannot be safely advanced. Check immediately instead of
  // waiting for the normal five-minute interval.
  scheduleCatalogSynchronization(
    localUpdate.revisionApplied ? 2_000 : 500,
    'proof-mutation',
  );
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const query = String(focused.value || '').trim();

  if (!query) {
    await interaction.respond([]);
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

    await interaction.respond(
      choices
        .filter((choice) => choice?.name && choice?.value)
        .slice(0, 25)
        .map((choice) => ({
          name: truncate(choice.name, 100),
          value: truncate(choice.value, 100),
        })),
    );
  } catch (error) {
    console.warn(
      `Autocomplete failed for ` +
        `${interaction.commandName}/${focused.name}:`,
      error,
    );

    if (!interaction.responded) {
      await interaction.respond([]).catch(() => undefined);
    }
  }
}

async function handleAddProof(interaction) {
  const songInput =
    interaction.options.getString('song', true);
  const player =
    interaction.options.getString('player', true).trim();
  const proofUrl =
    interaction.options.getString('proof', true).trim();

  if (!validHttpsUrl(proofUrl)) {
    await interaction.reply({
      content: '❌ The proof must be a valid HTTPS URL.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await deferCommand(interaction);

  const songRef = await resolveSongReference(
    songInput,
    { onlyUnfcd: true },
  );

  const data = await callAppsScript('addProof', {
    songRef,
    player,
    proofUrl,
    discordUser: discordUserLabel(interaction),
  });

  applyProofMutationAndScheduleSync(data);

  const embed = successEmbed('Proof added', data);

  await interaction.editReply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleSongInfo(interaction) {
  const songInput =
    interaction.options.getString('song', true);

  await deferCommand(interaction);

  const songRef = await resolveSongReference(songInput);
  const data = await callAppsScript('song', { songRef });

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
  }

  await interaction.editReply({
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
    await interaction.reply({
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
    await interaction.reply({
      content: '❌ The proof must be a valid HTTPS URL.',
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
    payload.player = playerOption.trim();
  }

  if (proofOption !== null) {
    payload.proofUrl = proofOption.trim();
  }

  const data = await callAppsScript('editProof', payload);

  applyProofMutationAndScheduleSync(data);

  const embed = successEmbed('Proof updated', data);

  await interaction.editReply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleRemoveProof(interaction) {
  const songInput =
    interaction.options.getString('song', true);

  await deferCommand(interaction);

  const songRef = await resolveSongReference(songInput);

  const data = await callAppsScript('removeProof', {
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

  await interaction.editReply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  });
}

async function handleBotStatus(interaction) {
  await deferCommand(interaction);

  const data = await callAppsScript('health');
  const backend = data?.backend || {};
  const songIndex = data?.songIndexRebuild || {};
  const remoteCatalog = data?.autocompleteCatalog || {};
  const localCatalog = getAutocompleteCatalogStatus();

  const healthy =
    backend.ok !== false &&
    backend.spreadsheetAccessible !== false;

  let autocompleteState = 'Loading';

  if (localCatalog.refreshing) {
    autocompleteState = 'Refreshing';
  } else if (localCatalog.ready) {
    autocompleteState =
      localCatalog.token === String(remoteCatalog.catalogToken || '')
        ? 'Synchronized'
        : 'Update pending';
  } else if (localCatalog.lastError) {
    autocompleteState = 'Load failed';
  }

  const embed = new EmbedBuilder()
    .setTitle('FCBot status')
    .setColor(healthy ? 0x57f287 : 0xed4245)
    .addFields(
      {
        name: 'Discord',
        value: 'Online',
        inline: true,
      },
      {
        name: 'Spreadsheet',
        value: backend.spreadsheetAccessible
          ? 'Connected'
          : 'Unavailable',
        inline: true,
      },
      {
        name: 'Setlists',
        value: String(backend.setlistCount ?? 'Unknown'),
        inline: true,
      },
      {
        name: 'Indexed songs',
        value: String(songIndex.indexedSongs ?? 'Unknown'),
        inline: true,
      },
      {
        name: 'Index state',
        value: songIndex.dirty ? 'Needs rebuild' : 'Ready',
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
          `${remoteCatalog.revision || 'Unknown'}`,
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

  await interaction.editReply({
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
    await interaction.editReply({
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

  await interaction.editReply({
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
      await interaction.reply({
        content: 'Unknown command.',
        flags: MessageFlags.Ephemeral,
      });
  }
}

function getPublicHealthStatus() {
  const catalog = getAutocompleteCatalogStatus();

  return {
    ok: true,
    service: 'ultimate-clone-hero-fc-proof-bot',
    discord: {
      ready: client.isReady(),
      user: client.user?.tag || null,
      guilds: client.guilds.cache.size,
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
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    }
  } catch (error) {
    console.error('Interaction failed:', error);

    if (!interaction.isRepliable()) return;

    const content = errorMessage(error);

    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply({
          content,
          embeds: [],
          allowedMentions: { parse: [] },
        })
        .catch(() => undefined);
    } else {
      await interaction
        .reply({
          content,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        })
        .catch(() => undefined);
    }
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
