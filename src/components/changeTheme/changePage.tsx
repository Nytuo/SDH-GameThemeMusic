import { call } from '@decky/api';
import {
  ConfirmModal,
  DialogButton,
  Focusable,
  ModalRoot,
  PanelSection,
  PanelSectionRow,
  showModal,
  TextField
} from '@decky/ui';
import { useAppId } from '../../hooks/useAppId';
import { useEffect, useState } from 'react';
import SteamSpinner from '../steamSpinner';
import { useSettings } from '../../hooks/useSettings';
import AudioPlayer from './audioPlayer';
import { getCache, updateCache } from '../../cache/musicCache';
import useTranslations from '../../hooks/useTranslations';
import { MediaContentPreview } from '../../../types/media';
import NoMusic from './noMusic';
import {
  AudioProvider,
  getResolverForVideoId,
  SEARCH_PROVIDERS
} from '../../actions/audio';
import { shouldSkipAudioDownload } from '../../lib/videoId';
import { PROVIDER_INFO } from '../../lib/providers';
import LocalMusicImport from './localMusicImport';

function SourceTabs({
  source,
  setSource
}: {
  source: AudioProvider;
  setSource: (source: AudioProvider) => void;
}) {
  const t = useTranslations();
  return (
    <Focusable
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
        margin: '0 0 12px'
      }}
    >
      {SEARCH_PROVIDERS.map((provider) => {
        const info = PROVIDER_INFO[provider];
        const active = provider === source;
        return (
          <DialogButton
            key={provider}
            onClick={() => setSource(provider)}
            style={{
              width: 'auto',
              minWidth: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              fontWeight: active ? 700 : 400,
              background: active ? info.color : undefined,
              color: active ? '#fff' : undefined
            }}
          >
            {info.icon()}
            {provider === 'local' ? t('sourceLocal') : info.label}
          </DialogButton>
        );
      })}
    </Focusable>
  );
}

export default function ChangePage({
  customSearch,
  currentSearch,
  setInitialSearch,
  loading,
  videos,
  source,
  setSource,
  onLibraryChanged
}: {
  videos: MediaContentPreview[];
  loading: boolean;
  source: AudioProvider;
  setSource: (source: AudioProvider) => void;
  customSearch: (term: string) => void;
  setInitialSearch: () => string;
  currentSearch: string;
  onLibraryChanged: () => void;
}) {
  const t = useTranslations();
  const { settings } = useSettings();
  const appid = useAppId();
  const appDetails = appStore.GetAppOverviewByGameID(appid);
  const appName = appDetails?.display_name?.replace(/([™®©])/g, '');
  const [selected, setSelected] = useState<string | undefined>();
  const [searchTerm, setSearchTerm] = useState(currentSearch);
  const isLocal = source === 'local';

  useEffect(() => {
    async function getData() {
      const cache = await getCache(appid);
      setSelected(cache?.videoId);
    }
    getData().catch(console.error);
  }, [appid]);

  async function selectNewAudio(audio: {
    title: string;
    videoId: string;
    audioUrl: string;
  }) {
    if (!shouldSkipAudioDownload(audio.videoId)) {
      const success = await getResolverForVideoId(audio.videoId).downloadAudio({
        id: audio.videoId,
        url: audio.audioUrl
      });
      if (!success) {
        showModal(
          <ModalRoot>{t('downloadFailedDetail')}</ModalRoot>,
          undefined,
          { strTitle: t('downloadFailed') }
        );
        return;
      }
    }
    setSelected(audio.videoId);
    await updateCache(appid, { videoId: audio.videoId });
  }

  function deleteLocalTrack(video: MediaContentPreview) {
    showModal(
      <ConfirmModal
        strTitle={t('deleteLocalConfirm')}
        strDescription={video.title}
        onOK={async () => {
          const ok = await call<[string], boolean>(
            'delete_local_music',
            video.id
          );
          if (ok && selected === video.id) {
            // Back to the automatic pick instead of a track that is gone.
            await updateCache(appid, { videoId: undefined });
            setSelected(undefined);
          }
          onLibraryChanged();
        }}
      />
    );
  }

  const canSearch = Boolean(searchTerm?.length);
  const showSpinner = loading && videos.length === 0;

  return (
    <div>
      <h2 style={{ margin: '20px 0' }}>{appName}</h2>
      <SourceTabs source={source} setSource={setSource} />
      {isLocal ? (
        <LocalMusicImport
          selectNewAudio={selectNewAudio}
          onImported={onLibraryChanged}
        />
      ) : (
        <PanelSection>
          <PanelSectionRow>
            <Focusable
              style={{
                display: 'grid',
                gap: '6px',
                gridTemplateColumns: '2fr max-content max-content',
                height: 'max-content',
                background: 'var(--main-editor-bg-color)',
                borderRadius: '6px',
                padding: '10px'
              }}
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  customSearch(searchTerm);
                }}
              >
                <TextField
                  onChange={(e) => setSearchTerm(e.target.value)}
                  value={searchTerm}
                />
              </form>
              <DialogButton
                disabled={!canSearch}
                focusable={canSearch}
                onClick={() => customSearch(searchTerm)}
              >
                {t('search')}
              </DialogButton>
              <DialogButton
                onClick={() => {
                  setSearchTerm(setInitialSearch());
                }}
              >
                {t('reset')}
              </DialogButton>
            </Focusable>
          </PanelSectionRow>
        </PanelSection>
      )}
      {showSpinner ? (
        <SteamSpinner />
      ) : (
        <Focusable
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: '10px',
            flexDirection: 'row'
          }}
        >
          <NoMusic selected={selected === ''} selectNewAudio={selectNewAudio} />
          {videos.map((video) => (
            <AudioPlayer
              key={video.id}
              video={video}
              volume={settings.volume}
              selected={selected === video.id}
              selectNewAudio={selectNewAudio}
              onDelete={isLocal ? () => deleteLocalTrack(video) : undefined}
            />
          ))}
          {loading && <SteamSpinner />}
          {!loading && videos.length === 0 && (
            <p
              style={{
                width: '100%',
                textAlign: 'center',
                opacity: 0.7,
                margin: '20px 0'
              }}
            >
              {isLocal
                ? t('noLocalMusic')
                : t('noResults', {
                    source: PROVIDER_INFO[source].label
                  })}
            </p>
          )}
        </Focusable>
      )}
    </div>
  );
}
