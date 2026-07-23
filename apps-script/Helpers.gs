/**
 * Helpers.gs
 * Shared utilities for the FC Proof Discord bot and Google Sheets backend.
 *
 * IMPORTANT:
 * - Keep every public helper prefixed with `fcBot` to avoid collisions with
 *   the functions already present in your Apps Script project.
 * - Programmatic spreadsheet edits do NOT fire Google Sheets onEdit triggers.
 *   The Discord API must explicitly call the shared summary/index/contributor
 *   update functions after writing a proof.
 */

var FCBOT_DEFAULT_CONFIG = Object.freeze({
  spreadsheetId: "", // Optional. Leave blank for a container-bound script.

  summarySheetName: "(List of UnFCed Songs)",
  contributorsSheetName: "Contributors",
  excludedSongsSheetName: "(Excluded Songs)",
  songIndexSheetName: "Song Index",
  playerIndexSheetName: "Player Index",
  logSheetName: "FCBot Logs",

  // The first three workbook tabs are not setlists.
  firstSetlistSheetPosition: 4, // One-based sheet position.

  songColumn: 1, // A
  fcerColumn: 2, // B

  // In the current workbook, the proof URL is embedded in the song cell.
  proofLinkColumn: 1, // A

  summaryStartRow: 2,
  summaryCounterRow: 1000,

  lockTimeoutMs: 30000,
  apiKeyPropertyName: "FCBOT_API_KEY",

  // Proof formatting used when Discord writes or removes a proof.
  // #6aa84f matches the completed-song green shown in the workbook.
  proofCompletedSongBackgroundColor: "#6aa84f",
  proofCompletedSongFontColor: "#ffffff",
  proofCompletedSongUnderline: true,
  proofCompletedPlayerBackgroundColor: "#ffffff",
  proofCompletedPlayerFontColor: "#000000",
  proofCompletedPlayerUnderline: false,

  proofUncompletedSongBackgroundColor: "#ffffff",
  proofUncompletedSongFontColor: "#000000",
  proofUncompletedSongUnderline: false,
  // Un-FC'd rows use a black player cell, matching the workbook layout.
  proofUncompletedPlayerBackgroundColor: "#000000",
  proofUncompletedPlayerFontColor: "#ffffff",
  proofUncompletedPlayerUnderline: false,

  // Keep this false initially. The API will accept any valid HTTPS URL.
  // It can be changed later in Config.gs.
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
    "www.youtube.com",
    "youtu.be",
    "streamable.com",
    "twitch.tv",
    "www.twitch.tv"
  ]
});

var FCBOT_SONG_INDEX_HEADERS = Object.freeze([
  "Song Ref",
  "Song",
  "Setlist",
  "Sheet ID",
  "Row",
  "FC Player",
  "Proof URL",
  "Updated At",
  "Song ID"
]);

var FCBOT_PLAYER_INDEX_HEADERS = Object.freeze([
  "Player",
  "FC Count",
  "Updated At"
]);

var FCBOT_LOG_HEADERS = Object.freeze([
  "Timestamp",
  "Action",
  "Status",
  "Discord User",
  "Song Ref",
  "Message"
]);

/**
 * Per-request memoization for deployed API calls.
 *
 * Apps Script service objects are comparatively expensive to reacquire. The
 * cache is explicitly opened and closed by the web API entry point, so no
 * Spreadsheet or Sheet handle can leak into a later execution. Non-API
 * triggers continue to use the uncached path.
 */
var FCBOT_REQUEST_SCOPE_ = null;

function fcBotBeginRequestScope_() {
  FCBOT_REQUEST_SCOPE_ = {
    spreadsheet: null,
    sheets: {},
    internalSheets: {},
    values: {}
  };
}

function fcBotEndRequestScope_() {
  FCBOT_REQUEST_SCOPE_ = null;
}

function fcBotGetRequestScopedValue_(key) {
  if (!FCBOT_REQUEST_SCOPE_) return undefined;
  return Object.prototype.hasOwnProperty.call(
    FCBOT_REQUEST_SCOPE_.values,
    key
  )
    ? FCBOT_REQUEST_SCOPE_.values[key]
    : undefined;
}

function fcBotSetRequestScopedValue_(key, value) {
  if (FCBOT_REQUEST_SCOPE_) {
    FCBOT_REQUEST_SCOPE_.values[key] = value;
  }
  return value;
}

