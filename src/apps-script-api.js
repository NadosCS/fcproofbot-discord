import { config } from './config.js';

export class AppsScriptApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AppsScriptApiError';
    this.code = options.code || 'API_ERROR';
    this.details = options.details ?? null;
    this.status = options.status ?? null;
    this.cause = options.cause;
  }
}

const requestCache = new Map();

let songCatalog = [];
let playerCatalog = [];
let catalogReady = false;
let catalogRevision = null;
let catalogPlayerRevision = null;
let catalogToken = null;
let catalogRemoteRevision = null;
let catalogRemoteToken = null;
let catalogUpdatedAt = null;
let catalogLoadedAt = null;
let catalogLastCheckedAt = null;
let catalogLastError = null;
let catalogLastErrorAt = null;
let catalogRefreshPromise = null;

function cacheKey(action, payload) {
  return `${action}:${JSON.stringify(payload)}`;
}

function getCached(key) {
  const entry = requestCache.get(key);
  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    requestCache.delete(key);
    return null;
  }

  return entry.value;
}

function setCached(key, value) {
  requestCache.set(key, {
    value,
    expiresAt: Date.now() + config.autocompleteCacheMs,
  });
}

export function clearAutocompleteCache() {
  requestCache.clear();
}

function makeApiTimeoutError(timeoutMs) {
  return new AppsScriptApiError(
    `The Apps Script request exceeded ${timeoutMs} ms.`,
    {
      code: 'API_TIMEOUT',
    },
  );
}

/**
 * Runs one Apps Script request behind both:
 * - an AbortController, which cancels fetch/body reading, and
 * - an explicit Promise race, which guarantees the caller is released when
 *   the deadline is reached.
 *
 * The timer is intentionally NOT unref'd. On some game/bot hosting panels,
 * unref'd timers can be delayed while the container is being paused or
 * rescheduled.
 */
async function withHardTimeout(requestFactory, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = makeApiTimeoutError(timeoutMs);
  let timeoutHandle;

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      requestFactory(controller.signal),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (cause) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 300);

    throw new AppsScriptApiError(
      'The Apps Script web app returned a non-JSON response. Confirm that the ' +
        'latest deployment is public, executes as you, and uses the /exec URL.',
      {
        code: 'INVALID_API_RESPONSE',
        status: response.status,
        details: preview || null,
        cause,
      },
    );
  }
}

export async function callAppsScript(
  action,
  payload = {},
  { timeoutMs = config.appsScriptTimeoutMs } = {},
) {
  const startedAt = Date.now();

  try {
    return await withHardTimeout(async (signal) => {
      const response = await fetch(config.appsScriptUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          accept: 'application/json',
        },
        body: JSON.stringify({
          action,
          apiKey: config.apiKey,
          ...payload,
        }),
        signal,
      });

      const result = await parseJsonResponse(response);

      if (!response.ok) {
        throw new AppsScriptApiError(
          result?.message || `Apps Script returned HTTP ${response.status}.`,
          {
            code: result?.code || 'HTTP_ERROR',
            details: result?.details,
            status: response.status,
          },
        );
      }

      if (!result || result.ok !== true) {
        throw new AppsScriptApiError(
          result?.message || 'The Apps Script request failed.',
          {
            code: result?.code || 'BACKEND_ERROR',
            details: result?.details,
            status: response.status,
          },
        );
      }

      return result.data;
    }, timeoutMs);
  } catch (error) {
    if (error instanceof AppsScriptApiError) {
      if (error.code === 'API_TIMEOUT') {
        error.details = {
          action,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
        };
      }

      throw error;
    }

    if (
      error?.name === 'AbortError' ||
      error?.code === 'ABORT_ERR'
    ) {
      const timeoutError = makeApiTimeoutError(timeoutMs);
      timeoutError.details = {
        action,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
      };
      timeoutError.cause = error;
      throw timeoutError;
    }

    throw new AppsScriptApiError(
      `Unable to contact Apps Script: ${error?.message || String(error)}`,
      {
        code: 'API_UNREACHABLE',
        details: {
          action,
          elapsedMs: Date.now() - startedAt,
        },
        cause: error,
      },
    );
  }
}

