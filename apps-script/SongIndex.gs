/**
 * SongIndex.gs — batch API edition
 *
 * Replaces the resumable/time-trigger rebuild approach.
 *
 * Full rebuilds use the Advanced Google Sheets service and values.batchGet()
 * to read every setlist's A:B values in a small number of API calls. This is
 * substantially faster and more reliable than opening hundreds of ranges one
 * sheet at a time or chaining continuation triggers.
 *
 * Index layout:
 * A  Song Ref       Stable ID reference, e.g. id:550e8400-...
 * B  Song
 * C  Setlist
 * D  Sheet ID
 * E  Row
 * F  FC Player
 * G  Proof URL      Populated by incremental per-setlist updates; full batch
 *                   rebuilds leave this blank because proof URLs are embedded
 *                   as rich-text links and are read live when a proof command
 *                   is executed.
 * H  Updated At
 * I  Song ID        Immutable identity stored only in this hidden index.
 *
 * Setlist tabs remain unchanged: songs stay in A and FC players stay in B.
 *
 * REQUIRED:
 * Enable the Advanced Google Sheets service in Apps Script:
 *   Services (+) -> Google Sheets API -> Add
 */

var FCBOT_SONG_INDEX_EDIT_HANDLER = "fcBotSongIndexEditTrigger";
var FCBOT_SONG_INDEX_CHANGE_HANDLER = "fcBotSongIndexChangeTrigger";
var FCBOT_SONG_INDEX_LEGACY_CONTINUATION_HANDLER = "fcBotContinueSongIndexRebuild";

var FCBOT_SONG_INDEX_RANGE_BATCH_SIZE = 40;
var FCBOT_SONG_INDEX_WRITE_BATCH_SIZE = 10000;

var FCBOT_SONG_INDEX_LAST_REBUILD_AT_KEY = "FCBOT_SONG_INDEX_LAST_REBUILD_AT";
var FCBOT_SONG_INDEX_LAST_REBUILD_SONGS_KEY = "FCBOT_SONG_INDEX_LAST_REBUILD_SONGS";
var FCBOT_SONG_INDEX_LAST_REBUILD_SETLISTS_KEY = "FCBOT_SONG_INDEX_LAST_REBUILD_SETLISTS";
var FCBOT_SONG_INDEX_LAST_REBUILD_DURATION_KEY = "FCBOT_SONG_INDEX_LAST_REBUILD_DURATION_MS";
var FCBOT_SONG_INDEX_DIRTY_KEY = "FCBOT_SONG_INDEX_DIRTY";

var FCBOT_AUTOCOMPLETE_CATALOG_REVISION_KEY =
  "FCBOT_AUTOCOMPLETE_CATALOG_REVISION";
var FCBOT_AUTOCOMPLETE_CATALOG_UPDATED_AT_KEY =
  "FCBOT_AUTOCOMPLETE_CATALOG_UPDATED_AT";
var FCBOT_AUTOCOMPLETE_CATALOG_REASON_KEY =
  "FCBOT_AUTOCOMPLETE_CATALOG_REASON";

// Lightweight workbook-structure snapshot used by the optimized onChange
// trigger. The compressed snapshot is split into chunks because Apps Script
// limits each individual Script Property value to 9 KB.
var FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION = 1;
var FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_SIZE = 7000;
var FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION_KEY =
  "FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION";
var FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_COUNT_KEY =
  "FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_COUNT";
var FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_PREFIX =
  "FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_";

var FCBOT_SONG_INDEX_LAST_MAINTENANCE_AT_KEY =
  "FCBOT_SONG_INDEX_LAST_MAINTENANCE_AT";
var FCBOT_SONG_INDEX_LAST_MAINTENANCE_TYPE_KEY =
  "FCBOT_SONG_INDEX_LAST_MAINTENANCE_TYPE";
var FCBOT_SONG_INDEX_LAST_MAINTENANCE_DURATION_KEY =
  "FCBOT_SONG_INDEX_LAST_MAINTENANCE_DURATION_MS";
var FCBOT_SONG_INDEX_LAST_MAINTENANCE_SHEETS_KEY =
  "FCBOT_SONG_INDEX_LAST_MAINTENANCE_SHEETS";

/**
 * Public full rebuild. Safe to run manually.
 */
function fcBotRebuildSongIndex() {
  return fcBotRunSongIndexRebuildWithOptionalLock_();
}

/**
 * Compatibility entry point used by DiscordAPI.gs.
 * If the caller already holds the shared script lock, this does not attempt to
 * acquire it again.
 */
function fcBotStartSongIndexRebuild() {
  return fcBotRunSongIndexRebuildWithOptionalLock_();
}

/**
 * One-time migration entry point for stable song IDs.
 *
 * IDs are stored only in the hidden Song Index sheet. No setlist columns are
 * inserted, hidden, or written by this migration.
 */
function fcBotMigrateStableSongIds() {
  return fcBotRunSongIndexRebuildWithOptionalLock_();
}

