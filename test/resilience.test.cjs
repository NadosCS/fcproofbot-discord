const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApiContext() {
  const filename = path.resolve(__dirname, '../src/apps-script-api.js');
  let source = fs.readFileSync(filename, 'utf8');
  source = source.replace(
    "import { config } from './config.js';",
    'const config = globalThis.__testConfig;',
  );
  source = source.replace(/\bexport\s+/g, '');
  source += `
    globalThis.__api = {
      AppsScriptApiError,
      callAppsScript,
      callProofMutation,
      resolveAutocompleteSongLabel,
      resolveSongSelection,
      synchronizeAutocompleteCatalog,
    };
  `;

  const quietConsole = {
    log() {},
    warn() {},
    error() {},
  };
  const context = vm.createContext({
    __testConfig: {
      appsScriptUrl: 'https://script.google.com/macros/s/test/exec',
      apiKey: 'test-key',
      appsScriptTimeoutMs: 1_000,
      autocompleteStatusTimeoutMs: 500,
      autocompleteTimeoutMs: 200,
      autocompleteCacheMs: 20_000,
      autocompleteCatalogPageSize: 5_000,
      proofBusyRetryAttempts: 2,
      proofBusyRetryBaseMs: 1,
    },
    AbortController,
    Array,
    Boolean,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Response,
    Set,
    String,
    TypeError,
    clearTimeout,
    console: quietConsole,
    fetch: null,
    setTimeout,
  });

  vm.runInContext(source, context, { filename });
  return context;
}

function loadAppsScriptContext() {
  const context = vm.createContext({
    Array,
    Boolean,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Set,
    String,
    console: { log() {}, warn() {}, error() {} },
  });
  const files = [
    'Config.gs',
    'Helpers.gs',
    'SongIndex.gs',
    'DiscordAPI.gs',
  ];

  for (const name of files) {
    const filename = path.resolve(__dirname, '../apps-script', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, {
      filename,
    });
  }

  return context;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('typed autocomplete display labels resolve to their hidden song ref', () => {
  const context = loadApiContext();
  const records = [{
    songRef: '123:45',
    song: 'A Red Letter Day',
    setlist: 'Zancharted VII: Septuple Schmingus',
  }];

  assert.equal(
    context.__api.resolveAutocompleteSongLabel(
      records,
      'A Red Letter Day \u2014 Zancharted VII: Septuple Schmingus',
    ),
    '123:45',
  );
  assert.equal(
    context.__api.resolveAutocompleteSongLabel(
      records,
      'A Red Letter Day \u2013 Zancharted VII: Septuple Schmingus',
    ),
    '123:45',
  );
});

test('stable song IDs are valid compact references', () => {
  const context = loadAppsScriptContext();
  const songId = '550e8400-e29b-41d4-a716-446655440000';

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.fcBotParseSongRef(`id:${songId}`))),
    { songId, stable: true },
  );
  assert.equal(
    context.fcBotCreateStableSongRef(songId.toUpperCase()),
    `id:${songId}`,
  );
});

test('expected song identity rejects a shifted legacy row', () => {
  const context = loadAppsScriptContext();
  let refreshes = 0;
  context.fcBotUpdateSongIndexForSheetUnlocked_ = () => {
    refreshes += 1;
  };

  assert.throws(
    () => context.fcBotAssertExpectedSongIdentity_(
      { songRef: '123:45' },
      {
        songName: 'Song Below',
        sheetName: 'Setlist',
        songId: '550e8400-e29b-41d4-a716-446655440000',
        sheet: {},
        row: 45,
      },
      {
        expectedSong: 'Selected Song',
        expectedSetlist: 'Setlist',
      },
    ),
    (error) => error.code === 'STALE_SONG_REFERENCE',
  );
  assert.equal(refreshes, 1);
});

test('expected song identity accepts a matching Song Index ID', () => {
  const context = loadAppsScriptContext();
  const songId = '550e8400-e29b-41d4-a716-446655440000';
  let refreshes = 0;
  context.fcBotUpdateSongIndexForSheetUnlocked_ = () => {
    refreshes += 1;
  };

  assert.doesNotThrow(
    () => context.fcBotAssertExpectedSongIdentity_(
      {
        songRef: `id:${songId}`,
        songId,
      },
      {
        songName: 'Selected Song',
        sheetName: 'Setlist',
        songId,
        sheet: {},
        row: 45,
      },
      {
        expectedSong: 'Selected Song',
        expectedSetlist: 'Setlist',
        expectedSongId: songId,
      },
    ),
  );
  assert.equal(refreshes, 0);
});