function normalizeLookupText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeRevision(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return null;

  const normalized = text.replace(/^0+(?=\d)/, '');
  return normalized || '0';
}

function revisionNumber(value) {
  const normalized = normalizeRevision(value);
  if (normalized === null) return null;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function numericCount(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppsScriptApiError(
      `Apps Script returned an invalid ${fieldName}.`,
      {
        code: 'INVALID_CATALOG_STATUS',
        details: { fieldName, value },
      },
    );
  }

  return parsed;
}

function describeStoredError(error) {
  if (!error) return null;

  return {
    name: error.name || 'Error',
    code: error.code || 'ERROR',
    message: error.message || String(error),
  };
}

function rememberCatalogError(error) {
  catalogLastError = error;
  catalogLastErrorAt = new Date();
}

function clearCatalogError() {
  catalogLastError = null;
  catalogLastErrorAt = null;
}

function makeSongRecord(row) {
  if (!Array.isArray(row) || row.length < 3) return null;

  const songRef = String(row[0] || '').trim();
  const song = String(row[1] || '').trim();
  const setlist = String(row[2] || '').trim();
  const fcPlayer = String(row[3] || '').trim();

  if (!/^\d+:\d+$/.test(songRef) || !song) return null;

  return {
    songRef,
    song,
    setlist,
    fcPlayer,
    songKey: normalizeLookupText(song),
    setlistKey: normalizeLookupText(setlist),
  };
}

function makePlayerRecord(row) {
  if (!Array.isArray(row) || row.length < 1) return null;

  const player = String(row[0] || '').trim();
  if (!player) return null;

  return {
    player,
    fcCount: Math.max(0, Number(row[1]) || 0),
    playerKey: normalizeLookupText(player),
  };
}

function sortPlayers(records) {
  records.sort((left, right) => {
    if (left.fcCount !== right.fcCount) {
      return right.fcCount - left.fcCount;
    }

    return left.player.localeCompare(right.player, undefined, {
      sensitivity: 'base',
    });
  });
}

function normalizeRemoteCatalogStatus(data) {
  const revision = normalizeRevision(data?.revision);
  if (revision === null) {
    throw new AppsScriptApiError(
      'The Apps Script deployment does not expose a valid catalog revision. ' +
        'Deploy the supplied DiscordAPI.gs and SongIndex.gs as a new web-app version.',
      {
        code: 'CATALOG_REVISION_MISSING',
      },
    );
  }

  const playerRevision = String(data?.playerRevision || '').trim();
  const token = String(data?.catalogToken || '').trim();

  if (!playerRevision || !token) {
    throw new AppsScriptApiError(
      'The Apps Script deployment does not expose the complete catalog token. ' +
        'Deploy the supplied DiscordAPI.gs as a new web-app version.',
      {
        code: 'CATALOG_TOKEN_MISSING',
      },
    );
  }

  return {
    revision,
    playerRevision,
    token,
    updatedAt: data?.updatedAt ? new Date(data.updatedAt) : null,
    reason: String(data?.reason || '').trim(),
    totalSongs: numericCount(data?.totalSongs, 'totalSongs'),
    totalPlayers: numericCount(data?.totalPlayers, 'totalPlayers'),
    dirty: Boolean(data?.dirty),
    busy: Boolean(data?.busy),
    generatedAt: data?.generatedAt ? new Date(data.generatedAt) : null,
  };
}

export async function fetchAutocompleteCatalogStatus() {
  const data = await callAppsScript(
    'catalogStatus',
    {},
    { timeoutMs: config.appsScriptTimeoutMs },
  );

  const status = normalizeRemoteCatalogStatus(data);
  catalogRemoteRevision = status.revision;
  catalogRemoteToken = status.token;
  catalogLastCheckedAt = new Date();

  return status;
}

/**
 * Downloads the compact Song Index in pages.
 *
 * Every page carries the same revision. The completed arrays replace the live
 * arrays only after:
 * - every page is received,
 * - the row counts match,
 * - no duplicate song references are present, and
 * - a final status check confirms that the revision did not change.
 */