function fcBotRunSongIndexRebuildWithOptionalLock_() {
  var lock = LockService.getScriptLock();

  // DiscordAPI calls this while already inside fcBotWithLock(). Script locks
  // are visible to the current execution through hasLock().
  if (lock.hasLock()) {
    return fcBotRebuildSongIndexUnlocked_();
  }

  lock.waitLock(Math.max(30000, Number(fcBotGetConfig().lockTimeoutMs) || 30000));
  try {
    return fcBotRebuildSongIndexUnlocked_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Full rebuild implementation. Reads all setlists through values.batchGet and
 * writes the finished index in large batches.
 */
function fcBotRebuildSongIndexUnlocked_() {
  fcBotAssertAdvancedSheetsService_();

  var props = PropertiesService.getScriptProperties();
  props.setProperty(FCBOT_SONG_INDEX_DIRTY_KEY, "true");

  var startedAt = Date.now();
  var spreadsheet = fcBotGetSpreadsheet();

  try {
    var indexSheet = fcBotGetSongIndexSheet(true);
    fcBotEnsureSheetSize(
      indexSheet,
      Math.max(2, indexSheet.getLastRow()),
      FCBOT_SONG_INDEX_HEADERS.length
    );
    var existingRecords = fcBotGetSongIndexSnapshot();
    var setlistSheets = fcBotGetSetlistSheets();
    var rows = fcBotBuildCompleteSongIndexRowsWithBatchApi_(
      spreadsheet,
      setlistSheets
    );
    fcBotAssignStableSongIdsToRows_(rows, existingRecords);

    fcBotWriteCompleteSongIndexInBatches_(indexSheet, rows);
    SpreadsheetApp.flush();

    var catalogState = fcBotTouchAutocompleteCatalogRevision_(
      "full-song-index-rebuild"
    );
    var durationMs = Date.now() - startedAt;

    // Capture the workbook structure only after the index has been completed.
    // Future row/sheet changes can then be handled incrementally.
    fcBotSaveSongIndexStructureSnapshot_(
      fcBotCaptureSongIndexStructureSnapshot_(spreadsheet)
    );

    // Do not pass deleteAllOthers=true here. The API key and unrelated
    // project settings are stored in the same Script Properties collection.
    props.setProperties({
      FCBOT_SONG_INDEX_LAST_REBUILD_AT: new Date().toISOString(),
      FCBOT_SONG_INDEX_LAST_REBUILD_SONGS: String(rows.length),
      FCBOT_SONG_INDEX_LAST_REBUILD_SETLISTS: String(setlistSheets.length),
      FCBOT_SONG_INDEX_LAST_REBUILD_DURATION_MS: String(durationMs),
      FCBOT_SONG_INDEX_DIRTY: "false",
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_AT: new Date().toISOString(),
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_TYPE: "FULL_REBUILD",
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_DURATION_MS: String(durationMs),
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_SHEETS: String(setlistSheets.length)
    });

    var result = {
      ok: true,
      changed: true,
      fullRebuild: true,
      running: false,
      indexedSongs: rows.length,
      indexedSetlists: setlistSheets.length,
      durationMs: durationMs,
      catalogRevision: catalogState.revision,
      catalogUpdatedAt: catalogState.updatedAt,
      message: "Song Index rebuilt successfully using the Sheets batch API."
    };

    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    // Leave dirty=true after a failed rebuild so status clearly indicates that
    // a manual repair may be required.
    props.setProperties({
      FCBOT_SONG_INDEX_DIRTY: "true",
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_AT: new Date().toISOString(),
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_TYPE: "FULL_REBUILD_FAILED",
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_DURATION_MS: String(
        Date.now() - startedAt
      ),
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_SHEETS: "0"
    });
    throw error;
  }
}

/**
 * Re-indexes one setlist. This is used for ordinary edits and Discord proof
 * submissions. Only that setlist's contiguous index block is replaced.
 */
function fcBotUpdateSongIndexForSheet(sheetOrIdentifier) {
  return fcBotWithLock(function() {
    return fcBotUpdateSongIndexForSheetUnlocked_(sheetOrIdentifier);
  });
}

function fcBotUpdateSongIndexForSheetUnlocked_(sheetOrIdentifier, options) {
  options = options || {};

  var setlistSheet = fcBotResolveSetlistSheet_(sheetOrIdentifier);
  if (!setlistSheet) {
    throw new Error("The requested setlist sheet was not found or is excluded.");
  }

  var indexSheet = fcBotGetSongIndexSheet(true);
  fcBotEnsureSheetSize(
    indexSheet,
    Math.max(2, indexSheet.getLastRow()),
    FCBOT_SONG_INDEX_HEADERS.length
  );
  var hasProvidedBlock = Object.prototype.hasOwnProperty.call(
    options,
    "existingBlock"
  );
  var block = hasProvidedBlock
    ? options.existingBlock
    : fcBotFindSongIndexBlock_(
        indexSheet,
        setlistSheet.getSheetId()
      );

  if (block && !block.contiguous) {
    // Repair a damaged index with the fast batch rebuild.
    return fcBotRebuildSongIndexUnlocked_();
  }

  var existingRecords = fcBotGetSongIndexRecordsForBlock_(indexSheet, block);
  var newRows = fcBotBuildSongIndexRowsForSheet_(setlistSheet);
  fcBotAssignStableSongIdsToRows_(newRows, existingRecords);

  var changed = fcBotSongIndexBlockNeedsReplacement_(
    indexSheet,
    block,
    newRows
  );

  if (!changed) {
    var unchangedCatalogState = fcBotGetAutocompleteCatalogRevision();
    return {
      ok: true,
      changed: false,
      fullRebuild: false,
      sheetName: setlistSheet.getName(),
      sheetId: setlistSheet.getSheetId(),
      indexedSongs: newRows.length,
      catalogRevision: unchangedCatalogState.revision,
      catalogUpdatedAt: unchangedCatalogState.updatedAt,
      message:
        'Song Index already matches "' + setlistSheet.getName() + '".'
    };
  }

  if (block) {
    fcBotReplaceExistingSongIndexBlock_(indexSheet, block, newRows);
  } else if (newRows.length) {
    // Appending new setlists is sufficient; search and autocomplete do not
    // depend on workbook tab order.
    var insertionRow = Math.max(2, indexSheet.getLastRow() + 1);
    fcBotInsertSongIndexBlock_(indexSheet, insertionRow, newRows);
  }

  SpreadsheetApp.flush();

  var catalogState =
    options.touchRevision === false
      ? fcBotGetAutocompleteCatalogRevision()
      : fcBotTouchAutocompleteCatalogRevision_(
          options.reason || "setlist-update:" + setlistSheet.getSheetId()
        );

  return {
    ok: true,
    changed: true,
    fullRebuild: false,
    sheetName: setlistSheet.getName(),
    sheetId: setlistSheet.getSheetId(),
    indexedSongs: newRows.length,
    catalogRevision: catalogState.revision,
    catalogUpdatedAt: catalogState.updatedAt,
    message: 'Song Index updated for "' + setlistSheet.getName() + '".'
  };
}

/**
 * Very fast path for one proof/player mutation.
 *
 * It updates only columns F:H of the matching Song Index row:
 *   F = FC player
 *   G = proof URL
 *   H = updated timestamp
 *
 * This avoids rebuilding the affected setlist's entire index block after every
 * Discord add/edit/remove request.
 */
function fcBotUpdateIndexedProofForRowUnlocked_(
  setlistSheet,
  songRow,
  options
) {
  options = options || {};
  songRow = Number(songRow);

  if (
    !fcBotIsSetlistSheet(setlistSheet) ||
    !Number.isInteger(songRow) ||
    songRow < 1
  ) {
    return {
      ok: false,
      updated: false,
      message: "Invalid setlist sheet or song row."
    };
  }

  var config = fcBotGetConfig();
  var songCell = null;
  var songName = fcBotNormalizeText(options.songName);
  if (!songName) {
    songCell = setlistSheet.getRange(songRow, config.songColumn);
    songName = fcBotNormalizeText(songCell.getDisplayValue());
  }

  if (!songName) {
    return fcBotUpdateSongIndexForSheetUnlocked_(setlistSheet, {
      reason:
        options.reason ||
        "single-proof-fallback-empty-song:" +
          setlistSheet.getSheetId() +
          ":" +
          songRow
    });
  }

  var indexSheet = fcBotGetSongIndexSheet(true);
  var songRef = fcBotCreateSongRef(setlistSheet, songRow);
  var providedIndexRow = Number(options.indexRow);
  var indexRow =
    Number.isInteger(providedIndexRow) && providedIndexRow >= 2
      ? providedIndexRow
      : fcBotFindSongIndexRowByReference_(indexSheet, songRef);

  if (!indexRow) {
    return fcBotUpdateSongIndexForSheetUnlocked_(setlistSheet, {
      reason:
        options.reason ||
        "single-proof-fallback-missing-index-row:" +
          setlistSheet.getSheetId() +
          ":" +
          songRow
    });
  }

  var indexedSong = fcBotNormalizeText(options.indexedSongName);
  if (!indexedSong) {
    indexedSong = fcBotNormalizeText(
      indexSheet.getRange(indexRow, 2).getDisplayValue()
    );
  }

  if (fcBotNormalizeKey(indexedSong) !== fcBotNormalizeKey(songName)) {
    return fcBotUpdateSongIndexForSheetUnlocked_(setlistSheet, {
      reason:
        options.reason ||
        "single-proof-fallback-song-mismatch:" +
          setlistSheet.getSheetId() +
          ":" +
          songRow
    });
  }

  var player = Object.prototype.hasOwnProperty.call(options, "player")
    ? fcBotNormalizeText(options.player)
    : fcBotNormalizeText(
        setlistSheet.getRange(songRow, config.fcerColumn).getDisplayValue()
      );
  var proofUrl = Object.prototype.hasOwnProperty.call(options, "proofUrl")
    ? fcBotNormalizeText(options.proofUrl)
    : fcBotGetCellLinkUrl(
        songCell || setlistSheet.getRange(songRow, config.songColumn)
      );
  var updatedAt = new Date();

  indexSheet
    .getRange(indexRow, 6, 1, 3)
    .setValues([[player, proofUrl, updatedAt]]);
  indexSheet
    .getRange(indexRow, 8)
    .setNumberFormat("yyyy-MM-dd HH:mm:ss");

  var catalogState = fcBotTouchAutocompleteCatalogRevision_(
    options.reason ||
      "single-proof-update:" +
        setlistSheet.getSheetId() +
        ":" +
        songRow
  );

  return {
    ok: true,
    updated: true,
    changed: true,
    fullRebuild: false,
    songRef: songRef,
    song: songName,
    player: player,
    proofUrl: proofUrl,
    indexRow: indexRow,
    catalogRevision: catalogState.revision,
    catalogUpdatedAt: catalogState.updatedAt
  };
}

/**
 * Compatibility wrapper used by the installable single-cell FCer edit path.
 */
function fcBotUpdateIndexedFcerForRowUnlocked_(setlistSheet, songRow) {
  var result = fcBotUpdateIndexedProofForRowUnlocked_(
    setlistSheet,
    songRow,
    {
      reason:
        "single-fcer-update:" +
        setlistSheet.getSheetId() +
        ":" +
        songRow
    }
  );

  return Boolean(result && result.ok);
}

/**
 * Installable edit trigger.
 * - A single FCer edit updates one index row.
 * - Song-name, proof-link, and multi-row edits refresh only that setlist block.
 */
function fcBotSongIndexEditTrigger(e) {
  if (!e || !e.range) return;

  var editedSheet = e.range.getSheet();
  if (!fcBotIsSetlistSheet(editedSheet)) return;

  var config = fcBotGetConfig();
  var startColumn = e.range.getColumn();
  var endColumn = startColumn + e.range.getNumColumns() - 1;

  var touchesSong =
    config.songColumn >= startColumn && config.songColumn <= endColumn;
  var touchesFcer =
    config.fcerColumn >= startColumn && config.fcerColumn <= endColumn;
  var touchesProof =
    config.proofLinkColumn >= startColumn && config.proofLinkColumn <= endColumn;

  if (!touchesSong && !touchesFcer && !touchesProof) return;

  try {
    fcBotWithLock(function() {
      var isSingleFcerCell =
        e.range.getNumRows() === 1 &&
        e.range.getNumColumns() === 1 &&
        startColumn === Number(config.fcerColumn);

      if (isSingleFcerCell) {
        var updated = fcBotUpdateIndexedFcerForRowUnlocked_(
          editedSheet,
          e.range.getRow()
        );

        if (updated) return;
      }

      fcBotUpdateSongIndexForSheetUnlocked_(editedSheet);
    });
  } catch (error) {
    console.error("Song Index edit trigger failed: " + error.message);
    fcBotWriteLog("song-index-edit", "error", {
      message: error.message
    });
  }
}

/**
 * Optimized installable change trigger.
 *
 * Google Sheets change events do not include the affected Range. Instead of
 * rebuilding all 28,000+ songs for every inserted row, this trigger compares
 * a lightweight workbook-structure snapshot and updates only the affected
 * setlist block(s).
 *
 * Normal behavior:
 * - INSERT_ROW / REMOVE_ROW: re-index only the setlist whose row count changed.
 * - INSERT_GRID: index only newly qualifying setlist tabs.
 * - REMOVE_GRID: delete only the removed setlist's index block.
 * - Rename / OTHER: reconcile setlist membership and refresh the active or
 *   renamed setlist when needed.
 * - INSERT_COLUMN / REMOVE_COLUMN: refresh only the affected setlist.
 *
 * A complete rebuild is retained only as a corruption fallback.
 */
function fcBotSongIndexChangeTrigger(e) {
  var changeType = e && e.changeType ? String(e.changeType) : "OTHER";
  var handledTypes = new Set([
    "INSERT_ROW",
    "REMOVE_ROW",
    "INSERT_COLUMN",
    "REMOVE_COLUMN",
    "INSERT_GRID",
    "REMOVE_GRID",
    "OTHER"
  ]);

  // EDIT is handled by fcBotSongIndexEditTrigger. FORMAT does not change the
  // catalog and should not perform any index work.
  if (!handledTypes.has(changeType)) return;

  var startedAt = Date.now();
  var props = PropertiesService.getScriptProperties();

  try {
    fcBotWithLock(function() {
      props.setProperty(FCBOT_SONG_INDEX_DIRTY_KEY, "true");

      var result = fcBotSynchronizeSongIndexStructureUnlocked_(e, changeType);
      var durationMs = Date.now() - startedAt;

      // A corruption fallback performs and records its own full rebuild.
      if (result && result.fullRebuild) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              changeType: changeType,
              durationMs: durationMs,
              result: result
            },
            null,
            2
          )
        );
        return;
      }

      props.setProperties({
        FCBOT_SONG_INDEX_DIRTY: "false",
        FCBOT_SONG_INDEX_LAST_MAINTENANCE_AT: new Date().toISOString(),
        FCBOT_SONG_INDEX_LAST_MAINTENANCE_TYPE: changeType,
        FCBOT_SONG_INDEX_LAST_MAINTENANCE_DURATION_MS: String(durationMs),
        FCBOT_SONG_INDEX_LAST_MAINTENANCE_SHEETS: String(
          result && result.affectedSheetIds
            ? result.affectedSheetIds.length
            : 0
        )
      });

      console.log(
        JSON.stringify(
          {
            ok: true,
            changeType: changeType,
            durationMs: durationMs,
            result: result
          },
          null,
          2
        )
      );
    });
  } catch (error) {
    // If a targeted update fails after partially changing the index, keep the
    // dirty flag set. A manual fcBotRebuildSongIndex() safely repairs it.
    props.setProperties({
      FCBOT_SONG_INDEX_DIRTY: "true",
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_AT: new Date().toISOString(),
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_TYPE: changeType + "_FAILED",
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_DURATION_MS: String(
        Date.now() - startedAt
      ),
      FCBOT_SONG_INDEX_LAST_MAINTENANCE_SHEETS: "0"
    });

    console.error("Song Index change trigger failed: " + error.message);
    fcBotWriteLog("song-index-change", "error", {
      message: changeType + ": " + error.message
    });
  }
}

