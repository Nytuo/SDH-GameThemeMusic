import { DialogButton, Focusable } from '@decky/ui';
import { toaster } from '@decky/api';
import { useEffect, useRef, useState } from 'react';
import useTranslations from '../../hooks/useTranslations';
import {
  AudioProvider,
  getProviderFromId,
  getResolverForVideoId
} from '../../actions/audio';
import { MediaContentPreview } from '../../../types/media';
import {
  FaCheck,
  FaCompactDisc,
  FaExclamationTriangle,
  FaFolder,
  FaMusic
} from 'react-icons/fa';
import { SiYoutubemusic, SiItunes } from 'react-icons/si';
import Spinner from '../spinner';
import useAudioPlayer from '../../hooks/useAudioPlayer';

const BADGES: Record<
  AudioProvider,
  { color: string; icon: JSX.Element; label: string }
> = {
  itunes: { color: '#d82d2d', icon: <SiItunes size={16} />, label: 'iTunes' },
  khinsider: {
    color: '#2d6fd8',
    icon: <FaCompactDisc size={16} />,
    label: 'KHInsider'
  },
  local: { color: '#3a8f3a', icon: <FaFolder size={16} />, label: 'Local' },
  ytdlp: {
    color: '#e62117',
    icon: <SiYoutubemusic size={16} />,
    label: 'YouTube'
  }
};

/** A URL that can be played as-is (no resolution needed). */
function directUrl(video: MediaContentPreview): string | undefined {
  const url = video.url;
  if (!url) return undefined;
  if (url.includes('youtube.com') || url.includes('youtu.be')) return undefined;
  return /^(https?:|data:)/.test(url) ? url : undefined;
}

export default function AudioPlayer({
  selected,
  selectNewAudio,
  video,
  volume
}: {
  video: MediaContentPreview;
  volume: number;
  selected: boolean;
  selectNewAudio: (audio: {
    title: string;
    videoId: string;
    audioUrl: string;
  }) => Promise<void>;
}) {
  const t = useTranslations();
  const provider = getProviderFromId(video.id);
  const [resolving, setResolving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(provider === 'local');
  const [audioUrl, setAudioUrl] = useState<string | undefined>(() =>
    directUrl(video)
  );
  const audioPlayer = useAudioPlayer(audioUrl, 'preview');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (provider === 'local') return;
    getResolverForVideoId(video.id)
      .isDownloaded(video)
      .then((result) => {
        if (mounted.current) setDownloaded(result);
      });
  }, [video.id]);

  useEffect(() => {
    if (audioPlayer.isPlaying) audioPlayer.setVolume(volume);
  }, [volume, audioPlayer.isPlaying]);

  function playbackFailed() {
    toaster.toast({
      title: t('playbackFailed'),
      body: t('playbackFailedDetail'),
      icon: <FaExclamationTriangle />,
      duration: 3000
    });
  }

  async function resolveUrl(): Promise<string | undefined> {
    if (audioUrl?.length) return audioUrl;
    setResolving(true);
    try {
      const url = await getResolverForVideoId(video.id).getAudioUrlFromVideo(
        video
      );
      if (mounted.current) setAudioUrl(url);
      return url;
    } catch (e) {
      console.error('[GameThemeMusic] Could not resolve preview', e);
      return undefined;
    } finally {
      if (mounted.current) setResolving(false);
    }
  }

  async function togglePlay() {
    if (audioPlayer.isPlaying) {
      audioPlayer.stop();
      return;
    }
    const url = await resolveUrl();
    if (!mounted.current) return;
    if (!url?.length) {
      playbackFailed();
      return;
    }
    audioPlayer.setVolume(volume);
    audioPlayer.play(url);
  }

  async function selectAudio() {
    if (!video.id.length) return;
    setDownloading(true);
    try {
      await selectNewAudio({
        title: video.title,
        videoId: video.id,
        audioUrl: audioUrl ?? directUrl(video) ?? ''
      });
      if (mounted.current) setDownloaded(true);
    } finally {
      if (mounted.current) setDownloading(false);
    }
  }

  const isItunes = provider === 'itunes';
  const badgeInfo = BADGES[provider];
  const busy = resolving || downloading;

  return (
    <div>
      <Focusable
        style={{
          background: 'var(--main-editor-bg-color)',
          borderRadius: '6px',
          display: 'grid',
          gridTemplateRows: 'max-content max-content max-content',
          overflow: 'hidden',
          padding: '10px',
          width: '230px'
        }}
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            aspectRatio: isItunes ? '1/1' : '16/9',
            maxWidth: '230px',
            margin: '0 auto',
            overflow: 'hidden',
            background: '#222',
            borderRadius: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {video.thumbnail ? (
            <img
              src={video.thumbnail}
              alt={video.title}
              loading="lazy"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: '6px',
                display: 'block',
                background: '#222'
              }}
            />
          ) : (
            <FaMusic size={48} color="#666" />
          )}
          <div
            style={{
              position: 'absolute',
              top: 6,
              left: 6,
              background: 'rgba(255,255,255,0.85)',
              borderRadius: '4px',
              padding: '2px 6px',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: '12px',
              fontWeight: 600,
              color: badgeInfo.color,
              zIndex: 2
            }}
          >
            {badgeInfo.icon}
            {badgeInfo.label}
          </div>
        </div>
        <p
          style={{
            color: 'var(--main-editor-text-color)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            width: '230px',
            height: '68px'
          }}
        >
          {video.title}
        </p>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            width: '230px'
          }}
        >
          <DialogButton onClick={togglePlay} disabled={busy} focusable={!busy}>
            {resolving ? (
              <Spinner />
            ) : audioPlayer.isPlaying ? (
              t('stop')
            ) : (
              t('play')
            )}
          </DialogButton>
          <div style={{ position: 'relative' }}>
            <DialogButton
              disabled={selected || busy}
              focusable={!selected && !busy}
              onClick={selectAudio}
            >
              {selected
                ? t('selected')
                : downloading
                  ? t('downloading')
                  : downloaded
                    ? t('select')
                    : t('download')}
            </DialogButton>
            {selected || downloaded ? (
              <div
                style={{
                  height: '20px',
                  width: '20px',
                  position: 'absolute',
                  bottom: '-6px',
                  right: '-6px',
                  background: selected ? '#59bf40' : '#4a6b8a',
                  borderRadius: '50%',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <FaCheck />
              </div>
            ) : (
              ''
            )}
          </div>
        </div>
      </Focusable>
    </div>
  );
}
