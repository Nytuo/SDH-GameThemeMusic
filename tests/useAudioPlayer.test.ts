import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import GlobalAudioPlayer from '../src/lib/globalAudioPlayer';

vi.mock('../src/state/AudioLoaderCompatState', () => ({
  useAudioLoaderCompatState: () => ({
    setOnThemePage: vi.fn(),
    registerAudioPlayer: vi.fn(),
    unregisterAudioPlayer: vi.fn()
  })
}));

describe('GlobalAudioPlayer', () => {
  let mockAudioElement: any;

  beforeEach(() => {
    mockAudioElement = {
      src: '',
      loop: false,
      volume: 1,
      paused: true,
      ended: false,
      currentTime: 0,
      readyState: 4, // HAVE_ENOUGH_DATA
      preload: 'none',
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    global.Audio = vi.fn(() => mockAudioElement) as any;

    (GlobalAudioPlayer as any).instance = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should create singleton instance', () => {
    const instance1 = GlobalAudioPlayer.getInstance();
    const instance2 = GlobalAudioPlayer.getInstance();

    expect(instance1).toBe(instance2);
    expect(global.Audio).toHaveBeenCalledTimes(1);
  });

  it('should initialize audio element with correct settings', () => {
    const player = GlobalAudioPlayer.getInstance();
    const element = player.getAudioElement();

    expect(element.preload).toBe('auto');
    expect(element.loop).toBe(true);
  });

  it('should return the same audio element', () => {
    const player = GlobalAudioPlayer.getInstance();
    const element1 = player.getAudioElement();
    const element2 = player.getAudioElement();

    expect(element1).toBe(element2);
    expect(element1).toBe(mockAudioElement);
  });

  it('should allow setting src on audio element', () => {
    const player = GlobalAudioPlayer.getInstance();
    const element = player.getAudioElement();

    element.src = 'http://example.com/audio.mp3';
    expect(element.src).toBe('http://example.com/audio.mp3');
  });

  it('should allow calling play on audio element', async () => {
    const player = GlobalAudioPlayer.getInstance();
    const element = player.getAudioElement();

    await element.play();
    expect(mockAudioElement.play).toHaveBeenCalled();
  });

  it('should allow calling pause on audio element', () => {
    const player = GlobalAudioPlayer.getInstance();
    const element = player.getAudioElement();

    element.pause();
    expect(mockAudioElement.pause).toHaveBeenCalled();
  });

  it('should allow setting volume on audio element', () => {
    const player = GlobalAudioPlayer.getInstance();
    const element = player.getAudioElement();

    element.volume = 0.5;
    expect(element.volume).toBe(0.5);
  });

  it('should allow adding event listeners', () => {
    const player = GlobalAudioPlayer.getInstance();
    const element = player.getAudioElement();
    const listener = vi.fn();

    element.addEventListener('canplaythrough', listener);
    expect(mockAudioElement.addEventListener).toHaveBeenCalledWith(
      'canplaythrough',
      listener
    );
  });

  it('should allow removing event listeners', () => {
    const player = GlobalAudioPlayer.getInstance();
    const element = player.getAudioElement();
    const listener = vi.fn();

    element.removeEventListener('canplaythrough', listener);
    expect(mockAudioElement.removeEventListener).toHaveBeenCalledWith(
      'canplaythrough',
      listener
    );
  });

  it('should persist across multiple getInstance calls', () => {
    const player1 = GlobalAudioPlayer.getInstance();
    const element1 = player1.getAudioElement();
    element1.src = 'http://example.com/audio.mp3';
    element1.volume = 0.7;

    const player2 = GlobalAudioPlayer.getInstance();
    const element2 = player2.getAudioElement();

    expect(element2.src).toBe('http://example.com/audio.mp3');
    expect(element2.volume).toBe(0.7);
  });
});
