import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAudio, installFakeAudio } from './fakeAudio';
import {
  destroyAudioChannels,
  getAudioChannel,
  pauseAllAudio,
  RELEASE_GRACE_MS,
  setAllAudioSuspended
} from '../../src/lib/audioChannel';

const el = (name: 'theme' | 'preview') =>
  getAudioChannel(name).element as unknown as FakeAudio;

beforeEach(() => {
  installFakeAudio();
  destroyAudioChannels();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AudioChannel', () => {
  it('channels are singletons with their own element', () => {
    expect(getAudioChannel('theme')).toBe(getAudioChannel('theme'));
    expect(el('theme')).not.toBe(el('preview'));
    expect(el('theme').loop).toBe(true);
  });

  it('play loads the url and takes ownership', () => {
    const channel = getAudioChannel('preview');
    const a = Symbol('a');
    channel.acquire(a);
    channel.play(a, 'https://a');
    expect(el('preview').src).toBe('https://a');
    expect(channel.isPlayingFor(a)).toBe(true);
  });

  it('only the owner can pause or stop', () => {
    const channel = getAudioChannel('preview');
    const a = Symbol('a');
    const b = Symbol('b');
    channel.play(a, 'https://a');
    channel.stop(b);
    expect(el('preview').paused).toBe(false);
    channel.stop(a);
    expect(el('preview').paused).toBe(true);
  });

  it('a new owner replaces the previous track (preview bug)', () => {
    const channel = getAudioChannel('preview');
    const a = Symbol('a');
    const b = Symbol('b');
    channel.play(a, 'https://a');
    channel.play(b, 'https://b');
    expect(el('preview').src).toBe('https://b');
    expect(channel.isPlayingFor(a)).toBe(false);
    expect(channel.isPlayingFor(b)).toBe(true);
  });

  it('previews pause the theme and the theme cannot interrupt a preview', () => {
    const theme = getAudioChannel('theme');
    const preview = getAudioChannel('preview');
    const t = Symbol('t');
    const p = Symbol('p');
    theme.play(t, 'https://theme');
    preview.play(p, 'https://preview');
    expect(el('theme').paused).toBe(true);
    expect(theme.play(t, 'https://theme')).toBe(false);
    expect(el('theme').paused).toBe(true);
  });

  it('suspension pauses and blocks playback', () => {
    const theme = getAudioChannel('theme');
    const t = Symbol('t');
    theme.play(t, 'https://theme');
    setAllAudioSuspended(true);
    expect(el('theme').paused).toBe(true);
    expect(theme.play(t, 'https://theme')).toBe(false);
    expect(el('theme').paused).toBe(true);

    setAllAudioSuspended(false);
    expect(theme.play(t, 'https://theme')).toBe(true);
    expect(el('theme').paused).toBe(false);
  });

  it('channels created while suspended start suspended', () => {
    setAllAudioSuspended(true);
    const preview = getAudioChannel('preview');
    expect(preview.isSuspended()).toBe(true);
  });

  it('theme keeps playing across a quick remount, then halts', () => {
    const theme = getAudioChannel('theme');
    const a = Symbol('a');
    const b = Symbol('b');
    theme.acquire(a);
    theme.play(a, 'https://theme');
    theme.release(a);

    vi.advanceTimersByTime(RELEASE_GRACE_MS / 2);
    theme.acquire(b);
    vi.advanceTimersByTime(RELEASE_GRACE_MS * 2);
    expect(el('theme').paused).toBe(false);

    theme.release(b);
    vi.advanceTimersByTime(RELEASE_GRACE_MS + 1);
    expect(el('theme').paused).toBe(true);
    expect(theme.getUrl()).toBe('');
    expect(el('theme').removeAttribute).toHaveBeenCalledWith('src');
  });

  it('preview halts as soon as its owner unmounts', () => {
    const preview = getAudioChannel('preview');
    const a = Symbol('a');
    const other = Symbol('other');
    preview.acquire(a);
    preview.acquire(other);
    preview.play(a, 'https://a');
    preview.release(a);
    expect(el('preview').paused).toBe(true);
    expect(preview.getUrl()).toBe('');
  });

  it('setVolume clamps and ignores invalid values', () => {
    const theme = getAudioChannel('theme');
    theme.setVolume(2);
    expect(el('theme').volume).toBe(1);
    theme.setVolume(-1);
    expect(el('theme').volume).toBe(0);
    theme.setVolume(NaN);
    expect(el('theme').volume).toBe(0);
  });

  it('pauseAllAudio / destroyAudioChannels stop everything', () => {
    getAudioChannel('theme').play(Symbol(), 'https://t');
    getAudioChannel('preview').play(Symbol(), 'https://p');
    const theme = el('theme');
    pauseAllAudio();
    expect(theme.paused).toBe(true);
    destroyAudioChannels();
    expect(theme.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('swallows rejected play() promises', async () => {
    const channel = getAudioChannel('preview');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    el('preview').play.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    );
    channel.play(Symbol(), 'https://a');
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