export async function refreshAutocompleteCatalog({
  logProgress = false,
  expectedRevision = null,
} = {}) {
  if (catalogRefreshPromise) return catalogRefreshPromise;

  catalogRefreshPromise = (async () => {
    const nextSongs = [];
    let nextPlayers = [];
    let offset = 0;
    let downloadRevision = null;
    let downloadPlayerRevision = null;
    let downloadToken = null;
    let expectedTotalSongs = null;
    let expectedTotalPlayers = null;
    let downloadUpdatedAt = null;
    let pageNumber = 0;

    if (logProgress) {
      console.log('Loading local autocomplete catalog from Apps Script...');
    }

    while (true) {
      pageNumber += 1;

      if (pageNumber > 1000) {
        throw new AppsScriptApiError(
          'Autocomplete catalog pagination did not finish.',
          {
            code: 'CATALOG_PAGINATION_ERROR',
          },
        );
      }

      const data = await callAppsScript(
        'catalog',
        {
          offset,
          limit: config.autocompleteCatalogPageSize,
          includePlayers: offset === 0,
        },
        { timeoutMs: config.appsScriptTimeoutMs },
      );

      const pageRevision = normalizeRevision(data?.catalogRevision);
      const pagePlayerRevision =
        String(data?.playerRevision || '').trim();
      const pageToken = String(data?.catalogToken || '').trim();

      if (pageRevision === null || !pagePlayerRevision || !pageToken) {
        throw new AppsScriptApiError(
          'A catalog page did not include a valid revision token.',
          {
            code: 'CATALOG_TOKEN_MISSING',
          },
        );
      }

      if (downloadRevision === null) {
        downloadRevision = pageRevision;
        downloadPlayerRevision = pagePlayerRevision;
        downloadToken = pageToken;
        downloadUpdatedAt = data?.catalogUpdatedAt
          ? new Date(data.catalogUpdatedAt)
          : null;

        const requestedRevision = normalizeRevision(expectedRevision);
        if (
          requestedRevision !== null &&
          requestedRevision !== downloadRevision &&
          logProgress
        ) {
          console.log(
            `Catalog changed before download began: expected revision ` +
              `${requestedRevision}, downloading revision ${downloadRevision}.`,
          );
        }
      } else if (
        pageRevision !== downloadRevision ||
        pagePlayerRevision !== downloadPlayerRevision ||
        pageToken !== downloadToken
      ) {
        throw new AppsScriptApiError(
          'The autocomplete catalog changed while it was downloading. Retrying.',
          {
            code: 'CATALOG_CHANGED_DURING_DOWNLOAD',
            details: {
              firstToken: downloadToken,
              pageToken,
              pageNumber,
            },
          },
        );
      }

      const totalSongs = numericCount(data?.totalSongs, 'totalSongs');
      const totalPlayers = numericCount(data?.totalPlayers, 'totalPlayers');

      if (expectedTotalSongs === null) {
        expectedTotalSongs = totalSongs;
      } else if (totalSongs !== expectedTotalSongs) {
        throw new AppsScriptApiError(
          'The song count changed while the catalog was downloading.',
          {
            code: 'CATALOG_CHANGED_DURING_DOWNLOAD',
          },
        );
      }

      if (expectedTotalPlayers === null) {
        expectedTotalPlayers = totalPlayers;
      } else if (totalPlayers !== expectedTotalPlayers) {
        throw new AppsScriptApiError(
          'The player count changed while the catalog was downloading.',
          {
            code: 'CATALOG_CHANGED_DURING_DOWNLOAD',
          },
        );
      }

      const pageSongs = Array.isArray(data?.songs) ? data.songs : [];
      for (const row of pageSongs) {
        const record = makeSongRecord(row);
        if (record) nextSongs.push(record);
      }

      if (offset === 0) {
        if (!Array.isArray(data?.players)) {
          throw new AppsScriptApiError(
            'The first catalog page did not include the Player Index.',
            {
              code: 'CATALOG_PLAYERS_MISSING',
            },
          );
        }

        nextPlayers = data.players
          .map(makePlayerRecord)
          .filter(Boolean);
      }

      const rawNextOffset = data?.nextOffset;
      if (rawNextOffset === null || rawNextOffset === undefined) break;

      const nextOffset = Number(rawNextOffset);
      if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
        throw new AppsScriptApiError(
          'Apps Script returned an invalid catalog page offset.',
          {
            code: 'CATALOG_PAGINATION_ERROR',
          },
        );
      }

      offset = nextOffset;

      if (logProgress) {
        console.log(
          `Loaded ${nextSongs.length}/${expectedTotalSongs ?? '?'} songs...`,
        );
      }
    }

    if (nextSongs.length !== expectedTotalSongs) {
      throw new AppsScriptApiError(
        `Autocomplete catalog expected ${expectedTotalSongs} songs but ` +
          `received ${nextSongs.length}.`,
        {
          code: 'CATALOG_COUNT_MISMATCH',
        },
      );
    }

    if (nextPlayers.length !== expectedTotalPlayers) {
      throw new AppsScriptApiError(
        `Autocomplete catalog expected ${expectedTotalPlayers} players but ` +
          `received ${nextPlayers.length}.`,
        {
          code: 'CATALOG_PLAYER_COUNT_MISMATCH',
        },
      );
    }

    const uniqueSongRefs = new Set(nextSongs.map((record) => record.songRef));
    if (uniqueSongRefs.size !== nextSongs.length) {
      throw new AppsScriptApiError(
        'The downloaded catalog contains duplicate song references.',
        {
          code: 'CATALOG_DUPLICATE_REFERENCES',
        },
      );
    }

    const finalStatus = await fetchAutocompleteCatalogStatus();

    if (finalStatus.busy || finalStatus.dirty) {
      throw new AppsScriptApiError(
        'The Song Index changed while the catalog was downloading. Retrying.',
        {
          code: 'CATALOG_CHANGED_DURING_DOWNLOAD',
        },
      );
    }

    if (
      finalStatus.token !== downloadToken ||
      finalStatus.revision !== downloadRevision ||
      finalStatus.playerRevision !== downloadPlayerRevision ||
      finalStatus.totalSongs !== expectedTotalSongs ||
      finalStatus.totalPlayers !== expectedTotalPlayers
    ) {
      throw new AppsScriptApiError(
        'The autocomplete catalog changed before the download completed. Retrying.',
        {
          code: 'CATALOG_CHANGED_DURING_DOWNLOAD',
          details: {
            downloadedToken: downloadToken,
            currentToken: finalStatus.token,
          },
        },
      );
    }

    sortPlayers(nextPlayers);

    // Atomic replacement: autocomplete continues using the previous complete
    // arrays until every validation above succeeds.
    songCatalog = nextSongs;
    playerCatalog = nextPlayers;
    catalogReady = true;
    catalogRevision = downloadRevision;
    catalogPlayerRevision = downloadPlayerRevision;
    catalogToken = downloadToken;
    catalogRemoteRevision = finalStatus.revision;
    catalogRemoteToken = finalStatus.token;
    catalogUpdatedAt = downloadUpdatedAt || finalStatus.updatedAt;
    catalogLoadedAt = new Date();
    clearCatalogError();
    clearAutocompleteCache();

    if (logProgress) {
      console.log(
        `Local autocomplete ready at revision ${catalogRevision}: ` +
          `${songCatalog.length} songs, ${playerCatalog.length} players.`,
      );
    }

    return {
      ...getAutocompleteCatalogStatus(),
      changed: true,
    };
  })()
    .catch((error) => {
      rememberCatalogError(error);
      throw error;
    })
    .finally(() => {
      catalogRefreshPromise = null;
    });

  return catalogRefreshPromise;
}

