import { useParams } from '@decky/ui';
import { ReactElement, useEffect } from 'react';

import useThemeMusic from '../../hooks/useThemeMusic';
import { useSettings } from '../../hooks/useSettings';
import { getCache } from '../../cache/musicCache';
import useAudioPlayer from '../../hooks/useAudioPlayer';
import { useAudioLoaderCompatState } from '../../state/AudioLoaderCompatState';

function AppThemePlayer({ appid }: { appid: number }): ReactElement {
  const { settings, isLoading: settingsIsLoading } = useSettings();
  const { gamesRunning, suspended } = useAudioLoaderCompatState();
  const { audio, isLoading } = useThemeMusic(appid);
  const audioPlayer = useAudioPlayer(audio.audioUrl);

  useEffect(() => {
    let ignore = false;
    if (!settingsIsLoading) {
      getCache(appid).then((cache) => {
        if (ignore) return;
        audioPlayer.setVolume(
          typeof cache?.volume === 'number' && isFinite(cache.volume)
            ? cache.volume
            : settings.volume
        );
      });
    }
    return () => {
      ignore = true;
    };
  }, [appid, settingsIsLoading, settings.volume]);

  const canPlay = gamesRunning.length === 0 && !suspended;

  useEffect(() => {
    if (isLoading) return;
    if (!audio.audioUrl?.length) {
      // "No music" (or nothing found): silence whatever was playing before.
      audioPlayer.stop();
    } else if (canPlay) {
      audioPlayer.play();
    } else {
      audioPlayer.pause();
    }
  }, [audio.audioUrl, isLoading, canPlay]);

  return <></>;
}

/**
 * Game detail page player (no `appid` prop, read from the route) or
 * homepage focus player (`appid` prop).
 */
export default function ThemePlayer({
  appid: propAppId
}: { appid?: number } = {}): ReactElement {
  const { settings, isLoading } = useSettings();
  const { appid: paramAppId } = useParams<{ appid: string }>();
  const isDetailPage = propAppId === undefined;
  const appid = isDetailPage ? parseInt(paramAppId ?? '0') : propAppId;

  if (isLoading || !appid || !Number.isFinite(appid)) return <></>;
  // In homepage mode the detail page stays silent.
  if (isDetailPage && settings.homepageFocusMode) return <></>;
  return <AppThemePlayer key={appid} appid={appid} />;
}
