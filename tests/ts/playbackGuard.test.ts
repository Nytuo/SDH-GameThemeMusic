import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '@decky/ui';
import {
  isAudibleVideoPlaying,
  isGamepadUIClosed,
  startPlaybackGuard
} from '../../src/lib/playbackGuard';

type Callback = (...args: unknown[]) => void;

function installSteamClient() {
  const callbacks: Record<string, Callback> = {};
  const unregister = vi.fn();
  const make = (name: string) =>
    vi.fn((cb: Callback) => {
      callbacks[name] = cb;
      return { unregister };
    });
  (globalThis as any).SteamClient = {
    UI: {
      RegisterForUIModeChanged: make('uiMode'),
      GetUIMode: vi.fn(() => Promise.resolve(4))
    },
    System: {
      RegisterForOnSuspendRequest: make('suspend'),
      RegisterForOnResumeFromSuspend: make('resume')
    }
  };
  return { callbacks, unregister };
}

function addVideo(
  state: Partial<Record<'paused' | 'muted' | 'loop', boolean>>
) {
  const video = document.createElement('video');
  let paused = state.paused ?? false;
  Object.defineProperty(video, 'paused', { get: () => paused });
  video.muted = state.muted ?? false;
  video.loop = state.loop ?? false;
  document.body.appendChild(video);
  return {
    video,
    setPaused(value: boolean) {
      paused = value;
      video.dispatchEvent(new Event(value ? 'pause' : 'play'));
    }
  };
}

function setMainWindow(value: unknown) {
  (Router as any).WindowStore = value;
}

describe('playback guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setMainWindow({
      GamepadUIMainWindowInstance: { BrowserWindow: { closed: false } }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setMainWindow(undefined);
    document.body.innerHTML = '';
  });

  it('suspends when Steam switches to desktop mode and resumes in Big Picture', () => {
    const { callbacks } = installSteamClient();
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    expect(onChange).toHaveBeenLastCalledWith(false);

    callbacks.uiMode(7);
    expect(onChange).toHaveBeenLastCalledWith(true);

    callbacks.uiMode(4);
    expect(onChange).toHaveBeenLastCalledWith(false);
    stop();
  });

  it('suspends while the device sleeps', () => {
    const { callbacks } = installSteamClient();
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    callbacks.suspend();
    expect(onChange).toHaveBeenLastCalledWith(true);
    callbacks.resume();
    expect(onChange).toHaveBeenLastCalledWith(false);
    stop();
  });

  it('suspends when the Big Picture window goes away', () => {
    installSteamClient();
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    setMainWindow({ GamepadUIMainWindowInstance: undefined });
    vi.advanceTimersByTime(1500);
    expect(onChange).toHaveBeenLastCalledWith(true);

    setMainWindow({
      GamepadUIMainWindowInstance: { BrowserWindow: { closed: false } }
    });
    vi.advanceTimersByTime(1500);
    expect(onChange).toHaveBeenLastCalledWith(false);
    stop();
  });

  it('only reports changes', () => {
    const { callbacks } = installSteamClient();
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    callbacks.uiMode(4);
    callbacks.uiMode(4);
    vi.advanceTimersByTime(5000);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('applies the initial UI mode', async () => {
    installSteamClient();
    (globalThis as any).SteamClient.UI.GetUIMode = vi.fn(() =>
      Promise.resolve(7)
    );
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    await vi.runOnlyPendingTimersAsync();
    expect(onChange).toHaveBeenLastCalledWith(true);
    stop();
  });

  it('unregisters everything on dispose', () => {
    const { unregister } = installSteamClient();
    const stop = startPlaybackGuard(vi.fn());
    stop();
    expect(unregister).toHaveBeenCalledTimes(3);
  });

  it('tolerates a client without these APIs', () => {
    (globalThis as any).SteamClient = {};
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    expect(onChange).toHaveBeenLastCalledWith(false);
    stop();
  });

  it('does not block playback when the window store is unknown', () => {
    setMainWindow(undefined);
    expect(isGamepadUIClosed()).toBe(false);
    setMainWindow({
      GamepadUIMainWindowInstance: { BrowserWindow: { closed: true } }
    });
    expect(isGamepadUIClosed()).toBe(true);
  });

  it('suspends while the startup movie plays', () => {
    installSteamClient();
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    expect(onChange).toHaveBeenLastCalledWith(false);

    const movie = addVideo({ paused: true });
    movie.setPaused(false);
    expect(onChange).toHaveBeenLastCalledWith(true);

    movie.setPaused(true);
    expect(onChange).toHaveBeenLastCalledWith(false);
    stop();
  });

  it('catches a video that was already playing on the next check', () => {
    installSteamClient();
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    addVideo({});
    vi.advanceTimersByTime(1500);
    expect(onChange).toHaveBeenLastCalledWith(true);
    stop();
  });

  it('ignores muted and looping videos', () => {
    addVideo({ muted: true });
    addVideo({ loop: true });
    addVideo({ paused: true });
    expect(isAudibleVideoPlaying()).toBe(false);
    addVideo({});
    expect(isAudibleVideoPlaying()).toBe(true);
  });
});