/**
 * Performs a cheap revision check. A full download occurs only when the
 * backend revision/counts differ, the local catalog is not ready, or force is
 * true.
 */
export async function synchronizeAutocompleteCatalog({
  force = false,
  logProgress = false,
  reason = 'scheduled',
} = {}) {
  if (catalogRefreshPromise) return catalogRefreshPromise;

  try {
    const remote = await fetchAutocompleteCatalogStatus();

    if (remote.busy || remote.dirty) {
      return {
        ...getAutocompleteCatalogStatus(),
        changed: false,
        deferred: true,
        reason,
      };
    }

    const needsRefresh =
      force ||
      !catalogReady ||
      catalogToken !== remote.token ||
      catalogRevision !== remote.revision ||
      catalogPlayerRevision !== remote.playerRevision ||
      songCatalog.length !== remote.totalSongs ||
      playerCatalog.length !== remote.totalPlayers;

    if (!needsRefresh) {
      clearCatalogError();

      return {
        ...getAutocompleteCatalogStatus(),
        changed: false,
        deferred: false,
        reason,
      };
    }

    return refreshAutocompleteCatalog({
      logProgress,
      expectedRevision: remote.revision,
    });
  } catch (error) {
    rememberCatalogError(error);
    throw error;
  }
}

export function getAutocompleteCatalogStatus() {
  return {
    ready: catalogReady,
    refreshing: Boolean(catalogRefreshPromise),
    songs: songCatalog.length,
    players: playerCatalog.length,
    revision: catalogRevision,
    playerRevision: catalogPlayerRevision,
    token: catalogToken,
    remoteRevision: catalogRemoteRevision,
    remoteToken: catalogRemoteToken,
    catalogUpdatedAt,
    loadedAt: catalogLoadedAt,
    lastCheckedAt: catalogLastCheckedAt,
    lastError: describeStoredError(catalogLastError),
    lastErrorAt: catalogLastErrorAt,
  };
}

