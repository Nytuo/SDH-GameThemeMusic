import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '@decky/ui';
import { call } from '@decky/api';
import { FakeAudio, installFakeAudio } from './fakeAudio';

const store = new Map<string, unknown>();
vi.mock('localforage', () => ({
  default: {
    config: vi.fn(),
    getItem: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    setItem: vi.fn(async (k: string, v: unknown) => {
      store.set(k, v);
      return v;
    }),
    removeItem: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    clear: vi.fn(async () => store.clear()),
    keys: vi.fn(async () => Array.from(store.keys())),
    iterate: vi.fn()
  }
}));

import { startPlaybackGuard, isDesktopUI } from '../../src/lib/playbackGuard';
import {
  getDesktopAppId,
  startDesktopPlayer
} from '../../src/lib/desktopPlayer';
import {
  destroyAudioChannels,
  getAudioChannel
} from '../../src/lib/audioChannel';
import { AudioLoaderCompatState } from '../../src/state/AudioLoaderCompatState';
import { NO_AUDIO, resolveThemeAudio } from '../../src/lib/themeResolver';
import { updateCache } from '../../src/cache/musicCache';
import { formatBackupName } from '../../src/components/settings';
import { isAudioProvider } from '../../src/components/changeTheme';

const mockCall = call as unknown as ReturnType<typeof vi.fn>;

function setWindowStore(value: unknown) {
  (Router as any).WindowStore = value;
}

function installUiMode(initialMode = 4) {
  let uiMode: (mode: number) => void = () => {};
  (globalThis as any).SteamClient = {
    UI: {
      RegisterForUIModeChanged: vi.fn((cb: (mode: number) => void) => {
        uiMode = cb;
        return { unregister: vi.fn() };
      }),
      GetUIMode: vi.fn(() => Promise.resolve(initialMode))
    },
    System: {
      RegisterForOnSuspendRequest: vi.fn(() => ({ unregister: vi.fn() })),
      RegisterForOnResumeFromSuspend: vi.fn(() => ({ unregister: vi.fn() }))
    }
  };
  return (mode: number) => uiMode(mode);
}

describe('playback guard in the desktop client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setWindowStore({
      GamepadUIMainWindowInstance: { BrowserWindow: { closed: false } }
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('keeps suspending the desktop client by default', () => {
    const setMode = installUiMode();
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange);
    setMode(7);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(isDesktopUI()).toBe(true);
    stop();
    expect(isDesktopUI()).toBe(false);
  });

  it('plays in the desktop client when allowed, and follows the setting', () => {
    const setMode = installUiMode();
    let allowed = true;
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange, { allowDesktop: () => allowed });
    setMode(7);
    expect(onChange).toHaveBeenLastCalledWith(false);

    allowed = false;
    vi.advanceTimersByTime(1100);
    expect(onChange).toHaveBeenLastCalledWith(true);
    stop();
  });

  it('does not suspend a missing Big Picture window when desktop is allowed', () => {
    installUiMode();
    setWindowStore({ GamepadUIMainWindowInstance: null });
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange, { allowDesktop: () => true });
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(isDesktopUI()).toBe(true);
    stop();
  });

  it('still suspends while sleeping even when desktop is allowed', () => {
    installUiMode();
    const suspend = vi.fn();
    (globalThis as any).SteamClient.System.RegisterForOnSuspendRequest = vi.fn(
      (cb: () => void) => {
        suspend.mockImplementation(cb);
        return { unregister: vi.fn() };
      }
    );
    const onChange = vi.fn();
    const stop = startPlaybackGuard(onChange, { allowDesktop: () => true });
    suspend();
    expect(onChange).toHaveBeenLastCalledWith(true);
    stop();
  });
});

describe('getDesktopAppId', () => {
  afterEach(() => setWindowStore(undefined));

  it('finds the game open in a desktop library window', () => {
    setWindowStore({
      GamepadUIMainWindowInstance: { BrowserWindow: {} },
      SteamUIWindows: [
        { BrowserWindow: { location: { pathname: '/library/home' } } },
        { m_history: { location: { pathname: '/library/app/220' } } }
      ]
    });
    expect(getDesktopAppId()).toBe(220);
  });

  it('reads hash routes too', () => {
    setWindowStore({
      SteamUIWindows: [
        {
          BrowserWindow: {
            location: { hash: '#/library/app/730/achievements' }
          }
        }
      ]
    });
    expect(getDesktopAppId()).toBe(730);
  });

  it('ignores the Big Picture window and unknown layouts', () => {
    const bpm = {
      BrowserWindow: { location: { pathname: '/library/app/5' } }
    };
    setWindowStore({ GamepadUIMainWindowInstance: bpm, SteamUIWindows: [bpm] });
    expect(getDesktopAppId()).toBeNull();
    setWindowStore(undefined);
    expect(getDesktopAppId()).toBeNull();
  });
});

