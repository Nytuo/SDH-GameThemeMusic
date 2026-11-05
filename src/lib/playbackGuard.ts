import { Router } from '@decky/ui';

/** EUIMode.Desktop – Steam left Big Picture / Game Mode. */
const UI_MODE_DESKTOP = 7;
const WATCHDOG_INTERVAL_MS = 1000;

type Unregisterable = { unregister: () => void };

const steamClient = (): any => (globalThis as any).SteamClient;

function register(
  target: any,
  method: string,
  callback: (...args: never[]) => void
): Unregisterable | null {
  try {
    if (typeof target?.[method] !== 'function') return null;
    const handle = target[method](callback);
    if (handle && typeof handle.unregister === 'function') return handle;
  } catch (e) {
    console.warn('[GameThemeMusic] Could not register Steam callback', e);
  }
  return null;
}

let uiModeDesktop = false;
let bigPictureClosed = false;

/**
 * True while Steam shows its desktop client rather than Big Picture / Game
 * Mode (or Big Picture has no window at all). Only meaningful while a
 * playback guard is running.
 */
export function isDesktopUI(): boolean {
  return uiModeDesktop || bigPictureClosed;
}

/** True when the Big Picture window is gone or closed. */
export function isGamepadUIClosed(): boolean {
  try {
    const store = Router?.WindowStore;
    if (!store) return false; // unknown client layout, don't block playback
    const main = store.GamepadUIMainWindowInstance;
    if (!main) return true;
    return main.BrowserWindow?.closed === true;
  } catch {
    return false;
  }
}

const VIDEO_EVENTS = [
  'play',
  'playing',
  'pause',
  'ended',
  'emptied',
  'volumechange'
] as const;

function getWatchedDocuments(): Document[] {
  const docs: Document[] = [];
  try {
    const main = Router?.WindowStore?.GamepadUIMainWindowInstance as any;
    const doc = main?.BrowserWindow?.document;
    if (doc && typeof doc.querySelectorAll === 'function') docs.push(doc);
  } catch {
    /* window gone */
  }
  if (typeof document !== 'undefined' && !docs.includes(document)) {
    docs.push(document);
  }
  return docs;
}

/**
 * True while a video with sound is playing, e.g. the Big Picture startup
 * movie. Looping or muted videos (animated backgrounds) are ignored.
 */
export function isAudibleVideoPlaying(
  docs: Document[] = getWatchedDocuments()
): boolean {
  try {
    return docs.some((doc) =>
      Array.from(doc.querySelectorAll('video')).some(
        (video) =>
          !video.paused &&
          !video.ended &&
          !video.muted &&
          !video.loop &&
          video.volume > 0
      )
    );
  } catch {
    return false;
  }
}

export type PlaybackGuardOptions = {
  /** Keep playing while Steam shows its desktop client (re-read every second). */
  allowDesktop?: () => boolean;
};

/**
 * Suspend playback whenever Steam is not showing Big Picture / Game Mode
 * (unless `allowDesktop` says the desktop client is fine), the device goes to
 * sleep, or a video with sound (the startup movie) plays. Calls
 * `onChange(true)` to suspend and `onChange(false)` to allow playback again.
 * Returns a disposer.
 */
export function startPlaybackGuard(
  onChange: (suspended: boolean) => void,
  options: PlaybackGuardOptions = {}
): () => void {
  let desktopMode = false;
  let sleeping = false;
  let windowClosed = isGamepadUIClosed();
  let videoPlaying = isAudibleVideoPlaying();
  let last: boolean | null = null;

  const update = () => {
    uiModeDesktop = desktopMode;
    bigPictureClosed = windowClosed;
    const desktopAllowed = options.allowDesktop?.() === true;
    const suspended =
      (!desktopAllowed && (desktopMode || windowClosed)) ||
      sleeping ||
      videoPlaying;
    if (suspended !== last) {
      last = suspended;
      onChange(suspended);
    }
  };

  const onUIMode = (mode: number) => {
    desktopMode = mode === UI_MODE_DESKTOP;
    update();
  };

  const handles = [
    register(steamClient()?.UI, 'RegisterForUIModeChanged', onUIMode),
    register(steamClient()?.System, 'RegisterForOnSuspendRequest', () => {
      sleeping = true;
      update();
    }),
    register(steamClient()?.System, 'RegisterForOnResumeFromSuspend', () => {
      sleeping = false;
      update();
    })
  ];

  try {
    const pending = steamClient()?.UI?.GetUIMode?.();
    if (pending && typeof pending.then === 'function') {
      pending.then(onUIMode).catch(() => {});
    }
  } catch {
    /* older clients */
  }

  // Media events don't bubble, so listen in the capture phase.
  const onVideoEvent = (event: Event) => {
    if ((event.target as Element | null)?.tagName !== 'VIDEO') return;
    videoPlaying = isAudibleVideoPlaying();
    update();
  };
  const listened = new Set<Document>();
  const listenToVideos = () => {
    for (const doc of getWatchedDocuments()) {
      if (listened.has(doc)) continue;
      try {
        VIDEO_EVENTS.forEach((e) =>
          doc.addEventListener(e, onVideoEvent, true)
        );
        listened.add(doc);
      } catch {
        /* detached document */
      }
    }
  };
  const unlistenToVideos = () => {
    listened.forEach((doc) => {
      try {
        VIDEO_EVENTS.forEach((e) =>
          doc.removeEventListener(e, onVideoEvent, true)
        );
      } catch {
        /* window gone */
      }
    });
    listened.clear();
  };

  listenToVideos();
  const watchdog = setInterval(() => {
    windowClosed = isGamepadUIClosed();
    listenToVideos();
    videoPlaying = isAudibleVideoPlaying();
    update();
  }, WATCHDOG_INTERVAL_MS);

  update();

  return () => {
    clearInterval(watchdog);
    uiModeDesktop = false;
    bigPictureClosed = false;
    unlistenToVideos();
    handles.forEach((h) => {
      try {
        h?.unregister();
      } catch {
        /* already gone */
      }
    });
  };
}
