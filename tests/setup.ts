import '@testing-library/jest-dom';
import { vi } from 'vitest';

vi.mock('@decky/ui', () => ({
  definePlugin: vi.fn(),
  staticClasses: {},
  useParams: vi.fn(),
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

global.SteamClient = {
  GameSessions: {
    RegisterForAppLifetimeNotifications: vi.fn(() => ({
      unregister: vi.fn()
    }))
  }
} as any;

global.Audio = vi.fn().mockImplementation(() => ({
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
  load: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  src: '',
  currentTime: 0,
  duration: 0,
  paused: true,
  volume: 1,
  loop: false,
  readyState: 4
}));
