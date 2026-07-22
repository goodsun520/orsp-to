import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchImage, UpstreamFetchError } from '../src/legado/fetchSource.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cover transport DNS safety', () => {
  it('rejects a hostname that rebinds to a private address at connection lookup time', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    lookup
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }] as never)
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);

    await expect(
      fetchImage(new URL('http://cover-rebind.invalid/image.jpg'), {
        allowedOrigin: 'http://cover-rebind.invalid',
        timeoutMs: 250,
      }),
    ).rejects.toBeInstanceOf(UpstreamFetchError);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
