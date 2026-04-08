import { useEffect, useMemo, useState } from 'react';
import { useAudioLoaderCompatState } from '../state/AudioLoaderCompatState';
import GlobalAudioPlayer from '../lib/globalAudioPlayer';

const useAudioPlayer = (
  audioUrl: string | undefined
): {
  play: () => void;
  pause: () => void;
  stop: () => void;
  setVolume: (volume: number) => void;
  togglePlay: () => void;
  isPlaying: boolean;
  isReady: boolean;
} => {
  const { setOnThemePage, registerAudioPlayer, unregisterAudioPlayer } =
    useAudioLoaderCompatState();

  const audioPlayer: HTMLAudioElement = useMemo(() => {
    return GlobalAudioPlayer.getInstance().getAudioElement();
  }, []);

  useEffect(() => {
    setOnThemePage(true);
  }, []);

  useEffect(() => {
    registerAudioPlayer(audioPlayer);
    return () => {
      unregisterAudioPlayer(audioPlayer);
    };
  }, [audioPlayer]);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (audioUrl?.length) {
      if (audioPlayer.src !== audioUrl) {
        setIsReady(false);
        audioPlayer.src = audioUrl;
        audioPlayer.loop = true;
      }
    }
  }, [audioUrl]);

  useEffect(() => {
    if (audioPlayer.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
      setIsReady(true);
    }

    const handleCanPlay = () => setIsReady(true);
    audioPlayer.addEventListener('canplaythrough', handleCanPlay);

    return () => {
      audioPlayer.removeEventListener('canplaythrough', handleCanPlay);
    };
  }, [audioUrl]);

  function play() {
    if (audioPlayer.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
      audioPlayer.play();
      setIsPlaying(true);
      setOnThemePage(true);
    }
  }

  function pause() {
    if (!audioPlayer.paused && !audioPlayer.ended) {
      audioPlayer.pause();
      setIsPlaying(false);
    }
  }

  function stop() {
    if (!audioPlayer.paused || audioPlayer.currentTime > 0) {
      audioPlayer.pause();
      audioPlayer.currentTime = 0;
      setIsPlaying(false);
    }
  }

  function togglePlay() {
    if (isPlaying) stop();
    else play();
  }

  function setVolume(newVolume: number) {
    audioPlayer.volume = newVolume;
  }

  return {
    play,
    pause,
    stop,
    setVolume,
    togglePlay,
    isPlaying,
    isReady
  };
};

export default useAudioPlayer;
