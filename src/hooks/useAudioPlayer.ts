import { useEffect, useReducer, useState } from 'react';
import { useAudioLoaderCompatState } from '../state/AudioLoaderCompatState';
import { ChannelName, getAudioChannel } from '../lib/audioChannel';

export type AudioPlayerControls = {
  /** Play `audioUrl`, or `url` when given (e.g. just resolved). */
  play: (url?: string) => void;
  pause: () => void;
  stop: () => void;
  setVolume: (volume: number) => void;
  togglePlay: () => void;
  isPlaying: boolean;
  isReady: boolean;
};

/**
 * Control one of the shared audio channels.
 *
 * The `theme` channel preloads `audioUrl` as soon as it is known; the
 * `preview` channel only loads it when `play()` is called, so rendering a page
 * full of previews does not start dozens of downloads.
 */
const useAudioPlayer = (
  audioUrl: string | undefined,
  channelName: ChannelName = 'theme'
): AudioPlayerControls => {
  const { setOnThemePage } = useAudioLoaderCompatState();
  const [id] = useState(() => Symbol(channelName));
  const channel = getAudioChannel(channelName);
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    channel.acquire(id);
    // The most recently mounted theme player is the one in control.
    if (channelName === 'theme') channel.claim(id);
    setOnThemePage(true);
    const unsubscribe = channel.subscribe(rerender);
    return () => {
      unsubscribe();
      channel.release(id);
      setOnThemePage(false);
    };
  }, [channel]);

  useEffect(() => {
    if (channelName === 'theme' && audioUrl?.length) {
      channel.load(id, audioUrl);
    } else if (!audioUrl?.length && channel.isOwner(id)) {
      channel.stop(id);
    }
  }, [audioUrl, channel]);

  function play(url: string | undefined = audioUrl) {
    if (url?.length) channel.play(id, url);
  }

  function pause() {
    channel.pause(id);
  }

  function stop() {
    channel.stop(id);
  }

  const isPlaying = channel.isPlayingFor(id);

  function togglePlay() {
    if (isPlaying) stop();
    else play();
  }

  function setVolume(newVolume: number) {
    channel.setVolume(newVolume);
  }

  return {
    play,
    pause,
    stop,
    setVolume,
    togglePlay,
    isPlaying,
    isReady: channel.isReadyFor(audioUrl)
  };
};

export default useAudioPlayer;
