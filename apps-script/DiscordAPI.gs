/**
 * DiscordAPI.gs
 * Google Apps Script web-app API used by the Discord bot.
 *
 * Required project files:
 *   - Helpers.gs
 *   - Config.gs
 *   - SongIndex.gs (use the batch API edition)
 *   - PlayerIndex.gs
 *
 * Supported actions:
 *
 * GET or POST:
 *   ping
 *   health
 *   songs          { q, limit, onlyUnfcd }
 *   players        { q, limit }
 *   song           { songRef }
 *   catalog        { offset, limit, includePlayers }
 *   catalogStatus  {}
 *
 * POST only:
 *   addProof       { songRef, player, proofUrl, expectedSong,
 *                    expectedSetlist, expectedSongId?, discordUser }
 *   editProof      { songRef, player?, proofUrl?, expectedSong,
 *                    expectedSetlist, expectedSongId?, discordUser }
 *   removeProof    { songRef, expectedSong, expectedSetlist,
 *                    expectedSongId?, discordUser }
 *   refreshIndexes { discordUser }
 *
 * Authentication:
 *   Every action except `ping` requires `apiKey` in the JSON body or query
 *   parameters. The key is stored in Apps Script Properties and is generated
 *   with fcBotGenerateAndStoreApiKey().
 */

var FCBOT_API_VERSION = "1.4.0";

/** Apps Script web-app GET entry point. */
function doGet(e) {
  return fcBotHandleApiRequest_(e, "GET");
}

/** Apps Script web-app POST entry point. */
function doPost(e) {
  return fcBotHandleApiRequest_(e, "POST");
}

/** Routes one web-app request and converts all thrown errors to JSON. */
function fcBotHandleApiRequest_(e, method) {
  var requestData = {};
  var action = "";
  fcBotBeginRequestScope_();

  try {
    requestData = fcBotParseWebRequest(e);
    action = fcBotNormalizeKey(requestData.action || requestData.route);

    if (!action) {
      return fcBotFailure(
        "MISSING_ACTION",
        "The request must include an action."
      );
    }

    if (action === "ping") {
      return fcBotSuccess("FCBot API is online.", {
        version: FCBOT_API_VERSION,
        timestamp: new Date().toISOString()
      });
    }

    fcBotRequireValidApiKey(requestData);

    switch (action) {
      case "health":
        return fcBotSuccess("Backend status loaded.", fcBotApiHealth_());

      case "songs":
        return fcBotSuccess(
          "Song autocomplete results loaded.",
          fcBotApiSongs_(requestData)
        );

      case "players":
        return fcBotSuccess(
          "Player autocomplete results loaded.",
          fcBotApiPlayers_(requestData)
        );

      case "catalog":
      case "autocompletecatalog":
        return fcBotSuccess(
          "Autocomplete catalog page loaded.",
          fcBotApiAutocompleteCatalog_(requestData)
        );

      case "catalogstatus":
      case "catalogrevision":
        return fcBotSuccess(
          "Autocomplete catalog status loaded.",
          fcBotApiCatalogStatus_()
        );

      case "song":
      case "songinfo":
        return fcBotSuccess(
          "Song information loaded.",
          fcBotApiSongInfo_(requestData)
        );

      case "addproof":
        fcBotRequirePostMethod_(method, action);
        return fcBotSuccess(
          "Proof added successfully.",
          fcBotApiAddProof_(requestData)
        );

      case "editproof":
        fcBotRequirePostMethod_(method, action);
        return fcBotSuccess(
          "Proof updated successfully.",
          fcBotApiEditProof_(requestData)
        );

      case "removeproof":
        fcBotRequirePostMethod_(method, action);
        return fcBotSuccess(
          "Proof removed successfully.",
          fcBotApiRemoveProof_(requestData)
        );

      case "refreshindexes":
      case "refresh":
        fcBotRequirePostMethod_(method, action);
        return fcBotSuccess(
          "Indexes refreshed successfully.",
          fcBotApiRefreshIndexes_(requestData)
        );

      default:
        return fcBotFailure(
          "UNKNOWN_ACTION",
          'Unknown API action: "' + action + '".'
        );
    }
  } catch (error) {
    var description = fcBotDescribeError(error);

    fcBotWriteLog(action || "api-request", "error", {
      discordUser: requestData.discordUser,
      songRef: requestData.songRef,
      message: description.code + ": " + description.message
    });

    return fcBotFailure(
      description.code,
      description.message,
      error && error.details ? error.details : null
    );
  } finally {
    fcBotEndRequestScope_();
  }
}

function fcBotRequirePostMethod_(method, action) {
  if (method !== "POST") {
    var error = new Error('The "' + action + '" action requires POST.');
    error.code = "METHOD_NOT_ALLOWED";
    throw error;
  }
}

/** Returns a small diagnostic report for the future Discord bot. */
function fcBotApiHealth_() {
  var backendStatus = fcBotGetBackendStatus();
  var rebuildStatus = null;

  if (typeof fcBotGetSongIndexRebuildStatus === "function") {
    rebuildStatus = fcBotGetSongIndexRebuildStatus();
  }

  return {
    version: FCBOT_API_VERSION,
    backend: backendStatus,
    songIndexRebuild: rebuildStatus,
    contributorSafety:
      typeof fcBotGetContributorSafetyStatus === "function"
        ? fcBotGetContributorSafetyStatus()
        : { initialized: false, healthy: false, error: "ContributorSafety.gs is missing." },
    autocompleteCatalog: fcBotApiCatalogStatus_(),
    timestamp: new Date().toISOString()
  };
}

/** Returns Discord-ready song autocomplete choices. */
function fcBotApiSongs_(requestData) {
  var config = fcBotGetConfig();
  var query = fcBotNormalizeText(requestData.q || requestData.query);
  var limit = fcBotClampAutocompleteLimit_(requestData.limit);
  var onlyUnfcd = fcBotToBoolean_(requestData.onlyUnfcd, true);
  var records = fcBotSearchSongIndex(query, limit, onlyUnfcd);

  var choices = records.map(function(record) {
    var label = record.song + " — " + record.setlist;
    return {
      name: fcBotTruncate_(label, 100),
      value: record.songRef
    };
  });

  return {
    query: query,
    onlyUnfcd: onlyUnfcd,
    count: choices.length,
    choices: choices,
    songs: records
  };
}

/** Returns Discord-ready player autocomplete choices. */
function fcBotApiPlayers_(requestData) {
  var query = fcBotNormalizeText(requestData.q || requestData.query);
  var limit = fcBotClampAutocompleteLimit_(requestData.limit);
  var players = fcBotSearchPlayerIndex(query, limit);

  var choices = players.map(function(player) {
    var suffix = player.fcCount === 1 ? "1 FC" : player.fcCount + " FCs";
    return {
      name: fcBotTruncate_(player.player + " — " + suffix, 100),
      value: fcBotTruncate_(player.player, 100)
    };
  });

  return {
    query: query,
    count: choices.length,
    choices: choices,
    players: players
  };
}


/**
 * Returns a compact page of the song/player indexes for local Discord
 * autocomplete. The Node bot downloads these pages with its normal request
 * timeout, then answers Discord autocomplete interactions from memory.
 *
 * Compact song row format:
 *   [songRef, song, setlist, fcPlayer]
 *
 * Compact player row format:
 *   [player, fcCount]
 */
function fcBotApiCatalogStatus_() {
  var busyStatus = fcBotBuildBusyApiCatalogStatus_();
  if (busyStatus) return busyStatus;

  return fcBotBuildApiCatalogStatusFromPlayers_(
    fcBotGetPlayerIndexSnapshot()
  );
}

/**
 * Returns a minimal valid status immediately when another execution owns the
 * mutation lock. The Node bot checks busy before inspecting counts/tokens, so
 * there is no reason to read either index while a write is in progress.
 */
function fcBotBuildBusyApiCatalogStatus_() {
  var lock = LockService.getScriptLock();
  if (lock.hasLock()) return null;

  var acquired = lock.tryLock(1);
  if (acquired) {
    lock.releaseLock();
    return null;
  }

  var revisionState =
    typeof fcBotGetAutocompleteCatalogRevision === "function"
      ? fcBotGetAutocompleteCatalogRevision()
      : { revision: "0", updatedAt: "", reason: "unsupported" };
  var revision = String(revisionState.revision || "0");
  var props = PropertiesService.getScriptProperties();

  return {
    revision: revision,
    playerRevision: "busy",
    catalogToken: revision + ".busy",
    updatedAt: revisionState.updatedAt || "",
    reason: revisionState.reason || "",
    totalSongs: 0,
    totalPlayers: 0,
    dirty: props.getProperty(FCBOT_SONG_INDEX_DIRTY_KEY) === "true",
    busy: true,
    generatedAt: new Date().toISOString()
  };
}

