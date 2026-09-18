import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioLoaderCompatState } from '../../src/state/AudioLoaderCompatState';
import { FakeAudio, installFakeAudio } from './fakeAudio';
import {
  destroyAudioChannels,
  getAudioChannel
} from '../../src/lib/audioChannel';

const themeElement = () =>
  getAudioChannel('theme').element as unknown as FakeAudio;

describe('AudioLoaderCompatState', () => {
  let menuMusic: {
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    installFakeAudio();
    destroyAudioChannels();
    vi.useFakeTimers();
    menuMusic = { play: vi.fn(), pause: vi.fn() };
    (window as any).AUDIOLOADER_MENUMUSIC = menuMusic;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as any).AUDIOLOADER_MENUMUSIC;
  });

  it('pauses all audio when a game starts', () => {
    const state = new AudioLoaderCompatState();
    getAudioChannel('theme').play(Symbol(), 'https://a');
    state.setGamesRunning([42]);
    expect(themeElement().paused).toBe(true);
    expect(state.getPublicState().gamesRunning).toEqual([42]);
  });

  it('deduplicates running games', () => {
    const state = new AudioLoaderCompatState();
    state.setGamesRunning([42, 42, 7]);
    expect(state.getPublicState().gamesRunning).toEqual([42, 7]);
  });

  it('suspension pauses audio and is exposed in public state', () => {
    const state = new AudioLoaderCompatState();
    const listener = vi.fn();
    state.eventBus.addEventListener('stateUpdate', listener);
    getAudioChannel('theme').play(Symbol(), 'https://a');

    state.setSuspended(true);
    expect(themeElement().paused).toBe(true);
    expect(state.getPublicState().suspended).toBe(true);
    expect(listener).toHaveBeenCalled();
    expect(getAudioChannel('theme').play(Symbol(), 'https://a')).toBe(false);

    state.setSuspended(false);
    expect(state.getPublicState().suspended).toBe(false);
    expect(getAudioChannel('theme').play(Symbol(), 'https://a')).toBe(true);
  });

  it('mutes AudioLoader menu music while on a theme page', () => {
    const state = new AudioLoaderCompatState();
    state.setOnThemePage(true);
    vi.runAllTimers();
    expect(state.getPublicState().onAppPage).toBe(true);
    expect(menuMusic.pause).toHaveBeenCalled();
  });

  it('resumes AudioLoader menu music once every player has left', () => {
    const state = new AudioLoaderCompatState();
    state.setOnThemePage(true);
    state.setOnThemePage(true);
    vi.runAllTimers();

    state.setOnThemePage(false);
    vi.runAllTimers();
    expect(state.getPublicState().onAppPage).toBe(true);

    state.setOnThemePage(false);
    vi.runAllTimers();
    expect(state.getPublicState().onAppPage).toBe(false);
    expect(menuMusic.play).toHaveBeenCalled();
  });

  it('a delayed release does not override a newer claim', () => {
    const state = new AudioLoaderCompatState();
    state.setOnThemePage(true);
    vi.runAllTimers();
    state.setOnThemePage(false); // delayed by 1s
    state.setOnThemePage(true); // page transition: new player mounts
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