/**
 * Returns configuration defaults merged with Config.gs overrides.
 * Config.gs may define a global object named FCBOT_CONFIG.
 */
function fcBotGetConfig() {
  var overrides = {};

  if (typeof FCBOT_CONFIG !== "undefined" && FCBOT_CONFIG) {
    overrides = FCBOT_CONFIG;
  }

  var config = Object.assign({}, FCBOT_DEFAULT_CONFIG, overrides);

  // Always clone arrays so callers cannot mutate the global defaults.
  config.allowedProofHosts = Array.isArray(overrides.allowedProofHosts)
    ? overrides.allowedProofHosts.slice()
    : FCBOT_DEFAULT_CONFIG.allowedProofHosts.slice();

  return config;
}

/**
 * Returns the target spreadsheet.
 * A configured spreadsheet ID is safer for deployed web apps. A
 * container-bound Apps Script project can leave spreadsheetId blank.
 */
function fcBotGetSpreadsheet() {
  if (FCBOT_REQUEST_SCOPE_ && FCBOT_REQUEST_SCOPE_.spreadsheet) {
    return FCBOT_REQUEST_SCOPE_.spreadsheet;
  }

  var config = fcBotGetConfig();
  var spreadsheet;

  if (config.spreadsheetId) {
    spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  } else {
    spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  }

  if (!spreadsheet) {
    throw new Error(
      "No active spreadsheet is available. Set spreadsheetId in Config.gs " +
      "or bind this Apps Script project to the spreadsheet."
    );
  }

  if (FCBOT_REQUEST_SCOPE_) {
    FCBOT_REQUEST_SCOPE_.spreadsheet = spreadsheet;
  }
  return spreadsheet;
}

/** Returns a required sheet or throws a clear error. */
function fcBotRequireSheet(sheetName) {
  if (
    FCBOT_REQUEST_SCOPE_ &&
    Object.prototype.hasOwnProperty.call(FCBOT_REQUEST_SCOPE_.sheets, sheetName)
  ) {
    return FCBOT_REQUEST_SCOPE_.sheets[sheetName];
  }

  var sheet = fcBotGetSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Required sheet "' + sheetName + '" was not found.');
  }
  if (FCBOT_REQUEST_SCOPE_) {
    FCBOT_REQUEST_SCOPE_.sheets[sheetName] = sheet;
  }
  return sheet;
}

function fcBotGetSummarySheet() {
  return fcBotRequireSheet(fcBotGetConfig().summarySheetName);
}

function fcBotGetContributorsSheet() {
  return fcBotRequireSheet(fcBotGetConfig().contributorsSheetName);
}

/** Returns an existing sheet or creates it with the supplied headers. */
function fcBotGetOrCreateInternalSheet(sheetName, headers, hideSheet) {
  var cachedState = FCBOT_REQUEST_SCOPE_
    ? FCBOT_REQUEST_SCOPE_.internalSheets[sheetName]
    : null;
  if (cachedState) {
    if (hideSheet && !cachedState.hideEnsured) {
      if (!cachedState.sheet.isSheetHidden()) {
        cachedState.sheet.hideSheet();
      }
      cachedState.hideEnsured = true;
    }
    return cachedState.sheet;
  }

  var spreadsheet = fcBotGetSpreadsheet();
  var sheet =
    FCBOT_REQUEST_SCOPE_ && FCBOT_REQUEST_SCOPE_.sheets[sheetName]
      ? FCBOT_REQUEST_SCOPE_.sheets[sheetName]
      : spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }

  fcBotEnsureSheetSize(sheet, 2, Math.max(1, headers.length));

  var currentHeaders = sheet
    .getRange(1, 1, 1, headers.length)
    .getDisplayValues()[0];

  var headersDiffer = headers.some(function(header, index) {
    return currentHeaders[index] !== header;
  });

  if (headersDiffer) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  if (hideSheet && !sheet.isSheetHidden()) {
    sheet.hideSheet();
  }

  if (FCBOT_REQUEST_SCOPE_) {
    FCBOT_REQUEST_SCOPE_.sheets[sheetName] = sheet;
    FCBOT_REQUEST_SCOPE_.internalSheets[sheetName] = {
      sheet: sheet,
      hideEnsured: Boolean(hideSheet)
    };
  }

  return sheet;
}

