import { useEffect, useState } from 'react';

import { getResolverForVideoId } from '../actions/audio';

import { getCache, updateCache } from '../cache/musicCache';
import { isCachedNoMusic } from '../lib/videoId';
import { useSettings } from './useSettings';

type ThemeAudio = { videoId: string; audioUrl: string };

const NO_AUDIO: ThemeAudio = { videoId: '', audioUrl: '' };

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

const useThemeMusic = (appId: number) => {
  const { settings, isLoading: settingsLoading } = useSettings();
  const [audio, setAudio] = useState<ThemeAudio>(NO_AUDIO);
  const [isLoading, setIsLoading] = useState(true);
  const appName = getAppName(appId);

  useEffect(() => {
    let ignore = false;

    async function resolve(): Promise<ThemeAudio> {
      const cache = await getCache(appId);
      if (isCachedNoMusic(cache?.videoId)) return NO_AUDIO;

      if (cache?.videoId?.length) {
        const resolver = getResolverForVideoId(cache.videoId);
        const audioUrl = await resolver.getAudioUrlFromVideo({
          id: cache.videoId
        });
        return audioUrl?.length
          ? { videoId: cache.videoId, audioUrl }
          : NO_AUDIO;
      }

      if (settings.defaultMuted || !appName?.length) return NO_AUDIO;

      const resolver = getResolverForVideoId('');
      const found = await resolver.getAudio(appName, () => ignore);
      if (ignore || !found?.audioUrl?.length) return NO_AUDIO;

      // Only the id is persisted: stream URLs expire and data URLs are huge.
      await updateCache(appId, { videoId: found.videoId });
      // Download in the background so playback starts right away.
      resolver.downloadAudio({ id: found.videoId }).catch(() => {});
      return found;
    }

    if (!appId || settingsLoading) {
      setIsLoading(!!appId);
      setAudio(NO_AUDIO);
      return;
    }

    setIsLoading(true);
    resolve()
      .catch((e) => {
        console.error('[GameThemeMusic] Could not resolve theme music', e);
        return NO_AUDIO;
      })
      .then((result) => {
        if (ignore) return;
        setAudio(result);
        setIsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [appId, appName, settingsLoading]);

  return {
    audio,
    isLoading
  };
};

export default useThemeMusic;
