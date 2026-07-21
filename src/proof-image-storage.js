import { randomUUID } from 'node:crypto';

import {
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const IMAGE_TYPES = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});

const DISCORD_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);

export class ProofImageStorageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProofImageStorageError';
    this.code = options.code ?? 'PROOF_IMAGE_STORAGE_ERROR';
    this.cause = options.cause;
  }
}

function normalizeImageType(value) {
  const normalized = String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function validateDiscordAttachmentUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    parsed.protocol === 'https:' &&
    DISCORD_ATTACHMENT_HOSTS.has(parsed.hostname.toLowerCase()) &&
    parsed.pathname.startsWith('/attachments/')
  );
}

export function detectImageType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

export function isDirectImageUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      /\.(?:gif|jpe?g|png|webp)$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function appendObjectKey(publicBaseUrl, objectKey) {
  const encodedKey = objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `${publicBaseUrl.replace(/\/+$/, '')}/${encodedKey}`;
}

function makeObjectKey(now, id, extension) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `proofs/${year}/${month}/${id}${extension}`;
}

async function withAbortTimeout(timeoutMs, callback) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await callback(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function attachmentValidationError(attachment, maxBytes) {
  const claimedType = normalizeImageType(attachment?.contentType);
  if (claimedType && !IMAGE_TYPES[claimedType]) {
    return new ProofImageStorageError(
      'The proof image must be a PNG, JPEG, or WebP file.',
      { code: 'UNSUPPORTED_PROOF_IMAGE' },
    );
  }

  if (!Number.isFinite(attachment?.size) || attachment.size <= 0) {
    return new ProofImageStorageError(
      'The attached proof image is empty or has an invalid size.',
      { code: 'INVALID_PROOF_IMAGE_SIZE' },
    );
  }

  if (attachment.size > maxBytes) {
    const maxMegabytes = Math.floor(maxBytes / (1_024 * 1_024));
    return new ProofImageStorageError(
      `The proof image must be ${maxMegabytes} MB or smaller.`,
      { code: 'PROOF_IMAGE_TOO_LARGE' },
    );
  }

  if (!validateDiscordAttachmentUrl(attachment.url)) {
    return new ProofImageStorageError(
      'The proof attachment did not contain a valid Discord image URL.',
      { code: 'INVALID_PROOF_IMAGE_URL' },
    );
  }

  return null;
}

export function createProofImageStorage(
  storageConfig,
  options = {},
) {
  if (!storageConfig?.enabled) {
    return Object.freeze({
      enabled: false,
      async upload() {
        throw new ProofImageStorageError(
          'Image uploads are not configured yet. Submit a proof URL instead ' +
            'or ask an administrator to configure Backblaze B2.',
          { code: 'PROOF_IMAGE_STORAGE_NOT_CONFIGURED' },
        );
      },
    });
  }

  const maxBytes = options.maxBytes ?? 10 * 1_024 * 1_024;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 15_000;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const makeId = options.makeId ?? randomUUID;
  const client = options.s3Client ?? new S3Client({
    endpoint: storageConfig.endpoint,
    region: storageConfig.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: storageConfig.keyId,
      secretAccessKey: storageConfig.applicationKey,
    },
  });

  return Object.freeze({
    enabled: true,

    async upload(attachment) {
      const validationError = attachmentValidationError(
        attachment,
        maxBytes,
      );
      if (validationError) throw validationError;

      let response;
      try {
        response = await withAbortTimeout(
          downloadTimeoutMs,
          (signal) => fetchImpl(attachment.url, {
            headers: {
              accept: Object.keys(IMAGE_TYPES).join(', '),
            },
            redirect: 'error',
            signal,
          }),
        );
      } catch (error) {
        throw new ProofImageStorageError(
          'Unable to download the attached proof image from Discord. Please retry.',
          {
            code: error?.name === 'AbortError'
              ? 'PROOF_IMAGE_DOWNLOAD_TIMEOUT'
              : 'PROOF_IMAGE_DOWNLOAD_FAILED',
            cause: error,
          },
        );
      }

      if (!response?.ok) {
        throw new ProofImageStorageError(
          'Discord did not return the attached proof image. Please retry.',
          { code: 'PROOF_IMAGE_DOWNLOAD_FAILED' },
        );
      }

      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        const maxMegabytes = Math.floor(maxBytes / (1_024 * 1_024));
        throw new ProofImageStorageError(
          `The proof image must be ${maxMegabytes} MB or smaller.`,
          { code: 'PROOF_IMAGE_TOO_LARGE' },
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > maxBytes) {
        const maxMegabytes = Math.floor(maxBytes / (1_024 * 1_024));
        throw new ProofImageStorageError(
          bytes.length === 0
            ? 'The attached proof image was empty.'
            : `The proof image must be ${maxMegabytes} MB or smaller.`,
          {
            code: bytes.length === 0
              ? 'INVALID_PROOF_IMAGE_SIZE'
              : 'PROOF_IMAGE_TOO_LARGE',
          },
        );
      }

      const detectedType = detectImageType(bytes);
      const claimedType = normalizeImageType(attachment.contentType);
      const downloadedType = normalizeImageType(
        response.headers.get('content-type'),
      );

      if (
        !detectedType ||
        (claimedType && claimedType !== detectedType) ||
        (downloadedType && downloadedType !== detectedType)
      ) {
        throw new ProofImageStorageError(
          'The attached file contents do not match a supported image format.',
          { code: 'INVALID_PROOF_IMAGE_CONTENT' },
        );
      }

      const objectKey = makeObjectKey(
        now(),
        makeId(),
        IMAGE_TYPES[detectedType],
      );
      const command = new PutObjectCommand({
        Bucket: storageConfig.bucket,
        Key: objectKey,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: detectedType,
        ContentDisposition: 'inline',
        CacheControl: 'public, max-age=31536000, immutable',
      });

      try {
        await withAbortTimeout(
          uploadTimeoutMs,
          (abortSignal) => client.send(command, { abortSignal }),
        );
      } catch (error) {
        throw new ProofImageStorageError(
          'Unable to store the proof image in Backblaze B2. Please retry or ' +
            'submit a proof URL instead.',
          {
            code: error?.name === 'AbortError'
              ? 'PROOF_IMAGE_UPLOAD_TIMEOUT'
              : 'PROOF_IMAGE_UPLOAD_FAILED',
            cause: error,
          },
        );
      }

      return Object.freeze({
        url: appendObjectKey(storageConfig.publicBaseUrl, objectKey),
        objectKey,
        contentType: detectedType,
        size: bytes.length,
      });
    },
  });
}
