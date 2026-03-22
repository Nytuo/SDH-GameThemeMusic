import { ReactElement, useEffect, useState } from 'react';
import ThemePlayer from '../themePlayer';
import { useSettings } from '../../hooks/useSettings';

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
  const [focusedAppId, setFocusedAppId] = useState<number | null>(null);

  useEffect(() => {
    const w = window as any;
    let lastAppId: number | null = null;
    let diagLogged = false;

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
      if (el && !diagLogged) {
        diagLogged = true;
      }
      const id = el ? getAppIdFromElement(el) : null;
      if (id !== null && id !== lastAppId) {
        lastAppId = id;
        setFocusedAppId(id);
      } else if (id === null && lastAppId !== null) {
        lastAppId = null;
        setFocusedAppId(null);
      }
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
    setTimeout(registerCallback, 2000);

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

      if (appId !== lastAppId) {
        lastAppId = appId;
        setFocusedAppId(appId);
      }
    };

    const interval = setInterval(tick, 400);
    return () => {
      clearInterval(interval);
      if (unregister) unregister();
    };
  }, []);

  const { settings } = useSettings();

  if (!focusedAppId || !settings.homepageFocusMode) return <></>;
  return <ThemePlayer key={focusedAppId} appid={focusedAppId} />;
}