/**
 * Installs automatic edit/change maintenance only. It intentionally does not
 * run the initial rebuild, so installation returns quickly and predictably.
 * Run fcBotRebuildSongIndex() once afterward.
 */
function fcBotInstallSongIndexTriggers() {
  fcBotAssertAdvancedSheetsService_();

  var spreadsheet = fcBotGetSpreadsheet();
  var handlerNames = new Set([
    FCBOT_SONG_INDEX_EDIT_HANDLER,
    FCBOT_SONG_INDEX_CHANGE_HANDLER,
    FCBOT_SONG_INDEX_LEGACY_CONTINUATION_HANDLER
  ]);
  var removed = 0;

  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlerNames.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  ScriptApp.newTrigger(FCBOT_SONG_INDEX_EDIT_HANDLER)
    .forSpreadsheet(spreadsheet)
    .onEdit()
    .create();

  ScriptApp.newTrigger(FCBOT_SONG_INDEX_CHANGE_HANDLER)
    .forSpreadsheet(spreadsheet)
    .onChange()
    .create();

  // Seed the structural snapshot immediately. This allows the first inserted
  // row or new sheet to use the optimized path even before another rebuild.
  fcBotSaveSongIndexStructureSnapshot_(
    fcBotCaptureSongIndexStructureSnapshot_(spreadsheet)
  );

  return {
    ok: true,
    removedOldTriggers: removed,
    message:
      "Optimized Song Index triggers installed. Run fcBotRebuildSongIndex() once if the existing index is missing or marked dirty."
  };
}

