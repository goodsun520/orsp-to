/**
 * ORSP book/chapter IDs must be opaque strings; Legado sources identify
 * books and chapters by their upstream URL. Short URLs round-trip through
 * base64url; SourceRegistry assigns persistent compact references to URLs
 * whose base64 representation would exceed the 200-character wire limit.
 */
export function encodeId(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

export function decodeId(id: string): string | null {
  try {
    const url = Buffer.from(id, 'base64url').toString('utf8');
    return url.startsWith('http://') || url.startsWith('https://') ? url : null;
  } catch {
    return null;
  }
}

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;

export function isValidOpaqueId(id: string): boolean {
  return OPAQUE_ID_PATTERN.test(id);
}
