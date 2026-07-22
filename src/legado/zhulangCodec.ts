import {
  constants as cryptoConstants,
  createHash,
  createPublicKey,
  publicDecrypt,
} from 'node:crypto';
import type { LegadoBookSource } from './types.js';

export const ZHULANG_SOURCE_NAME = '连尚读书[官方]';
export const ZHULANG_SOURCE_ORIGIN = 'https://read.zhulang.com';
export const ZHULANG_XXTEA_KEY = 'BIGfMA0GCSqGSIb3';
export const ZHULANG_RSA_PUBLIC_KEY_SPKI =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCsOCc6CujocxKQYj/qd8/Y2Fy+lpZI4LoLJ91EicuWUtJwROCp6qGl4ee76kG05zeJan/gBgr/8Lm6RlU9c+lQtTk+ZFQ3+soPKzG4UQDIOOrFKFr5kYnBCBkevotQlz5ForwArxyj83MVXSvVSSYxni/iiprhGW0cChai1BuIrQIDAQAB';
export const ZHULANG_JSLIB_SHA256 =
  '166b10c224db1afea4ee93349a61c2712dbe976f02227a70b9eeebdc02186830';

const DELTA = 0x9e3779b9;
const RSA_BLOCK_BYTES = 128;
const MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
const MAX_RSA_CIPHERTEXT_BYTES = RSA_BLOCK_BYTES * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const keyWords = bytesToWords(Buffer.from(ZHULANG_XXTEA_KEY, 'ascii'));
const rsaPublicKey = createPublicKey({
  key: Buffer.from(ZHULANG_RSA_PUBLIC_KEY_SPKI, 'base64'),
  format: 'der',
  type: 'spki',
});

