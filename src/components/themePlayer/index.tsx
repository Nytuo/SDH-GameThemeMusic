import { useParams } from '@decky/ui';
import { ReactElement, useEffect } from 'react';

import useThemeMusic from '../../hooks/useThemeMusic';
import { useSettings } from '../../hooks/useSettings';
import { getCache } from '../../cache/musicCache';
import useAudioPlayer from '../../hooks/useAudioPlayer';
import { useAudioLoaderCompatState } from '../../state/AudioLoaderCompatState';

export default function ThemePlayer({
  appid: propAppId
}: { appid?: number } = {}): ReactElement {
  const { settings, isLoading: settingsIsLoading } = useSettings();
  const { gamesRunning } = useAudioLoaderCompatState();
  const { appid: paramAppId } = useParams<{ appid: string }>();
  const appid =
    propAppId !== undefined ? propAppId : parseInt(paramAppId ?? '0');

  const isDetailPage = propAppId === undefined;
  const shouldPlay = !isDetailPage || !settings.homepageFocusMode;
  const { audio } = useThemeMusic(shouldPlay ? appid : 0);
  const audioPlayer = useAudioPlayer(audio.audioUrl);

  useEffect(() => {
    async function getData() {
      const cache = await getCache(appid);
      if (typeof cache?.volume === 'number' && isFinite(cache.volume)) {
        audioPlayer.setVolume(cache.volume);
      } else {
        audioPlayer.setVolume(settings.volume);
      }
    }
    if (!settingsIsLoading) {
      getData().then(() => {
        return;
      });
    }
  }, [settingsIsLoading]);

  useEffect(() => {
    if (
      audio?.audioUrl?.length &&
      audioPlayer.isReady &&
      gamesRunning.length === 0
    ) {
      audioPlayer.play();
    }
    if (gamesRunning.length > 0) {
      audioPlayer.pause();
    }
  }, [audio?.audioUrl, audioPlayer.isReady, gamesRunning]);

  return <></>;
}
