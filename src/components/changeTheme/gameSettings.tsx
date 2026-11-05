import {
  DialogButton,
  Focusable,
  SliderField,
  PanelSectionRow
} from '@decky/ui';
import { useAppId } from '../../hooks/useAppId';
import { useEffect, useState } from 'react';
import { getCache, updateCache } from '../../cache/musicCache';

import useTranslations from '../../hooks/useTranslations';
import { useSettings } from '../../hooks/useSettings';
import { FaRedo, FaVolumeUp } from 'react-icons/fa';
import { toaster } from '@decky/api';
import Spinner from '../spinner';
import useAudioPlayer from '../../hooks/useAudioPlayer';
import useThemeMusic, { getAppName } from '../../hooks/useThemeMusic';

export default function GameSettings() {
  const t = useTranslations();
  const { settings, isLoading: settingsIsLoading } = useSettings();
  const appId = useAppId();
  const appName = getAppName(appId);

  const { audio, isLoading: loading } = useThemeMusic(appId);
  const [themeVolume, setThemeVolume] = useState(settings.volume);

  const audioPlayer = useAudioPlayer(audio.audioUrl, 'preview');

  useEffect(() => {
    let ignore = false;
    if (!settingsIsLoading) {
      getCache(appId).then((cache) => {
        if (ignore) return;
        const volume =
          typeof cache?.volume === 'number' && isFinite(cache.volume)
            ? cache.volume
            : settings.volume;
        setThemeVolume(volume);
        audioPlayer.setVolume(volume);
      });
    }
    return () => {
      ignore = true;
    };
  }, [appId, settingsIsLoading]);

  function updateThemeVolume(newVol: number, reset?: boolean) {
    setThemeVolume(newVol);
    audioPlayer.setVolume(newVol);
    updateCache(appId, { volume: reset ? undefined : newVol }).catch(
      console.error
    );
  }

  function resetAutoPick() {
    // An empty override means "No music", so the key is removed instead.
    updateCache(appId, { videoId: undefined })
      .then(() =>
        toaster.toast({
          title: t('resetAutoPick'),
          body: t('resetAutoPickDone'),
          icon: <FaRedo />,
          duration: 2000
        })
      )
      .catch(console.error);
  }

  return (
    <div>
      <h2 style={{ margin: '20px 0' }}>{appName}</h2>

      <Focusable
        style={{
          background: 'var(--main-editor-bg-color)',
          borderRadius: '6px',
          display: 'grid',
          gridGap: '16px',
          gridTemplateColumns: '2fr max-content max-content',
          height: 'max-content',
          padding: '10px 10px 10px 16px',
          alignItems: 'center'
        }}
      >
        <div style={{ padding: '0 10px' }}>
          <PanelSectionRow>
            <SliderField
              layout="below"
              bottomSeparator="none"
              label={t('volume')}
              description={t('gameVolumeDescription')}
              value={themeVolume * 100}
              onChange={(newVal) => updateThemeVolume(newVal / 100)}
              min={0}
              max={100}
              step={1}
              icon={<FaVolumeUp />}
              editableValue
            />
          </PanelSectionRow>
        </div>
        <DialogButton
          onClick={audioPlayer.togglePlay}
          disabled={loading || !audio.audioUrl}
          focusable={!loading && !!audio.audioUrl}
          style={{ height: 'max-content' }}
        >
          {loading ? (
            <Spinner />
          ) : audioPlayer.isPlaying ? (
            t('stop')
          ) : (
            t('play')
          )}
        </DialogButton>
        <DialogButton
          onClick={() => updateThemeVolume(settings.volume, true)}
          style={{ height: 'max-content' }}
        >
          {t('resetVolume')}
        </DialogButton>
      </Focusable>
      <Focusable style={{ marginTop: '16px' }}>
        <DialogButton onClick={resetAutoPick} style={{ width: 'auto' }}>
          <FaRedo style={{ marginRight: 8 }} />
          {t('resetAutoPick')}
        </DialogButton>
        <div style={{ fontSize: '12px', opacity: 0.7, marginTop: '6px' }}>
          {t('resetAutoPickDescription')}
        </div>
      </Focusable>
    </div>
  );
}
