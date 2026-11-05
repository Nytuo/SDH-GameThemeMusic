import { Router } from '@decky/ui';
import { getAudioChannel } from './audioChannel';
import { isDesktopUI } from './playbackGuard';
import { resolveThemeAudio } from './themeResolver';
import { getCache } from '../cache/musicCache';
import { getSettingsSnapshot } from '../hooks/useSettings';
import type { AudioLoaderCompatState } from '../state/AudioLoaderCompatState';

/**
 * Theme music in the desktop Steam client (experimental).
 *
 * Big Picture shows the plugin through React patches; the desktop library is
 * a different window those patches never reach. This follows the game opened
 * in the desktop library instead, and plays through the same audio channel
 * without needing any React tree of its own.
 */

const POLL_INTERVAL_MS = 700;
const LIBRARY_APP_ROUTE = /\/library\/app\/(\d+)/;

function appIdFromLocation(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(LIBRARY_APP_ROUTE);
  const appId = match ? Number(match[1]) : NaN;
  return appId > 0 ? appId : null;
}

/** The game whose page is open in the desktop library, if it can be told. */
export function getDesktopAppId(): number | null {
  try {
    const store = Router?.WindowStore as any;
    const windows: any[] = store?.SteamUIWindows ?? [];
    for (const window of windows) {
      if (!window || window === store?.GamepadUIMainWindowInstance) continue;
      const browser = window.BrowserWindow;
      for (const candidate of [
        window.m_history?.location?.pathname,
        browser?.location?.pathname,
        browser?.location?.hash,
        browser?.location?.href
      ]) {
        const appId = appIdFromLocation(candidate);
        if (appId !== null) return appId;
      }
    }
  } catch {
    /* window store not available */
  }
  return null;
}

export function startDesktopPlayer(
  state: AudioLoaderCompatState,
  getAppId: () => number | null = getDesktopAppId
): () => void {
  const channel = getAudioChannel('theme');
  const id = Symbol('desktop-player');
  let currentApp: number | null = null;
  let playing = false;
  let generation = 0;

  const stop = () => {
    generation++;
    currentApp = null;
    if (playing) {
      playing = false;
      channel.stop(id);
      channel.release(id);
    }
  };

  const tick = async () => {
    const { suspended, gamesRunning } = state.getPublicState();
    const settings = getSettingsSnapshot();
    if (
      !settings.playInDesktopMode ||
      !isDesktopUI() ||
      suspended ||
      gamesRunning.length > 0
    ) {
      stop();
      return;
    }

    const appId = getAppId();
    if (appId === null) {
      stop();
      return;
    }
    if (appId === currentApp) return;

    stop();
    currentApp = appId;
    const mine = ++generation;
    try {
      const audio = await resolveThemeAudio(appId, {
        defaultMuted: settings.defaultMuted,
        autoFallback: settings.autoFallback,
        isCancelled: () => mine !== generation
      });
      if (mine !== generation || !audio.audioUrl.length) return;

      const cache = await getCache(appId);
      if (mine !== generation) return;
      channel.acquire(id);
      playing = true;
      channel.claim(id);
      channel.setVolume(
        typeof cache?.volume === 'number' && isFinite(cache.volume)
          ? cache.volume
          : settings.volume
      );
      channel.play(id, audio.audioUrl);
    } catch (e) {
      console.error('[GameThemeMusic] Desktop playback failed', e);
    }
  };

  const interval = setInterval(() => {
    tick().catch(console.error);
  }, POLL_INTERVAL_MS);

  return () => {
    clearInterval(interval);
    stop();
  };
}
