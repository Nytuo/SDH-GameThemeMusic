import { DialogButton, Focusable } from '@decky/ui';
import { toaster } from '@decky/api';
import { useEffect, useRef, useState } from 'react';
import useTranslations from '../../hooks/useTranslations';
import { getProviderFromId, getResolverForVideoId } from '../../actions/audio';
import { MediaContentPreview } from '../../../types/media';
import {
  FaCheck,
  FaExclamationTriangle,
  FaMusic,
  FaTrash
} from 'react-icons/fa';
import Spinner from '../spinner';
import useAudioPlayer from '../../hooks/useAudioPlayer';
import { PROVIDER_INFO } from '../../lib/providers';

/** A URL that can be played as-is (no resolution needed). */
function directUrl(video: MediaContentPreview): string | undefined {
  const url = video.url;
  if (!url) return undefined;
  if (/youtube\.com|youtu\.be|soundcloud\.com/.test(url)) return undefined;
  return /^(https?:|data:)/.test(url) ? url : undefined;
}

export default function AudioPlayer({
  selected,
  selectNewAudio,
  video,
  volume,
  onDelete
}: {
  /** Only given for imported local files. */
  onDelete?: () => void;
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

  const badgeInfo = PROVIDER_INFO[provider];
  const isSquare = provider === 'itunes' || provider === 'deezer';
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
            aspectRatio: isSquare ? '1/1' : '16/9',
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
            {badgeInfo.icon()}
            {provider === 'local' ? t('sourceLocal') : badgeInfo.label}
            {badgeInfo.preview ? ` · ${t('previewOnly')}` : ''}
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
              style={
                selected
                  ? {
                      background: '#3d8f2f',
                      color: '#fff',
                      opacity: 1,
                      fontWeight: 700
                    }
                  : undefined
              }
            >
              {selected ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  <FaCheck />
                  {t('selected')}
                </span>
              ) : downloading ? (
                t('downloading')
              ) : downloaded ? (
                t('select')
              ) : (
                t('download')
              )}
            </DialogButton>
            {downloaded && !selected ? (
              <div
                title={t('downloaded')}
                style={{
                  position: 'absolute',
                  top: '50%',
                  right: '8px',
                  transform: 'translateY(-50%)',
                  height: '18px',
                  width: '18px',
                  background: '#4a6b8a',
                  borderRadius: '50%',
                  color: 'white',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '10px',
                  pointerEvents: 'none'
                }}
              >
                <FaCheck />
              </div>
            ) : null}
          </div>
          {onDelete && (
            <DialogButton onClick={onDelete} disabled={busy} focusable={!busy}>
              <FaTrash style={{ marginRight: 6 }} />
              {t('delete')}
            </DialogButton>
          )}
        </div>
      </Focusable>
    </div>
  );
}
