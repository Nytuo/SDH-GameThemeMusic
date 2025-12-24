import { DialogButton, Focusable } from '@decky/ui';
import { useEffect, useState } from 'react';
import useTranslations from '../../hooks/useTranslations';
import { getResolverForVideoId } from '../../actions/audio';
import { YouTubeVideoPreview } from '../../../types/YouTube';
import { FaCheck } from 'react-icons/fa';
import { SiYoutubemusic, SiItunes } from 'react-icons/si';
import Spinner from '../spinner';
import useAudioPlayer from '../../hooks/useAudioPlayer';
export default function AudioPlayer({
  handlePlay,
  selected,
  selectNewAudio,
  video,
  volume
}: {
  video: YouTubeVideoPreview & { isPlaying: boolean };
  volume: number;
  handlePlay: (startPlaying: boolean) => void;
  selected: boolean;
  selectNewAudio: (audio: {
    title: string;
    videoId: string;
    audioUrl: string;
  }) => Promise<void>;
}) {
  const t = useTranslations();
  const [loading, setLoading] = useState(video.url === undefined);
  const [downloading, setDownloading] = useState(false);
  const [audioUrl, setAudio] = useState<string | undefined>();
  const audioPlayer = useAudioPlayer(audioUrl);

  useEffect(() => {
    async function getData() {
      const resolver = getResolverForVideoId(video.id);
      setLoading(true);
      const res = await resolver.getAudioUrlFromVideo(video);
      setAudio(res);
      setLoading(false);
    }
    if (video.id.length) {
      getData().then(() => {
        return;
      });
    }
  }, [video.id]);

  useEffect(() => {
    if (audioPlayer.isReady) {
      audioPlayer.setVolume(volume);
    }
  }, [audioPlayer.isReady, volume]);

  useEffect(() => {
    if (audioPlayer.isReady) {
      if (video.isPlaying) audioPlayer.play();
      else audioPlayer.stop();
    }
  }, [video.isPlaying]);

  function togglePlay() {
    handlePlay(!video.isPlaying);
  }

  async function selectAudio() {
    if (audioUrl?.length && video.id.length) {
      setDownloading(true);
      await selectNewAudio({
        title: video.title,
        videoId: video.id,
        audioUrl: audioUrl
      });
      setDownloading(false);
    }
  }

  if (!loading && !audioUrl) return <></>;
  const isItunes = video.id?.startsWith('itunes_');
  const badge = isItunes ? (
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
        fontSize: '12px',
        fontWeight: 600,
        color: '#d82d2d',
        zIndex: 2
      }}
    >
      <SiItunes size={16} style={{ marginRight: 4 }} />
      iTunes
    </div>
  ) : (
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
        fontSize: '12px',
        fontWeight: 600,
        color: '#e62117',
        zIndex: 2
      }}
    >
      <SiYoutubemusic size={16} style={{ marginRight: 4 }} />
      YouTube
    </div>
  );
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
          <img
            src={video.thumbnail}
            alt={video.title}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              borderRadius: '6px',
              display: 'block',
              aspectRatio: isItunes ? '1/1' : '16/9',
              background: '#222'
            }}
          />
          {badge}
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

        {loading || downloading ? (
          <div
            style={{
              height: '85px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {downloading && <div>Downloading...</div>}
            <Spinner />
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              width: '230px'
            }}
          >
            <DialogButton
              onClick={togglePlay}
              disabled={loading}
              focusable={!loading}
            >
              {video.isPlaying ? t('stop') : t('play')}
            </DialogButton>
            <div style={{ position: 'relative' }}>
              <DialogButton
                disabled={selected || loading}
                focusable={!selected && !loading}
                onClick={selectAudio}
              >
                {selected ? t('selected') : t('download')}
              </DialogButton>
              {selected ? (
                <div
                  style={{
                    height: '20px',
                    width: '20px',
                    position: 'absolute',
                    bottom: '-6px',
                    right: '-6px',
                    background: '#59bf40',
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
        )}
      </Focusable>
    </div>
  );
}
