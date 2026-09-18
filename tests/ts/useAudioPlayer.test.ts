import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { FakeAudio, installFakeAudio } from './fakeAudio';

const compat = {
  setOnThemePage: vi.fn()
};

vi.mock('../../src/state/AudioLoaderCompatState', () => ({
  useAudioLoaderCompatState: () => compat
}));

import useAudioPlayer from '../../src/hooks/useAudioPlayer';
import {
  destroyAudioChannels,
  getAudioChannel
} from '../../src/lib/audioChannel';

const element = (name: 'theme' | 'preview' = 'theme') =>
  getAudioChannel(name).element as unknown as FakeAudio;

beforeEach(() => {
  installFakeAudio();
  destroyAudioChannels();
  compat.setOnThemePage.mockClear();
});

describe('useAudioPlayer (theme)', () => {
  it('claims and releases the theme page', () => {
    const { unmount } = renderHook(() => useAudioPlayer(undefined));
    expect(compat.setOnThemePage).toHaveBeenLastCalledWith(true);
    unmount();
    expect(compat.setOnThemePage).toHaveBeenLastCalledWith(false);
  });

  it('preloads the url and reports readiness', () => {
    const { result } = renderHook(() => useAudioPlayer('https://a'));
    expect(element().src).toBe('https://a');
    expect(result.current.isReady).toBe(false);
    act(() => element().becomeReady());
    expect(result.current.isReady).toBe(true);
  });

  it('play / stop / togglePlay', () => {
    const { result } = renderHook(() => useAudioPlayer('https://a'));

    act(() => result.current.play());
    expect(element().play).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);

    element().currentTime = 12;
    act(() => result.current.stop());
    expect(element().paused).toBe(true);
    expect(element().currentTime).toBe(0);
    expect(result.current.isPlaying).toBe(false);

    act(() => result.current.togglePlay());
    expect(result.current.isPlaying).toBe(true);
  });

  it('switches source when the url changes', () => {
    const { rerender } = renderHook(({ url }) => useAudioPlayer(url), {
      initialProps: { url: 'https://a' }
    });
    rerender({ url: 'https://b' });
    expect(element().src).toBe('https://b');
  });

  it('the newest theme player takes control', () => {
    const first = renderHook(() => useAudioPlayer('https://a'));
    act(() => first.result.current.play());
    const second = renderHook(() => useAudioPlayer(undefined));
    // "No music" for the newly focused game silences the previous one.
    act(() => second.result.current.stop());
    expect(element().paused).toBe(true);
  });

  it('setVolume writes through to the element', () => {
    const { result } = renderHook(() => useAudioPlayer('https://a'));
    act(() => result.current.setVolume(0.3));
    expect(element().volume).toBe(0.3);
  });
});

describe('useAudioPlayer (preview)', () => {
  it('does not load anything until play', () => {
    renderHook(() => useAudioPlayer('https://a', 'preview'));
    expect(element('preview').src).toBe('');
  });

  it('each card plays its own track (regression: previews played the downloaded song)', () => {
    // The theme channel holds the already-downloaded song.
    const theme = renderHook(() =>
      useAudioPlayer('data:audio/mpeg;base64,OLD')
    );
    act(() => theme.result.current.play());

    const a = renderHook(() => useAudioPlayer('https://a', 'preview'));
    const b = renderHook(() => useAudioPlayer('https://b', 'preview'));

    act(() => b.result.current.play());
    expect(element('preview').src).toBe('https://b');
    expect(element('theme').paused).toBe(true);
    expect(b.result.current.isPlaying).toBe(true);

    act(() => a.result.current.play());
    expect(element('preview').src).toBe('https://a');
    expect(a.result.current.isPlaying).toBe(true);
    expect(b.result.current.isPlaying).toBe(false);
  });

  it('play(url) plays a freshly resolved url', () => {
    const { result } = renderHook(() => useAudioPlayer(undefined, 'preview'));
    act(() => result.current.play('https://resolved'));
    expect(element('preview').src).toBe('https://resolved');
  });

  it('stops when the playing card unmounts (leaving the page)', () => {
    const { result, unmount } = renderHook(() =>
      useAudioPlayer('https://a', 'preview')
    );
    act(() => result.current.play());
    unmount();
    expect(element('preview').paused).toBe(true);
    expect(element('preview').src).toBe('');
  });
});
