import { isDirectImageUrl } from './proof-image-storage.js';

const IMG_CHEST_PAGE_HOSTS = new Set([
  'imgchest.com',
  'www.imgchest.com',
]);

const IMG_CHEST_IMAGE_HOST = 'cdn.imgchest.com';
const MAX_PAGE_BYTES = 1_000_000;

function imgChestPostId(value) {
  try {
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/p\/([a-z0-9]+)\/?$/i);

    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      !IMG_CHEST_PAGE_HOSTS.has(parsed.hostname.toLowerCase()) ||
      !match
    ) {
      return null;
    }

    return match[1];
  } catch {
    return null;
  }
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&(amp|quot|apos|#39|lt|gt);/gi, (entity) => {
      const replacements = {
        '&amp;': '&',
        '&quot;': '"',
        '&apos;': "'",
        '&#39;': "'",
        '&lt;': '<',
        '&gt;': '>',
      };

      return replacements[entity.toLowerCase()] ?? entity;
    });
}

function attributesFromTag(tag) {
  const attributes = new Map();
  const pattern =
    /([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  for (const match of tag.matchAll(pattern)) {
    attributes.set(
      match[1].toLowerCase(),
      decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? ''),
    );
  }

  return attributes;
}

function imgChestPreviewFromHtml(html) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = attributesFromTag(match[0]);
    const property = (
      attributes.get('property') ?? attributes.get('name') ?? ''
    ).toLowerCase();

    if (property !== 'og:image' && property !== 'twitter:image') {
      continue;
    }

    const content = attributes.get('content');
    if (!content) continue;

    try {
      const parsed = new URL(content, 'https://imgchest.com');
      if (
        parsed.protocol === 'https:' &&
        parsed.hostname.toLowerCase() === IMG_CHEST_IMAGE_HOST &&
        parsed.pathname.startsWith('/files/') &&
        isDirectImageUrl(parsed.href)
      ) {
        return parsed.href;
      }
    } catch {
      // Ignore malformed metadata and continue looking for another image tag.
    }
  }

  return null;
}

async function fetchImgChestPreview(postId, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchImpl(
      `https://imgchest.com/p/${postId}`,
      {
        headers: {
          accept: 'text/html',
          'user-agent': 'FCBot proof preview',
        },
        redirect: 'error',
        signal: controller.signal,
      },
    );

    if (!response?.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('text/html')) return null;

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_BYTES) {
      return null;
    }

    const html = await response.text();
    if (new TextEncoder().encode(html).byteLength > MAX_PAGE_BYTES) {
      return null;
    }

    return imgChestPreviewFromHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createProofPreviewResolver(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const successCacheMs = options.successCacheMs ?? 6 * 60 * 60 * 1_000;
  const failureCacheMs = options.failureCacheMs ?? 5 * 60 * 1_000;
  const currentTime = options.currentTime ?? Date.now;
  const cache = new Map();

  return Object.freeze({
    async resolve(proofUrl) {
      if (isDirectImageUrl(proofUrl)) return proofUrl;

      const postId = imgChestPostId(proofUrl);
      if (!postId) return null;

      const cacheKey = `imgchest:${postId.toLowerCase()}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > currentTime()) {
        return cached.value;
      }

      const previewUrl = await fetchImgChestPreview(postId, {
        fetchImpl,
        timeoutMs,
      });

      cache.set(cacheKey, {
        value: previewUrl,
        expiresAt:
          currentTime() + (previewUrl ? successCacheMs : failureCacheMs),
      });

      return previewUrl;
    },
  });
}
