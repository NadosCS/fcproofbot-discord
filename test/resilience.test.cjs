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
        songs: [['123:45', 'Song', 'Setlist', '']],
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
});