function fcBotGetSongIndexSheet(createIfMissing) {
  var config = fcBotGetConfig();
  var spreadsheet = fcBotGetSpreadsheet();
  var sheet = spreadsheet.getSheetByName(config.songIndexSheetName);

  if (!sheet && createIfMissing !== false) {
    sheet = fcBotGetOrCreateInternalSheet(
      config.songIndexSheetName,
      FCBOT_SONG_INDEX_HEADERS,
      true
    );
  }

  return sheet;
}

function fcBotGetPlayerIndexSheet(createIfMissing) {
  var config = fcBotGetConfig();
  var spreadsheet = fcBotGetSpreadsheet();
  var sheet = spreadsheet.getSheetByName(config.playerIndexSheetName);

  if (!sheet && createIfMissing !== false) {
    sheet = fcBotGetOrCreateInternalSheet(
      config.playerIndexSheetName,
      FCBOT_PLAYER_INDEX_HEADERS,
      true
    );
  }

  return sheet;
}

function fcBotGetLogSheet(createIfMissing) {
  var config = fcBotGetConfig();
  var spreadsheet = fcBotGetSpreadsheet();
  var sheet = spreadsheet.getSheetByName(config.logSheetName);

  if (!sheet && createIfMissing !== false) {
    sheet = fcBotGetOrCreateInternalSheet(
      config.logSheetName,
      FCBOT_LOG_HEADERS,
      true
    );
  }

  return sheet;
}

/** Creates the hidden internal sheets used by the bot backend. */
function fcBotSetupCoreSheets() {
  fcBotGetSongIndexSheet(true);
  fcBotGetPlayerIndexSheet(true);
  fcBotGetLogSheet(true);

  SpreadsheetApp.flush();
  return {
    ok: true,
    message: "FCBot internal sheets are ready."
  };
}

/** Ensures a sheet has at least the requested rows and columns. */
function fcBotEnsureSheetSize(sheet, requiredRows, requiredColumns) {
  requiredRows = Math.max(1, Number(requiredRows) || 1);
  requiredColumns = Math.max(1, Number(requiredColumns) || 1);

  var missingRows = requiredRows - sheet.getMaxRows();
  if (missingRows > 0) {
    sheet.insertRowsAfter(sheet.getMaxRows(), missingRows);
  }

  var missingColumns = requiredColumns - sheet.getMaxColumns();
  if (missingColumns > 0) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), missingColumns);
  }
}

/** Safe range helper. Returns null rather than creating an invalid range. */
function fcBotSafeGetRange(sheet, startRow, startColumn, numRows, numColumns) {
  startRow = Number(startRow);
  startColumn = Number(startColumn);
  numRows = Number(numRows);
  numColumns = Number(numColumns);

  if (
    !sheet ||
    startRow < 1 ||
    startColumn < 1 ||
    numRows < 1 ||
    numColumns < 1
  ) {
    return null;
  }

  fcBotEnsureSheetSize(
    sheet,
    startRow + numRows - 1,
    startColumn + numColumns - 1
  );

  return sheet.getRange(startRow, startColumn, numRows, numColumns);
}

/** Returns the last nonblank row in a column, or startRow - 1. */
function fcBotGetLastNonEmptyRow(sheet, column, startRow) {
  column = Number(column) || 1;
  startRow = Number(startRow) || 1;

  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) return startRow - 1;

  var values = sheet
    .getRange(startRow, column, lastRow - startRow + 1, 1)
    .getDisplayValues();

  for (var index = values.length - 1; index >= 0; index--) {
    if (fcBotNormalizeText(values[index][0])) {
      return startRow + index;
    }
  }

  return startRow - 1;
}

/** Returns normalized nonblank values from a vertical range. */
function fcBotReadNonBlankColumn(sheet, column, startRow, endRow) {
  startRow = Number(startRow) || 1;
  endRow = Number(endRow) || sheet.getLastRow();

  if (endRow < startRow) return [];

  return sheet
    .getRange(startRow, column, endRow - startRow + 1, 1)
    .getDisplayValues()
    .map(function(row) {
      return fcBotNormalizeText(row[0]);
    })
    .filter(Boolean);
}

/** Collapses whitespace and trims text without changing capitalization. */
function fcBotNormalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/** Normalized case-insensitive lookup key. */
function fcBotNormalizeKey(value) {
  return fcBotNormalizeText(value).toLocaleLowerCase();
}

