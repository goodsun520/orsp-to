import { describe, expect, it } from 'vitest';
import {
  ZHULANG_JSLIB_SHA256,
  ZHULANG_RSA_PUBLIC_KEY_SPKI,
  ZHULANG_SOURCE_NAME,
  ZHULANG_SOURCE_ORIGIN,
  ZHULANG_XXTEA_KEY,
  decodeZhulangJson,
  decodeZhulangText,
  decryptZhulangBytes,
  encryptZhulangBytes,
  encryptZhulangText,
  hasKnownZhulangCodecFingerprint,
  isAllowedZhulangCoverUrl,
  isZhulangSource,
  rsaPublicDecryptZhulang,
} from '../src/legado/zhulangCodec.js';

describe('Zhulang source recognition', () => {
  it('matches only the audited name and exact origin', () => {
    expect(isZhulangSource({ bookSourceName: ZHULANG_SOURCE_NAME, bookSourceUrl: ZHULANG_SOURCE_ORIGIN })).toBe(true);
    expect(isZhulangSource({ bookSourceName: ZHULANG_SOURCE_NAME, bookSourceUrl: `${ZHULANG_SOURCE_ORIGIN}/` })).toBe(true);
    expect(isZhulangSource({ bookSourceName: '连尚读书', bookSourceUrl: ZHULANG_SOURCE_ORIGIN })).toBe(false);
    expect(isZhulangSource({ bookSourceName: ZHULANG_SOURCE_NAME, bookSourceUrl: 'http://read.zhulang.com' })).toBe(false);
    expect(isZhulangSource({ bookSourceName: ZHULANG_SOURCE_NAME, bookSourceUrl: `${ZHULANG_SOURCE_ORIGIN}/evil` })).toBe(false);
    expect(isZhulangSource({ bookSourceName: ZHULANG_SOURCE_NAME, bookSourceUrl: 'https://read.zhulang.com.evil.test' })).toBe(false);
  });

  it('checks the codec fingerprint as inert source text', () => {
    expect(ZHULANG_JSLIB_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(hasKnownZhulangCodecFingerprint({ jsLib: 'not the audited library' })).toBe(false);
    expect(hasKnownZhulangCodecFingerprint({ jsLib: undefined })).toBe(false);
  });

  it('does not allow arbitrary cross-origin covers', () => {
    const source = {
      bookSourceName: ZHULANG_SOURCE_NAME,
      bookSourceUrl: ZHULANG_SOURCE_ORIGIN,
      jsLib: 'not the audited library',
    };
    expect(isAllowedZhulangCoverUrl(source, new URL('https://readstatic.zhulang.com/cover.jpg'))).toBe(false);
    expect(isAllowedZhulangCoverUrl(source, new URL('https://evil.example/cover.jpg'))).toBe(false);
  });
});

describe('Zhulang XXTEA codec', () => {
  it('uses the audited key and stable little-endian include-length vector', () => {
    expect(ZHULANG_XXTEA_KEY).toBe('BIGfMA0GCSqGSIb3');
    expect(encryptZhulangText('hello')).toBe('HL/nec+k1lOVj8I8');
    expect(decodeZhulangText('HL/nec+k1lOVj8I8')).toBe('hello');
  });

  it('round trips UTF-8 text, JSON, and arbitrary bytes', () => {
    const json = { message: '连尚读书', count: 3, ok: true };
    const encryptedJson = encryptZhulangText(JSON.stringify(json));
    expect(decodeZhulangJson<typeof json>(encryptedJson)).toEqual(json);

    const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    expect(decryptZhulangBytes(encryptZhulangBytes(bytes))).toEqual(bytes);
    expect(decodeZhulangText(encryptZhulangText(''))).toBe('');
  });

  it('rejects malformed Base64, truncated words, corrupt lengths, and invalid JSON', () => {
    expect(() => decryptZhulangBytes('%%%')).toThrow(/Base64/);
    expect(() => decryptZhulangBytes(Buffer.alloc(4).toString('base64'))).toThrow(/two 32-bit words/);
    expect(() => decryptZhulangBytes(Buffer.alloc(8).toString('base64'))).toThrow(/embedded length/);
    expect(() => decodeZhulangJson(encryptZhulangText('not json'))).toThrow(/encrypted JSON/);
    expect(() => encryptZhulangBytes(new Uint8Array(8 * 1024 * 1024 + 1))).toThrow(/limit/);
  });
});

describe('Zhulang RSA public decrypt', () => {
  it('pins the audited SPKI and rejects non-block and invalid PKCS#1 input', () => {
    expect(Buffer.from(ZHULANG_RSA_PUBLIC_KEY_SPKI, 'base64').length).toBe(162);
    expect(() => rsaPublicDecryptZhulang('')).toThrow(/multiple of 128/);
    expect(() => rsaPublicDecryptZhulang(Buffer.alloc(127).toString('base64'))).toThrow(/multiple of 128/);
    expect(() => rsaPublicDecryptZhulang(Buffer.alloc(128).toString('base64'))).toThrow(/Invalid Zhulang RSA/);
  });
});