function fcBotRemoveSongIndexTriggers() {
  var handlerNames = new Set([
    FCBOT_SONG_INDEX_EDIT_HANDLER,
    FCBOT_SONG_INDEX_CHANGE_HANDLER,
    FCBOT_SONG_INDEX_LEGACY_CONTINUATION_HANDLER
  ]);
  var removed = 0;

  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (handlerNames.has(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  return { ok: true, removedTriggers: removed };
}

/**
 * Compatibility no-op for any stale legacy continuation trigger that fires
 * after this replacement file is installed.
 */
function fcBotContinueSongIndexRebuild() {
  return {
    ok: true,
    running: false,
    message: "Continuation rebuilds are no longer used."
  };
}

function fcBotCancelSongIndexRebuild() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (
      trigger.getHandlerFunction() ===
      FCBOT_SONG_INDEX_LEGACY_CONTINUATION_HANDLER
    ) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  return {
    ok: true,
    running: false,
    removedLegacyTriggers: removed
  };
}

function fcBotGetSongIndexRebuildStatus() {
  var props = PropertiesService.getScriptProperties();
  var indexSheet = fcBotGetSongIndexSheet(true);
  var catalogState = fcBotGetAutocompleteCatalogRevision();
  var snapshot = fcBotReadSongIndexStructureSnapshot_();

  return {
    running: false,
    dirty: props.getProperty(FCBOT_SONG_INDEX_DIRTY_KEY) === "true",
    indexedSongs: Math.max(0, indexSheet.getLastRow() - 1),
    indexedSetlists: Number(
      props.getProperty(FCBOT_SONG_INDEX_LAST_REBUILD_SETLISTS_KEY) || 0
    ),
    lastRebuildAt:
      props.getProperty(FCBOT_SONG_INDEX_LAST_REBUILD_AT_KEY) || "",
    lastDurationMs: Number(
      props.getProperty(FCBOT_SONG_INDEX_LAST_REBUILD_DURATION_KEY) || 0
    ),
    lastMaintenanceAt:
      props.getProperty(FCBOT_SONG_INDEX_LAST_MAINTENANCE_AT_KEY) || "",
    lastMaintenanceType:
      props.getProperty(FCBOT_SONG_INDEX_LAST_MAINTENANCE_TYPE_KEY) || "",
    lastMaintenanceDurationMs: Number(
      props.getProperty(FCBOT_SONG_INDEX_LAST_MAINTENANCE_DURATION_KEY) || 0
    ),
    lastMaintenanceSheets: Number(
      props.getProperty(FCBOT_SONG_INDEX_LAST_MAINTENANCE_SHEETS_KEY) || 0
    ),
    structureSnapshotAvailable: Boolean(snapshot),
    structureSnapshotCapturedAt: snapshot ? snapshot.capturedAt || "" : "",
    catalogRevision: catalogState.revision,
    catalogUpdatedAt: catalogState.updatedAt
  };
}

/**
 * Returns the lightweight revision used by the Discord bot to decide whether
 * the complete autocomplete catalog must be downloaded again.
 *
 * A revision is created lazily for existing installations, so deploying this
 * file does not require an immediate full Song Index rebuild.
 */
function fcBotGetAutocompleteCatalogRevision() {
  var props = PropertiesService.getScriptProperties();
  var rawRevision = props.getProperty(
    FCBOT_AUTOCOMPLETE_CATALOG_REVISION_KEY
  );

  if (!rawRevision) {
    var initializedAt = new Date().toISOString();
    // Preserve FCBOT_API_KEY and all other Script Properties.
    props.setProperties({
      FCBOT_AUTOCOMPLETE_CATALOG_REVISION: "1",
      FCBOT_AUTOCOMPLETE_CATALOG_UPDATED_AT: initializedAt,
      FCBOT_AUTOCOMPLETE_CATALOG_REASON: "initial-state"
    });

    return {
      revision: "1",
      updatedAt: initializedAt,
      reason: "initial-state"
    };
  }

  var revisionNumber = Number(rawRevision);
  if (!Number.isFinite(revisionNumber) || revisionNumber < 1) {
    revisionNumber = 1;
  }

  return {
    revision: String(Math.floor(revisionNumber)),
    updatedAt:
      props.getProperty(FCBOT_AUTOCOMPLETE_CATALOG_UPDATED_AT_KEY) || "",
    reason:
      props.getProperty(FCBOT_AUTOCOMPLETE_CATALOG_REASON_KEY) || ""
  };
}

/**
 * Increments the autocomplete catalog revision after a completed index
 * mutation. Callers use the shared script lock, so increments cannot be lost.
 */
function fcBotTouchAutocompleteCatalogRevision_(reason) {
  var props = PropertiesService.getScriptProperties();
  var current = Number(
    props.getProperty(FCBOT_AUTOCOMPLETE_CATALOG_REVISION_KEY) || 0
  );

  if (!Number.isFinite(current) || current < 0) {
    current = 0;
  }

  var nextRevision = Math.floor(current) + 1;
  var updatedAt = new Date().toISOString();
  var normalizedReason = fcBotNormalizeText(reason) || "catalog-update";

  // Preserve FCBOT_API_KEY and all other Script Properties.
  props.setProperties({
    FCBOT_AUTOCOMPLETE_CATALOG_REVISION: String(nextRevision),
    FCBOT_AUTOCOMPLETE_CATALOG_UPDATED_AT: updatedAt,
    FCBOT_AUTOCOMPLETE_CATALOG_REASON: normalizedReason
  });

  return {
    revision: String(nextRevision),
    updatedAt: updatedAt,
    reason: normalizedReason
  };
}

/**
 * Reconciles structural workbook changes without rebuilding the complete
 * index. The caller must hold the shared script lock.
 */
function fcBotSynchronizeSongIndexStructureUnlocked_(e, changeType) {
  fcBotAssertAdvancedSheetsService_();

  var spreadsheet =
    e && e.source && typeof e.source.getSheets === "function"
      ? e.source
      : fcBotGetSpreadsheet();

  var previousSnapshot = fcBotReadSongIndexStructureSnapshot_();
  var currentSnapshot = fcBotCaptureSongIndexStructureSnapshot_(spreadsheet);
  var currentRecordsById = fcBotSnapshotRecordsById_(currentSnapshot);
  var previousRecordsById = fcBotSnapshotRecordsById_(previousSnapshot);
  var indexedMap = fcBotGetIndexedSetlistMap_();
  var sheetObjectsById = fcBotGetSheetObjectsById_(spreadsheet);

  var currentSetlistIds = new Set();
  Object.keys(currentRecordsById).forEach(function(id) {
    if (currentRecordsById[id].isSetlist) currentSetlistIds.add(id);
  });

  var candidateIds = new Set();
  var removedIds = new Set();
  var reasons = [];

  // Reconcile the current workbook's setlist membership against the actual
  // index. This detects new/deleted tabs and sheets renamed into or out of an
  // excluded name even when no previous snapshot is available.
  Object.keys(indexedMap).forEach(function(id) {
    if (!currentSetlistIds.has(id)) {
      removedIds.add(id);
      reasons.push("remove-indexed-sheet:" + id);
    }
  });

  currentSetlistIds.forEach(function(id) {
    if (!indexedMap[id]) {
      candidateIds.add(id);
      reasons.push("add-unindexed-sheet:" + id);
    } else if (
      fcBotNormalizeText(indexedMap[id].name) !==
      fcBotNormalizeText(currentRecordsById[id].name)
    ) {
      candidateIds.add(id);
      reasons.push("rename-sheet:" + id);
    }
  });

  // Compare row/column counts and setlist classification with the previous
  // structural snapshot. Sheet tab-order changes alone do not require an
  // index rewrite because autocomplete does not depend on tab order.
  Object.keys(currentRecordsById).forEach(function(id) {
    var current = currentRecordsById[id];
    var previous = previousRecordsById[id];

    if (!previous) {
      // With no prior snapshot, membership reconciliation above finds truly
      // new setlists and the active-sheet fallback handles row/OTHER events.
      // Do not refresh every existing setlist.
      return;
    }

    if (previous.isSetlist && !current.isSetlist) {
      removedIds.add(id);
      return;
    }

    if (!current.isSetlist) return;

    var rowCountChanged = previous.maxRows !== current.maxRows;
    var columnCountChanged = previous.maxColumns !== current.maxColumns;
    var nameChanged = previous.name !== current.name;
    var becameSetlist = !previous.isSetlist && current.isSetlist;

    if (
      rowCountChanged ||
      columnCountChanged ||
      nameChanged ||
      becameSetlist
    ) {
      candidateIds.add(id);
    }
  });

  // A change event does not provide a Range. The active sheet is a useful
  // fallback for first-run snapshots and for OTHER/column events whose effect
  // cannot be inferred solely from row counts.
  var activeSheet = null;
  try {
    activeSheet = spreadsheet.getActiveSheet();
  } catch (ignored) {
    activeSheet = null;
  }

  if (activeSheet && fcBotIsSetlistSheet(activeSheet)) {
    var activeId = String(activeSheet.getSheetId());

    if (
      !previousSnapshot ||
      changeType === "INSERT_ROW" ||
      changeType === "REMOVE_ROW" ||
      changeType === "INSERT_COLUMN" ||
      changeType === "REMOVE_COLUMN" ||
      changeType === "OTHER"
    ) {
      candidateIds.add(activeId);
    }
  }

  // Validate all blocks before modifying anything. A non-contiguous block is
  // evidence of index corruption and is the one case where a full rebuild is
  // safer than targeted maintenance.
  var corrupted = false;
  removedIds.forEach(function(id) {
    if (indexedMap[id] && !indexedMap[id].contiguous) corrupted = true;
  });
  candidateIds.forEach(function(id) {
    if (indexedMap[id] && !indexedMap[id].contiguous) corrupted = true;
  });

  if (corrupted) {
    return fcBotRebuildSongIndexUnlocked_();
  }

  var affectedIds = [];
  var changed = false;

  // Delete removed setlist blocks from bottom to top so row positions remain
  // valid while physical rows are removed from the hidden index sheet.
  var removalBlocks = [];
  removedIds.forEach(function(id) {
    var block = indexedMap[id];
    if (block) {
      removalBlocks.push({ id: id, block: block });
    }
  });
  removalBlocks.sort(function(left, right) {
    return right.block.startRow - left.block.startRow;
  });

  var indexSheet = fcBotGetSongIndexSheet(true);
  removalBlocks.forEach(function(item) {
    fcBotDeleteSongIndexBlock_(indexSheet, item.block);
    changed = true;
    affectedIds.push(item.id);
  });

  // Refresh only the setlists whose structure or membership changed. The
  // updater compares A:G first, so inserting an empty row below the final song
  // produces no write and no unnecessary catalog revision.
  var fullRebuildResult = null;
  candidateIds.forEach(function(id) {
    if (fullRebuildResult || removedIds.has(id)) return;

    var sheet = sheetObjectsById[id];
    if (!sheet || !fcBotIsSetlistSheet(sheet)) return;

    var updateOptions = {
      touchRevision: false,
      reason: "structural-change:" + changeType
    };

    // In the common INSERT_ROW/REMOVE_ROW case, no blocks were deleted, so
    // reuse the map already read from Song Index instead of scanning column D
    // a second time.
    if (!removalBlocks.length) {
      updateOptions.existingBlock = indexedMap[id] || null;
    }

    var updateResult = fcBotUpdateSongIndexForSheetUnlocked_(
      sheet,
      updateOptions
    );

    if (updateResult.fullRebuild) {
      fullRebuildResult = updateResult;
      return;
    }

    if (updateResult.changed) {
      changed = true;
      affectedIds.push(id);
    }
  });

  if (fullRebuildResult) return fullRebuildResult;

  var catalogState = fcBotGetAutocompleteCatalogRevision();
  if (changed) {
    catalogState = fcBotTouchAutocompleteCatalogRevision_(
      "structural-change:" + changeType
    );
  }

  // Persist the new structure whether or not catalog rows changed. This keeps
  // later comparisons precise and prevents repeated work for the same event.
  fcBotSaveSongIndexStructureSnapshot_(currentSnapshot);

  PropertiesService.getScriptProperties().setProperty(
    FCBOT_SONG_INDEX_LAST_REBUILD_SETLISTS_KEY,
    String(currentSetlistIds.size)
  );

  return {
    ok: true,
    changed: changed,
    fullRebuild: false,
    changeType: changeType,
    affectedSheetIds: Array.from(new Set(affectedIds)),
    candidateSheetIds: Array.from(candidateIds),
    removedSheetIds: Array.from(removedIds),
    reasons: reasons,
    catalogRevision: catalogState.revision,
    catalogUpdatedAt: catalogState.updatedAt,
    message: changed
      ? "Song Index structure synchronized incrementally."
      : "No Song Index rows needed to change."
  };
}

/**
 * Returns true when the existing A:G or I values differ from freshly built
 * rows. Column H is intentionally ignored because it is an update timestamp.
 */
function fcBotSongIndexBlockNeedsReplacement_(indexSheet, block, newRows) {
  if (!block) return newRows.length > 0;
  if (block.count !== newRows.length) return true;
  if (!newRows.length) return block.count > 0;

  var existing = indexSheet
    .getRange(
      block.startRow,
      1,
      block.count,
      FCBOT_SONG_INDEX_HEADERS.length
    )
    .getValues();

  for (var rowIndex = 0; rowIndex < newRows.length; rowIndex++) {
    if (!fcBotSongIndexRowsEqualWithoutTimestamp_(existing[rowIndex], newRows[rowIndex])) {
      return true;
    }
  }

  return false;
}

function fcBotSongIndexRowsEqualWithoutTimestamp_(left, right) {
  return (
    fcBotNormalizeText(left[0]) === fcBotNormalizeText(right[0]) &&
    fcBotNormalizeText(left[1]) === fcBotNormalizeText(right[1]) &&
    fcBotNormalizeText(left[2]) === fcBotNormalizeText(right[2]) &&
    Number(left[3]) === Number(right[3]) &&
    Number(left[4]) === Number(right[4]) &&
    fcBotNormalizeText(left[5]) === fcBotNormalizeText(right[5]) &&
    fcBotNormalizeText(left[6]) === fcBotNormalizeText(right[6]) &&
    fcBotNormalizeSongId(left[8]) === fcBotNormalizeSongId(right[8])
  );
}

function fcBotGetSongIndexRecordsForBlock_(indexSheet, block) {
  if (!indexSheet || !block || block.count < 1) return [];

  return indexSheet
    .getRange(
      block.startRow,
      1,
      block.count,
      FCBOT_SONG_INDEX_HEADERS.length
    )
    .getValues()
    .map(fcBotSongIndexRowToObject_);
}

function fcBotDeleteSongIndexBlock_(indexSheet, block) {
  if (!block || block.count < 1) return;
  indexSheet.deleteRows(block.startRow, block.count);
}

/**
 * Reads a compact map of every setlist block currently present in Song Index.
 */
function fcBotGetIndexedSetlistMap_() {
  var indexSheet = fcBotGetSongIndexSheet(true);
  var lastRow = indexSheet.getLastRow();
  var map = {};

  if (lastRow < 2) return map;

  var values = indexSheet
    .getRange(2, 3, lastRow - 1, 2)
    .getValues();

  values.forEach(function(row, offset) {
    var idNumber = Number(row[1]);
    if (!Number.isFinite(idNumber)) return;

    var id = String(Math.floor(idNumber));
    var sheetRow = offset + 2;

    if (!map[id]) {
      map[id] = {
        sheetId: Number(id),
        name: fcBotNormalizeText(row[0]),
        startRow: sheetRow,
        endRow: sheetRow,
        count: 1,
        contiguous: true
      };
      return;
    }

    if (sheetRow !== map[id].endRow + 1) {
      map[id].contiguous = false;
    }

    map[id].endRow = sheetRow;
    map[id].count++;
  });

  return map;
}

function fcBotGetSheetObjectsById_(spreadsheet) {
  var output = {};
  spreadsheet.getSheets().forEach(function(sheet) {
    output[String(sheet.getSheetId())] = sheet;
  });
  return output;
}

/**
 * Captures sheet IDs, names, tab positions, row counts, column counts, and
 * current setlist classification through one Advanced Sheets API request.
 */
function fcBotCaptureSongIndexStructureSnapshot_(spreadsheet) {
  fcBotAssertAdvancedSheetsService_();

  spreadsheet = spreadsheet || fcBotGetSpreadsheet();
  var config = fcBotGetConfig();
  var excludedNames = fcBotGetExcludedSheetNameSet();
  var response = Sheets.Spreadsheets.get(spreadsheet.getId(), {
    fields:
      "sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))"
  });

  var records = (response.sheets || []).map(function(sheetResource) {
    var properties = sheetResource.properties || {};
    var grid = properties.gridProperties || {};
    var oneBasedIndex = Number(properties.index || 0) + 1;
    var name = String(properties.title || "");
    var isSetlist =
      oneBasedIndex >= Number(config.firstSetlistSheetPosition) &&
      !excludedNames.has(name);

    return [
      Number(properties.sheetId),
      name,
      oneBasedIndex,
      Number(grid.rowCount || 0),
      Number(grid.columnCount || 0),
      isSetlist ? 1 : 0
    ];
  });

  records.sort(function(left, right) {
    return left[2] - right[2];
  });

  return {
    version: FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
    sheets: records
  };
}

function fcBotSnapshotRecordsById_(snapshot) {
  var output = {};
  if (!snapshot || !Array.isArray(snapshot.sheets)) return output;

  snapshot.sheets.forEach(function(record) {
    if (!Array.isArray(record) || record.length < 6) return;

    var idNumber = Number(record[0]);
    if (!Number.isFinite(idNumber)) return;

    var id = String(Math.floor(idNumber));
    output[id] = {
      sheetId: Number(id),
      name: String(record[1] || ""),
      index: Number(record[2] || 0),
      maxRows: Number(record[3] || 0),
      maxColumns: Number(record[4] || 0),
      isSetlist: Number(record[5]) === 1
    };
  });

  return output;
}

/** Stores the compressed structural snapshot in 7,000-character chunks. */
function fcBotSaveSongIndexStructureSnapshot_(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.sheets)) {
    throw new Error("Cannot save an invalid Song Index structure snapshot.");
  }

  var json = JSON.stringify(snapshot);
  var compressed = Utilities.gzip(
    Utilities.newBlob(json, "application/json", "song-index-structure.json")
  );
  var encoded = Utilities.base64EncodeWebSafe(compressed.getBytes());
  var chunks = [];

  for (
    var offset = 0;
    offset < encoded.length;
    offset += FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_SIZE
  ) {
    chunks.push(
      encoded.substring(
        offset,
        offset + FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_SIZE
      )
    );
  }

  var props = PropertiesService.getScriptProperties();
  var oldChunkCount = Number(
    props.getProperty(
      FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_COUNT_KEY
    ) || 0
  );

  chunks.forEach(function(chunk, index) {
    props.setProperty(
      FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_PREFIX + index,
      chunk
    );
  });

  for (var index = chunks.length; index < oldChunkCount; index++) {
    props.deleteProperty(
      FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_PREFIX + index
    );
  }

  var metadata = {};
  metadata[FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION_KEY] = String(
    FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION
  );
  metadata[FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_COUNT_KEY] = String(
    chunks.length
  );
  props.setProperties(metadata);

  return {
    ok: true,
    sheetCount: snapshot.sheets.length,
    chunkCount: chunks.length,
    capturedAt: snapshot.capturedAt || ""
  };
}