function songMatchRank(record, queryKey) {
  if (record.songKey === queryKey) return 0;
  if (record.songKey.startsWith(queryKey)) return 1;
  if (record.songKey.includes(queryKey)) return 2;
  if (record.setlistKey.startsWith(queryKey)) return 3;
  if (record.setlistKey.includes(queryKey)) return 4;
  return null;
}

function insertBoundedSorted(list, value, compare, limit) {
  let low = 0;
  let high = list.length;

  while (low < high) {
    const middle = (low + high) >> 1;

    if (compare(value, list[middle]) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  if (low >= limit && list.length >= limit) return;

  list.splice(low, 0, value);

  if (list.length > limit) {
    list.pop();
  }
}

function compareSongRecords(left, right) {
  const songComparison = left.song.localeCompare(
    right.song,
    undefined,
    { sensitivity: 'base' },
  );

  if (songComparison !== 0) return songComparison;

  return left.setlist.localeCompare(
    right.setlist,
    undefined,
    { sensitivity: 'base' },
  );
}

function searchLocalSongs(query, onlyUnfcd, limit = 25) {
  const queryKey = normalizeLookupText(query);
  if (!queryKey) return [];

  // Keep only the best `limit` records for each rank instead of collecting and
  // sorting every match. Broad one-character queries can match thousands of
  // songs; bounding each bucket prevents those autocomplete interactions from
  // blocking the Node event loop.
  const buckets = Array.from({ length: 5 }, () => []);

  for (const record of songCatalog) {
    if (onlyUnfcd && record.fcPlayer) continue;

    const rank = songMatchRank(record, queryKey);
    if (rank === null) continue;

    insertBoundedSorted(
      buckets[rank],
      record,
      compareSongRecords,
      limit,
    );
  }

  const output = [];

  for (const bucket of buckets) {
    for (const record of bucket) {
      output.push(record);
      if (output.length >= limit) return output;
    }
  }

  return output;
}

function comparePlayerRecords(left, right) {
  if (left.fcCount !== right.fcCount) {
    return right.fcCount - left.fcCount;
  }

  return left.player.localeCompare(
    right.player,
    undefined,
    { sensitivity: 'base' },
  );
}

function searchLocalPlayers(query, limit = 25) {
  const queryKey = normalizeLookupText(query);
  if (!queryKey) return [];

  const buckets = Array.from({ length: 3 }, () => []);

  for (const record of playerCatalog) {
    let rank = null;

    if (record.playerKey === queryKey) rank = 0;
    else if (record.playerKey.startsWith(queryKey)) rank = 1;
    else if (record.playerKey.includes(queryKey)) rank = 2;

    if (rank === null) continue;

    insertBoundedSorted(
      buckets[rank],
      record,
      comparePlayerRecords,
      limit,
    );
  }

  const output = [];

  for (const bucket of buckets) {
    for (const record of bucket) {
      output.push(record);
      if (output.length >= limit) return output;
    }
  }

  return output;
}

export async function searchSongs(query, onlyUnfcd) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];

  if (catalogReady) {
    return searchLocalSongs(normalizedQuery, onlyUnfcd, 25).map((record) => ({
      name: `${record.song} — ${record.setlist}`,
      value: record.songRef,
    }));
  }

  // Do not repeatedly start slow web requests while the startup catalog is
  // still loading. Discord will show no options for those few seconds.
  if (catalogRefreshPromise) return [];

  const payload = {
    q: normalizedQuery,
    limit: 25,
    onlyUnfcd,
  };
  const key = cacheKey('songs', payload);
  const cached = getCached(key);
  if (cached) return cached;

  const data = await callAppsScript('songs', payload, {
    timeoutMs: config.autocompleteTimeoutMs,
  });

  const choices = Array.isArray(data?.choices)
    ? data.choices.slice(0, 25)
    : [];

  setCached(key, choices);
  return choices;
}

