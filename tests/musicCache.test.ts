import { describe, it, expect, vi, beforeEach } from 'vitest';
import { call } from '@decky/api';

const store = new Map<string, unknown>();

vi.mock('localforage', () => ({
  default: {
    config: vi.fn(),
    getItem: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    setItem: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
      return v;
    }),
    removeItem: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    clear: vi.fn(async () => store.clear()),
    iterate: vi.fn(async (fn: (v: unknown, k: string) => void) => {
      store.forEach((v, k) => fn(v, k));
    })
  }
}));

import {
  updateCache,
  getCache,
  getFullCache,
  clearCache,
  exportCache,
  importCache,
  listCacheBackups,
  clearDownloads
} from '../src/cache/musicCache';

const mockCall = call as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  mockCall.mockReset();
});

describe('musicCache', () => {
  it('merges updates into existing entries', async () => {
    await updateCache(10, { videoId: 'abc' });
    await updateCache(10, { volume: 0.4 });
    expect(await getCache(10)).toEqual({ videoId: 'abc', volume: 0.4 });
  });

  it('returns null for unknown games', async () => {
    expect(await getCache(999)).toBeNull();
  });

  it('getFullCache returns every entry', async () => {
    await updateCache(1, { videoId: 'a' });
    await updateCache(2, { videoId: 'b' });
    expect(await getFullCache()).toEqual({
      '1': { videoId: 'a' },
      '2': { videoId: 'b' }
    });
  });

  it('clearCache(appId) only removes that game', async () => {
    await updateCache(1, { videoId: 'a' });
    await updateCache(2, { videoId: 'b' });
    await clearCache(1);
    expect(await getCache(1)).toBeNull();
    expect(await getCache(2)).toEqual({ videoId: 'b' });
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('clearCache() wipes everything including backend backups', async () => {
    await updateCache(1, { videoId: 'a' });
    await clearCache();
    expect(await getFullCache()).toEqual({});
    expect(mockCall).toHaveBeenCalledWith('clear_cache');
  });

  it('exportCache sends the full cache to the backend', async () => {
    await updateCache(1, { videoId: 'a' });
    await exportCache();
    expect(mockCall).toHaveBeenCalledWith('export_cache', {
      '1': { videoId: 'a' }
    });
  });

  it('importCache replaces the local cache', async () => {
    await updateCache(1, { videoId: 'old' });
    mockCall.mockResolvedValue({ '2': { videoId: 'new' } });
    await importCache('backup-1');
    expect(mockCall).toHaveBeenCalledWith('import_cache', 'backup-1');
    expect(await getFullCache()).toEqual({ '2': { videoId: 'new' } });
  });

  it('listCacheBackups / clearDownloads proxy to the backend', async () => {
    mockCall.mockResolvedValue(['b1']);
    expect(await listCacheBackups()).toEqual(['b1']);
    await clearDownloads();
    expect(mockCall).toHaveBeenCalledWith('clear_downloads');
  });
});