/** Matches only the audited source identity at its exact HTTPS origin. */
export function isZhulangSource(source: Pick<LegadoBookSource, 'bookSourceName' | 'bookSourceUrl'>): boolean {
  if (source.bookSourceName !== ZHULANG_SOURCE_NAME) return false;
  try {
    const url = new URL(source.bookSourceUrl);
    return (
      url.origin === ZHULANG_SOURCE_ORIGIN &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/** Verifies the captured jsLib as data; it is never evaluated or executed. */
export function hasKnownZhulangCodecFingerprint(source: Pick<LegadoBookSource, 'jsLib'>): boolean {
  return (
    typeof source.jsLib === 'string' &&
    createHash('sha256').update(source.jsLib, 'utf8').digest('hex') === ZHULANG_JSLIB_SHA256
  );
}

/** Allows only the audited source's dedicated HTTPS cover CDN. */
export function isAllowedZhulangCoverUrl(source: LegadoBookSource, cover: URL): boolean {
  return (
    isZhulangSource(source) &&
    hasKnownZhulangCodecFingerprint(source) &&
    cover.protocol === 'https:' &&
    cover.hostname === 'readstatic.zhulang.com' &&
    cover.port === '' &&
    cover.username === '' &&
    cover.password === ''
  );
}

export function encryptZhulangBytes(plaintext: Uint8Array): string {
  if (plaintext.byteLength === 0) return '';
  assertLength(plaintext.byteLength, MAX_PLAINTEXT_BYTES, 'Zhulang plaintext');

  const words = bytesToWords(plaintext, true);
  const rounds = 6 + Math.floor(52 / words.length);
  let sum = 0;
  let z = words[words.length - 1]!;

  for (let round = 0; round < rounds; round += 1) {
    sum = (sum + DELTA) >>> 0;
    const e = (sum >>> 2) & 3;
    for (let p = 0; p < words.length - 1; p += 1) {
      const y = words[p + 1]!;
      z = words[p] = (words[p]! + mix(sum, y, z, p, e)) >>> 0;
    }
    const y = words[0]!;
    const p = words.length - 1;
    z = words[p] = (words[p]! + mix(sum, y, z, p, e)) >>> 0;
  }

  return wordsToBytes(words).toString('base64');
}

export function decryptZhulangBytes(ciphertextBase64: string): Buffer {
  if (ciphertextBase64 === '') return Buffer.alloc(0);
  const ciphertext = decodeBase64(ciphertextBase64, MAX_PLAINTEXT_BYTES + 8, 'Zhulang ciphertext');
  if (ciphertext.length < 8 || ciphertext.length % 4 !== 0) {
    throw new Error('Zhulang ciphertext must contain at least two 32-bit words');
  }

  const words = bytesToWords(ciphertext);
  const rounds = 6 + Math.floor(52 / words.length);
  let sum = Math.imul(rounds, DELTA) >>> 0;
  let y = words[0]!;

  for (let round = 0; round < rounds; round += 1) {
    const e = (sum >>> 2) & 3;
    for (let p = words.length - 1; p > 0; p -= 1) {
      const z = words[p - 1]!;
      y = words[p] = (words[p]! - mix(sum, y, z, p, e)) >>> 0;
    }
    const z = words[words.length - 1]!;
    y = words[0] = (words[0]! - mix(sum, y, z, 0, e)) >>> 0;
    sum = (sum - DELTA) >>> 0;
  }

  const declaredLength = words[words.length - 1]!;
  const availableLength = (words.length - 1) * 4;
  const minimumLength = Math.max(0, availableLength - 3);
  if (declaredLength < minimumLength || declaredLength > availableLength) {
    throw new Error('Zhulang ciphertext has an invalid embedded length');
  }
  return wordsToBytes(words.slice(0, -1)).subarray(0, declaredLength);
}

export function encryptZhulangText(plaintext: string): string {
  return encryptZhulangBytes(Buffer.from(plaintext, 'utf8'));
}

export function decodeZhulangText(ciphertextBase64: string): string {
  try {
    return textDecoder.decode(decryptZhulangBytes(ciphertextBase64));
  } catch (error) {
    throw new Error('Invalid Zhulang encrypted text', { cause: error });
  }
}

export function decodeZhulangJson<T = unknown>(ciphertextBase64: string): T {
  const text = decodeZhulangText(ciphertextBase64);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error('Invalid Zhulang encrypted JSON', { cause: error });
  }
}

/** Decrypts private-key-produced PKCS#1 v1.5 blocks with the audited public key. */
export function rsaPublicDecryptZhulang(ciphertextBase64: string): string {
  const ciphertext = decodeBase64(
    ciphertextBase64,
    MAX_RSA_CIPHERTEXT_BYTES,
    'Zhulang RSA ciphertext',
  );
  if (ciphertext.length === 0 || ciphertext.length % RSA_BLOCK_BYTES !== 0) {
    throw new Error(`Zhulang RSA ciphertext must be a multiple of ${RSA_BLOCK_BYTES} bytes`);
  }

  const chunks: Buffer[] = [];
  try {
    for (let offset = 0; offset < ciphertext.length; offset += RSA_BLOCK_BYTES) {
      chunks.push(
        publicDecrypt(
          { key: rsaPublicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
          ciphertext.subarray(offset, offset + RSA_BLOCK_BYTES),
        ),
      );
    }
    return textDecoder.decode(Buffer.concat(chunks));
  } catch (error) {
    throw new Error('Invalid Zhulang RSA ciphertext', { cause: error });
  }
}

function mix(sum: number, y: number, z: number, p: number, e: number): number {
  const shifts = (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) >>> 0;
  return (shifts ^ ((sum ^ y) + (keyWords[(p & 3) ^ e]! ^ z))) >>> 0;
}

function bytesToWords(bytes: Uint8Array, includeLength = false): number[] {
  const wordCount = Math.ceil(bytes.byteLength / 4);
  const words = new Array<number>(wordCount + (includeLength ? 1 : 0)).fill(0);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    words[index >>> 2] = (words[index >>> 2]! | (bytes[index]! << ((index & 3) * 8))) >>> 0;
  }
  if (includeLength) words[wordCount] = bytes.byteLength;
  return words;
}

function wordsToBytes(words: readonly number[]): Buffer {
  const bytes = Buffer.allocUnsafe(words.length * 4);
  for (let index = 0; index < words.length; index += 1) {
    bytes.writeUInt32LE(words[index]! >>> 0, index * 4);
  }
  return bytes;
}

function decodeBase64(value: string, maxBytes: number, label: string): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error(`${label} is too large`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical Base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  assertLength(decoded.length, maxBytes, label);
  return decoded;
}

function assertLength(length: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new Error(`${label} exceeds the ${maximum}-byte limit`);
  }
}
