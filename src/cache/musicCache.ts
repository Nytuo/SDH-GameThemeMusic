import { call } from '@decky/api';
import localforage from 'localforage';

const STORAGE_KEY = 'game-theme-music-cache';

localforage.config({
  name: STORAGE_KEY
});

type GameThemeMusicCache = {
  videoId?: string | undefined;
  volume?: number;
};

type GameThemeMusicCacheMapping = { [key: string]: GameThemeMusicCache };

export async function updateCache(appId: number, newData: GameThemeMusicCache) {
  const oldCache = (await localforage.getItem(
    appId.toString()
  )) as GameThemeMusicCache | null;

  return await localforage.setItem(appId.toString(), {
    ...(oldCache || {}),
    ...newData
  });
}

export async function getFullCache(): Promise<GameThemeMusicCacheMapping> {
  const fullCache: GameThemeMusicCacheMapping = {};
  await localforage.iterate((value: GameThemeMusicCache, key) => {
    fullCache[key] = value;
  });
  return fullCache;
}

export async function exportCache() {
  await call<[GameThemeMusicCacheMapping]>(
    'export_cache',
    await getFullCache()
  );
}

export async function importCache(name: string) {
  const newCache = await call<[string], GameThemeMusicCacheMapping>(
    'import_cache',
    name
  );
  // Write the backup first and only then drop what it doesn't contain, so a
  // failure half way never leaves the user with an empty cache.
  for (const [key, value] of Object.entries(newCache)) {
    await localforage.setItem(key, value);
  }
  for (const key of await localforage.keys()) {
    if (!(key in newCache)) await localforage.removeItem(key);
  }
}

export async function listCacheBackups(): Promise<string[]> {
  return await call<[], string[]>('list_cache_backups');
}

export async function clearCache(appId?: number) {
  if (appId?.toString().length) {
    await localforage.removeItem(appId.toString());
  } else {
    // Backups are the user's safety net and are kept.
    await localforage.clear();
  }
}

export async function getCache(
  appId: number
): Promise<GameThemeMusicCache | null> {
  return await localforage.getItem<GameThemeMusicCache>(appId.toString());
}

/** Delete downloaded audio. Returns how many files were removed. */
export async function clearDownloads(): Promise<number> {
  return (await call<[], number>('clear_downloads')) ?? 0;
}