function fcBotReadSongIndexStructureSnapshot_() {
  var props = PropertiesService.getScriptProperties();
  var version = Number(
    props.getProperty(FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION_KEY) || 0
  );
  var chunkCount = Number(
    props.getProperty(
      FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_COUNT_KEY
    ) || 0
  );

  if (
    version !== FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION ||
    !Number.isInteger(chunkCount) ||
    chunkCount < 1
  ) {
    return null;
  }

  var encoded = "";
  for (var index = 0; index < chunkCount; index++) {
    var chunk = props.getProperty(
      FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_CHUNK_PREFIX + index
    );
    if (!chunk) return null;
    encoded += chunk;
  }

  try {
    var compressedBytes = Utilities.base64DecodeWebSafe(encoded);
    var json = Utilities.ungzip(
      Utilities.newBlob(compressedBytes)
    ).getDataAsString("UTF-8");
    var snapshot = JSON.parse(json);

    if (
      !snapshot ||
      Number(snapshot.version) !==
        FCBOT_SONG_INDEX_STRUCTURE_SNAPSHOT_VERSION ||
      !Array.isArray(snapshot.sheets)
    ) {
      return null;
    }

    return snapshot;
  } catch (error) {
    console.error(
      "Could not read Song Index structure snapshot: " + error.message
    );
    return null;
  }
}

