import { vi } from 'vitest';

/** Minimal HTMLAudioElement stand-in that fires the events our hooks use. */
export class FakeAudio extends EventTarget {
  private _src = '';
  loop = false;
  preload = 'none';
  volume = 1;
  paused = true;
  ended = false;
  currentTime = 0;
  readyState = 0;

  play = vi.fn(() => {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });

  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });

  load = vi.fn();

  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this._src = '';
  });

  get src() {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
    this.readyState = 0;
  }

  /** Simulate the browser having buffered enough data. */
  becomeReady() {
    this.readyState = 4;
    this.dispatchEvent(new Event('canplaythrough'));
  }
}

export function installFakeAudio() {
  const created: FakeAudio[] = [];
  const ctor = vi.fn(() => {
    const a = new FakeAudio();
    created.push(a);
    return a;
  });
  (globalThis as any).Audio = ctor;
  return { created, ctor };
}
