import { isDesktopUI } from './playbackGuard';
import { getDesktopAppId } from './desktopPlayer';
import {
  closeDesktopWindows,
  getDesktopWindow,
  openChangeThemeWindow,
  openSettingsWindow
} from './desktopWindows';
import { getSettingsSnapshot } from '../hooks/useSettings';
import { getAppName } from './themeResolver';
import { isThemeMuted, setThemeMuted } from './audioChannel';

/**
 * Buttons in the desktop library's left sidebar, next to the search box and
 * filter button: mute the theme music, change a game's music, and the plugin
 * settings. They are plain DOM, so they need no React tree of their own.
 *
 * Steam's class names are hashed and change between versions, so the sidebar
 * row is found through the search box. If it is not found, the buttons float
 * in a corner of the window instead of disappearing.
 */

const GROUP_ID = 'gtm-sidebar-buttons';
const POLL_INTERVAL_MS = 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Material "volume up" / "volume off", and the plugin's own musical-notes logo.
const ICON_VOLUME_UP =
  'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z';
const ICON_VOLUME_OFF =
  'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z';
const ICON_NOTES =
  'M98.05 18.54c-11.46-.08-23.59 1.28-36.08 3.99L130.1 261.1c-14.2-5.1-31.18-6.2-48.09-3.2-39.17 6.9-67.15 33.8-62.52 59.8 4.64 26.1 40.14 41.7 79.33 34.7 39.08-6.9 67.08-33.7 62.38-59.8-22.1-80.8-44.4-163-66.39-244.21 50.69 3.59 72.59 31.58 90.59 60.31-.5-62.33-37.7-89.81-87.35-90.16zm310.65 30.7c-13.9.1-28.8 2.59-44.1 7.22l87.1 232.44c-14.6-3.9-31.6-3.7-48.3.7-38.4 10-64.2 39-57.5 64.6 6.7 25.7 43.4 38.3 81.8 28.2 38.5-10 64.2-39 57.5-64.6-28.6-78.8-57.3-158.9-85.8-238.2 50.8-.5 74.9 25.7 95.2 52.9-5.2-58.55-40.4-83.61-85.9-83.26zM258.4 163.5l1.8 248.1c-12.3-8.6-28.4-14.3-45.6-15.9-39.4-3.8-73.7 14.5-76.2 41-2.5 26.3 27.7 50.8 67.1 54.5 39.7 3.9 73.7-14.5 76.3-40.9.2-83.8.8-168.9 1.3-253.1 47.9 17 61.6 49.8 71.2 82.4 19.9-74.1-27.9-112.3-95.9-116.1z';

export type LauncherLabels = {
  changeMusic: string;
  settings: string;
  mute: string;
  unmute: string;
};

function setIcon(
  button: HTMLElement,
  path: string,
  viewBox = '0 0 24 24',
  size = 18
) {
  const doc = button.ownerDocument;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  const shape = doc.createElementNS(SVG_NS, 'path');
  shape.setAttribute('d', path);
  svg.appendChild(shape);
  button.replaceChildren(svg);
}

function makeButton(doc: Document, role: string, onClick: () => void) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.dataset.role = role;
  Object.assign(button.style, {
    width: '32px',
    height: '32px',
    padding: '0',
    border: 'none',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    opacity: '0.8',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none'
  });
  button.addEventListener('mouseenter', () => {
    button.style.background = 'rgba(255,255,255,0.12)';
    button.style.opacity = '1';
  });
  button.addEventListener('mouseleave', () => {
    button.style.background = 'transparent';
    button.style.opacity = '0.8';
  });
  // Steam's focus handling must not take the click.
  button.addEventListener('mousedown', (e) => e.stopPropagation());
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return button;
}

function syncMute(button: HTMLElement, labels: LauncherLabels) {
  const muted = isThemeMuted();
  setIcon(button, muted ? ICON_VOLUME_OFF : ICON_VOLUME_UP);
  button.style.color = muted ? '#e0645c' : 'inherit';
  button.title = muted ? labels.unmute : labels.mute;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(muted));
}

function buildGroup(doc: Document, labels: LauncherLabels) {
  const group = doc.createElement('div');
  group.id = GROUP_ID;

  const mute = makeButton(doc, 'mute', () => {
    setThemeMuted(!isThemeMuted());
    syncMute(mute, labels);
  });
  syncMute(mute, labels);

  const change = makeButton(doc, 'change', () => {
    const appId = getDesktopAppId();
    if (appId) openChangeThemeWindow(appId, getAppName(appId) || undefined);
  });
  change.textContent = '♫';
  change.style.fontSize = '17px';
  change.title = labels.changeMusic;
  change.setAttribute('aria-label', labels.changeMusic);

  const settings = makeButton(doc, 'settings', () => openSettingsWindow());
  setIcon(settings, ICON_NOTES, '0 0 512 512', 16);
  settings.title = labels.settings;
  settings.setAttribute('aria-label', labels.settings);

  group.append(mute, change, settings);
  return group;
}

/** The row holding Steam's library search box and filter button. */
export function findSidebarRow(doc: Document): HTMLElement | null {
  const input = doc.querySelector<HTMLElement>('input.DialogInput');
  const row =
    input?.closest('.DialogInput_Wrapper')?.parentElement?.parentElement ??
    null;
  if (!row || row.children.length < 2) return null;
  return row.querySelector('.tool-tip-source') ? row : null;
}

function place(doc: Document, group: HTMLElement) {
  const row = findSidebarRow(doc);
  if (row) {
    if (group.parentElement !== row) row.appendChild(group);
    Object.assign(group.style, {
      position: '',
      right: '',
      bottom: '',
      zIndex: '',
      display: 'flex',
      alignItems: 'center',
      flex: 'none',
      marginLeft: '2px'
    });
  } else {
    if (group.parentElement !== doc.body) doc.body.appendChild(group);
    Object.assign(group.style, {
      position: 'fixed',
      right: '18px',
      bottom: '18px',
      zIndex: '2147483000',
      display: 'flex',
      alignItems: 'center',
      flex: '',
      marginLeft: '',
      background: 'rgba(24,26,33,0.92)',
      borderRadius: '6px'
    });
  }
}

function removeGroup(win: Window | undefined) {
  try {
    win?.document?.getElementById(GROUP_ID)?.remove();
  } catch {
    /* window already gone */
  }
}

export function startDesktopLauncher(labels: () => LauncherLabels): () => void {
  let host: Window | undefined;

  const tick = () => {
    const wanted = getSettingsSnapshot().playInDesktopMode && isDesktopUI();
    const win = wanted ? getDesktopWindow() : undefined;

    if (host && host !== win) removeGroup(host);
    host = win;
    if (!win) return;

    try {
      const doc = win.document;
      let group = doc.getElementById(GROUP_ID);
      if (!group) group = buildGroup(doc, labels());
      place(doc, group);

      const mute = group.querySelector<HTMLElement>('[data-role="mute"]');
      if (mute) syncMute(mute, labels());
      // The change page needs a game; the settings do not.
      const change = group.querySelector<HTMLElement>('[data-role="change"]');
      if (change) {
        change.style.display = getDesktopAppId() !== null ? 'flex' : 'none';
      }
    } catch (e) {
      console.warn('[GameThemeMusic] Could not show the desktop buttons', e);
    }
  };

  const interval = setInterval(tick, POLL_INTERVAL_MS);
  tick();

  return () => {
    clearInterval(interval);
    removeGroup(host);
    closeDesktopWindows();
  };
}