/** Returns the names of all sheets that must never be treated as setlists. */
function fcBotGetExcludedSheetNameSet() {
  var config = fcBotGetConfig();
  var names = [
    config.excludedSongsSheetName,
    config.summarySheetName,
    config.contributorsSheetName,
    config.songIndexSheetName,
    config.playerIndexSheetName,
    config.logSheetName
  ];

  return new Set(names.filter(Boolean));
}

/** Determines whether a sheet is an actual setlist tab. */
function fcBotIsSetlistSheet(sheet) {
  if (!sheet) return false;

  var config = fcBotGetConfig();
  var excluded = fcBotGetExcludedSheetNameSet();

  if (sheet.getIndex() < config.firstSetlistSheetPosition) return false;
  if (excluded.has(sheet.getName())) return false;

  return true;
}

/** Returns all current setlist sheets in workbook tab order. */
function fcBotGetSetlistSheets() {
  return fcBotGetSpreadsheet()
    .getSheets()
    .filter(fcBotIsSetlistSheet);
}

/** Returns a sheet by its immutable numeric sheet ID. */
function fcBotGetSheetById(sheetId) {
  sheetId = Number(sheetId);
  if (!Number.isInteger(sheetId)) return null;

  var sheets = fcBotGetSpreadsheet().getSheets();
  for (var index = 0; index < sheets.length; index++) {
    if (sheets[index].getSheetId() === sheetId) {
      return sheets[index];
    }
  }

  return null;
}

/**
 * Creates the legacy row-based reference retained during migration.
 * Format: numericSheetId:row
 */
function fcBotCreateSongRef(sheet, row) {
  if (!sheet || !Number.isInteger(Number(row)) || Number(row) < 1) {
    throw new Error("Cannot create a song reference from an invalid sheet or row.");
  }

  return sheet.getSheetId() + ":" + Number(row);
}

function fcBotNormalizeSongId(value) {
  var normalized = fcBotNormalizeText(value).toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized
  )
    ? normalized
    : "";
}

function fcBotCreateStableSongRef(songId) {
  var normalized = fcBotNormalizeSongId(songId);
  if (!normalized) {
    throw new Error("Cannot create a stable reference from an invalid song ID.");
  }
  return "id:" + normalized;
}

/** Parses either an immutable song ID or a legacy row reference. */
function fcBotParseSongRef(songRef) {
  var normalized = fcBotNormalizeText(songRef);
  var stableMatch = /^id:(.+)$/i.exec(normalized);
  if (stableMatch) {
    var songId = fcBotNormalizeSongId(stableMatch[1]);
    return songId ? { songId: songId, stable: true } : null;
  }

  var match = /^(\d+):(\d+)$/.exec(normalized);
  if (!match) return null;

  return {
    sheetId: Number(match[1]),
    row: Number(match[2]),
    stable: false
  };
}

/** Resolves and validates a compact song reference. */
function fcBotResolveSongRef(songRef) {
  var parsed = fcBotParseSongRef(songRef);
  if (!parsed) return null;

  var indexed = null;
  if (parsed.stable) {
    if (typeof fcBotGetIndexedSongByRef !== "function") return null;
    indexed = fcBotGetIndexedSongByRef(songRef);
    if (!indexed) return null;
    parsed = {
      sheetId: Number(indexed.sheetId),
      row: Number(indexed.row)
    };
  }

  var sheet = fcBotGetSheetById(parsed.sheetId);
  if (!sheet || !fcBotIsSetlistSheet(sheet)) return null;
  if (parsed.row < 1 || parsed.row > sheet.getMaxRows()) return null;

  var config = fcBotGetConfig();
  var songName = fcBotNormalizeText(
    sheet.getRange(parsed.row, config.songColumn).getDisplayValue()
  );

  if (!songName) return null;

  if (
    indexed &&
    fcBotNormalizeKey(songName) !== fcBotNormalizeKey(indexed.song)
  ) {
    return null;
  }

  return {
    ref: indexed ? indexed.songRef : songRef,
    songId: indexed ? indexed.songId : "",
    sheet: sheet,
    sheetId: parsed.sheetId,
    sheetName: sheet.getName(),
    row: parsed.row,
    songName: songName
  };
}

