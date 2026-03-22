import { afterPatch, findInReactTree } from '@decky/ui';
import { routerHook } from '@decky/api';
import { ReactElement } from 'react';

import FocusedGameThemePlayer from '../components/focusedGameThemePlayer';
import {
  AudioLoaderCompatState,
  AudioLoaderCompatStateContextProvider
} from '../state/AudioLoaderCompatState';

function patchRoute(
  route: string,
  audioLoaderCompatState: AudioLoaderCompatState
) {
  return routerHook.addPatch(route, (tree) => {
    const routeProps = findInReactTree(tree, (x) => x?.renderFunc);
    if (routeProps) {
      afterPatch(
        routeProps,
        'renderFunc',
        (_args: unknown[], ret: ReactElement) => {
          const container = findInReactTree(ret, (x: any) =>
            Array.isArray(x?.props?.children)
          );
          if (container && container.props) {
            container.props.children = [
              ...container.props.children,
              <AudioLoaderCompatStateContextProvider
                key="focused-game-theme-music"
                AudioLoaderCompatStateClass={audioLoaderCompatState}
              >
                <FocusedGameThemePlayer />
              </AudioLoaderCompatStateContextProvider>
            ];
          }
          return ret;
        }
      );
    }
    return tree;
  });
}

export function patchHomeScreen(
  audioLoaderCompatState: AudioLoaderCompatState
) {
  const homePatch = patchRoute('/library/home', audioLoaderCompatState);
  const libraryPatch = patchRoute('/library', audioLoaderCompatState);
  return { homePatch, libraryPatch };
}
