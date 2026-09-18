import { Router } from '@decky/ui';
import { ReactElement, useEffect, useState } from 'react';
import ThemePlayer from '../themePlayer';
import { useSettings } from '../../hooks/useSettings';

/** Wait this long on a tile before switching music (avoids thrashing). */
const FOCUS_DWELL_MS = 500;
const POLL_INTERVAL_MS = 400;

/** Routes where the focus player must stay silent. */
const BLOCKED_ROUTES = ['/gamethememusic/'];
const DETAIL_ROUTE = /\/library\/app\/(\d+)/;

export function getCurrentRoute(): string | null {
  try {
    const main = Router?.WindowStore?.GamepadUIMainWindowInstance as any;
    const path =
      main?.m_history?.location?.pathname ??
      main?.BrowserWindow?.location?.pathname;
    return typeof path === 'string' ? path : null;
  } catch {
    return null;
  }
}

export function isFocusPlaybackRoute(path: string | null): boolean {
  if (path === null) return true;
  return !BLOCKED_ROUTES.some((blocked) => path.includes(blocked));
}

export function getDetailRouteAppId(path: string | null): number | null {
  const match = path?.match(DETAIL_ROUTE);
  const appId = match ? Number(match[1]) : NaN;
  return appId > 0 ? appId : null;
}

function isDomElement(obj: any): obj is HTMLElement {
  return (
    obj &&
    typeof obj === 'object' &&
    obj.nodeType === 1 &&
    typeof obj.tagName === 'string'
  );
}

function getAppIdFromFiber(fiber: any): number | null {
  const props = fiber.memoizedProps || fiber.pendingProps;
  if (!props) return null;
  for (const key of [
    'appid',
    'nAppID',
    'nGameId',
    'appId',
    'gameId',
    'gameid',
    'nApp',
    'id'
  ]) {
    if (typeof props[key] === 'number' && props[key] > 0) return props[key];
    if (typeof props[key] === 'string' && Number(props[key]) > 0)
      return Number(props[key]);
  }
  for (const key of [
    'overview',
    'appOverview',
    'app',
    'game',
    'appData',
    'item',
    'capsule'
  ]) {
    const obj = props[key];
    if (!obj) continue;
    for (const idKey of ['appid', 'nAppID', 'id', 'appId']) {
      if (typeof obj[idKey] === 'number' && obj[idKey] > 0) return obj[idKey];
    }
  }
  return null;
}

function getAppIdFromElement(el: HTMLElement | null): number | null {
  let current: HTMLElement | null = el;
  while (current) {
    try {
      const fiberKey = Object.keys(current).find((k) =>
        k.startsWith('__reactFiber$')
      );
      if (fiberKey) {
        let fiber = (current as any)[fiberKey];
        let depth = 0;
        while (fiber && depth < 150) {
          const id = getAppIdFromFiber(fiber);
          if (id !== null) return id;
          fiber = fiber.return;
          depth++;
        }
      }
    } catch {
      /* ignore */
    }
    current = current.parentElement;
  }
  return null;
}

function getElementFromNavNode(node: any): HTMLElement | null {
  if (!node || typeof node !== 'object') return null;
  if (isDomElement(node)) return node;

  if (isDomElement(node.m_element)) return node.m_element;
  return null;
}

export default function FocusedGameThemePlayer(): ReactElement {
  const { settings } = useSettings();
  const enabled = settings.homepageFocusMode;
  const [focusedAppId, setFocusedAppId] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFocusedAppId(null);
      return;
    }

    const w = window as any;
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;

    const commit = (appId: number | null) => {
      if (dwellTimer !== null) clearTimeout(dwellTimer);
      dwellTimer = null;
      if (appId === null) {
        setFocusedAppId(null);
      } else {
        dwellTimer = setTimeout(() => setFocusedAppId(appId), FOCUS_DWELL_MS);
      }
    };
    let lastAppId: number | null = null;

    const update = (appId: number | null) => {
      const route = getCurrentRoute();
      // On a game's detail page keep playing that game, whatever is focused.
      const next = isFocusPlaybackRoute(route)
        ? (getDetailRouteAppId(route) ?? appId)
        : null;
      if (next === lastAppId) return;
      lastAppId = next;
      commit(next);
    };

    const getFocusedNavNode = () => {
      try {
        const ctx = w.FocusNavController?.m_ActiveContext;
        if (!ctx) return null;

        const tree = ctx.m_LastActiveFocusNavTree ?? ctx.m_LastActiveNavTree;
        return tree?.m_lastFocusNode ?? null;
      } catch {
        return null;
      }
    };

    const getAppIdFromNavNode = (node: any): number | null => {
      const el = getElementFromNavNode(node);
      if (!el) return null;
      return getAppIdFromElement(el);
    };

    const onFocusChanged = (_type: any, _from: any, to: any) => {
      if (!to) return;
      const el = getElementFromNavNode(to);
      update(el ? getAppIdFromElement(el) : null);
    };

    let unregister: (() => void) | null = null;
    const registerCallback = () => {
      try {
        const ctx = w.FocusNavController?.m_ActiveContext;
        const cb = ctx?.m_FocusChangedCallbacks;
        if (!cb) return;
        if (typeof cb.Register === 'function') {
          const result = cb.Register(onFocusChanged);

          if (result && typeof result.Unregister === 'function') {
            unregister = () => result.Unregister();
          } else if (typeof result === 'function') {
            unregister = result;
          }
        }
      } catch {
        /* ignore */
      }
    };
    const registerTimer = setTimeout(registerCallback, 2000);

    const tick = () => {
      let appId: number | null = null;

      const node = getFocusedNavNode();
      if (node) {
        appId = getAppIdFromNavNode(node);
      }

      if (appId === null) {
        try {
          const ctx = w.FocusNavController?.m_ActiveContext;
          const to = ctx?.m_ActiveFocusChange?.to;
          if (to) {
            appId = getAppIdFromNavNode(to);
          }
        } catch {
          /* ignore */
        }
      }

      if (appId === null) {
        try {
          const hovered = Array.from(
            document.querySelectorAll(':hover')
          ) as HTMLElement[];
          for (let i = hovered.length - 1; i >= 0; i--) {
            const id = getAppIdFromElement(hovered[i]);
            if (id !== null) {
              appId = id;
              break;
            }
          }
        } catch {
          /* ignore */
        }
      }

      update(appId);
    };

    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(registerTimer);
      if (dwellTimer !== null) clearTimeout(dwellTimer);
      if (unregister) unregister();
    };
  }, [enabled]);

  if (!focusedAppId || !enabled) return <></>;
  return <ThemePlayer key={focusedAppId} appid={focusedAppId} />;
}
