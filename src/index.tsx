import { Router, staticClasses } from '@decky/ui';
import { definePlugin, routerHook } from '@decky/api';

import { GiMusicalNotes } from 'react-icons/gi';

import Settings from './components/settings';
import patchLibraryApp from './lib/patchLibraryApp';
import FocusedGameThemePlayer from './components/focusedGameThemePlayer';
import patchContextMenu, { LibraryContextMenu } from './lib/patchContextMenu';
import ChangeTheme from './components/changeTheme';
import {
  AudioLoaderCompatState,
  AudioLoaderCompatStateContextProvider
} from './state/AudioLoaderCompatState';
import { destroyAudioChannels } from './lib/audioChannel';
import { startPlaybackGuard } from './lib/playbackGuard';

import { name } from '@decky/manifest';

export default definePlugin(() => {
  const state: AudioLoaderCompatState = new AudioLoaderCompatState();

  // Games already running when the plugin (re)loads.
  try {
    const running = (Router?.RunningApps ?? [])
      .map((app) => Number(app.appid))
      .filter((appid) => Number.isFinite(appid) && appid > 0);
    if (running.length) state.setGamesRunning(running);
  } catch {
    /* Router not ready */
  }

  const stopPlaybackGuard = startPlaybackGuard((suspended) =>
    state.setSuspended(suspended)
  );
  const libraryPatch = patchLibraryApp(state);

  const GlobalPlayer = () => (
    <AudioLoaderCompatStateContextProvider AudioLoaderCompatStateClass={state}>
      <FocusedGameThemePlayer />
    </AudioLoaderCompatStateContextProvider>
  );
  routerHook.addGlobalComponent('GTMFocusedPlayer', GlobalPlayer);

  routerHook.addRoute(
    '/gamethememusic/:appid',
    () => (
      <AudioLoaderCompatStateContextProvider
        AudioLoaderCompatStateClass={state}
      >
        <ChangeTheme />
      </AudioLoaderCompatStateContextProvider>
    ),
    {
      exact: true
    }
  );

  let patchedMenu: { unpatch: () => void } | null = null;
  try {
    if (LibraryContextMenu) {
      patchedMenu = patchContextMenu(LibraryContextMenu);
    }
  } catch (e) {
    console.warn('[GameThemeMusic] Failed to patch context menu:', e);
  }

  const AppStateRegistrar =
    SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
      (update: AppState) => {
        const { gamesRunning } = state.getPublicState();
        const setGamesRunning = state.setGamesRunning.bind(state);

        if (update.bRunning) {
          setGamesRunning([...gamesRunning, update.unAppID]);
        } else {
          const filteredGames = gamesRunning.filter(
            (e: number) => e !== update.unAppID
          );
          setGamesRunning(filteredGames);
        }
      }
    );

  return {
    name,
    titleView: <div className={staticClasses.Title}>{name}</div>,
    icon: <GiMusicalNotes />,
    content: <Settings />,
    onDismount() {
      stopPlaybackGuard();
      AppStateRegistrar.unregister();
      routerHook.removePatch('/library/app/:appid', libraryPatch);
      routerHook.removeRoute('/gamethememusic/:appid');
      routerHook.removeGlobalComponent('GTMFocusedPlayer');
      patchedMenu?.unpatch();
      destroyAudioChannels();
    }
  };
});