/** Manual diagnostic/repair helper. It does not rebuild the Song Index. */
function fcBotRefreshSongIndexStructureSnapshot() {
  var snapshot = fcBotCaptureSongIndexStructureSnapshot_(
    fcBotGetSpreadsheet()
  );
  var result = fcBotSaveSongIndexStructureSnapshot_(snapshot);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** Returns all indexed songs as plain objects. */
function fcBotGetSongIndexSnapshot() {
  var indexSheet = fcBotGetSongIndexSheet(true);
  fcBotEnsureSheetSize(
    indexSheet,
    Math.max(2, indexSheet.getLastRow()),
    FCBOT_SONG_INDEX_HEADERS.length
  );
  var lastRow = indexSheet.getLastRow();
  if (lastRow < 2) return [];

  return indexSheet
    .getRange(2, 1, lastRow - 1, FCBOT_SONG_INDEX_HEADERS.length)
    .getValues()
    .filter(function(row) {
      return fcBotNormalizeText(row[0]);
    })
    .map(fcBotSongIndexRowToObject_);
}

/**
 * Finds the Song Index row for a compact song reference.
 *
 * Stable references are found through Song Index column I. Legacy references
 * continue to use Sheet ID + Row (D:E) during rollout.
 */
function fcBotFindSongIndexRowByReference_(indexSheet, songRef) {
  var normalizedRef = fcBotNormalizeText(songRef);
  var parsed = fcBotParseSongRef(normalizedRef);

  if (!parsed || !indexSheet) return null;

  var lastRow = indexSheet.getLastRow();
  if (lastRow < 2) return null;

  if (parsed.stable) {
    var idMatch = indexSheet
      .getRange(2, 9, lastRow - 1, 1)
      .createTextFinder(parsed.songId)
      .matchEntireCell(true)
      .findNext();
    return idMatch ? idMatch.getRow() : null;
  }

  var sheetIdMatches = indexSheet
    .getRange(2, 4, lastRow - 1, 1)
    .createTextFinder(String(parsed.sheetId))
    .matchEntireCell(true)
    .findAll();

  if (!sheetIdMatches || !sheetIdMatches.length) return null;

  var firstCandidateRow = sheetIdMatches[0].getRow();
  var lastCandidateRow =
    sheetIdMatches[sheetIdMatches.length - 1].getRow();
  var candidateValues = indexSheet
    .getRange(
      firstCandidateRow,
      4,
      lastCandidateRow - firstCandidateRow + 1,
      2
    )
    .getValues();

  for (var offset = 0; offset < candidateValues.length; offset++) {
    var storedSheetId = Number(candidateValues[offset][0]);
    var storedSongRow = Number(candidateValues[offset][1]);

    if (
      storedSheetId === Number(parsed.sheetId) &&
      storedSongRow === Number(parsed.row)
    ) {
      return firstCandidateRow + offset;
    }
  }

  return null;
}

/** Returns one indexed song by compact song reference. */
function fcBotGetIndexedSongByRef(songRef) {
  var normalizedRef = fcBotNormalizeText(songRef);
  var parsed = fcBotParseSongRef(normalizedRef);
  var indexSheet = fcBotGetSongIndexSheet(true);
  fcBotEnsureSheetSize(
    indexSheet,
    Math.max(2, indexSheet.getLastRow()),
    FCBOT_SONG_INDEX_HEADERS.length
  );
  var indexRow =
    fcBotFindSongIndexRowByReference_(indexSheet, normalizedRef);

  if (!indexRow) return null;

  var row = indexSheet
    .getRange(indexRow, 1, 1, FCBOT_SONG_INDEX_HEADERS.length)
    .getValues()[0];

  // Prefer the stable ID stored in the hidden index even when the caller used
  // a legacy row reference.
  var storedSongId = fcBotNormalizeSongId(row[8]);
  row[0] = storedSongId
    ? fcBotCreateStableSongRef(storedSongId)
    : (parsed && !parsed.stable ? normalizedRef : fcBotNormalizeText(row[0]));

  var result = fcBotSongIndexRowToObject_(row);
  Object.defineProperty(result, "_indexRow", {
    value: indexRow,
    enumerable: false
  });
  return result;
}

/**
 * Repairs existing column-A references and forces reference/ID columns to
 * plain text.
 *
 * Run this once after installing this file. A full Song Index rebuild is not
 * required. Future complete and incremental writes preserve plain-text
 * formatting automatically.
 */
function fcBotRepairSongIndexReferenceColumn() {
  return fcBotWithLock(function() {
    var indexSheet = fcBotGetSongIndexSheet(true);
    var lastRow = indexSheet.getLastRow();

    if (lastRow < 2) {
      return {
        ok: true,
        repairedRows: 0,
        message: "Song Index has no data rows to repair."
      };
    }

    var rowCount = lastRow - 1;
    var sourceValues = indexSheet
      .getRange(2, 4, rowCount, 6)
      .getValues();
    var references = sourceValues.map(function(row) {
      var sheetId = Math.floor(Number(row[0]));
      var songRow = Math.floor(Number(row[1]));
      var songId = fcBotNormalizeSongId(row[5]);

      if (songId) {
        return [fcBotCreateStableSongRef(songId)];
      }

      if (
        !Number.isFinite(sheetId) ||
        sheetId < 0 ||
        !Number.isFinite(songRow) ||
        songRow < 1
      ) {
        return [""];
      }

      return [String(sheetId) + ":" + String(songRow)];
    });

    var targetRange = indexSheet.getRange(2, 1, rowCount, 1);
    targetRange.setNumberFormat("@");
    targetRange.setValues(references);
    indexSheet.getRange(2, 9, rowCount, 1).setNumberFormat("@");
    SpreadsheetApp.flush();

    return {
      ok: true,
      repairedRows: rowCount,
      message:
        "Song Index references were rebuilt from stable IDs where available " +
        "and formatted as plain text."
    };
  });
}

/** Searches indexed songs for Discord autocomplete. */
function fcBotSearchSongIndex(searchText, limit, onlyUnfcd) {
  var config = fcBotGetConfig();
  var query = fcBotNormalizeKey(searchText);
  var resultLimit = Math.min(
    Math.max(1, Number(limit) || Number(config.autocompleteResultLimit) || 25),
    100
  );

  var records = fcBotGetSongIndexSnapshot();
  var matches = [];

  for (var index = 0; index < records.length; index++) {
    var record = records[index];
    if (onlyUnfcd && record.fcPlayer) continue;

    var songKey = fcBotNormalizeKey(record.song);
    var setlistKey = fcBotNormalizeKey(record.setlist);

    if (
      query &&
      songKey.indexOf(query) === -1 &&
      setlistKey.indexOf(query) === -1
    ) {
      continue;
    }

    matches.push(record);
    if (matches.length >= resultLimit) break;
  }

  return matches;
}

/**
 * Uses values.batchGet to read A:B from many setlists in a few requests.
 */
function fcBotBuildCompleteSongIndexRowsWithBatchApi_(spreadsheet, setlistSheets) {
  var spreadsheetId = spreadsheet.getId();
  var output = [];
  var timestamp = new Date();

  for (
    var start = 0;
    start < setlistSheets.length;
    start += FCBOT_SONG_INDEX_RANGE_BATCH_SIZE
  ) {
    var sheetChunk = setlistSheets.slice(
      start,
      start + FCBOT_SONG_INDEX_RANGE_BATCH_SIZE
    );
    var ranges = sheetChunk.map(function(sheet) {
      return fcBotQuoteSheetNameForA1_(sheet.getName()) + "!A:B";
    });

    var response = Sheets.Spreadsheets.Values.batchGet(spreadsheetId, {
      ranges: ranges,
      majorDimension: "ROWS",
      valueRenderOption: "FORMATTED_VALUE"
    });

    var valueRanges = response.valueRanges || [];

    for (var chunkIndex = 0; chunkIndex < sheetChunk.length; chunkIndex++) {
      var sheet = sheetChunk[chunkIndex];
      var values =
        valueRanges[chunkIndex] && valueRanges[chunkIndex].values
          ? valueRanges[chunkIndex].values
          : [];

      for (var rowOffset = 0; rowOffset < values.length; rowOffset++) {
        var songName = fcBotNormalizeText(values[rowOffset][0]);
        if (!songName) continue;

        var rowNumber = rowOffset + 1;
        output.push([
          fcBotCreateSongRef(sheet, rowNumber),
          songName,
          sheet.getName(),
          sheet.getSheetId(),
          rowNumber,
          fcBotNormalizeText(values[rowOffset][1]),
          "",
          timestamp,
          ""
        ]);
      }
    }
  }

  return output;
}

/**
 * Builds one setlist block with live rich-text proof URLs. This is used only
 * for incremental updates, so the richer read remains small and predictable.
 */
function fcBotBuildSongIndexRowsForSheet_(sheet) {
  if (!fcBotIsSetlistSheet(sheet)) return [];

  var config = fcBotGetConfig();
  var lastSongRow = fcBotGetLastNonEmptyRow(sheet, config.songColumn, 1);
  if (lastSongRow < 1) return [];

  var songRange = sheet.getRange(1, config.songColumn, lastSongRow, 1);
  var songValues = songRange.getDisplayValues();
  var fcerValues = sheet
    .getRange(1, config.fcerColumn, lastSongRow, 1)
    .getDisplayValues();

  var proofRange = sheet.getRange(1, config.proofLinkColumn, lastSongRow, 1);
  var proofDisplayValues = proofRange.getDisplayValues();
  var proofRichTextValues = proofRange.getRichTextValues();
  var proofFormulas = proofRange.getFormulas();

  var timestamp = new Date();
  var output = [];

  for (var offset = 0; offset < lastSongRow; offset++) {
    var songName = fcBotNormalizeText(songValues[offset][0]);
    if (!songName) continue;

    var rowNumber = offset + 1;
    output.push([
      fcBotCreateSongRef(sheet, rowNumber),
      songName,
      sheet.getName(),
      sheet.getSheetId(),
      rowNumber,
      fcBotNormalizeText(fcerValues[offset][0]),
      fcBotExtractProofUrlFromBatchValues_(
        proofRichTextValues[offset][0],
        proofFormulas[offset][0],
        proofDisplayValues[offset][0]
      ),
      timestamp,
      ""
    ]);
  }

  return output;
}

function fcBotStableSongIdentityKey_(sheetId, songName) {
  var normalizedSheetId = Math.floor(Number(sheetId));
  var normalizedSong = fcBotNormalizeKey(songName);

  if (
    !Number.isFinite(normalizedSheetId) ||
    normalizedSheetId < 0 ||
    !normalizedSong
  ) {
    return "";
  }

  return String(normalizedSheetId) + "\n" + normalizedSong;
}

/**
 * Assigns stable IDs without touching setlist tabs.
 *
 * A prior ID is reused only when the normalized song name occurs exactly once
 * in both the old and new block for the same sheet. This safely follows unique
 * songs across row insertions/deletions. Ambiguous duplicate names receive new
 * IDs so a stale reference can never silently jump between duplicate rows.
 */
function fcBotAssignStableSongIdsToRows_(rows, existingRecords) {
  rows = Array.isArray(rows) ? rows : [];
  existingRecords = Array.isArray(existingRecords) ? existingRecords : [];

  var existingByKey = Object.create(null);
  var newCounts = Object.create(null);
  var knownIds = Object.create(null);
  var assignedIds = Object.create(null);

  existingRecords.forEach(function(record) {
    var songId = fcBotNormalizeSongId(record && record.songId);
    var key = fcBotStableSongIdentityKey_(
      record && record.sheetId,
      record && record.song
    );

    if (songId) knownIds[songId] = true;
    if (!songId || !key) return;
    if (!existingByKey[key]) existingByKey[key] = [];
    existingByKey[key].push(songId);
  });

  rows.forEach(function(row) {
    var key = fcBotStableSongIdentityKey_(row[3], row[1]);
    if (key) newCounts[key] = (newCounts[key] || 0) + 1;
  });

  rows.forEach(function(row) {
    var key = fcBotStableSongIdentityKey_(row[3], row[1]);
    var candidates = key && existingByKey[key] ? existingByKey[key] : [];
    var songId =
      key &&
      newCounts[key] === 1 &&
      candidates.length === 1 &&
      !assignedIds[candidates[0]]
        ? candidates[0]
        : "";

    if (!songId) {
      do {
        songId = fcBotNormalizeSongId(Utilities.getUuid());
      } while (!songId || knownIds[songId] || assignedIds[songId]);
    }

    knownIds[songId] = true;
    assignedIds[songId] = true;
    row[0] = fcBotCreateStableSongRef(songId);
    row[8] = songId;
  });

  return rows;
}

function fcBotWriteCompleteSongIndexInBatches_(indexSheet, rows) {
  var columnCount = FCBOT_SONG_INDEX_HEADERS.length;
  var previousDataRows = Math.max(0, indexSheet.getLastRow() - 1);
  var rowsToClear = Math.max(previousDataRows, rows.length);

  fcBotEnsureSheetSize(
    indexSheet,
    Math.max(2, rows.length + 1),
    columnCount
  );

  indexSheet
    .getRange(1, 1, 1, columnCount)
    .setValues([FCBOT_SONG_INDEX_HEADERS])
    .setFontWeight("bold");
  indexSheet.setFrozenRows(1);

  if (rowsToClear > 0) {
    indexSheet.getRange(2, 1, rowsToClear, columnCount).clearContent();
  }

  for (
    var start = 0;
    start < rows.length;
    start += FCBOT_SONG_INDEX_WRITE_BATCH_SIZE
  ) {
    var chunk = rows.slice(start, start + FCBOT_SONG_INDEX_WRITE_BATCH_SIZE);
    indexSheet
      .getRange(start + 2, 1, chunk.length, 1)
      .setNumberFormat("@");
    indexSheet
      .getRange(start + 2, 1, chunk.length, columnCount)
      .setValues(chunk);
    indexSheet
      .getRange(start + 2, 8, chunk.length, 1)
      .setNumberFormat("yyyy-MM-dd HH:mm:ss");
    indexSheet
      .getRange(start + 2, 9, chunk.length, 1)
      .setNumberFormat("@");
  }

  if (!indexSheet.isSheetHidden()) indexSheet.hideSheet();
}

function fcBotFindSongIndexBlock_(indexSheet, sheetId) {
  var lastRow = indexSheet.getLastRow();
  if (lastRow < 2) return null;

  var sheetIds = indexSheet
    .getRange(2, 4, lastRow - 1, 1)
    .getValues()
    .map(function(row) {
      return Number(row[0]);
    });

  var positions = [];
  sheetIds.forEach(function(value, index) {
    if (value === Number(sheetId)) positions.push(index + 2);
  });

  if (!positions.length) return null;

  var contiguous = true;
  for (var index = 1; index < positions.length; index++) {
    if (positions[index] !== positions[index - 1] + 1) {
      contiguous = false;
      break;
    }
  }

  return {
    startRow: positions[0],
    endRow: positions[positions.length - 1],
    count: positions.length,
    contiguous: contiguous
  };
}

function fcBotReplaceExistingSongIndexBlock_(indexSheet, block, newRows) {
  var oldCount = block.count;
  var newCount = newRows.length;
  var difference = newCount - oldCount;

  if (difference > 0) {
    indexSheet.insertRowsAfter(block.endRow, difference);
  }

  if (newCount > 0) {
    indexSheet
      .getRange(block.startRow, 1, newCount, 1)
      .setNumberFormat("@");
    indexSheet
      .getRange(block.startRow, 1, newCount, FCBOT_SONG_INDEX_HEADERS.length)
      .setValues(newRows);
    indexSheet
      .getRange(block.startRow, 8, newCount, 1)
      .setNumberFormat("yyyy-MM-dd HH:mm:ss");
    indexSheet
      .getRange(block.startRow, 9, newCount, 1)
      .setNumberFormat("@");
  }

  if (difference < 0) {
    indexSheet.deleteRows(block.startRow + newCount, Math.abs(difference));
  }
}

function fcBotInsertSongIndexBlock_(indexSheet, insertionRow, newRows) {
  if (!newRows.length) return;

  fcBotEnsureSheetSize(
    indexSheet,
    insertionRow + newRows.length - 1,
    FCBOT_SONG_INDEX_HEADERS.length
  );

  indexSheet
    .getRange(insertionRow, 1, newRows.length, 1)
    .setNumberFormat("@");
  indexSheet
    .getRange(insertionRow, 1, newRows.length, FCBOT_SONG_INDEX_HEADERS.length)
    .setValues(newRows);
  indexSheet
    .getRange(insertionRow, 8, newRows.length, 1)
    .setNumberFormat("yyyy-MM-dd HH:mm:ss");
  indexSheet
    .getRange(insertionRow, 9, newRows.length, 1)
    .setNumberFormat("@");
}

function fcBotResolveSetlistSheet_(sheetOrIdentifier) {
  var sheet = null;

  if (
    sheetOrIdentifier &&
    typeof sheetOrIdentifier.getSheetId === "function" &&
    typeof sheetOrIdentifier.getName === "function"
  ) {
    sheet = sheetOrIdentifier;
  } else if (typeof sheetOrIdentifier === "number") {
    sheet = fcBotGetSheetById(sheetOrIdentifier);
  } else {
    var identifier = fcBotNormalizeText(sheetOrIdentifier);
    if (/^\d+$/.test(identifier)) {
      sheet = fcBotGetSheetById(Number(identifier));
    }
    if (!sheet && identifier) {
      sheet = fcBotGetSpreadsheet().getSheetByName(identifier);
    }
  }

  return sheet && fcBotIsSetlistSheet(sheet) ? sheet : null;
}

function fcBotExtractProofUrlFromBatchValues_(richText, formula, displayValue) {
  if (richText) {
    var directUrl = richText.getLinkUrl();
    if (directUrl) return directUrl;

    var runs = richText.getRuns() || [];
    for (var index = 0; index < runs.length; index++) {
      var runUrl = runs[index].getLinkUrl();
      if (runUrl) return runUrl;
    }
  }

  if (formula) {
    var formulaMatch = /^=HYPERLINK\(\s*["']([^"']+)["']/i.exec(formula);
    if (formulaMatch) return formulaMatch[1];
  }

  var normalizedDisplay = fcBotNormalizeText(displayValue);
  return fcBotIsValidHttpUrl(normalizedDisplay) ? normalizedDisplay : "";
}

function fcBotSongIndexRowToObject_(row) {
  var songId = fcBotNormalizeSongId(row[8]);
  var sheetId = Number(row[3]);
  var songRow = Number(row[4]);
  var songRef = songId
    ? fcBotCreateStableSongRef(songId)
    : (
        Number.isFinite(sheetId) &&
        Number.isFinite(songRow) &&
        songRow >= 1
          ? String(Math.floor(sheetId)) + ":" + String(Math.floor(songRow))
          : fcBotNormalizeText(row[0])
      );

  return {
    songRef: songRef,
    songId: songId,
    song: fcBotNormalizeText(row[1]),
    setlist: fcBotNormalizeText(row[2]),
    sheetId: sheetId,
    row: songRow,
    fcPlayer: fcBotNormalizeText(row[5]),
    proofUrl: fcBotNormalizeText(row[6]),
    updatedAt: row[7] || ""
  };
}

function fcBotQuoteSheetNameForA1_(sheetName) {
  return "'" + String(sheetName).replace(/'/g, "''") + "'";
}

function fcBotAssertAdvancedSheetsService_() {
  if (
    typeof Sheets === "undefined" ||
    !Sheets.Spreadsheets ||
    !Sheets.Spreadsheets.Values
  ) {
    throw new Error(
      "The Advanced Google Sheets service is not enabled. In the Apps Script editor, open Services (+), add Google Sheets API, then run this function again."
    );
  }
}
