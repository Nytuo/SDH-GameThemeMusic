import { useEffect, useState } from 'react';

import {
  getAppName,
  NO_AUDIO,
  resolveThemeAudio,
  ThemeAudio
} from '../lib/themeResolver';
import { useSettings } from './useSettings';

export { getAppName };

const useThemeMusic = (appId: number) => {
  const { settings, isLoading: settingsLoading } = useSettings();
  const [audio, setAudio] = useState<ThemeAudio>(NO_AUDIO);
  const [isLoading, setIsLoading] = useState(true);
  const appName = getAppName(appId);

  useEffect(() => {
    let ignore = false;

    if (!appId || settingsLoading) {
      setIsLoading(!!appId);
      setAudio(NO_AUDIO);
      return;
    }

    setIsLoading(true);
    resolveThemeAudio(appId, {
      defaultMuted: settings.defaultMuted,
      autoFallback: settings.autoFallback,
      isCancelled: () => ignore
    })
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
  }, [
    appId,
    appName,
    settingsLoading,
    settings.defaultMuted,
    settings.autoFallback
  ]);

  return {
    audio,
    isLoading
  };
};

export default useThemeMusic;
