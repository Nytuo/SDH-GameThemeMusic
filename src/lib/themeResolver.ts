import { findAutoAudio, getResolverForVideoId } from '../actions/audio';
import { getCache, updateCache } from '../cache/musicCache';
import { isCachedNoMusic } from './videoId';

export type ThemeAudio = { videoId: string; audioUrl: string };

export const NO_AUDIO: ThemeAudio = { videoId: '', audioUrl: '' };

export function getAppName(appId: number): string | undefined {
  if (!appId) return undefined;
  try {
    return appStore
      .GetAppOverviewByGameID(appId)
      ?.display_name?.replace(/([™®©])/g, '')
      .trim();
  } catch {
    return undefined;
  }
}

export type ResolveOptions = {
  /** Do not search for music when the game has no saved choice. */
  defaultMuted: boolean;
  /** Try other sources when YouTube has nothing. */
  autoFallback: boolean;
  isCancelled?: () => boolean;
};

/**
 * Music for a game: the user's saved choice, or an automatic pick from the
 * first source that has something (which is then remembered and downloaded in
 * the background so later plays start instantly).
 */
export async function resolveThemeAudio(
  appId: number,
  options: ResolveOptions
): Promise<ThemeAudio> {
  const { defaultMuted, autoFallback, isCancelled = () => false } = options;
  const cache = await getCache(appId);
  if (isCachedNoMusic(cache?.videoId)) return NO_AUDIO;

  if (cache?.videoId?.length) {
    const resolver = getResolverForVideoId(cache.videoId);
    const audioUrl = await resolver.getAudioUrlFromVideo({
      id: cache.videoId
    });
    return audioUrl?.length ? { videoId: cache.videoId, audioUrl } : NO_AUDIO;
  }

  const appName = getAppName(appId);
  if (defaultMuted || !appName?.length) return NO_AUDIO;

  const found = await findAutoAudio(appName, {
    fallback: autoFallback,
    isCancelled
  });
  if (isCancelled() || !found?.audioUrl.length) return NO_AUDIO;

  // Only the id is persisted: stream URLs expire and data URLs are huge.
  await updateCache(appId, { videoId: found.videoId });
  // Download in the background so playback starts right away.
  getResolverForVideoId(found.videoId)
    .downloadAudio({ id: found.videoId, url: found.audioUrl })
    .catch(() => {});
  return { videoId: found.videoId, audioUrl: found.audioUrl };
}
