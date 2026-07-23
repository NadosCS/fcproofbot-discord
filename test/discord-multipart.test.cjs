const assert = require('node:assert/strict');
const test = require('node:test');

const multipartModulePromise = import('../src/discord-multipart.js');

test('builds a Discord attachment payload for an embedded proof image', async () => {
  const { createDiscordMultipartBody } = await multipartModulePromise;
  const body = createDiscordMultipartBody(
    {
      embeds: [
        {
          image: { url: 'attachment://proof.png' },
        },
      ],
    },
    {
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: 'image/png',
      filename: 'proof.png',
      description: 'Proof for Test Song',
    },
  );

  const payload = JSON.parse(body.get('payload_json'));
  const file = body.get('files[0]');

  assert.deepEqual(payload.attachments, [
    {
      id: 0,
      filename: 'proof.png',
      description: 'Proof for Test Song',
    },
  ]);
  assert.equal(
    payload.embeds[0].image.url,
    'attachment://proof.png',
  );
  assert.equal(file.name, 'proof.png');
  assert.equal(file.type, 'image/png');
  assert.equal(file.size, 4);
});
