import '@testing-library/jest-dom';
import * as React from 'react';
import { vi } from 'vitest';

// The plugin is compiled with jsxFactory = window.SP_REACT.createElement.
(window as any).SP_REACT = React;

vi.mock('@decky/ui', () => ({
  definePlugin: vi.fn(),
  staticClasses: {},
  useParams: vi.fn(() => ({})),
  afterPatch: vi.fn(),
  fakeRenderComponent: vi.fn((component) => ({ type: component })),
  findInReactTree: vi.fn(),
  findModuleChild: vi.fn(),
  findInTree: vi.fn(),
  MenuItem: vi.fn(({ children }) => children),
  Navigation: {
    Navigate: vi.fn()
  },
  appDetailsClasses: {
    InnerContainer: 'InnerContainer'
  },
  createReactTreePatcher: vi.fn()
}));

vi.mock('@decky/api', () => ({
  call: vi.fn(),
  routerHook: {
    addPatch: vi.fn(),
    addRoute: vi.fn(),
    addGlobalComponent: vi.fn(),
    removePatch: vi.fn(),
    removeRoute: vi.fn(),
    removeGlobalComponent: vi.fn()
  }
}));

vi.mock('@decky/manifest', () => ({
  name: 'Game Theme Music'
}));

(globalThis as any).SteamClient = {
  GameSessions: {
    RegisterForAppLifetimeNotifications: vi.fn(() => ({
      unregister: vi.fn()
    }))
  },
  UI: {
    RegisterForUIModeChanged: vi.fn(() => ({ unregister: vi.fn() })),
    GetUIMode: vi.fn(() => Promise.resolve(4))
  }
};

(globalThis as any).appStore = {
  GetAppOverviewByGameID: vi.fn(() => ({ display_name: 'Test Game' }))
};
