/**
 * Config.gs
 * Workbook-specific settings and one-time setup helpers for the FC Proof bot.
 *
 * SETUP:
 * 1. Keep your existing spreadsheet ID in `spreadsheetId` below.
 *    It is the text between /d/ and /edit in the Google Sheets URL.
 * 2. Save the Apps Script project.
 * 3. Run `fcBotInitializeBackend()` once from the Apps Script editor.
 * 4. Run `fcBotGenerateAndStoreApiKey()` once and securely copy the key from
 *    the execution log. The same key is placed in the Discord bot's
 *    environment variables.
 *
 * Do not place Discord bot tokens, webhook URLs, or API keys in this file.
 * Secrets belong in Apps Script Properties or hosting environment variables.
 */

var FCBOT_CONFIG = Object.freeze({
  /**
   * IMPORTANT:
   * Keep the spreadsheetId value already used by your working deployment.
   * Leave blank only when your bound Apps Script project is already working
   * correctly with SpreadsheetApp.getActiveSpreadsheet().
   */
  spreadsheetId: "1RC_px-McyyBhCQQbTqtFJAww2Neo7XatRw9gvR5hABU",

  // Existing workbook sheets.
  summarySheetName: "(List of UnFCed Songs)",
  contributorsSheetName: "Contributors",
  excludedSongsSheetName: "(Excluded Songs)",

  // Hidden sheets maintained by the backend.
  songIndexSheetName: "Song Index",
  playerIndexSheetName: "Player Index",
  logSheetName: "FCBot Logs",

  // The first three workbook tabs are not setlists. Setlists start at tab 4.
  firstSetlistSheetPosition: 4,

  // Setlist layout: song/proof link in A and FCer name in B.
  songColumn: 1,
  fcerColumn: 2,
  proofLinkColumn: 1,

  // Existing summary layout.
  summaryStartRow: 2,
  summaryCounterRow: 1000,

  // Discord autocomplete allows at most 25 choices.
  autocompleteResultLimit: 25,

  // Maximum accepted lengths for API input.
  maxPlayerNameLength: 100,
  maxProofUrlLength: 2000,
  maxDiscordUserLength: 100,

  // Proof-submission rules.
  allowProofOverwrite: false,
  allowPlayerOverwrite: false,
  requirePlayerInPlayerIndex: false,

  // Preserve the song title and embed the proof URL into the song cell.
  proofLinkUsesSongText: true,

  // Formatting applied after a Discord proof submission.
  // Empty strings mean "leave the existing formatting unchanged".
  completedRowBackgroundColor: "",
  completedSongFontColor: "",
  completedFcerFontColor: "",
  completedFontWeight: "",

  // Script-wide lock used to prevent simultaneous Discord submissions from
  // changing the same workbook at the same time.
  lockTimeoutMs: 30000,

  // Name of the Script Property that stores the API key.
  apiKeyPropertyName: "FCBOT_API_KEY",

  /**
   * When false, every syntactically valid HTTPS proof URL is accepted.
   * When true, only the hosts below and their subdomains are accepted.
   */
  restrictProofHosts: false,
  allowedProofHosts: [
    "discord.com",
    "discordapp.com",
    "cdn.discordapp.com",
    "media.discordapp.net",
    "imgur.com",
    "i.imgur.com",
    "imgchest.com",
    "youtube.com",
    "youtu.be",
    "streamable.com",
    "twitch.tv",
    "clips.twitch.tv",
    "medal.tv",
    "drive.google.com"
  ]
});

/**
 * Validates workbook-specific configuration and returns a readable report.
 * This function does not expose the stored API key.
 */