/** Builds catalog status from an already-loaded Player Index snapshot. */
function fcBotBuildApiCatalogStatusFromPlayers_(playerSnapshot) {
  var revisionState =
    typeof fcBotGetAutocompleteCatalogRevision === "function"
      ? fcBotGetAutocompleteCatalogRevision()
      : { revision: "0", updatedAt: "", reason: "unsupported" };

  var songIndexSheet = fcBotGetSongIndexSheet(true);
  playerSnapshot = Array.isArray(playerSnapshot) ? playerSnapshot : [];
  var playerRevision =
    fcBotComputeAutocompletePlayerRevision_(playerSnapshot);
  var revision = String(revisionState.revision || "0");
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  var busy = false;

  if (!lock.hasLock()) {
    var acquired = lock.tryLock(1);
    busy = !acquired;
    if (acquired) lock.releaseLock();
  }

  return {
    revision: revision,
    playerRevision: playerRevision,
    catalogToken: revision + "." + playerRevision,
    updatedAt: revisionState.updatedAt || "",
    reason: revisionState.reason || "",
    totalSongs: Math.max(0, songIndexSheet.getLastRow() - 1),
    totalPlayers: playerSnapshot.length,
    dirty:
      props.getProperty(FCBOT_SONG_INDEX_DIRTY_KEY) === "true",
    busy: busy,
    generatedAt: new Date().toISOString()
  };
}

/**
 * Produces a lightweight fingerprint of the complete Player Index. This lets
 * the bot detect contributor-count changes even when another existing script
 * rebuilds Player Index without touching the Song Index revision.
 */
function fcBotComputeAutocompletePlayerRevision_(players) {
  var serialized = players.map(function(player) {
    return (
      fcBotNormalizeKey(player.player) +
      "\u001f" +
      String(Number(player.fcCount) || 0)
    );
  }).join("\u001e");

  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    serialized,
    Utilities.Charset.UTF_8
  );

  return Utilities
    .base64EncodeWebSafe(digest)
    .replace(/=+$/g, "");
}

function fcBotApiAutocompleteCatalog_(requestData) {
  // Catalog pages are read-only and are validated optimistically with a token
  // before and after the bulk read. Holding the mutation lock here caused
  // autocomplete downloads to reject otherwise valid /addproof commands.
  var initialState = fcBotApiCatalogStatus_();
  fcBotRequireReadableCatalogState_(initialState);

  var indexSheet = fcBotGetSongIndexSheet(true);
  var totalSongs = Math.max(0, indexSheet.getLastRow() - 1);

  var offset = Math.floor(Number(requestData.offset) || 0);
  if (offset < 0) offset = 0;
  if (offset > totalSongs) offset = totalSongs;

  var pageSize = Math.floor(Number(requestData.limit) || 5000);
  pageSize = Math.min(5000, Math.max(100, pageSize));

  var rowCount = Math.min(pageSize, totalSongs - offset);
  var songRows = [];

  if (rowCount > 0) {
    songRows = indexSheet
      .getRange(offset + 2, 1, rowCount, 9)
      .getValues()
      .map(function(row) {
        // Prefer the stable ID in the hidden index. Legacy Sheet ID + Row
        // references remain available until every client has refreshed.
        var sheetId = Math.floor(Number(row[3]));
        var songRow = Math.floor(Number(row[4]));
        var song = fcBotNormalizeText(row[1]);
        var songId = fcBotNormalizeSongId(row[8]);

        if (!Number.isFinite(sheetId) || sheetId < 0 ||
            !Number.isFinite(songRow) || songRow < 1 || !song) {
          return null;
        }

        return [
          songId
            ? fcBotCreateStableSongRef(songId)
            : String(sheetId) + ":" + String(songRow),
          song,
          fcBotNormalizeText(row[2]),
          fcBotNormalizeText(row[5])
        ];
      })
      .filter(function(row) {
        return row !== null;
      });
  }

  var nextOffset = offset + rowCount;
  if (nextOffset >= totalSongs) nextOffset = null;

  var playerRows = [];
  var includePlayers =
    offset === 0 && fcBotToBoolean_(requestData.includePlayers, true);

  if (includePlayers) {
    playerRows = fcBotGetPlayerIndexSnapshot().map(function(player) {
      return [
        fcBotNormalizeText(player.player),
        Number(player.fcCount) || 0
      ];
    });
  }

  var finalState = fcBotApiCatalogStatus_();
  fcBotRequireReadableCatalogState_(finalState);

  if (
    initialState.catalogToken !== finalState.catalogToken ||
    initialState.revision !== finalState.revision ||
    initialState.playerRevision !== finalState.playerRevision ||
    totalSongs !== finalState.totalSongs
  ) {
    var changed = new Error(
      "The autocomplete catalog changed while this page was being read."
    );
    changed.code = "CATALOG_CHANGED_DURING_READ";
    throw changed;
  }

  return {
    offset: offset,
    pageSize: pageSize,
    returnedSongs: songRows.length,
    totalSongs: totalSongs,
    totalPlayers: finalState.totalPlayers,
    nextOffset: nextOffset,
    songs: songRows,
    players: playerRows,
    catalogRevision: finalState.revision,
    playerRevision: finalState.playerRevision,
    catalogToken: finalState.catalogToken,
    catalogUpdatedAt: finalState.updatedAt,
    busy: false,
    dirty: false,
    generatedAt: new Date().toISOString()
  };
}

function fcBotRequireReadableCatalogState_(state) {
  if (state && !state.busy && !state.dirty) return;

  var busy = new Error(
    "The backend index is busy. Autocomplete will retry automatically."
  );
  busy.code = "BACKEND_BUSY";
  throw busy;
}

/**
 * Returns current song information from the real setlist row.
 *
 * A full batch Song Index rebuild intentionally leaves embedded proof URLs
 * blank, because rich-text hyperlinks cannot be read through values.batchGet.
 * Therefore this endpoint uses Song Index only to locate and validate the song,
 * then reads the FC player and proof hyperlink live from the setlist cells.
 */
function fcBotApiSongInfo_(requestData) {
  var songRef = fcBotRequireSongRef_(requestData.songRef);

  return fcBotWithLock(function() {
    var record = fcBotGetIndexedSongByRef(songRef);

    if (!record) {
      var notFound = new Error(
        "The requested song is not present in Song Index."
      );
      notFound.code = "SONG_NOT_FOUND";
      throw notFound;
    }

    var live = fcBotRequireFreshSongReference_(record);
    var config = fcBotGetConfig();
    var player = fcBotNormalizeText(
      live.sheet.getRange(live.row, config.fcerColumn).getDisplayValue()
    );
    var proofUrl = fcBotGetCellLinkUrl(
      live.sheet.getRange(live.row, config.proofLinkColumn)
    );

    return {
      songRef: record.songRef,
      songId: live.songId,
      song: live.songName,
      setlist: live.sheetName,
      sheetId: live.sheetId,
      row: live.row,
      fcPlayer: player,
      proofUrl: proofUrl,
      isFcd: Boolean(player),
      hasProof: Boolean(proofUrl),
      updatedAt: record.updatedAt || "",
      liveReadAt: new Date().toISOString()
    };
  });
}

/**
 * Proof mutations should never wait behind a long maintenance operation for
 * tens of seconds. If the shared backend lock is unavailable, return a clear
 * retryable error quickly.
 */