/** Reads the first hyperlink found in a cell's rich text or formula. */
function fcBotGetCellLinkUrl(range) {
  if (!range) return "";

  var richText = range.getRichTextValue();
  if (richText) {
    var directUrl = richText.getLinkUrl();
    if (directUrl) return directUrl;

    var runs = richText.getRuns() || [];
    for (var index = 0; index < runs.length; index++) {
      var runUrl = runs[index].getLinkUrl();
      if (runUrl) return runUrl;
    }
  }

  var formula = range.getFormula();
  if (formula) {
    var hyperlinkMatch = /^=HYPERLINK\(\s*"([^"]+)"/i.exec(formula);
    if (hyperlinkMatch) return hyperlinkMatch[1];
  }

  var value = fcBotNormalizeText(range.getDisplayValue());
  return fcBotIsValidHttpUrl(value) ? value : "";
}

/**
 * Embeds a proof URL in the song cell and applies the completed-song format.
 *
 * Completed format:
 * - Song cell: green (#6aa84f), white underlined text.
 * - Player cell: white background, black text, no underline.
 */
function fcBotSetCellLinkUrl(range, proofUrl, displayText) {
  if (!range) throw new Error("A target range is required.");
  if (fcBotIsDiscordProofUrl(proofUrl)) {
    throw new Error(
      "Discord-hosted proof links are not allowed because they may expire. " +
      "Use a permanent HTTPS host instead."
    );
  }

  if (!fcBotIsAllowedProofUrl(proofUrl)) {
    throw new Error("The proof URL is not valid or is not allowed.");
  }

  var text = fcBotNormalizeText(displayText || range.getDisplayValue());
  if (!text) {
    throw new Error("Cannot add a hyperlink to a blank song cell.");
  }

  var textStyle = range.getTextStyle();
  var richText = SpreadsheetApp.newRichTextValue()
    .setText(text)
    .setLinkUrl(proofUrl)
    .setTextStyle(textStyle)
    .build();

  range.setRichTextValue(richText);
  fcBotApplyCompletedProofFormatting_(range);
}

/**
 * Removes the hyperlink and restores the uncompleted-song format.
 *
 * Uncompleted format:
 * - Song cell: white background, black text, no underline.
 * - Player cell: black background, white text, no underline.
 */
function fcBotClearCellLinkUrl(range) {
  if (!range) throw new Error("A target range is required.");

  var text = range.getDisplayValue();
  var textStyle = range.getTextStyle();
  var richText = SpreadsheetApp.newRichTextValue()
    .setText(text)
    .setTextStyle(textStyle)
    .build();

  range.setRichTextValue(richText);
  fcBotApplyUncompletedProofFormatting_(range);
}

/** Applies the exact completed proof formatting to the song and player cells. */
function fcBotApplyCompletedProofFormatting_(proofCell) {
  if (!proofCell) {
    throw new Error("A proof cell is required for completed formatting.");
  }

  var config = fcBotGetConfig();
  var sheet = proofCell.getSheet();
  var row = proofCell.getRow();
  var playerCell = sheet.getRange(row, Number(config.fcerColumn));

  proofCell
    .setBackground(config.proofCompletedSongBackgroundColor)
    .setFontColor(config.proofCompletedSongFontColor)
    .setFontLine(
      config.proofCompletedSongUnderline ? "underline" : "none"
    );

  playerCell
    .setBackground(config.proofCompletedPlayerBackgroundColor)
    .setFontColor(config.proofCompletedPlayerFontColor)
    .setFontLine(
      config.proofCompletedPlayerUnderline ? "underline" : "none"
    );
}

/** Restores the exact uncompleted formatting to the song and player cells. */
function fcBotApplyUncompletedProofFormatting_(proofCell) {
  if (!proofCell) {
    throw new Error("A proof cell is required for uncompleted formatting.");
  }

  var config = fcBotGetConfig();
  var sheet = proofCell.getSheet();
  var row = proofCell.getRow();
  var playerCell = sheet.getRange(row, Number(config.fcerColumn));

  proofCell
    .setBackground(config.proofUncompletedSongBackgroundColor)
    .setFontColor(config.proofUncompletedSongFontColor)
    .setFontLine(
      config.proofUncompletedSongUnderline ? "underline" : "none"
    );

  playerCell
    .setBackground(config.proofUncompletedPlayerBackgroundColor)
    .setFontColor(config.proofUncompletedPlayerFontColor)
    .setFontLine(
      config.proofUncompletedPlayerUnderline ? "underline" : "none"
    );
}

