import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { FakeAudio, installFakeAudio } from './fakeAudio';

const compat = {
  setOnThemePage: vi.fn(),
  registerAudioPlayer: vi.fn(),
  unregisterAudioPlayer: vi.fn()
};

vi.mock('../src/state/AudioLoaderCompatState', () => ({
  useAudioLoaderCompatState: () => compat
}));

import GlobalAudioPlayer from '../src/lib/globalAudioPlayer';
import useAudioPlayer from '../src/hooks/useAudioPlayer';

let audio: ReturnType<typeof installFakeAudio>;

beforeEach(() => {
  audio = installFakeAudio();
  (GlobalAudioPlayer as any).instance = null;
  Object.values(compat).forEach((fn) => fn.mockClear());
});

function element(): FakeAudio {
  return GlobalAudioPlayer.getInstance().getAudioElement() as unknown as FakeAudio;
}

describe('GlobalAudioPlayer', () => {
  it('is a looping singleton', () => {
    const a = GlobalAudioPlayer.getInstance();
    const b = GlobalAudioPlayer.getInstance();
    expect(a).toBe(b);
    expect(audio.ctor).toHaveBeenCalledTimes(1);
    expect(a.getAudioElement().loop).toBe(true);
    expect(a.getAudioElement().preload).toBe('auto');
  });
});

describe('useAudioPlayer', () => {
  it('registers with the compat state and unregisters on unmount', () => {
    const { unmount } = renderHook(() => useAudioPlayer(undefined));
    expect(compat.registerAudioPlayer).toHaveBeenCalledTimes(1);
    unmount();
    expect(compat.unregisterAudioPlayer).toHaveBeenCalledTimes(1);
  });

  it('loads the url and becomes ready on canplaythrough', () => {
    const { result } = renderHook(() => useAudioPlayer('https://a'));
    expect(element().src).toBe('https://a');
    expect(result.current.isReady).toBe(false);

    act(() => element().becomeReady());
    expect(result.current.isReady).toBe(true);
  });

  it('does not play before the audio is ready', () => {
    const { result } = renderHook(() => useAudioPlayer('https://a'));
    act(() => result.current.play());
    expect(element().play).not.toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
  });

  it('play / stop / togglePlay', () => {
    const { result } = renderHook(() => useAudioPlayer('https://a'));
    act(() => element().becomeReady());

    act(() => result.current.play());
    expect(element().play).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);

    element().currentTime = 12;
    act(() => result.current.stop());
    expect(element().pause).toHaveBeenCalled();
    expect(element().currentTime).toBe(0);
    expect(result.current.isPlaying).toBe(false);

    act(() => result.current.togglePlay());
    expect(result.current.isPlaying).toBe(true);
  });

  it('pause only pauses a playing element', () => {
    const { result } = renderHook(() => useAudioPlayer('https://a'));
    act(() => result.current.pause());
    expect(element().pause).not.toHaveBeenCalled();
  });

  it('setVolume writes through to the element', () => {
    const { result } = renderHook(() => useAudioPlayer('https://a'));
    act(() => result.current.setVolume(0.3));
    expect(element().volume).toBe(0.3);
  });

  it('switches source when the url changes', () => {
    const { rerender } = renderHook(({ url }) => useAudioPlayer(url), {
      initialProps: { url: 'https://a' }
    });
    rerender({ url: 'https://b' });
    expect(element().src).toBe('https://b');
  });
});
