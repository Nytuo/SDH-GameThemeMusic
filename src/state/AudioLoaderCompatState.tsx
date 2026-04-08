/* eslint-disable @typescript-eslint/no-explicit-any */
import { createContext, FC, useContext, useEffect, useState } from 'react';

interface PublicAudioLoaderCompatState {
  gamesRunning: number[];
  onAppPage: boolean;
}

interface PublicAudioLoaderCompatStateContext extends PublicAudioLoaderCompatState {
  setGamesRunning(gamesRunning: number[]): void;
  setOnThemePage(onAppPage: boolean): void;
  registerAudioPlayer(player: HTMLAudioElement): void;
  unregisterAudioPlayer(player: HTMLAudioElement): void;
}

export class AudioLoaderCompatState {
  private delayMs = 1000;
  private gamesRunning: number[] = [];
  private onThemePage: boolean = false;
  private lastOnThemePageTime: number = 0;
  private activeAudioPlayer: HTMLAudioElement | null = null;

  public eventBus = new EventTarget();

  getPublicState() {
    return {
      gamesRunning: this.gamesRunning,
      onAppPage: this.onThemePage
    };
  }

  setGamesRunning(gamesRunning: number[]) {
    const oldGamesRunning = this.gamesRunning;
    const noGamesRunning = gamesRunning.length === 0;
    const gameJustStarted = gamesRunning.length > oldGamesRunning.length;
    const incrMs = 10;

    this.gamesRunning = gamesRunning;

    if (gameJustStarted && this.activeAudioPlayer) {
      this.activeAudioPlayer.pause();
    }

    if (noGamesRunning && oldGamesRunning.length > 0) {
      for (let i = 0; i < this.delayMs; i += incrMs) {
        setTimeout(() => {
          this.setAudioLoaderEnabled(false);
        }, i);
      }
    }
    setTimeout(
      () => {
        this.forceUpdate();
      },
      noGamesRunning ? this.delayMs : 0
    );
  }

  setOnThemePage(onAppPage: boolean) {
    const time = Date.now();
    setTimeout(
      () => {
        this.setOnThemePageInternal(onAppPage, time);
      },
      onAppPage ? 0 : this.delayMs
    );
  }

  private setAudioLoaderEnabled(enabled: boolean) {
    const audioLoader = (window as any).AUDIOLOADER_MENUMUSIC;
    if (audioLoader) {
      if (enabled) audioLoader.play();
      else audioLoader.pause();
    }
  }

  private setOnThemePageInternal(onAppPage: boolean, time: number) {
    if (time < this.lastOnThemePageTime) {
      return;
    }
    this.onThemePage = onAppPage;
    this.lastOnThemePageTime = time;
    this.forceUpdate();
  }

  registerAudioPlayer(player: HTMLAudioElement) {
    this.activeAudioPlayer = player;
    if (this.gamesRunning.length > 0) {
      player.pause();
    }
  }

  unregisterAudioPlayer(player: HTMLAudioElement) {
    if (this.activeAudioPlayer === player) {
      this.activeAudioPlayer = null;
    }
  }

  private forceUpdate() {
    if (this.onThemePage) {
      this.setAudioLoaderEnabled(false);
    } else {
      this.setAudioLoaderEnabled(this.gamesRunning.length === 0);
    }

    if (this.activeAudioPlayer && this.gamesRunning.length > 0) {
      this.activeAudioPlayer.pause();
    }

    this.eventBus.dispatchEvent(new Event('stateUpdate'));
  }
}

const AudioLoaderCompatStateContext =
  createContext<PublicAudioLoaderCompatStateContext>(null as any);
export const useAudioLoaderCompatState = () =>
  useContext(AudioLoaderCompatStateContext);

interface ProviderProps {
  AudioLoaderCompatStateClass: AudioLoaderCompatState;
  children?: React.ReactNode;
}

export const AudioLoaderCompatStateContextProvider: FC<ProviderProps> = ({
  children,
  AudioLoaderCompatStateClass
}) => {
  const [publicState, setPublicState] = useState<PublicAudioLoaderCompatState>({
    ...AudioLoaderCompatStateClass.getPublicState()
  });

  useEffect(() => {
    function onUpdate() {
      setPublicState({ ...AudioLoaderCompatStateClass.getPublicState() });
    }

    AudioLoaderCompatStateClass.eventBus.addEventListener(
      'stateUpdate',
      onUpdate
    );

    return () =>
      AudioLoaderCompatStateClass.eventBus.removeEventListener(
        'stateUpdate',
        onUpdate
      );
  }, []);

  const setGamesRunning = (gamesRunning: number[]) =>
    AudioLoaderCompatStateClass.setGamesRunning(gamesRunning);
  const setOnThemePage = (onAppPage: boolean) =>
    AudioLoaderCompatStateClass.setOnThemePage(onAppPage);
  const registerAudioPlayer = (player: HTMLAudioElement) =>
    AudioLoaderCompatStateClass.registerAudioPlayer(player);
  const unregisterAudioPlayer = (player: HTMLAudioElement) =>
    AudioLoaderCompatStateClass.unregisterAudioPlayer(player);

  return (
    <AudioLoaderCompatStateContext.Provider
      value={{
        ...publicState,
        setGamesRunning,
        setOnThemePage,
        registerAudioPlayer,
        unregisterAudioPlayer
      }}
    >
      {children}
    </AudioLoaderCompatStateContext.Provider>
  );
};