export async function searchPlayers(query) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];

  if (catalogReady) {
    return searchLocalPlayers(normalizedQuery, 25).map((record) => {
      const suffix = record.fcCount === 1
        ? '1 FC'
        : `${record.fcCount} FCs`;

      return {
        name: `${record.player} — ${suffix}`,
        value: record.player,
      };
    });
  }

  if (catalogRefreshPromise) return [];

  const payload = {
    q: normalizedQuery,
    limit: 25,
  };
  const key = cacheKey('players', payload);
  const cached = getCached(key);
  if (cached) return cached;

  const data = await callAppsScript('players', payload, {
    timeoutMs: config.autocompleteTimeoutMs,
  });

  const choices = Array.isArray(data?.choices)
    ? data.choices.slice(0, 25)
    : [];

  setCached(key, choices);
  return choices;
}

function isSongReference(value) {
  return /^\d+:\d+$/.test(String(value || '').trim());
}

function chooseSongReference(records, rawInput) {
  if (records.length === 0) {
    throw new AppsScriptApiError(`No song matched "${rawInput}".`, {
      code: 'SONG_NOT_FOUND',
    });
  }

  const queryKey = normalizeLookupText(rawInput);
  const exactMatches = records.filter(
    (record) => record.songKey === queryKey,
  );

  if (exactMatches.length === 1) return exactMatches[0].songRef;
  if (records.length === 1) return records[0].songRef;

  const prefixMatches = records.filter((record) =>
    record.songKey.startsWith(queryKey));

  if (prefixMatches.length === 1) return prefixMatches[0].songRef;

  const examples = records
    .slice(0, 5)
    .map((record) => `${record.song} — ${record.setlist}`)
    .join('\n');

  throw new AppsScriptApiError(
    `More than one song matched "${rawInput}". Type the full song title.\n${examples}`,
    {
      code: 'AMBIGUOUS_SONG_QUERY',
    },
  );
}

/**
 * Accepts either the hidden autocomplete songRef or ordinary typed song text.
 */
export async function resolveSongReference(input, { onlyUnfcd = false } = {}) {
  const rawInput = String(input || '').trim();

  if (!rawInput) {
    throw new AppsScriptApiError('Enter a song name.', {
      code: 'MISSING_SONG_QUERY',
    });
  }

  if (isSongReference(rawInput)) return rawInput;

  if (catalogReady) {
    return chooseSongReference(
      searchLocalSongs(rawInput, onlyUnfcd, 25),
      rawInput,
    );
  }

  const data = await callAppsScript(
    'songs',
    {
      q: rawInput,
      limit: 25,
      onlyUnfcd,
    },
    { timeoutMs: config.appsScriptTimeoutMs },
  );

  const records = (Array.isArray(data?.songs) ? data.songs : [])
    .map((record) => ({
      songRef: String(record?.songRef || '').trim(),
      song: String(record?.song || '').trim(),
      setlist: String(record?.setlist || '').trim(),
      fcPlayer: String(record?.fcPlayer || '').trim(),
      songKey: normalizeLookupText(record?.song),
      setlistKey: normalizeLookupText(record?.setlist),
    }))
    .filter((record) => record.songRef && record.song);

  return chooseSongReference(records, rawInput);
}

