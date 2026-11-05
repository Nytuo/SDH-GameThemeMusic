import { call } from '@decky/api';
import { useEffect, useReducer } from 'react';

export type Settings = {
  defaultMuted: boolean;
  volume: number;
  homepageFocusMode: boolean;
  /** Try other sources when YouTube has nothing for a game. */
  autoFallback: boolean;
  /** Also play theme music in the desktop Steam client (experimental). */
  playInDesktopMode: boolean;
  /** Source tab last used on the "change theme" page. */
  lastSource: string;
};

export const defaultSettings: Settings = {
  defaultMuted: false,
  volume: 1,
  homepageFocusMode: false,
  autoFallback: true,
  playInDesktopMode: false,
  lastSource: 'ytdlp'
};

/** Slider drags change the volume many times a second; write once it settles. */
export const SAVE_DEBOUNCE_MS = 300;
const LOAD_RETRIES = 3;
const LOAD_RETRY_DELAY_MS = 1500;

let _settings: Settings = { ...defaultSettings };
let _loaded = false;
let _loadPromise: Promise<void> | null = null;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
const _subscribers = new Set<() => void>();

function notifyAll() {
  _subscribers.forEach((fn) => fn());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSaved(): Promise<Settings | undefined> {
  for (let attempt = 0; attempt < LOAD_RETRIES; attempt++) {
    try {
      return await call<[string, Settings], Settings>(
        'get_setting',
        'settings',
        defaultSettings
      );
    } catch (e) {
      console.error('[GameThemeMusic] Could not load settings', e);
      // Saving defaults over the user's real settings after a transient
      // backend error would lose them, so try again first.
      if (attempt < LOAD_RETRIES - 1) await sleep(LOAD_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

function loadSettings() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = fetchSaved()
    .then((saved) => {
      // Keys added in newer versions fall back to their defaults. Changes the
      // user made while loading win over the stored values.
      _settings = {
        ...defaultSettings,
        ...(saved && typeof saved === 'object' ? saved : {}),
        ..._pendingChanges
      };
    })
    .finally(() => {
      _loaded = true;
      notifyAll();
    });
  return _loadPromise;
}

let _pendingChanges: Partial<Settings> = {};

function flushSave() {
  _saveTimer = null;
  // Never write before the stored settings were read: the write would replace
  // them with defaults.
  (_loaded ? Promise.resolve() : (_loadPromise ?? loadSettings()))
    .then(() =>
      call<[string, Settings], Settings>('set_setting', 'settings', _settings)
    )
    .catch(console.error);
}

function saveSettings(
  key: keyof Settings,
  value: Settings[keyof Settings]
): void {
  _settings = { ..._settings, [key]: value };
  if (!_loaded) _pendingChanges = { ..._pendingChanges, [key]: value };

  notifyAll();
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

/** Current settings outside React (playback guard, desktop player). */
export function getSettingsSnapshot(): Settings {
  return _settings;
}

/** Start loading the settings without waiting for a component to ask. */
export function ensureSettingsLoaded(): Promise<void> {
  return loadSettings();
}

export const useSettings = () => {
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    _subscribers.add(forceUpdate);
    if (!_loaded) {
      loadSettings();
    }
    return () => {
      _subscribers.delete(forceUpdate);
    };
  }, []);

  function setDefaultMuted(value: Settings['defaultMuted']) {
    saveSettings('defaultMuted', value);
  }
  function setVolume(value: Settings['volume']) {
    saveSettings('volume', value);
  }
  function setHomepageFocusMode(value: Settings['homepageFocusMode']) {
    saveSettings('homepageFocusMode', value);
  }
  function setAutoFallback(value: Settings['autoFallback']) {
    saveSettings('autoFallback', value);
  }
  function setPlayInDesktopMode(value: Settings['playInDesktopMode']) {
    saveSettings('playInDesktopMode', value);
  }
  function setLastSource(value: Settings['lastSource']) {
    saveSettings('lastSource', value);
  }

  return {
    settings: _settings,
    setDefaultMuted,
    setVolume,
    setHomepageFocusMode,
    setAutoFallback,
    setPlayInDesktopMode,
    setLastSource,
    isLoading: !_loaded
  };
};
