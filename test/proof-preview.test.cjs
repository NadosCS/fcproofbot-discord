const assert = require('node:assert/strict');
const test = require('node:test');

const previewModulePromise = import('../src/proof-preview.js');

test('resolves and caches the first ImgChest social-preview image', async () => {
  const { createProofPreviewResolver } = await previewModulePromise;
  let fetchCalls = 0;
  const resolver = createProofPreviewResolver({
    fetchImpl: async (url, request) => {
      fetchCalls += 1;
      assert.equal(url, 'https://imgchest.com/p/abc123');
      assert.equal(request.redirect, 'error');

      return new Response(
        '<html><head>' +
          '<meta content="https://cdn.imgchest.com/files/proof.png' +
          '?width=1200&amp;height=900" property="og:image">' +
          '</head></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        },
      );
    },
    currentTime: () => 1_000,
  });

  const expected =
    'https://cdn.imgchest.com/files/proof.png?width=1200&height=900';

  assert.equal(
    await resolver.resolve('https://www.imgchest.com/p/abc123?ignored=1'),
    expected,
  );
  assert.equal(
    await resolver.resolve('https://imgchest.com/p/abc123'),
    expected,
  );
  assert.equal(fetchCalls, 1);
});

test('returns direct image links without making a preview request', async () => {
  const { createProofPreviewResolver } = await previewModulePromise;
  let fetchCalls = 0;
  const resolver = createProofPreviewResolver({
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response();
    },
  });
  const imageUrl = 'https://proofs.example/proof.webp?version=2';

  assert.equal(await resolver.resolve(imageUrl), imageUrl);
  assert.equal(fetchCalls, 0);
});

test('ignores untrusted image URLs in ImgChest page metadata', async () => {
  const { createProofPreviewResolver } = await previewModulePromise;
  const resolver = createProofPreviewResolver({
    fetchImpl: async () => new Response(
      '<meta property="og:image" ' +
        'content="https://attacker.example/not-proof.png">',
      {
        status: 200,
        headers: { 'content-type': 'text/html' },
      },
    ),
  });

  assert.equal(
    await resolver.resolve('https://imgchest.com/p/abc123'),
    null,
  );
});