/**
 * Repairs the formatting of one already-completed song without changing its
 * player name or proof URL.
 */
function fcBotRepairProofFormattingByRef(songRef) {
  return fcBotWithLock(function() {
    var live = fcBotResolveSongRef(songRef);

    if (!live) {
      throw new Error(
        'The song reference "' + songRef + '" does not resolve to a setlist row.'
      );
    }

    var config = fcBotGetConfig();
    var proofCell = live.sheet.getRange(
      live.row,
      Number(config.proofLinkColumn)
    );
    var playerCell = live.sheet.getRange(
      live.row,
      Number(config.fcerColumn)
    );
    var player = fcBotNormalizeText(playerCell.getDisplayValue());
    var proofUrl = fcBotGetCellLinkUrl(proofCell);

    if (!player || !proofUrl) {
      throw new Error(
        'The selected song must have both an FC player and a proof URL.'
      );
    }

    fcBotApplyCompletedProofFormatting_(proofCell);
    SpreadsheetApp.flush();

    var result = {
      ok: true,
      songRef: songRef,
      song: live.songName,
      setlist: live.sheetName,
      row: live.row,
      player: player,
      proofUrl: proofUrl,
      message: "Proof formatting repaired successfully."
    };

    console.log(JSON.stringify(result, null, 2));
    return result;
  });
}

/**
 * Repairs the already-added "A Fatal Encounter" proof from the screenshot.
 * Run this once from the Apps Script editor after replacing Helpers.gs.
 */
function fcBotRepairFatalEncounterFormatting() {
  return fcBotRepairProofFormattingByRef("1536382713:30");
}

/**
 * Extracts and validates the hostname from an HTTPS URL.
 *
 * Google Apps Script does not provide the browser/Node.js URL class, so this
 * parser intentionally avoids `new URL(...)`.
 */
function fcBotExtractHttpsHostname_(value) {
  var text = fcBotNormalizeText(value);

  if (!text || /\s/.test(text)) {
    return "";
  }

  // Capture the authority between https:// and the first path/query/fragment.
  var match = /^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(text);
  if (!match) {
    return "";
  }

  var authority = match[1];

  // Reject embedded credentials and IPv6 literals. Neither is needed for the
  // proof-host allowlist.
  if (
    authority.indexOf("@") !== -1 ||
    authority.charAt(0) === "["
  ) {
    return "";
  }

  // Remove an optional numeric port.
  var hostname = authority
    .replace(/:\d+$/, "")
    .toLocaleLowerCase()
    .replace(/\.$/, "");

  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.indexOf("..") !== -1
  ) {
    return "";
  }

  var labels = hostname.split(".");

  for (var index = 0; index < labels.length; index++) {
    var label = labels[index];

    if (
      !label ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    ) {
      return "";
    }
  }

  return hostname;
}

function fcBotIsValidHttpUrl(value) {
  return Boolean(fcBotExtractHttpsHostname_(value));
}

/** Returns true when the URL is hosted by Discord or a Discord CDN domain. */
function fcBotIsDiscordProofUrl(value) {
  var hostname = fcBotExtractHttpsHostname_(value);
  if (!hostname) {
    return false;
  }

  var blockedDiscordHosts = [
    "discord.com",
    "discordapp.com",
    "discordapp.net",
    "discord.gg",
    "discordcdn.com"
  ];

  return blockedDiscordHosts.some(function(blockedHost) {
    return (
      hostname === blockedHost ||
      hostname.endsWith("." + blockedHost)
    );
  });
}

function fcBotIsAllowedProofUrl(value) {
  var hostname = fcBotExtractHttpsHostname_(value);
  if (!hostname) {
    return false;
  }

  // Discord-hosted attachment links are deliberately rejected even when
  // restrictProofHosts is false.
  if (fcBotIsDiscordProofUrl(value)) {
    return false;
  }

  var config = fcBotGetConfig();

  if (!config.restrictProofHosts) {
    return true;
  }

  return config.allowedProofHosts.some(function(allowedHost) {
    allowedHost = fcBotNormalizeKey(allowedHost);

    return (
      hostname === allowedHost ||
      hostname.endsWith("." + allowedHost)
    );
  });
}