describe('desktop player', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeAudio();
    destroyAudioChannels();
    store.clear();
    mockCall.mockReset();
    setWindowStore({
      GamepadUIMainWindowInstance: { BrowserWindow: { closed: false } }
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    setWindowStore(undefined);
  });

  async function settings(patch: Record<string, unknown>) {
    vi.resetModules();
    return patch;
  }
  void settings;

  it('plays the selected game and stops when it is left or the setting is off', async () => {
    const { useSettings, defaultSettings } =
      await import('../../src/hooks/useSettings');
    const { renderHook, act } = await import('@testing-library/react');
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'local_audio_url') return 'http://127.0.0.1:1/audio/a.mp3';
      return defaultSettings;
    });
    const hook = renderHook(() => useSettings());
    await vi.waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    act(() => hook.result.current.setPlayInDesktopMode(true));

    const setMode = installUiMode(7);
    const stopGuard = startPlaybackGuard(() => {}, {
      allowDesktop: () => true
    });
    setMode(7);
    await updateCache(220, { videoId: 'dQw4w9WgXcQ' });
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'single_yt_url') return 'http://127.0.0.1:1/audio/a.mp3';
      return undefined;
    });

    let app: number | null = 220;
    const state = new AudioLoaderCompatState();
    const stop = startDesktopPlayer(state, () => app);
    const element = getAudioChannel('theme').element as unknown as FakeAudio;

    await vi.advanceTimersByTimeAsync(2000);
    expect(element.src).toBe('http://127.0.0.1:1/audio/a.mp3');
    expect(element.paused).toBe(false);

    app = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(element.paused).toBe(true);

    app = 220;
    await vi.advanceTimersByTimeAsync(2000);
    expect(element.paused).toBe(false);

    act(() => hook.result.current.setPlayInDesktopMode(false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(element.paused).toBe(true);

    stop();
    stopGuard();
  });
});

describe('resolveThemeAudio', () => {
  beforeEach(() => {
    store.clear();
    mockCall.mockReset();
  });

  it('honours "No music" without any backend call', async () => {
    await updateCache(1, { videoId: '' });
    expect(
      await resolveThemeAudio(1, { defaultMuted: false, autoFallback: true })
    ).toEqual(NO_AUDIO);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('plays the saved choice', async () => {
    await updateCache(1, { videoId: 'deezer_9' });
    mockCall.mockResolvedValue('http://127.0.0.1:1/audio/deezer_9.mp3');
    expect(
      await resolveThemeAudio(1, { defaultMuted: false, autoFallback: true })
    ).toEqual({
      videoId: 'deezer_9',
      audioUrl: 'http://127.0.0.1:1/audio/deezer_9.mp3'
    });
  });

  it('does not search when default muted', async () => {
    expect(
      await resolveThemeAudio(2, { defaultMuted: true, autoFallback: true })
    ).toEqual(NO_AUDIO);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('remembers and downloads an automatic pick, falling back when needed', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'search_yt') return null; // yt-dlp unavailable
      if (method === 'search_itunes') return [];
      if (method === 'search_deezer')
        return [
          { id: 'deezer_5', title: 't', url: 'https://d/p.mp3', thumbnail: '' }
        ];
      if (method === 'fetch_url') return '';
      return undefined;
    });
    const result = await resolveThemeAudio(3, {
      defaultMuted: false,
      autoFallback: true
    });
    expect(result).toEqual({
      videoId: 'deezer_5',
      audioUrl: 'https://d/p.mp3'
    });
    expect(store.get('3')).toEqual({ videoId: 'deezer_5' });
    expect(mockCall).toHaveBeenCalledWith(
      'download_url',
      'https://d/p.mp3',
      'deezer_5'
    );
  });
});

describe('small helpers', () => {
  it('formatBackupName makes backup names readable', () => {
    expect(formatBackupName('backup-2026-11-05 10-12-03')).toBe(
      '2026-11-05 10:12:03'
    );
    expect(formatBackupName('custom')).toBe('custom');
  });

  it('isAudioProvider validates stored tab names', () => {
    expect(isAudioProvider('deezer')).toBe(true);
    expect(isAudioProvider('nope')).toBe(false);
    expect(isAudioProvider(undefined)).toBe(false);
  });
});
