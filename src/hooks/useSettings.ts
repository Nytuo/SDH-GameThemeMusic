import { call } from '@decky/api';
import { useEffect, useState } from 'react';

export type Settings = {
  defaultMuted: boolean;
  volume: number;
};

export const defaultSettings: Settings = {
  defaultMuted: false,
  volume: 1
};

export const useSettings = () => {
  const [settings, setSettings] = useState<Settings>(defaultSettings);

  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const getData = async () => {
      setIsLoading(true);
      const savedSettings = await call<[string, Settings], Settings>(
        'get_setting',
        'settings',
        settings
      );
      setSettings(savedSettings);
      setIsLoading(false);
    };
    getData().then(() => {
      return;
    });
  }, []);

  async function updateSettings(
    key: keyof Settings,
    value: Settings[keyof Settings]
  ) {
    setSettings((oldSettings) => {
      const newSettings = { ...oldSettings, [key]: value };
      call<[string, Settings], Settings>(
        'set_setting',
        'settings',
        newSettings
      ).catch(console.error);
      return newSettings;
    });
  }

  function setDefaultMuted(value: Settings['defaultMuted']) {
    updateSettings('defaultMuted', value).then(() => {
      return;
    });
  }
  function setVolume(value: Settings['volume']) {
    updateSettings('volume', value).then(() => {
      return;
    });
  }

  return {
    settings,
    setDefaultMuted,
    setVolume,
    isLoading
  };
};