/** Reads a Script Property. Secrets should be stored there, not in source. */
function fcBotGetScriptProperty(propertyName) {
  return PropertiesService.getScriptProperties().getProperty(propertyName) || "";
}

function fcBotSetScriptProperty(propertyName, value) {
  PropertiesService.getScriptProperties().setProperty(
    propertyName,
    String(value)
  );
}

/** One-time helper for setting the API key from the Apps Script editor. */
function fcBotSetApiKey(apiKey) {
  apiKey = fcBotNormalizeText(apiKey);
  if (apiKey.length < 32) {
    throw new Error("Use an API key containing at least 32 characters.");
  }

  fcBotSetScriptProperty(fcBotGetConfig().apiKeyPropertyName, apiKey);
  return {
    ok: true,
    message: "FCBot API key saved in Script Properties."
  };
}

/** Constant-time-ish comparison for equal-length secrets. */
function fcBotConstantTimeEquals(left, right) {
  left = String(left || "");
  right = String(right || "");

  var mismatch = left.length ^ right.length;
  var length = Math.max(left.length, right.length);

  for (var index = 0; index < length; index++) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return mismatch === 0;
}

/**
 * Validates an API key supplied in a JSON body or query parameter.
 * Apps Script web-app event objects do not reliably expose HTTP headers, so
 * the bot sends the key as `apiKey` in the request body.
 */
function fcBotRequireValidApiKey(requestData) {
  var config = fcBotGetConfig();
  var expected = fcBotGetScriptProperty(config.apiKeyPropertyName);

  if (!expected) {
    throw new Error(
      "FCBot API key is not configured. Run fcBotSetApiKey(...) once."
    );
  }

  var received = requestData && requestData.apiKey;
  if (!fcBotConstantTimeEquals(expected, received)) {
    var error = new Error("Unauthorized request.");
    error.code = "UNAUTHORIZED";
    throw error;
  }
}

/** Parses GET parameters or a JSON POST body into a plain object. */
function fcBotParseWebRequest(e) {
  if (!e) return {};

  var result = {};

  if (e.parameter) {
    Object.keys(e.parameter).forEach(function(key) {
      result[key] = e.parameter[key];
    });
  }

  if (e.postData && e.postData.contents) {
    var contentType = String(e.postData.type || "").toLocaleLowerCase();

    if (contentType.indexOf("application/json") !== -1) {
      var parsed = JSON.parse(e.postData.contents);
      if (parsed && typeof parsed === "object") {
        Object.keys(parsed).forEach(function(key) {
          result[key] = parsed[key];
        });
      }
    }
  }

  return result;
}

/** Creates an Apps Script JSON response. */
function fcBotJsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function fcBotSuccess(message, data) {
  return fcBotJsonResponse({
    ok: true,
    message: message || "Success.",
    data: data === undefined ? null : data
  });
}

function fcBotFailure(code, message, details) {
  return fcBotJsonResponse({
    ok: false,
    code: code || "ERROR",
    message: message || "The request failed.",
    details: details === undefined ? null : details
  });
}

/** Serializes a callback behind a script-wide lock. */
function fcBotWithLock(callback, timeoutMs) {
  if (typeof callback !== "function") {
    throw new Error("fcBotWithLock requires a callback function.");
  }

  var timeout = Number(timeoutMs) || fcBotGetConfig().lockTimeoutMs;
  var lock = LockService.getScriptLock();
  lock.waitLock(timeout);

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

/** Appends an audit-log entry without exposing secrets. */
function fcBotWriteLog(action, status, context) {
  context = context || {};

  try {
    var sheet = fcBotGetLogSheet(true);
    var row = [
      new Date(),
      fcBotNormalizeText(action),
      fcBotNormalizeText(status),
      fcBotNormalizeText(context.discordUser),
      fcBotNormalizeText(context.songRef),
      fcBotNormalizeText(context.message)
    ];

    sheet.appendRow(row);
  } catch (error) {
    console.error("FCBot logging failed: " + error.message);
  }
}

/** Converts an unknown thrown value into a safe client-facing error object. */
function fcBotDescribeError(error) {
  var code = error && error.code ? String(error.code) : "INTERNAL_ERROR";
  var message = error && error.message
    ? String(error.message)
    : "An unexpected error occurred.";

  return {
    code: code,
    message: message
  };
}
