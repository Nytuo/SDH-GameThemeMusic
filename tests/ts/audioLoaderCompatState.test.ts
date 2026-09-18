import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioLoaderCompatState } from '../../src/state/AudioLoaderCompatState';
import { FakeAudio } from './fakeAudio';

describe('AudioLoaderCompatState', () => {
  let menuMusic: {
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    menuMusic = { play: vi.fn(), pause: vi.fn() };
    (window as any).AUDIOLOADER_MENUMUSIC = menuMusic;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).AUDIOLOADER_MENUMUSIC;
  });

  it('pauses the active player when a game starts', () => {
    const state = new AudioLoaderCompatState();
    const player = new FakeAudio();
    state.registerAudioPlayer(player as unknown as HTMLAudioElement);

    state.setGamesRunning([42]);
    expect(player.pause).toHaveBeenCalled();
    expect(state.getPublicState().gamesRunning).toEqual([42]);
  });

  it('pauses a player registered while a game is running', () => {
    const state = new AudioLoaderCompatState();
    state.setGamesRunning([42]);
    const player = new FakeAudio();
    state.registerAudioPlayer(player as unknown as HTMLAudioElement);
    expect(player.pause).toHaveBeenCalled();
  });

  it('unregister only clears the matching player', () => {
    const state = new AudioLoaderCompatState();
    const a = new FakeAudio();
    const b = new FakeAudio();
    state.registerAudioPlayer(a as unknown as HTMLAudioElement);
    state.unregisterAudioPlayer(b as unknown as HTMLAudioElement);
    state.setGamesRunning([1]);
    expect(a.pause).toHaveBeenCalled();
  });

  it('mutes AudioLoader menu music while on a theme page', () => {
    const state = new AudioLoaderCompatState();
    state.setOnThemePage(true);
    vi.runAllTimers();
    expect(state.getPublicState().onAppPage).toBe(true);
    expect(menuMusic.pause).toHaveBeenCalled();
  });

  it('resumes AudioLoader menu music after leaving the theme page', () => {
    const state = new AudioLoaderCompatState();
    state.setOnThemePage(true);
    vi.runAllTimers();
    state.setOnThemePage(false);
    vi.runAllTimers();
    expect(state.getPublicState().onAppPage).toBe(false);
    expect(menuMusic.play).toHaveBeenCalled();
  });

  it('ignores stale theme-page updates', () => {
    const state = new AudioLoaderCompatState();
    vi.setSystemTime(1000);
    state.setOnThemePage(false); // delayed
    vi.setSystemTime(2000);
    state.setOnThemePage(true); // immediate
    vi.runAllTimers();
    expect(state.getPublicState().onAppPage).toBe(true);
  });

  it('emits stateUpdate events', () => {
    const state = new AudioLoaderCompatState();
    const listener = vi.fn();
    state.eventBus.addEventListener('stateUpdate', listener);
    state.setGamesRunning([1]);
    vi.runAllTimers();
    expect(listener).toHaveBeenCalled();
  });
});