function adjustLocalPlayer(playerName, delta) {
  const name = String(playerName || '').trim();
  if (!name || !delta) return;

  const key = normalizeLookupText(name);
  const existingIndex = playerCatalog.findIndex(
    (record) => record.playerKey === key,
  );

  if (existingIndex === -1) {
    if (delta > 0) {
      playerCatalog.push({
        player: name,
        fcCount: delta,
        playerKey: key,
      });
    }
    return;
  }

  const record = playerCatalog[existingIndex];
  record.player = name;
  record.playerKey = key;
  record.fcCount = Math.max(0, record.fcCount + delta);

  if (record.fcCount === 0) {
    playerCatalog.splice(existingIndex, 1);
  }
}

/**
 * Applies the exact add/edit/remove mutation to the in-memory catalog.
 *
 * The local revision is advanced only when the backend revision is exactly
 * the next revision. If another sheet change happened first, the revision is
 * intentionally left stale so the scheduled synchronizer downloads everything.
 */
export function applyLocalProofMutation(data) {
  const songRef = String(data?.songRef || '').trim();
  const previousPlayer = String(data?.previousPlayer || '').trim();
  const nextPlayer = String(data?.player || '').trim();

  const songRecord = songCatalog.find(
    (record) => record.songRef === songRef,
  );

  if (songRecord) {
    songRecord.fcPlayer = nextPlayer;
  }

  const previousKey = normalizeLookupText(previousPlayer);
  const nextKey = normalizeLookupText(nextPlayer);

  if (previousKey !== nextKey) {
    adjustLocalPlayer(previousPlayer, -1);
    adjustLocalPlayer(nextPlayer, 1);
  } else if (nextKey) {
    const existingPlayer = playerCatalog.find(
      (record) => record.playerKey === nextKey,
    );

    if (existingPlayer) {
      existingPlayer.player = nextPlayer;
    }
  }

  sortPlayers(playerCatalog);
  clearAutocompleteCache();

  const backendRevision = normalizeRevision(data?.catalogRevision);
  const backendPlayerRevision =
    String(data?.playerRevision || '').trim() || null;
  const backendToken =
    String(data?.catalogToken || '').trim() || null;
  const localNumber = revisionNumber(catalogRevision);
  const backendNumber = revisionNumber(backendRevision);
  let revisionApplied = false;

  if (
    backendRevision !== null &&
    backendPlayerRevision &&
    backendToken &&
    localNumber !== null &&
    backendNumber !== null &&
    (backendNumber === localNumber || backendNumber === localNumber + 1)
  ) {
    catalogRevision = backendRevision;
    catalogPlayerRevision = backendPlayerRevision;
    catalogToken = backendToken;
    catalogRemoteRevision = backendRevision;
    catalogRemoteToken = backendToken;
    catalogUpdatedAt = data?.catalogUpdatedAt
      ? new Date(data.catalogUpdatedAt)
      : catalogUpdatedAt;
    revisionApplied = true;
  } else {
    if (backendRevision !== null) {
      catalogRemoteRevision = backendRevision;
    }
    if (backendToken) {
      catalogRemoteToken = backendToken;
    }
  }

  return {
    revisionApplied,
    localRevision: catalogRevision,
    localToken: catalogToken,
    backendRevision,
    backendToken,
  };
}

/** Compatibility helper retained for older index.js imports. */
export function updateLocalSong(songRef, player) {
  const wanted = String(songRef || '').trim();
  const record = songCatalog.find((song) => song.songRef === wanted);

  if (record) {
    record.fcPlayer = String(player || '').trim();
  }

  clearAutocompleteCache();
}
