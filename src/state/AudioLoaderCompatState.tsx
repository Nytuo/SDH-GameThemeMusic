import { createContext, FC, useContext, useEffect, useState } from 'react';
import { pauseAllAudio, setAllAudioSuspended } from '../lib/audioChannel';

interface PublicAudioLoaderCompatState {
  gamesRunning: number[];
  onAppPage: boolean;
  /** Playback is not allowed right now (Big Picture closed, sleeping...). */
  suspended: boolean;
}

interface PublicAudioLoaderCompatStateContext extends PublicAudioLoaderCompatState {
  setGamesRunning(gamesRunning: number[]): void;
  setOnThemePage(onAppPage: boolean): void;
}

export class AudioLoaderCompatState {
  private delayMs = 1000;
  private gamesRunning: number[] = [];
  private onThemePage: boolean = false;
  private themePageClaims = 0;
  private lastOnThemePageTime: number = 0;
  private suspended = false;

  public eventBus = new EventTarget();

  getPublicState(): PublicAudioLoaderCompatState {
    return {
      gamesRunning: this.gamesRunning,
      onAppPage: this.onThemePage,
      suspended: this.suspended
    };
  }

  setGamesRunning(gamesRunning: number[]) {
    const oldGamesRunning = this.gamesRunning;
    const next = Array.from(new Set(gamesRunning));
    const noGamesRunning = next.length === 0;
    const incrMs = 10;

    this.gamesRunning = next;

    if (!noGamesRunning) {
      pauseAllAudio();
    }

    // AudioLoader resumes its menu music on its own once no game is running,
    // force it off for a moment so we stay in control.
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

  /**
   * Every mounted player claims the theme page with `true` and releases it
   * with `false`; AudioLoader menu music only comes back once all claims are
   * released (after a short delay to cover page transitions).
   */
  setOnThemePage(onAppPage: boolean) {
    this.themePageClaims = Math.max(
      0,
      this.themePageClaims + (onAppPage ? 1 : -1)
    );
    const target = this.themePageClaims > 0;
    const time = Date.now();
    setTimeout(
      () => {
        this.setOnThemePageInternal(target, time);
      },
      target ? 0 : this.delayMs
    );
  }

  setSuspended(suspended: boolean) {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    setAllAudioSuspended(suspended);
    this.forceUpdate();
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
    // A release scheduled before a newer claim must not win.
    if (!onAppPage && this.themePageClaims > 0) {
      return;
    }
    this.onThemePage = onAppPage;
    this.lastOnThemePageTime = time;
    this.forceUpdate();
  }

  private forceUpdate() {
    if (this.onThemePage) {
      this.setAudioLoaderEnabled(false);
    } else {
      this.setAudioLoaderEnabled(this.gamesRunning.length === 0);
    }

    if (this.gamesRunning.length > 0) {
      pauseAllAudio();
    }

    this.eventBus.dispatchEvent(new Event('stateUpdate'));
  }
}

const AudioLoaderCompatStateContext =
  createContext<PublicAudioLoaderCompatStateContext>({
    gamesRunning: [],
    onAppPage: false,
    suspended: false,
    setGamesRunning: () => {},
    setOnThemePage: () => {}
  });
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
    // Catch updates that happened between first render and subscribing.
    onUpdate();

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

  return (
    <AudioLoaderCompatStateContext.Provider
      value={{
        ...publicState,
        setGamesRunning,
        setOnThemePage
      }}
    >
      {children}
    </AudioLoaderCompatStateContext.Provider>
  );
};
