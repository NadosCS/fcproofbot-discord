const assert = require('node:assert/strict');
const test = require('node:test');

const storageModulePromise = import('../src/proof-image-storage.js');

const storageConfig = Object.freeze({
  enabled: true,
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  region: 'us-west-004',
  bucket: 'proof-bucket',
  keyId: 'test-key-id',
  applicationKey: 'test-application-key',
  publicBaseUrl: 'https://proof-bucket.s3.us-west-004.backblazeb2.com',
});

const discordAttachmentUrl =
  'https://cdn.discordapp.com/ephemeral-attachments/123/456/' +
  'proof.png?ex=test';

test('uploads a verified Discord image to a stable public B2 URL', async () => {
  const { createProofImageStorage } = await storageModulePromise;
  const png = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const sent = [];
  const storage = createProofImageStorage(storageConfig, {
    maxBytes: 1_024,
    downloadTimeoutMs: 1_000,
    uploadTimeoutMs: 1_000,
    fetchImpl: async () => new Response(png, {
      status: 200,
      headers: {
        'content-length': String(png.length),
        'content-type': 'image/png',
      },
    }),
    s3Client: {
      async send(command, options) {
        sent.push({ command, options });
        return {};
      },
    },
    now: () => new Date('2026-07-21T12:00:00.000Z'),
    makeId: () => 'fixed-id',
  });

  const result = await storage.upload({
    contentType: 'image/png',
    name: 'proof.png',
    size: png.length,
    url: discordAttachmentUrl,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].command.input.Bucket, 'proof-bucket');
  assert.equal(
    sent[0].command.input.Key,
    'proofs/2026/07/fixed-id.png',
  );
  assert.equal(sent[0].command.input.ContentType, 'image/png');
  assert.equal(sent[0].command.input.ContentDisposition, 'inline');
  assert.equal(sent[0].options.abortSignal.aborted, false);
  assert.equal(
    result.url,
    'https://proof-bucket.s3.us-west-004.backblazeb2.com/' +
      'proofs/2026/07/fixed-id.png',
  );
  assert.equal(result.size, png.length);
  assert.equal(result.filename, 'proof.png');
  assert.deepEqual(result.bytes, png);
});

test('rejects files whose bytes do not match the claimed image type', async () => {
  const { createProofImageStorage } = await storageModulePromise;
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);
  let uploadCalls = 0;
  const storage = createProofImageStorage(storageConfig, {
    maxBytes: 1_024,
    fetchImpl: async () => new Response(jpeg, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }),
    s3Client: {
      async send() {
        uploadCalls += 1;
      },
    },
  });

  await assert.rejects(
    storage.upload({
      contentType: 'image/png',
      name: 'not-really-a-png.png',
      size: jpeg.length,
      url: discordAttachmentUrl,
    }),
    (error) => error.code === 'INVALID_PROOF_IMAGE_CONTENT',
  );
  assert.equal(uploadCalls, 0);
});

test('rejects oversized attachments before downloading them', async () => {
  const { createProofImageStorage } = await storageModulePromise;
  let downloadCalls = 0;
  const storage = createProofImageStorage(storageConfig, {
    maxBytes: 10,
    fetchImpl: async () => {
      downloadCalls += 1;
      return new Response();
    },
    s3Client: { async send() {} },
  });

  await assert.rejects(
    storage.upload({
      contentType: 'image/png',
      name: 'large.png',
      size: 11,
      url: discordAttachmentUrl,
    }),
    (error) => error.code === 'PROOF_IMAGE_TOO_LARGE',
  );
  assert.equal(downloadCalls, 0);
});

test('embeds only direct HTTPS image URLs', async () => {
  const { isDirectImageUrl } = await storageModulePromise;

  assert.equal(
    isDirectImageUrl('https://proofs.example/image.PNG?version=1'),
    true,
  );
  assert.equal(
    isDirectImageUrl('https://example.com/gallery/image-id'),
    false,
  );
  assert.equal(isDirectImageUrl('http://example.com/proof.png'), false);
});

test('/addproof exposes optional image and URL proof inputs', async () => {
  const { commands } = await import('../src/commands.js');
  const addProof = commands.find((command) => command.name === 'addproof');
  const options = addProof.options;
  const imageOption = options.find((option) => option.name === 'proof_image');
  const urlOption = options.find((option) => option.name === 'proof');

  assert.equal(imageOption.type, 11);
  assert.equal(imageOption.required, false);
  assert.equal(urlOption.type, 3);
  assert.equal(urlOption.required, false);
});