function fcBotValidateConfiguration() {
  var config = fcBotGetConfig();
  var errors = [];
  var warnings = [];

  if (!fcBotNormalizeText(config.spreadsheetId)) {
    warnings.push(
      "spreadsheetId is blank. This is acceptable while testing from the " +
      "bound spreadsheet, but it must be set if the deployed web app cannot " +
      "resolve the active spreadsheet."
    );
  } else if (!/^[a-zA-Z0-9-_]+$/.test(config.spreadsheetId)) {
    errors.push("spreadsheetId contains invalid characters.");
  }

  var positiveIntegerFields = [
    "firstSetlistSheetPosition",
    "songColumn",
    "fcerColumn",
    "proofLinkColumn",
    "summaryStartRow",
    "summaryCounterRow",
    "autocompleteResultLimit",
    "maxPlayerNameLength",
    "maxProofUrlLength",
    "maxDiscordUserLength",
    "lockTimeoutMs"
  ];

  positiveIntegerFields.forEach(function(fieldName) {
    var value = Number(config[fieldName]);
    if (!Number.isInteger(value) || value < 1) {
      errors.push(fieldName + " must be a positive integer.");
    }
  });

  if (Number(config.autocompleteResultLimit) > 25) {
    errors.push("autocompleteResultLimit cannot exceed Discord's limit of 25.");
  }

  var requiredSheetNames = [
    "summarySheetName",
    "contributorsSheetName",
    "excludedSongsSheetName",
    "songIndexSheetName",
    "playerIndexSheetName",
    "logSheetName"
  ];

  requiredSheetNames.forEach(function(fieldName) {
    if (!fcBotNormalizeText(config[fieldName])) {
      errors.push(fieldName + " cannot be blank.");
    }
  });

  var internalNames = [
    config.songIndexSheetName,
    config.playerIndexSheetName,
    config.logSheetName
  ].map(fcBotNormalizeKey);

  if (new Set(internalNames).size !== internalNames.length) {
    errors.push("Internal sheet names must be unique.");
  }

  if (!Array.isArray(config.allowedProofHosts)) {
    errors.push("allowedProofHosts must be an array.");
  }

  var apiKeyConfigured = Boolean(
    fcBotGetScriptProperty(config.apiKeyPropertyName)
  );

  if (!apiKeyConfigured) {
    warnings.push(
      "No API key is stored yet. Run fcBotGenerateAndStoreApiKey() before " +
      "deploying the Discord API."
    );
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings,
    apiKeyConfigured: apiKeyConfigured,
    spreadsheetIdConfigured: Boolean(fcBotNormalizeText(config.spreadsheetId))
  };
}

/**
 * One-time backend initializer.
 * Creates hidden internal sheets, verifies the required workbook sheets, and
 * writes a setup report to the execution log.
 */
function fcBotInitializeBackend() {
  var validation = fcBotValidateConfiguration();

  if (!validation.ok) {
    throw new Error(
      "FCBot configuration is invalid:\n- " + validation.errors.join("\n- ")
    );
  }

  // These must already exist in the workbook.
  fcBotGetSummarySheet();
  fcBotGetContributorsSheet();

  var config = fcBotGetConfig();
  fcBotRequireSheet(config.excludedSongsSheetName);

  var setupResult = fcBotSetupCoreSheets();
  var setlistCount = fcBotGetSetlistSheets().length;

  var report = {
    ok: true,
    message: setupResult.message,
    setlistCount: setlistCount,
    songIndexSheet: config.songIndexSheetName,
    playerIndexSheet: config.playerIndexSheetName,
    logSheet: config.logSheetName,
    warnings: validation.warnings
  };

  console.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Generates and stores a new 64-character API key.
 *
 * Run this from the Apps Script editor, then copy the key from the execution
 * log immediately. Generating another key invalidates the previous one.
 */
function fcBotGenerateAndStoreApiKey() {
  var key = (
    Utilities.getUuid().replace(/-/g, "") +
    Utilities.getUuid().replace(/-/g, "")
  );

  fcBotSetApiKey(key);

  console.log(
    "FCBot API key (copy this now and keep it private):\n" + key
  );

  return {
    ok: true,
    message: "A new API key was generated and stored in Script Properties.",
    apiKey: key
  };
}

/** Reports whether setup is complete without revealing secret values. */
function fcBotGetBackendStatus() {
  var config = fcBotGetConfig();
  var spreadsheet = null;
  var spreadsheetError = "";

  try {
    spreadsheet = fcBotGetSpreadsheet();
  } catch (error) {
    spreadsheetError = error.message;
  }

  var status = {
    ok: !spreadsheetError,
    spreadsheetAccessible: Boolean(spreadsheet),
    spreadsheetName: spreadsheet ? spreadsheet.getName() : "",
    spreadsheetIdConfigured: Boolean(fcBotNormalizeText(config.spreadsheetId)),
    apiKeyConfigured: Boolean(
      fcBotGetScriptProperty(config.apiKeyPropertyName)
    ),
    summarySheetFound: false,
    contributorsSheetFound: false,
    excludedSongsSheetFound: false,
    songIndexSheetFound: false,
    playerIndexSheetFound: false,
    logSheetFound: false,
    setlistCount: 0,
    error: spreadsheetError
  };

  if (spreadsheet) {
    status.summarySheetFound = Boolean(
      spreadsheet.getSheetByName(config.summarySheetName)
    );
    status.contributorsSheetFound = Boolean(
      spreadsheet.getSheetByName(config.contributorsSheetName)
    );
    status.excludedSongsSheetFound = Boolean(
      spreadsheet.getSheetByName(config.excludedSongsSheetName)
    );
    status.songIndexSheetFound = Boolean(
      spreadsheet.getSheetByName(config.songIndexSheetName)
    );
    status.playerIndexSheetFound = Boolean(
      spreadsheet.getSheetByName(config.playerIndexSheetName)
    );
    status.logSheetFound = Boolean(
      spreadsheet.getSheetByName(config.logSheetName)
    );
    status.setlistCount = spreadsheet
      .getSheets()
      .filter(fcBotIsSetlistSheet)
      .length;
  }

  console.log(JSON.stringify(status, null, 2));
  return status;
}