test('stable song IDs survive a unique song moving to another row', () => {
  const context = loadAppsScriptContext();
  const songId = '550e8400-e29b-41d4-a716-446655440000';
  const rows = [[
    '123:9',
    'Moved Song',
    'Setlist',
    123,
    9,
    '',
    '',
    new Date(),
    '',
  ]];
  const existing = [{
    songId,
    song: 'Moved Song',
    setlist: 'Setlist',
    sheetId: 123,
    row: 10,
  }];

  context.Utilities = {
    getUuid: () => {
      throw new Error('a unique match should reuse its existing ID');
    },
  };
  context.fcBotAssignStableSongIdsToRows_(rows, existing);

  assert.equal(rows[0][0], `id:${songId}`);
  assert.equal(rows[0][8], songId);
  assert.equal(rows[0][4], 9);
});

test('ambiguous duplicate song names receive fresh Song Index-only IDs', () => {
  const context = loadAppsScriptContext();
  const oldIds = [
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440001',
  ];
  const newIds = [
    '550e8400-e29b-41d4-a716-446655440010',
    '550e8400-e29b-41d4-a716-446655440011',
  ];
  const rows = [
    ['123:4', 'Duplicate', 'Setlist', 123, 4, '', '', new Date(), ''],
    ['123:8', 'Duplicate', 'Setlist', 123, 8, '', '', new Date(), ''],
  ];
  const existing = [
    { songId: oldIds[0], song: 'Duplicate', sheetId: 123, row: 5 },
    { songId: oldIds[1], song: 'Duplicate', sheetId: 123, row: 9 },
  ];
  let generated = 0;

  context.Utilities = {
    getUuid: () => newIds[generated++],
  };
  context.fcBotAssignStableSongIdsToRows_(rows, existing);

  assert.deepEqual(
    rows.map((row) => row[8]),
    newIds,
  );
  assert.deepEqual(
    rows.map((row) => row[0]),
    newIds.map((songId) => `id:${songId}`),
  );
  assert.equal(rows[0].length, 9);
  assert.equal(rows[1].length, 9);
});

test('proof mutations retry only explicit pre-commit BACKEND_BUSY responses', async () => {
  const context = loadApiContext();
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return jsonResponse({
        ok: false,
        code: 'BACKEND_BUSY',
        message: 'busy',
      });
    }
    return jsonResponse({ ok: true, data: { committed: true } });
  };

  const result = await context.__api.callProofMutation(
    'addProof',
    { songRef: '123:45' },
    { retryDelaysMs: [0, 0] },
  );
  assert.equal(calls, 3);
  assert.equal(result.committed, true);
});

test('proof mutations never retry uncertain transport failures', async () => {
  const context = loadApiContext();
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };

  await assert.rejects(
    context.__api.callProofMutation(
      'addProof',
      { songRef: '123:45' },
      { retryDelaysMs: [0, 0] },
    ),
    (error) => error.code === 'API_UNREACHABLE',
  );
  assert.equal(calls, 1);
});

test('Google HTML 404 responses are classified as transient', async () => {
  const context = loadApiContext();
  context.fetch = async () => new Response('<!DOCTYPE html><html></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });

  await assert.rejects(
    context.__api.callAppsScript('catalogStatus'),
    (error) => error.code === 'TRANSIENT_API_RESPONSE',
  );
});

test('overlapping catalog synchronizations share one request sequence', async () => {
  const context = loadApiContext();
  const stableRef =
    'id:550e8400-e29b-41d4-a716-446655440000';
  let calls = 0;
  context.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    await new Promise((resolve) => setTimeout(resolve, 5));

    if (request.action === 'catalogStatus') {
      return jsonResponse({
        ok: true,
        data: {
          revision: '7',
          playerRevision: 'players-1',
          catalogToken: '7.players-1',
          totalSongs: 1,
          totalPlayers: 1,
          busy: false,
          dirty: false,
        },
      });
    }

    return jsonResponse({
      ok: true,
      data: {
        songs: [[stableRef, 'Song', 'Setlist', '']],
        players: [['Alice', 1]],
        totalSongs: 1,
        totalPlayers: 1,
        nextOffset: null,
        catalogRevision: '7',
        playerRevision: 'players-1',
        catalogToken: '7.players-1',
      },
    });
  };

  const [first, second] = await Promise.all([
    context.__api.synchronizeAutocompleteCatalog({ reason: 'one' }),
    context.__api.synchronizeAutocompleteCatalog({ reason: 'two' }),
  ]);

  assert.equal(calls, 3);
  assert.equal(first.changed, true);
  assert.equal(second.changed, true);
  assert.equal(first.songs, 1);

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await context.__api.resolveSongSelection(stableRef),
    )),
    {
      songRef: stableRef,
      songId: '550e8400-e29b-41d4-a716-446655440000',
      song: 'Song',
      setlist: 'Setlist',
    },
  );
});
