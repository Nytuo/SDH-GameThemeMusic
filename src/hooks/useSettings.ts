import { call } from '@decky/api';
import { useEffect, useReducer } from 'react';

export type Settings = {
  defaultMuted: boolean;
  volume: number;
  homepageFocusMode: boolean;
};

export const defaultSettings: Settings = {
  defaultMuted: false,
  volume: 1,
  homepageFocusMode: false
};

let _settings: Settings = { ...defaultSettings };
let _loaded = false;
let _loadPromise: Promise<void> | null = null;
const _subscribers = new Set<() => void>();

function notifyAll() {
  _subscribers.forEach((fn) => fn());
}

function loadSettings() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = call<[string, Settings], Settings>(
    'get_setting',
    'settings',
    defaultSettings
  ).then((saved) => {
    _settings = saved;
    _loaded = true;
    notifyAll();
  });
  return _loadPromise;
}

function saveSettings(
  key: keyof Settings,
  value: Settings[keyof Settings]
): void {
  _settings = { ..._settings, [key]: value };

  notifyAll();
  call<[string, Settings], Settings>(
    'set_setting',
    'settings',
    _settings
  ).catch(console.error);
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

  return {
    settings: _settings,
    setDefaultMuted,
    setVolume,
    setHomepageFocusMode,
    isLoading: !_loaded
  };
};
