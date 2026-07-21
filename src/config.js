import 'dotenv/config';

const REQUIRED_ENVIRONMENT_VARIABLES = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'APPS_SCRIPT_URL',
  'FCBOT_API_KEY',
];

function parsePositiveInteger(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === '') return fallback;

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parsePositiveIntegerWithLegacy(
  name,
  legacyName,
  fallback,
) {
  if (process.env[name]?.trim()) {
    return parsePositiveInteger(name, fallback);
  }

  if (process.env[legacyName]?.trim()) {
    return parsePositiveInteger(legacyName, fallback);
  }

  return fallback;
}

function parseBoolean(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === '') return fallback;

  const normalized = rawValue.trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  throw new Error(`${name} must be true or false.`);
}

function requireEnvironment() {
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter(
    (name) => !process.env[name] || !process.env[name].trim(),
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in the five required values.',
    );
  }

  const appsScriptUrl = process.env.APPS_SCRIPT_URL.trim();
  let parsedUrl;

  try {
    parsedUrl = new URL(appsScriptUrl);
  } catch {
    throw new Error('APPS_SCRIPT_URL is not a valid URL.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('APPS_SCRIPT_URL must use HTTPS.');
  }

  if (!parsedUrl.pathname.endsWith('/exec')) {
    throw new Error(
      'APPS_SCRIPT_URL must be the deployed web-app URL ending in /exec.',
    );
  }
}

requireEnvironment();

const autocompleteSyncMinutes = parsePositiveIntegerWithLegacy(
  'AUTOCOMPLETE_SYNC_MINUTES',
  'AUTOCOMPLETE_REFRESH_MINUTES',
  5,
);

const autocompleteRetryBaseSeconds = parsePositiveInteger(
  'AUTOCOMPLETE_RETRY_BASE_SECONDS',
  30,
);

const autocompleteRetryMaxMinutes = parsePositiveInteger(
  'AUTOCOMPLETE_RETRY_MAX_MINUTES',
  10,
);

export const config = Object.freeze({
  port: parsePositiveInteger('PORT', 3_000),

  discordToken: process.env.DISCORD_TOKEN.trim(),
  discordClientId: process.env.DISCORD_CLIENT_ID.trim(),
  discordGuildId: process.env.DISCORD_GUILD_ID.trim(),
  appsScriptUrl: process.env.APPS_SCRIPT_URL.trim(),
  apiKey: process.env.FCBOT_API_KEY.trim(),

  ephemeralReplies: parseBoolean('EPHEMERAL_REPLIES', true),

  // Discord requires the initial interaction acknowledgement within three
  // seconds. Keep this below that deadline.
  discordAckTimeoutMs: Math.min(
    parsePositiveInteger('DISCORD_ACK_TIMEOUT_MS', 2_200),
    2_700,
  ),

  // Editing the deferred response is less time-sensitive but still must never
  // be allowed to hang for minutes.
  discordResponseTimeoutMs: Math.min(
    parsePositiveInteger('DISCORD_RESPONSE_TIMEOUT_MS', 10_000),
    30_000,
  ),

  // Applies only to the remaining discord.js REST calls. Interaction
  // callbacks use the direct, abortable transport in index.js.
  discordRestTimeoutMs: Math.min(
    parsePositiveInteger('DISCORD_REST_TIMEOUT_MS', 10_000),
    30_000,
  ),

  // Keep ordinary backend calls safely below Discord's interaction-token
  // lifetime. The value is capped even if a hosting-panel variable is set too
  // high by mistake.
  appsScriptTimeoutMs: Math.min(
    parsePositiveInteger('APPS_SCRIPT_TIMEOUT_MS', 60_000),
    120_000,
  ),

  // Catalog status is a lightweight revision check. Failing it quickly keeps
  // one transient Google response from occupying the synchronizer for a full
  // minute while the previous complete local catalog remains usable.
  autocompleteStatusTimeoutMs: Math.min(
    parsePositiveInteger('AUTOCOMPLETE_STATUS_TIMEOUT_MS', 15_000),
    30_000,
  ),

  // /botstatus should never wait on a slow backend for minutes. It will show
  // local status plus a clear backend timeout instead.
  botStatusTimeoutMs: Math.min(
    parsePositiveInteger('BOT_STATUS_TIMEOUT_MS', 10_000),
    30_000,
  ),

  // Read-only song lookups should fail visibly rather than leaving Discord on
  // "Bot is thinking..." for an extended period.
  songInfoTimeoutMs: Math.min(
    parsePositiveInteger('SONG_INFO_TIMEOUT_MS', 30_000),
    60_000,
  ),

  autocompleteTimeoutMs: Math.min(
    parsePositiveInteger('AUTOCOMPLETE_TIMEOUT_MS', 2_400),
    2_800,
  ),

  autocompleteCacheMs:
    parsePositiveInteger('AUTOCOMPLETE_CACHE_SECONDS', 20) * 1_000,

  autocompleteCatalogPageSize: Math.min(
    parsePositiveInteger('AUTOCOMPLETE_CATALOG_PAGE_SIZE', 5_000),
    5_000,
  ),

  // This is now a lightweight revision-check interval. The complete catalog
  // is downloaded only when the Apps Script revision changes.
  autocompleteSyncCheckMs: autocompleteSyncMinutes * 60_000,

  autocompleteRetryBaseMs: autocompleteRetryBaseSeconds * 1_000,
  autocompleteRetryMaxMs: autocompleteRetryMaxMinutes * 60_000,

  // BACKEND_BUSY is returned before a proof mutation begins, so retrying only
  // that explicit code cannot duplicate a committed add/edit/remove.
  proofBusyRetryAttempts: Math.min(
    parsePositiveInteger('PROOF_BUSY_RETRY_ATTEMPTS', 2),
    4,
  ),
  proofBusyRetryBaseMs: Math.min(
    parsePositiveInteger('PROOF_BUSY_RETRY_BASE_MS', 750),
    5_000,
  ),
});