function fcBotWithProofMutationLock_(callback) {
  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(5000);

  if (!acquired) {
    var busy = new Error(
      "The backend is busy updating its indexes. Wait a few seconds and retry."
    );
    busy.code = "BACKEND_BUSY";
    throw busy;
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

/** Adds an FC player and proof to a currently un-FC'd song. */
function fcBotApiAddProof_(requestData) {
  var input = fcBotValidateProofMutationInput_(requestData, {
    requirePlayer: true,
    requireProofUrl: true
  });

  return fcBotWithProofMutationLock_(function() {
    if (typeof fcBotAssertContributorsReadyForMutation_ !== "function") {
      var missingSafety = new Error(
        "ContributorSafety.gs is missing. Proof changes are disabled for safety."
      );
      missingSafety.code = "CONTRIBUTOR_SAFETY_NOT_INSTALLED";
      throw missingSafety;
    }

    var contributorState = fcBotAssertContributorsReadyForMutation_();
    var target = fcBotLoadProofTargetUnlocked_(input.songRef, input);
    var config = fcBotGetConfig();
    var oldPlayer = fcBotNormalizeText(target.fcerCell.getDisplayValue());
    var oldProofUrl = fcBotGetCellLinkUrl(target.proofCell);

    if (oldPlayer && !config.allowPlayerOverwrite) {
      var playerError = new Error(
        'This song is already FC\'d by "' + oldPlayer + '".'
      );
      playerError.code = "ALREADY_FCD";
      playerError.details = {
        player: oldPlayer,
        proofUrl: oldProofUrl
      };
      throw playerError;
    }

    if (oldProofUrl && !config.allowProofOverwrite) {
      var proofError = new Error("This song already has a proof link.");
      proofError.code = "PROOF_ALREADY_EXISTS";
      proofError.details = {
        player: oldPlayer,
        proofUrl: oldProofUrl
      };
      throw proofError;
    }

    var contributorDeltas = {};
    if (oldPlayer && fcBotNormalizeKey(oldPlayer) !== fcBotNormalizeKey(input.player)) {
      contributorDeltas[oldPlayer] = -1;
    }
    if (!oldPlayer || fcBotNormalizeKey(oldPlayer) !== fcBotNormalizeKey(input.player)) {
      contributorDeltas[input.player] = (contributorDeltas[input.player] || 0) + 1;
    }

    var result = fcBotCommitProofMutationUnlocked_(target, {
      oldPlayer: oldPlayer,
      oldProofUrl: oldProofUrl,
      newPlayer: input.player,
      newProofUrl: input.proofUrl,
      synchronization: {
        oldPlayer: oldPlayer,
        newPlayer: input.player,
        contributorDeltas: contributorDeltas,
        contributorRows: contributorState.rows,
        stampLastFc: true,
        discordUser: input.discordUser
      },
      buildResult: function(syncResult) {
        return fcBotBuildProofMutationResult_(
          target,
          input.player,
          input.proofUrl,
          syncResult,
          oldPlayer
        );
      }
    });

    fcBotMaybeNotifyLegacyWebhook_(target, oldPlayer, input.player);

    fcBotWriteLogBestEffort_("add-proof", "success", {
      discordUser: input.discordUser,
      songRef: target.songRef,
      message: input.player + " — " + target.songName
    });

    return result;
  });
}

/** Explicitly replaces the player and/or proof on an existing indexed song. */
function fcBotApiEditProof_(requestData) {
  var hasPlayer = requestData.player !== undefined && requestData.player !== null;
  var hasProofUrl = requestData.proofUrl !== undefined && requestData.proofUrl !== null;

  if (!hasPlayer && !hasProofUrl) {
    var missingChanges = new Error(
      "editProof requires a player, a proofUrl, or both."
    );
    missingChanges.code = "NO_CHANGES";
    throw missingChanges;
  }

  var input = fcBotValidateProofMutationInput_(requestData, {
    requirePlayer: false,
    requireProofUrl: false,
    validatePlayerWhenPresent: hasPlayer,
    validateProofWhenPresent: hasProofUrl
  });

  return fcBotWithProofMutationLock_(function() {
    if (typeof fcBotAssertContributorsReadyForMutation_ !== "function") {
      var missingSafety = new Error(
        "ContributorSafety.gs is missing. Proof changes are disabled for safety."
      );
      missingSafety.code = "CONTRIBUTOR_SAFETY_NOT_INSTALLED";
      throw missingSafety;
    }

    var contributorState = fcBotAssertContributorsReadyForMutation_();
    var target = fcBotLoadProofTargetUnlocked_(input.songRef, input);
    var oldPlayer = fcBotNormalizeText(target.fcerCell.getDisplayValue());
    var oldProofUrl = fcBotGetCellLinkUrl(target.proofCell);
    var newPlayer = hasPlayer ? input.player : oldPlayer;
    var newProofUrl = hasProofUrl ? input.proofUrl : oldProofUrl;

    if (!newPlayer) {
      var noPlayer = new Error(
        "A proof cannot remain attached without an FC player. Use removeProof instead."
      );
      noPlayer.code = "PLAYER_REQUIRED";
      throw noPlayer;
    }

    if (!newProofUrl) {
      var noProof = new Error(
        "A completed song must have a proof URL. Use removeProof instead."
      );
      noProof.code = "PROOF_URL_REQUIRED";
      throw noProof;
    }

    var contributorDeltas = {};
    if (fcBotNormalizeKey(oldPlayer) !== fcBotNormalizeKey(newPlayer)) {
      if (oldPlayer) contributorDeltas[oldPlayer] = -1;
      contributorDeltas[newPlayer] = (contributorDeltas[newPlayer] || 0) + 1;
    }

    var result = fcBotCommitProofMutationUnlocked_(target, {
      oldPlayer: oldPlayer,
      oldProofUrl: oldProofUrl,
      newPlayer: newPlayer,
      newProofUrl: newProofUrl,
      synchronization: {
        oldPlayer: oldPlayer,
        newPlayer: newPlayer,
        contributorDeltas: contributorDeltas,
        contributorRows: contributorState.rows,
        stampLastFc: fcBotNormalizeKey(oldPlayer) !== fcBotNormalizeKey(newPlayer),
        discordUser: input.discordUser
      },
      buildResult: function(syncResult) {
        return fcBotBuildProofMutationResult_(
          target,
          newPlayer,
          newProofUrl,
          syncResult,
          oldPlayer
        );
      }
    });

    fcBotWriteLogBestEffort_("edit-proof", "success", {
      discordUser: input.discordUser,
      songRef: target.songRef,
      message: newPlayer + " — " + target.songName
    });

    return result;
  });
}

/** Removes both the FC player and embedded proof link. */
function fcBotApiRemoveProof_(requestData) {
  var input = fcBotValidateProofMutationInput_(requestData, {
    requirePlayer: false,
    requireProofUrl: false
  });

  return fcBotWithProofMutationLock_(function() {
    if (typeof fcBotAssertContributorsReadyForMutation_ !== "function") {
      var missingSafety = new Error(
        "ContributorSafety.gs is missing. Proof changes are disabled for safety."
      );
      missingSafety.code = "CONTRIBUTOR_SAFETY_NOT_INSTALLED";
      throw missingSafety;
    }

    var contributorState = fcBotAssertContributorsReadyForMutation_();
    var target = fcBotLoadProofTargetUnlocked_(input.songRef, input);
    var oldPlayer = fcBotNormalizeText(target.fcerCell.getDisplayValue());
    var oldProofUrl = fcBotGetCellLinkUrl(target.proofCell);

    if (!oldPlayer && !oldProofUrl) {
      var alreadyEmpty = new Error("This song does not currently have an FC proof.");
      alreadyEmpty.code = "NO_PROOF_TO_REMOVE";
      throw alreadyEmpty;
    }

    var contributorDeltas = {};
    if (oldPlayer) contributorDeltas[oldPlayer] = -1;

    var result = fcBotCommitProofMutationUnlocked_(target, {
      oldPlayer: oldPlayer,
      oldProofUrl: oldProofUrl,
      newPlayer: "",
      newProofUrl: "",
      synchronization: {
        oldPlayer: oldPlayer,
        newPlayer: "",
        contributorDeltas: contributorDeltas,
        contributorRows: contributorState.rows,
        stampLastFc: false,
        discordUser: input.discordUser
      },
      buildResult: function(syncResult) {
        return fcBotBuildProofMutationResult_(
          target,
          "",
          "",
          syncResult,
          oldPlayer
        );
      }
    });

    fcBotWriteLogBestEffort_("remove-proof", "success", {
      discordUser: input.discordUser,
      songRef: target.songRef,
      message: oldPlayer + " — " + target.songName
    });

    return result;
  });
}

/** Rebuilds both indexes and returns their completed results. */
function fcBotApiRefreshIndexes_(requestData) {
  return fcBotWithLock(function() {
    if (typeof fcBotAssertContributorsReadyForMutation_ !== "function") {
      var missingSafety = new Error(
        "ContributorSafety.gs is missing. Index refresh is disabled for safety."
      );
      missingSafety.code = "CONTRIBUTOR_SAFETY_NOT_INSTALLED";
      throw missingSafety;
    }

    fcBotAssertContributorsReadyForMutation_();

    var songIndexResult;

    if (typeof fcBotStartSongIndexRebuild === "function") {
      songIndexResult = fcBotStartSongIndexRebuild();
    } else {
      songIndexResult = fcBotRebuildSongIndexUnlocked_();
    }

    var playerIndexResult = fcBotRebuildPlayerIndexUnlocked_();

    fcBotWriteLog("refresh-indexes", "success", {
      discordUser: fcBotNormalizeText(requestData.discordUser),
      message: "Song and Player indexes refreshed."
    });

    return {
      songIndex: songIndexResult,
      playerIndex: playerIndexResult
    };
  });
}

/** Validates and normalizes proof mutation input. */
function fcBotValidateProofMutationInput_(requestData, options) {
  options = options || {};
  var config = fcBotGetConfig();
  var songRef = fcBotRequireSongRef_(requestData.songRef);
  var player = fcBotNormalizeSubmittedPlayerName_(requestData.player);
  var proofUrl = fcBotNormalizeText(requestData.proofUrl);
  var discordUser = fcBotNormalizeText(requestData.discordUser);
  var expectedSong = fcBotNormalizeText(requestData.expectedSong);
  var expectedSetlist = fcBotNormalizeText(requestData.expectedSetlist);
  var expectedSongId = fcBotNormalizeSongId(requestData.expectedSongId);

  if (options.requirePlayer && !player) {
    var playerRequired = new Error("A player name is required.");
    playerRequired.code = "PLAYER_REQUIRED";
    throw playerRequired;
  }

  if ((options.requirePlayer || options.validatePlayerWhenPresent) && player) {
    if (player.charAt(0) === "=") {
      var formulaPlayer = new Error(
        "Player names cannot begin with an equals sign."
      );
      formulaPlayer.code = "INVALID_PLAYER_NAME";
      throw formulaPlayer;
    }

    if (player.length > Number(config.maxPlayerNameLength)) {
      var playerTooLong = new Error("The player name is too long.");
      playerTooLong.code = "PLAYER_TOO_LONG";
      throw playerTooLong;
    }

    if (config.requirePlayerInPlayerIndex && !fcBotGetIndexedPlayer(player)) {
      var unknownPlayer = new Error(
        'Player "' + player + '" was not found in Player Index.'
      );
      unknownPlayer.code = "PLAYER_NOT_FOUND";
      throw unknownPlayer;
    }
  }

  if (options.requireProofUrl && !proofUrl) {
    var proofRequired = new Error("A proof URL is required.");
    proofRequired.code = "PROOF_URL_REQUIRED";
    throw proofRequired;
  }

  if ((options.requireProofUrl || options.validateProofWhenPresent) && proofUrl) {
    if (proofUrl.length > Number(config.maxProofUrlLength)) {
      var proofTooLong = new Error("The proof URL is too long.");
      proofTooLong.code = "PROOF_URL_TOO_LONG";
      throw proofTooLong;
    }

    if (fcBotIsDiscordProofUrl(proofUrl)) {
      var discordProof = new Error(
        "Discord-hosted proof links are not accepted because they may expire. " +
        "Upload the proof to a permanent host and submit that HTTPS link instead."
      );
      discordProof.code = "DISCORD_PROOF_URL_NOT_ALLOWED";
      throw discordProof;
    }

    if (!fcBotIsAllowedProofUrl(proofUrl)) {
      var invalidProof = new Error(
        "The proof URL is invalid or comes from a disallowed host."
      );
      invalidProof.code = "INVALID_PROOF_URL";
      throw invalidProof;
    }
  }

  if (discordUser.length > Number(config.maxDiscordUserLength)) {
    discordUser = discordUser.substring(0, Number(config.maxDiscordUserLength));
  }

  return {
    songRef: songRef,
    player: player,
    proofUrl: proofUrl,
    discordUser: discordUser,
    expectedSong: expectedSong,
    expectedSetlist: expectedSetlist,
    expectedSongId: expectedSongId
  };
}

/**
 * Removes the FC-count suffix used only for Discord autocomplete display.
 *
 * Exact indexed names win first, so a real player name ending in "— 20 FCs"
 * would still be preserved if it genuinely exists in Player Index.
 */
function fcBotNormalizeSubmittedPlayerName_(value) {
  var raw = fcBotNormalizeText(value);
  if (!raw) return "";

  if (typeof fcBotGetIndexedPlayer === "function") {
    var exact = fcBotGetIndexedPlayer(raw);
    if (exact && exact.player) {
      return fcBotNormalizeText(exact.player);
    }
  }

  var stripped = raw.replace(
    /\s+[—–-]\s+\d+\s+FCs?$/i,
    ""
  );
  stripped = fcBotNormalizeText(stripped);

  if (
    stripped &&
    typeof fcBotGetIndexedPlayer === "function"
  ) {
    var indexed = fcBotGetIndexedPlayer(stripped);
    if (indexed && indexed.player) {
      return fcBotNormalizeText(indexed.player);
    }
  }

  return stripped || raw;
}

function fcBotRequireSongRef_(value) {
  var songRef = fcBotNormalizeText(value);
  if (!fcBotParseSongRef(songRef)) {
    var error = new Error("A valid songRef is required.");
    error.code = "INVALID_SONG_REFERENCE";
    throw error;
  }
  return songRef;
}

/** Loads an indexed song and verifies that its sheet row has not moved. */
function fcBotLoadProofTargetUnlocked_(songRef, expectedIdentity) {
  var indexed = fcBotGetIndexedSongByRef(songRef);
  if (!indexed) {
    var missing = new Error("The song is no longer present in Song Index.");
    missing.code = "SONG_NOT_FOUND";
    throw missing;
  }

  var live = fcBotRequireFreshSongReference_(indexed);
  fcBotAssertExpectedSongIdentity_(indexed, live, expectedIdentity || {});
  var config = fcBotGetConfig();

  return {
    songRef: indexed.songRef,
    songId: live.songId,
    songName: live.songName,
    setlist: live.sheetName,
    sheet: live.sheet,
    sheetId: live.sheetId,
    row: live.row,
    indexRow: Number(indexed._indexRow) || 0,
    indexedSongName: indexed.song,
    songCell: live.sheet.getRange(live.row, config.songColumn),
    fcerCell: live.sheet.getRange(live.row, config.fcerColumn),
    proofCell: live.sheet.getRange(live.row, config.proofLinkColumn)
  };
}

/**
 * Stops a stale autocomplete choice from writing to the wrong song after rows
 * have been inserted, removed, or rearranged.
 */
function fcBotRequireFreshSongReference_(indexedRecord) {
  var sheet = fcBotGetSheetById(Number(indexedRecord.sheetId));
  var row = Math.floor(Number(indexedRecord.row));
  var config = fcBotGetConfig();

  if (
    !sheet ||
    !fcBotIsSetlistSheet(sheet) ||
    !Number.isFinite(row) ||
    row < 1 ||
    row > sheet.getMaxRows()
  ) {
    if (
      sheet &&
      fcBotIsSetlistSheet(sheet) &&
      typeof fcBotUpdateSongIndexForSheetUnlocked_ === "function"
    ) {
      fcBotUpdateSongIndexForSheetUnlocked_(sheet);
    }

    var missing = new Error("The song reference no longer resolves to a valid row.");
    missing.code = "STALE_SONG_REFERENCE";
    throw missing;
  }

  var songName = fcBotNormalizeText(
    sheet.getRange(row, config.songColumn).getDisplayValue()
  );

  if (
    !songName ||
    fcBotNormalizeKey(songName) !== fcBotNormalizeKey(indexedRecord.song)
  ) {
    if (typeof fcBotUpdateSongIndexForSheetUnlocked_ === "function") {
      fcBotUpdateSongIndexForSheetUnlocked_(sheet);
    }

    var stale = new Error(
      "The setlist changed after autocomplete. Select the song again and retry."
    );
    stale.code = "STALE_SONG_REFERENCE";
    stale.details = {
      expectedSong: indexedRecord.song,
      currentSong: songName,
      setlist: sheet.getName(),
      row: row
    };
    throw stale;
  }

  return {
    ref: indexedRecord.songRef,
    songId: fcBotNormalizeSongId(indexedRecord.songId),
    sheet: sheet,
    sheetId: sheet.getSheetId(),
    sheetName: sheet.getName(),
    row: row,
    songName: songName
  };
}

/**
 * Cross-checks the label captured by Discord before allowing a write. This is
 * the rollout guard for old row-based references and a second safety check for
 * stable IDs.
 */
function fcBotAssertExpectedSongIdentity_(
  indexedRecord,
  live,
  expectedIdentity
) {
  expectedIdentity = expectedIdentity || {};

  var expectedSong = fcBotNormalizeText(expectedIdentity.expectedSong);
  var expectedSetlist = fcBotNormalizeText(expectedIdentity.expectedSetlist);
  var rawExpectedSongId = fcBotNormalizeText(
    expectedIdentity.expectedSongId
  );
  var expectedSongId = fcBotNormalizeSongId(rawExpectedSongId);
  var currentSongId = fcBotNormalizeSongId(
    live.songId || indexedRecord.songId
  );
  var mismatch =
    (expectedSong &&
      fcBotNormalizeKey(expectedSong) !== fcBotNormalizeKey(live.songName)) ||
    (expectedSetlist &&
      fcBotNormalizeKey(expectedSetlist) !== fcBotNormalizeKey(live.sheetName)) ||
    (rawExpectedSongId && expectedSongId !== currentSongId);

  if (!mismatch) return;

  if (typeof fcBotUpdateSongIndexForSheetUnlocked_ === "function") {
    fcBotUpdateSongIndexForSheetUnlocked_(live.sheet);
  }

  var stale = new Error(
    "The setlist changed after autocomplete. Select the song again and retry."
  );
  stale.code = "STALE_SONG_REFERENCE";
  stale.details = {
    expectedSong: expectedSong,
    currentSong: live.songName,
    expectedSetlist: expectedSetlist,
    currentSetlist: live.sheetName,
    expectedSongId: rawExpectedSongId,
    currentSongId: currentSongId,
    row: live.row
  };
  throw stale;
}

function fcBotWriteProofCellsUnlocked_(target, player, proofUrl) {
  fcBotApplyProofCellStateUnlocked_(target, player, proofUrl);
}

/** Writes either a completed or uncompleted proof-cell state. */
function fcBotApplyProofCellStateUnlocked_(target, player, proofUrl, options) {
  options = options || {};
  player = fcBotNormalizeText(player);
  proofUrl = fcBotNormalizeText(proofUrl);

  if (player) {
    target.fcerCell.setValue(player);
  } else {
    target.fcerCell.clearContent();
  }

  if (proofUrl) {
    fcBotSetCellLinkUrl(target.proofCell, proofUrl, target.songName);
  } else {
    fcBotClearCellLinkUrl(target.proofCell);
  }

  if (player && proofUrl) {
    fcBotApplyProofFormattingUnlocked_(target);
  }

  if (!options.deferFlush) {
    SpreadsheetApp.flush();
  }
}

/** Captures the historical last-FC fields that a failed mutation may stamp. */
function fcBotCaptureSummaryAuditStateUnlocked_(setlistName) {
  var config = fcBotGetConfig();
  var summarySheet = fcBotGetSummarySheet();
  var lastSetlistRow = fcBotGetSummarySetlistLastRowUnlocked_(
    summarySheet,
    config
  );

  if (lastSetlistRow < config.summaryStartRow) return null;

  var names = summarySheet
    .getRange(
      config.summaryStartRow,
      1,
      lastSetlistRow - config.summaryStartRow + 1,
      1
    )
    .getDisplayValues()
    .map(function(row) {
      return fcBotNormalizeText(row[0]);
    });
  var offset = names.indexOf(setlistName);
  if (offset === -1) return null;

  var row = config.summaryStartRow + offset;
  var range = summarySheet.getRange(row, 2, 1, 3);
  var rangeValues = range.getValues()[0];
  var rangeFormulas = range.getFormulas()[0];
  var rangeFormats = range.getNumberFormats()[0];
  return {
    row: row,
    lastSetlistRow: lastSetlistRow,
    count: rangeValues[0],
    values: [rangeValues.slice(1)],
    formulas: [rangeFormulas.slice(1)],
    numberFormats: [rangeFormats.slice(1)]
  };
}

/** Restores the last-FC fields after rebuilding a rolled-back mutation. */
function fcBotRestoreSummaryAuditStateUnlocked_(snapshot) {
  if (!snapshot) return;

  var values = snapshot.values.map(function(row, rowIndex) {
    return row.map(function(value, columnIndex) {
      return snapshot.formulas[rowIndex][columnIndex] || value;
    });
  });
  fcBotGetSummarySheet()
    .getRange(snapshot.row, 3, 1, 2)
    .setValues(values)
    .setNumberFormats(snapshot.numberFormats);
}

/** Rebuilds every derived structure from the restored setlist source data. */
function fcBotRepairProofDerivedStateUnlocked_(target, summaryAudit) {
  var result = {};
  result.songIndex = fcBotRebuildSongIndexUnlocked_();

  var source = fcBotBuildContributorsFromSetlists_();
  var validation = fcBotValidateContributorRows_(source.rows, {
    deep: true,
    ignoreGrowthCheck: true
  });

  if (!validation.ok) {
    var invalid = new Error(
      "Rollback could not rebuild Contributors: " +
      validation.errors.join(" ")
    );
    invalid.code = "PROOF_ROLLBACK_CONTRIBUTORS_INVALID";
    invalid.details = validation;
    throw invalid;
  }

  result.contributors = fcBotCommitContributorRowsSafely_(validation.rows, {
    deep: true,
    ignoreGrowthCheck: true,
    reason: "proof-mutation-rollback"
  });
  result.playerIndex = fcBotRebuildPlayerIndexUnlocked_();
  result.summary = fcBotRefreshSummaryForSetlistUnlocked_(target.sheet, {
    stampLastFc: false
  });
  fcBotRestoreSummaryAuditStateUnlocked_(summaryAudit);

  if (typeof fcBotCloseContributorCircuit_ === "function") {
    fcBotCloseContributorCircuit_("proof-mutation-rollback");
  }

  SpreadsheetApp.flush();
  return result;
}

/**
 * Commits source and derived proof state as one recoverable operation.
 * Spreadsheet writes are not transactional, so failures restore the source
 * cells and rebuild every derived table before the original error is returned.
 */
function fcBotCommitProofMutationUnlocked_(target, mutation) {
  mutation = mutation || {};
  var summaryAudit = fcBotCaptureSummaryAuditStateUnlocked_(target.setlist);

  try {
    fcBotApplyProofCellStateUnlocked_(
      target,
      mutation.newPlayer,
      mutation.newProofUrl,
      { deferFlush: true }
    );
    var synchronizationContext = Object.assign(
      {},
      mutation.synchronization || {},
      {
        oldPlayer: mutation.oldPlayer,
        newPlayer: mutation.newPlayer,
        oldProofUrl: mutation.oldProofUrl,
        newProofUrl: mutation.newProofUrl,
        summaryAudit: summaryAudit
      }
    );
    var synchronization = fcBotSynchronizeProofMutationUnlocked_(
      target,
      synchronizationContext
    );

    return typeof mutation.buildResult === "function"
      ? mutation.buildResult(synchronization)
      : synchronization;
  } catch (error) {
    var originalError = error instanceof Error
      ? error
      : new Error(String(error));

    try {
      fcBotApplyProofCellStateUnlocked_(
        target,
        mutation.oldPlayer,
        mutation.oldProofUrl
      );
      fcBotRepairProofDerivedStateUnlocked_(target, summaryAudit);
    } catch (rollbackError) {
      var rollbackFailure = new Error(
        "The proof change failed and automatic rollback also failed. " +
        "Run the index and contributor repair tools before accepting more proof changes."
      );
      rollbackFailure.code = "PROOF_MUTATION_ROLLBACK_FAILED";
      rollbackFailure.details = {
        originalCode: originalError.code || "ERROR",
        originalMessage: originalError.message,
        rollbackMessage: rollbackError.message
      };
      throw rollbackFailure;
    }

    var originalDetails = originalError.details;
    if (!originalDetails || typeof originalDetails !== "object") {
      originalDetails = {};
    }
    originalError.details = Object.assign({}, originalDetails, {
      rolledBack: true
    });
    throw originalError;
  }
}

/** Applies only explicitly configured formatting; blank settings do nothing. */
function fcBotApplyProofFormattingUnlocked_(target) {
  var config = fcBotGetConfig();
  var firstColumn = Math.min(config.songColumn, config.fcerColumn);
  var lastColumn = Math.max(config.songColumn, config.fcerColumn);
  var rowRange = target.sheet.getRange(
    target.row,
    firstColumn,
    1,
    lastColumn - firstColumn + 1
  );

  if (fcBotNormalizeText(config.completedRowBackgroundColor)) {
    rowRange.setBackground(config.completedRowBackgroundColor);
  }

  if (fcBotNormalizeText(config.completedSongFontColor)) {
    target.songCell.setFontColor(config.completedSongFontColor);
  }

  if (fcBotNormalizeText(config.completedFcerFontColor)) {
    target.fcerCell.setFontColor(config.completedFcerFontColor);
  }

  if (fcBotNormalizeText(config.completedFontWeight)) {
    rowRange.setFontWeight(config.completedFontWeight);
  }
}

/**
 * Synchronizes derived workbook structures after a proof mutation.
 *
 * Order matters:
 * 1. Update the one Song Index row first, so autocomplete reflects the proof
 *    even if a later non-critical summary operation is slow.
 * 2. Update Contributors and only the affected Player Index entry when
 *    possible.
 * 3. Refresh the affected summary setlist last.
 */
function fcBotSynchronizeProofMutationUnlocked_(target, context) {
  context = context || {};

  var startedAt = Date.now();
  var timings = {};

  var stageStartedAt = Date.now();
  var songIndex;

  if (typeof fcBotUpdateIndexedProofForRowUnlocked_ === "function") {
    songIndex = fcBotUpdateIndexedProofForRowUnlocked_(
      target.sheet,
      target.row,
      {
        indexRow: target.indexRow,
        indexedSongName: target.indexedSongName,
        songName: target.songName,
        player: context.newPlayer,
        proofUrl: context.newProofUrl,
        reason:
          "discord-proof-mutation:" +
          target.sheetId +
          ":" +
          target.row
      }
    );
  } else {
    songIndex = fcBotUpdateSongIndexForSheetUnlocked_(target.sheet);
  }

  timings.songIndexMs = Date.now() - stageStartedAt;

  stageStartedAt = Date.now();
  var contributors = fcBotApplyContributorDeltasUnlocked_(
    context.contributorDeltas || {},
    { currentRows: context.contributorRows }
  );
  timings.contributorsMs = Date.now() - stageStartedAt;

  stageStartedAt = Date.now();
  var playerIndex = null;

  if (contributors.changed) {
    var affectedPlayers = contributors.affectedPlayers || [];

    if (typeof fcBotUpdatePlayerIndexEntriesUnlocked_ === "function") {
      playerIndex = fcBotUpdatePlayerIndexEntriesUnlocked_(
        affectedPlayers,
        contributors._rows || []
      );
    } else if (
      affectedPlayers.length === 1 &&
      typeof fcBotUpdatePlayerIndexEntryUnlocked_ === "function"
    ) {
      playerIndex = fcBotUpdatePlayerIndexEntryUnlocked_(
        affectedPlayers[0]
      );
    } else {
      playerIndex = fcBotRebuildPlayerIndexUnlocked_();
    }
  }

  timings.playerIndexMs = Date.now() - stageStartedAt;

  stageStartedAt = Date.now();
  var summary = fcBotUpdateSummaryForProofMutationUnlocked_(target, {
    oldPlayer: context.oldPlayer,
    newPlayer: context.newPlayer,
    stampLastFc: Boolean(context.stampLastFc),
    songName: target.songName,
    summaryAudit: context.summaryAudit
  });
  timings.summaryMs = Date.now() - stageStartedAt;

  SpreadsheetApp.flush();

  var playerRows = playerIndex && playerIndex._rows;
  var catalogState = playerRows
    ? fcBotBuildApiCatalogStatusFromPlayers_(
        playerRows.map(function(row) {
          return {
            player: fcBotNormalizeText(row[0]),
            fcCount: Number(row[1]) || 0,
            updatedAt: row[2] || ""
          };
        })
      )
    : null;

  timings.totalMs = Date.now() - startedAt;

  console.log(JSON.stringify({
    type: "proof-mutation-sync",
    songRef: target.songRef,
    setlist: target.setlist,
    row: target.row,
    timings: timings
  }));

  var result = {
    summary: summary,
    contributors: contributors,
    playerIndex: playerIndex,
    songIndex: songIndex,
    timings: timings
  };

  if (catalogState) {
    Object.defineProperty(result, "_catalogState", {
      value: catalogState,
      enumerable: false
    });
  }

  return result;
}

/**
 * Applies the common add/remove summary change without rescanning the complete
 * setlist or clearing and rewriting its complete UnFC'd-song column.
 * Invariant mismatches fall back to the canonical full refresh.
 */
function fcBotUpdateSummaryForProofMutationUnlocked_(target, options) {
  options = options || {};
  var config = fcBotGetConfig();
  var summarySheet = fcBotGetSummarySheet();
  var summaryAudit = options.summaryAudit || null;
  var setlistRow = summaryAudit && Number(summaryAudit.row) >= config.summaryStartRow
    ? Number(summaryAudit.row)
    : fcBotFindSummarySetlistRowUnlocked_(
        summarySheet,
        target.setlist,
        config
      );

  if (!setlistRow) {
    return fcBotRefreshSummaryFallbackUnlocked_(
      target,
      options,
      "The setlist was not found in the summary table."
    );
  }

  var oldHasPlayer = Boolean(fcBotNormalizeText(options.oldPlayer));
  var newHasPlayer = Boolean(fcBotNormalizeText(options.newPlayer));
  var membershipDelta = oldHasPlayer === newHasPlayer
    ? 0
    : (newHasPlayer ? -1 : 1);

  // A proof URL or player-name edit that does not change FC membership only
  // needs the optional last-FC audit stamp.
  if (membershipDelta === 0) {
    if (options.stampLastFc && options.songName) {
      summarySheet
        .getRange(setlistRow, 3)
        .setValue(new Date())
        .setNumberFormat("dd-MM-yyyy");
      summarySheet.getRange(setlistRow, 4).setValue(options.songName);
    }

    return {
      updated: Boolean(options.stampLastFc && options.songName),
      mode: "metadata-only",
      summaryRow: setlistRow,
      membershipDelta: 0,
      rowsWritten: 0
    };
  }

  var currentCountValue =
    summaryAudit && summaryAudit.count !== undefined
      ? summaryAudit.count
      : summarySheet.getRange(setlistRow, 2).getValue();
  var currentCount = Number(currentCountValue);
  if (!Number.isFinite(currentCount) || currentCount < 0) {
    return fcBotRefreshSummaryFallbackUnlocked_(
      target,
      options,
      "The existing summary count is invalid."
    );
  }
  currentCount = Math.floor(currentCount);

  var summaryColumn = fcBotFindSummarySongColumnUnlocked_(
    summarySheet,
    target.setlist
  );
  if (!summaryColumn) {
    return fcBotRefreshSummaryFallbackUnlocked_(
      target,
      options,
      "The setlist summary song column is missing."
    );
  }

  var oldSongs = fcBotReadSummarySongListUnlocked_(
    summarySheet,
    summaryColumn
  );
  if (!oldSongs.ok || oldSongs.songs.length !== currentCount) {
    return fcBotRefreshSummaryFallbackUnlocked_(
      target,
      options,
      "The summary count and compact song list do not match."
    );
  }

  var insertionIndex = fcBotCountUnfcdSongsBeforeRowUnlocked_(
    target.sheet,
    target.row,
    config
  );
  var newSongs = oldSongs.songs.slice();

  if (membershipDelta < 0) {
    if (
      insertionIndex >= newSongs.length ||
      fcBotNormalizeText(newSongs[insertionIndex]) !== target.songName
    ) {
      return fcBotRefreshSummaryFallbackUnlocked_(
        target,
        options,
        "The changed song was not at its expected summary position."
      );
    }
    newSongs.splice(insertionIndex, 1);
  } else {
    if (insertionIndex < 0 || insertionIndex > newSongs.length) {
      return fcBotRefreshSummaryFallbackUnlocked_(
        target,
        options,
        "The summary insertion position is invalid."
      );
    }
    newSongs.splice(insertionIndex, 0, target.songName);
  }

  var nextCount = currentCount + membershipDelta;
  if (nextCount < 0 || newSongs.length !== nextCount) {
    return fcBotRefreshSummaryFallbackUnlocked_(
      target,
      options,
      "The incremental summary result failed its count invariant."
    );
  }

  var write = fcBotWriteChangedSummarySongRowsUnlocked_(
    summarySheet,
    summaryColumn,
    oldSongs.songs,
    newSongs
  );

  summarySheet.getRange(setlistRow, 2).setValue(nextCount);
  summarySheet
    .getRange(setlistRow, 1, 1, 2)
    .setBackground(nextCount === 0 ? "#6aa84f" : "#ff0000");

  if (options.stampLastFc && options.songName) {
    summarySheet
      .getRange(setlistRow, 3)
      .setValue(new Date())
      .setNumberFormat("dd-MM-yyyy");
    summarySheet.getRange(setlistRow, 4).setValue(options.songName);
  }

  var summaryLastRow =
    summaryAudit && Number(summaryAudit.lastSetlistRow) >= setlistRow
      ? Number(summaryAudit.lastSetlistRow)
      : fcBotGetSummarySetlistLastRowUnlocked_(summarySheet, config);
  var countValues = summaryLastRow >= config.summaryStartRow
    ? summarySheet
        .getRange(
          config.summaryStartRow,
          2,
          summaryLastRow - config.summaryStartRow + 1,
          1
        )
        .getValues()
    : [];
  var totalUnfcd = countValues.reduce(function(total, row, index) {
    var rowNumber = config.summaryStartRow + index;
    var value = rowNumber === setlistRow
      ? nextCount
      : Number(row[0]);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);

  fcBotEnsureSheetSize(summarySheet, config.summaryCounterRow, 5);
  summarySheet
    .getRange(config.summaryCounterRow, 1, 1, 2)
    .setValues([["UnFC'd Songs:", totalUnfcd]])
    .setFontWeight("bold")
    .setBackground("#000000");

  return {
    updated: true,
    mode: "incremental",
    summaryRow: setlistRow,
    unfcdCount: nextCount,
    totalUnfcd: totalUnfcd,
    membershipDelta: membershipDelta,
    rowsWritten: write.rowCount
  };
}

function fcBotRefreshSummaryFallbackUnlocked_(target, options, reason) {
  var result = fcBotRefreshSummaryForSetlistUnlocked_(target.sheet, {
    stampLastFc: Boolean(options.stampLastFc),
    songName: options.songName || target.songName
  });
  result.mode = "full-fallback";
  result.fallbackReason = reason;
  return result;
}

function fcBotGetSummarySetlistLastRowUnlocked_(summarySheet, config) {
  var maximumRow = Math.min(
    Math.max(0, summarySheet.getLastRow()),
    Math.max(config.summaryStartRow - 1, config.summaryCounterRow - 1)
  );
  if (maximumRow < config.summaryStartRow) {
    return config.summaryStartRow - 1;
  }

  var names = summarySheet
    .getRange(
      config.summaryStartRow,
      1,
      maximumRow - config.summaryStartRow + 1,
      1
    )
    .getDisplayValues();

  for (var index = names.length - 1; index >= 0; index--) {
    if (fcBotNormalizeText(names[index][0])) {
      return config.summaryStartRow + index;
    }
  }
  return config.summaryStartRow - 1;
}

function fcBotFindSummarySetlistRowUnlocked_(summarySheet, setlistName, config) {
  var lastRow = fcBotGetSummarySetlistLastRowUnlocked_(summarySheet, config);
  if (lastRow < config.summaryStartRow) return 0;

  var names = summarySheet
    .getRange(
      config.summaryStartRow,
      1,
      lastRow - config.summaryStartRow + 1,
      1
    )
    .getDisplayValues();
  var wanted = fcBotNormalizeText(setlistName);

  for (var index = 0; index < names.length; index++) {
    if (fcBotNormalizeText(names[index][0]) === wanted) {
      return config.summaryStartRow + index;
    }
  }
  return 0;
}

function fcBotFindSummarySongColumnUnlocked_(summarySheet, setlistName) {
  var firstDataColumn = 5;
  var lastColumn = Math.max(firstDataColumn, summarySheet.getLastColumn());
  var headers = summarySheet
    .getRange(1, firstDataColumn, 1, lastColumn - firstDataColumn + 1)
    .getDisplayValues()[0];
  var wanted = fcBotNormalizeText(setlistName);

  for (var index = 0; index < headers.length; index++) {
    if (fcBotNormalizeText(headers[index]) === wanted) {
      return firstDataColumn + index;
    }
  }
  return 0;
}

function fcBotReadSummarySongListUnlocked_(summarySheet, column) {
  var lastRow = fcBotGetLastNonEmptyRow(summarySheet, column, 2);
  if (lastRow < 2) return { ok: true, songs: [] };

  var songs = summarySheet
    .getRange(2, column, lastRow - 1, 1)
    .getDisplayValues()
    .map(function(row) {
      return fcBotNormalizeText(row[0]);
    });

  return {
    ok: songs.every(function(song) { return Boolean(song); }),
    songs: songs
  };
}

function fcBotCountUnfcdSongsBeforeRowUnlocked_(setlistSheet, row, config) {
  var rowCount = Math.max(0, Number(row) - 1);
  if (!rowCount) return 0;

  var firstColumn = Math.min(config.songColumn, config.fcerColumn);
  var lastColumn = Math.max(config.songColumn, config.fcerColumn);
  var songOffset = config.songColumn - firstColumn;
  var playerOffset = config.fcerColumn - firstColumn;
  var values = setlistSheet
    .getRange(1, firstColumn, rowCount, lastColumn - firstColumn + 1)
    .getDisplayValues();

  return values.reduce(function(total, sourceRow) {
    var song = fcBotNormalizeText(sourceRow[songOffset]);
    var player = fcBotNormalizeText(sourceRow[playerOffset]);
    return total + (song && !player ? 1 : 0);
  }, 0);
}

function fcBotWriteChangedSummarySongRowsUnlocked_(
  summarySheet,
  column,
  oldSongs,
  newSongs
) {
  var maxLength = Math.max(oldSongs.length, newSongs.length);
  var firstDifference = -1;
  var lastDifference = -1;

  for (var index = 0; index < maxLength; index++) {
    if (
      fcBotNormalizeText(oldSongs[index]) !==
      fcBotNormalizeText(newSongs[index])
    ) {
      if (firstDifference === -1) firstDifference = index;
      lastDifference = index;
    }
  }

  if (firstDifference === -1) return { changed: false, rowCount: 0 };

  var rowCount = lastDifference - firstDifference + 1;
  fcBotEnsureSheetSize(summarySheet, firstDifference + rowCount + 1, column);
  var output = [];
  for (var offset = firstDifference; offset <= lastDifference; offset++) {
    output.push([newSongs[offset] || ""]);
  }
  summarySheet
    .getRange(firstDifference + 2, column, rowCount, 1)
    .setValues(output);

  return { changed: true, rowCount: rowCount };
}

/**
 * Recalculates only the affected setlist's summary row and E+ song column.
 * This mirrors the behavior of the user's existing onEdit without relying on
 * spreadsheet triggers, because API writes do not fire edit triggers.
 */
function fcBotRefreshSummaryForSetlistUnlocked_(setlistSheet, options) {
  options = options || {};
  var config = fcBotGetConfig();
  var summarySheet = fcBotGetSummarySheet();
  var lastSetlistRow = fcBotGetSummarySetlistLastRowUnlocked_(
    summarySheet,
    config
  );

  if (lastSetlistRow < config.summaryStartRow) {
    return {
      updated: false,
      warning: "The summary sheet has no setlist rows."
    };
  }

  var summaryNames = summarySheet
    .getRange(
      config.summaryStartRow,
      1,
      lastSetlistRow - config.summaryStartRow + 1,
      1
    )
    .getDisplayValues()
    .map(function(row) {
      return fcBotNormalizeText(row[0]);
    });

  var rowOffset = summaryNames.indexOf(setlistSheet.getName());
  if (rowOffset === -1) {
    return {
      updated: false,
      warning: 'Setlist "' + setlistSheet.getName() + '" is not in the summary list.'
    };
  }

  var summaryRow = config.summaryStartRow + rowOffset;
  var lastSongRow = fcBotGetLastNonEmptyRow(
    setlistSheet,
    config.songColumn,
    1
  );
  var unfcdSongs = [];

  if (lastSongRow >= 1) {
    var songValues = setlistSheet
      .getRange(1, config.songColumn, lastSongRow, 1)
      .getDisplayValues();
    var playerValues = setlistSheet
      .getRange(1, config.fcerColumn, lastSongRow, 1)
      .getDisplayValues();

    for (var offset = 0; offset < lastSongRow; offset++) {
      var song = fcBotNormalizeText(songValues[offset][0]);
      var player = fcBotNormalizeText(playerValues[offset][0]);
      if (song && !player) unfcdSongs.push(song);
    }
  }

  var unfcdCount = unfcdSongs.length;
  summarySheet.getRange(summaryRow, 2).setValue(unfcdCount);
  summarySheet
    .getRange(summaryRow, 1, 1, 2)
    .setBackground(unfcdCount === 0 ? "#6aa84f" : "#ff0000");

  if (options.stampLastFc && options.songName) {
    summarySheet
      .getRange(summaryRow, 3)
      .setValue(new Date())
      .setNumberFormat("dd-MM-yyyy");
    summarySheet.getRange(summaryRow, 4).setValue(options.songName);
  }

  fcBotEnsureSheetSize(summarySheet, config.summaryCounterRow, 5);

  var countValues = summarySheet
    .getRange(
      config.summaryStartRow,
      2,
      lastSetlistRow - config.summaryStartRow + 1,
      1
    )
    .getValues();
  var totalUnfcd = countValues.reduce(function(total, row) {
    var value = Number(row[0]);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);

  summarySheet
    .getRange(config.summaryCounterRow, 1, 1, 2)
    .setValues([["UnFC'd Songs:", totalUnfcd]])
    .setFontWeight("bold")
    .setBackground("#000000");

  fcBotUpdateSummarySongColumnUnlocked_(
    summarySheet,
    setlistSheet.getName(),
    unfcdSongs
  );

  return {
    updated: true,
    summaryRow: summaryRow,
    unfcdCount: unfcdCount,
    totalUnfcd: totalUnfcd
  };
}

function fcBotUpdateSummarySongColumnUnlocked_(summarySheet, setlistName, songs) {
  var firstDataColumn = 5;
  fcBotEnsureSheetSize(summarySheet, 2, firstDataColumn);

  var lastColumn = Math.max(firstDataColumn, summarySheet.getLastColumn());
  var headerWidth = lastColumn - firstDataColumn + 1;
  var headers = summarySheet
    .getRange(1, firstDataColumn, 1, headerWidth)
    .getDisplayValues()[0];
  var relativeIndex = headers.indexOf(setlistName);
  var targetColumn = relativeIndex === -1
    ? 0
    : firstDataColumn + relativeIndex;

  if (!songs.length) {
    if (targetColumn) {
      var existingLastRow = fcBotGetLastNonEmptyRow(
        summarySheet,
        targetColumn,
        2
      );

      // Preserve the row-1 setlist header. Only clear the prior song list.
      if (existingLastRow >= 2) {
        summarySheet
          .getRange(2, targetColumn, existingLastRow - 1, 1)
          .clearContent();
      }
    }
    return;
  }

  if (!targetColumn) {
    var actualLastColumn = summarySheet.getLastColumn();

    if (actualLastColumn < firstDataColumn) {
      fcBotEnsureSheetSize(
        summarySheet,
        Math.max(2, songs.length + 1),
        firstDataColumn
      );
      targetColumn = firstDataColumn;
    } else {
      summarySheet.insertColumnAfter(actualLastColumn);
      targetColumn = actualLastColumn + 1;
    }

    summarySheet.getRange(1, targetColumn).setValue(setlistName);
  }

  var oldLastRow = fcBotGetLastNonEmptyRow(
    summarySheet,
    targetColumn,
    2
  );
  var previousLength = oldLastRow >= 2 ? oldLastRow - 1 : 0;
  var clearLength = Math.max(previousLength, songs.length);

  if (clearLength > 0) {
    fcBotEnsureSheetSize(
      summarySheet,
      clearLength + 1,
      targetColumn
    );
    summarySheet
      .getRange(2, targetColumn, clearLength, 1)
      .clearContent();
  }

  summarySheet
    .getRange(2, targetColumn, songs.length, 1)
    .setValues(songs.map(function(song) {
      return [song];
    }));
}

/**
 * Applies one or more contributor count deltas and writes only the contiguous
 * section of Contributors!A:B that actually changed after re-sorting.
 */
function fcBotApplyContributorDeltasUnlocked_(rawDeltas, options) {
  if (typeof fcBotSafeApplyContributorDeltasUnlocked_ !== "function") {
    var missingSafety = new Error(
      "ContributorSafety.gs is missing. Contributor writes are disabled."
    );
    missingSafety.code = "CONTRIBUTOR_SAFETY_NOT_INSTALLED";
    throw missingSafety;
  }

  return fcBotSafeApplyContributorDeltasUnlocked_(rawDeltas, options || {});
}

function fcBotBuildProofMutationResult_(
  target,
  player,
  proofUrl,
  syncResult,
  previousPlayer
) {
  var songIndexState = syncResult && syncResult.songIndex;
  var catalogState =
    songIndexState && songIndexState.catalogRevision !== undefined
      ? {
          revision: songIndexState.catalogRevision,
          updatedAt: songIndexState.catalogUpdatedAt || ""
        }
      : (typeof fcBotGetAutocompleteCatalogRevision === "function"
          ? fcBotGetAutocompleteCatalogRevision()
          : { revision: "0", updatedAt: "" });

  var completeCatalogState =
    syncResult && syncResult._catalogState
      ? syncResult._catalogState
      : fcBotApiCatalogStatus_();

  return {
    songRef: target.songRef,
    songId: target.songId,
    song: target.songName,
    setlist: target.setlist,
    row: target.row,
    previousPlayer: fcBotNormalizeText(previousPlayer),
    player: player,
    proofUrl: proofUrl,
    catalogRevision: String(catalogState.revision || "0"),
    playerRevision: completeCatalogState.playerRevision,
    catalogToken: completeCatalogState.catalogToken,
    catalogUpdatedAt: catalogState.updatedAt || "",
    synchronization: syncResult
  };
}

/** Logging must never turn an already-committed mutation into an API failure. */
function fcBotWriteLogBestEffort_(action, status, details) {
  try {
    fcBotWriteLog(action, status, details);
  } catch (error) {
    console.error(
      "FCBot log write failed for " + action + ": " + error.message
    );
  }
}

/** Optional compatibility hook for the user's existing webhook script. */
function fcBotMaybeNotifyLegacyWebhook_(target, oldPlayer, newPlayer) {
  try {
    var config = fcBotGetConfig();
    if (config.notifyLegacyWebhook !== true) return;
    if (typeof outputOnEdit !== "function") return;

    outputOnEdit({
      range: target.fcerCell,
      source: fcBotGetSpreadsheet(),
      oldValue: oldPlayer || undefined,
      value: newPlayer || undefined
    });
  } catch (error) {
    fcBotWriteLogBestEffort_("legacy-webhook", "error", {
      songRef: target.songRef,
      message: error.message
    });
  }
}

function fcBotClampAutocompleteLimit_(value) {
  var config = fcBotGetConfig();
  var maxLimit = Math.min(
    25,
    Math.max(1, Number(config.autocompleteResultLimit) || 25)
  );
  var parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 1) return maxLimit;
  return Math.min(maxLimit, Math.floor(parsed));
}

function fcBotToBoolean_(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return Boolean(defaultValue);
  }
  if (typeof value === "boolean") return value;

  var normalized = fcBotNormalizeKey(value);
  if (["true", "1", "yes", "y", "on"].indexOf(normalized) !== -1) return true;
  if (["false", "0", "no", "n", "off"].indexOf(normalized) !== -1) return false;
  return Boolean(defaultValue);
}

function fcBotTruncate_(value, maximumLength) {
  var text = fcBotNormalizeText(value);
  maximumLength = Math.max(1, Number(maximumLength) || 1);
  if (text.length <= maximumLength) return text;
  if (maximumLength <= 1) return text.substring(0, maximumLength);
  return text.substring(0, maximumLength - 1) + "…";
}
