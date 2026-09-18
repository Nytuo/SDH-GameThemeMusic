/**
 * Shared audio outputs.
 *
 * - `theme`: the game's theme music. Shared so that Steam re-mounting the
 *   library page does not restart the track, but released (stopped) shortly
 *   after the last component using it unmounts.
 * - `preview`: the "Change Theme Music" previews. Only the card that pressed
 *   play owns it, so a preview can never play another card's (or the
 *   downloaded) track.
 *
 * Every channel can be suspended (Big Picture closed, device sleeping, plugin
 * unloading); a suspended channel refuses to play.
 */

export type ChannelName = 'theme' | 'preview';

type Listener = () => void;

/** Time a channel keeps playing after its last user unmounted. */
export const RELEASE_GRACE_MS = 400;

const MEDIA_EVENTS = [
  'play',
  'playing',
  'pause',
  'ended',
  'canplay',
  'canplaythrough',
  'emptied',
  'error'
] as const;

export class AudioChannel {
  readonly element: HTMLAudioElement;
  private url = '';
  private owner: symbol | null = null;
  private users = new Set<symbol>();
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private suspended = false;
  private listeners = new Set<Listener>();

  constructor(readonly name: ChannelName) {
    this.element = new Audio();
    this.element.preload = 'auto';
    this.element.loop = true;
    for (const event of MEDIA_EVENTS) {
      this.element.addEventListener(event, () => this.emit());
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  acquire(id: symbol) {
    this.users.add(id);
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  release(id: symbol) {
    this.users.delete(id);
    if (this.owner === id) {
      this.owner = null;
      if (this.name === 'preview') this.halt();
    }
    if (this.users.size === 0 && this.releaseTimer === null) {
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        if (this.users.size === 0) this.halt();
      }, RELEASE_GRACE_MS);
    }
  }

  getUrl() {
    return this.url;
  }

  isOwner(id: symbol) {
    return this.owner === id;
  }

  isSuspended() {
    return this.suspended;
  }

  isPlayingFor(id: symbol, url?: string) {
    return (
      this.owner === id &&
      !this.element.paused &&
      (url === undefined || url === this.url)
    );
  }

  isReadyFor(url: string | undefined) {
    return (
      !!url &&
      url === this.url &&
      this.element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    );
  }

  /** Take ownership without changing what is loaded. */
  claim(id: symbol) {
    this.owner = id;
  }

  /** Point the channel at `url` (without playing) and take ownership. */
  load(id: symbol, url: string) {
    if (!url) return;
    this.owner = id;
    if (url !== this.url) {
      this.url = url;
      this.element.src = url;
      this.element.loop = true;
    }
    this.emit();
  }

  play(id: symbol, url: string): boolean {
    if (!url) return false;
    this.load(id, url);
    if (this.suspended) return false;
    // A preview always wins over the theme music.
    const preview = channels.get('preview');
    if (this.name === 'theme' && preview && !preview.element.paused) {
      return false;
    }
    if (this.name === 'preview') channels.get('theme')?.pause();
    try {
      const result = this.element.play();
      if (result && typeof result.catch === 'function') {
        result.catch((err: unknown) => {
          if ((err as { name?: string })?.name !== 'AbortError') {
            console.warn(`[GameThemeMusic] ${this.name} playback failed`, err);
          }
        });
      }
    } catch (err) {
      console.warn(`[GameThemeMusic] ${this.name} playback failed`, err);
      return false;
    }
    return true;
  }

  /** Pause if `id` owns the channel (or unconditionally without an id). */
  pause(id?: symbol) {
    if (id !== undefined && this.owner !== id) return;
    if (!this.element.paused) this.element.pause();
  }

  stop(id?: symbol) {
    if (id !== undefined && this.owner !== id) return;
    this.pause();
    try {
      this.element.currentTime = 0;
    } catch {
      /* not seekable yet */
    }
  }

  setVolume(volume: number) {
    if (!Number.isFinite(volume)) return;
    this.element.volume = Math.min(1, Math.max(0, volume));
  }

  /** Stop playback and drop the source so nothing can resume it. */
  halt() {
    this.pause();
    this.url = '';
    this.owner = null;
    this.element.removeAttribute('src');
    try {
      this.element.load();
    } catch {
      /* jsdom / detached element */
    }
    this.emit();
  }

  setSuspended(suspended: boolean) {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) this.pause();
    this.emit();
  }
}

const channels = new Map<ChannelName, AudioChannel>();
let allSuspended = false;

export function getAudioChannel(name: ChannelName): AudioChannel {
  let channel = channels.get(name);
  if (!channel) {
    channel = new AudioChannel(name);
    channel.setSuspended(allSuspended);
    channels.set(name, channel);
  }
  return channel;
}

export function setAllAudioSuspended(suspended: boolean) {
  allSuspended = suspended;
  channels.forEach((channel) => channel.setSuspended(suspended));
}

export function pauseAllAudio() {
  channels.forEach((channel) => channel.pause());
}

/** Stop everything and forget the channels (plugin unload / tests). */
export function destroyAudioChannels() {
  channels.forEach((channel) => channel.halt());
  channels.clear();
  allSuspended = false;
}
