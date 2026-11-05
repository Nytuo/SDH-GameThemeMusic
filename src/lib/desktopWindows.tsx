import { ModalRoot, Router, showModal, ShowModalResult } from '@decky/ui';
import { GiMusicalNotes } from 'react-icons/gi';
import ChangeTheme from '../components/changeTheme';
import Settings from '../components/settings';
import { AppIdContext } from '../hooks/useAppId';
import { translate } from '../hooks/useTranslations';
import {
  AudioLoaderCompatState,
  AudioLoaderCompatStateContextProvider
} from '../state/AudioLoaderCompatState';

/**
 * Decky only adds the plugin's route and quick-access panel to Big Picture, so
 * in the desktop Steam client the "change music" page is blank and the
 * settings have no home. Steam's own dialogs there are separate popup windows,
 * so the same screens are opened as those.
 */

const PLUGIN_TITLE = 'Game Theme Music';
const OPEN_DEBOUNCE_MS = 400;

let themeState: AudioLoaderCompatState | null = null;
let openWindow: ShowModalResult | null = null;
let lastOpen = 0;

export function setDesktopThemeState(state: AudioLoaderCompatState | null) {
  themeState = state;
}

/** The desktop library window (anything that is not the Big Picture one). */
export function getDesktopWindow(): Window | undefined {
  try {
    const store = Router?.WindowStore as any;
    const windows: any[] = store?.SteamUIWindows ?? [];
    for (const entry of windows) {
      if (!entry || entry === store?.GamepadUIMainWindowInstance) continue;
      const browser = entry.BrowserWindow as Window | undefined;
      if (browser?.document?.body && !browser.closed) return browser;
    }
  } catch {
    /* window store not available */
  }
  return undefined;
}

function Header({ subtitle }: { subtitle?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '4px 2px 12px',
        fontSize: '18px',
        fontWeight: 700
      }}
    >
      <GiMusicalNotes size={24} />
      <span>{PLUGIN_TITLE}</span>
      {subtitle ? (
        <span style={{ fontWeight: 400, opacity: 0.7 }}>{subtitle}</span>
      ) : null}
    </div>
  );
}

function show(
  header: React.ReactNode,
  body: React.ReactNode,
  width: number,
  height: number,
  scroll: boolean
) {
  // The same click can reach the menu item twice (mouse and gamepad paths).
  const now = Date.now();
  if (now - lastOpen < OPEN_DEBOUNCE_MS) return;
  lastOpen = now;

  try {
    openWindow?.Close();
  } catch (e) {
    console.warn('[GameThemeMusic] Could not close the previous window', e);
  }
  openWindow = null;

  // Steam injects `closeModal` into the root; passing our own that calls
  // `Close()` again recurses until the stack overflows. It also sizes the
  // dialog to its content, so the content is given the window's own size.
  const modal: ShowModalResult = showModal(
    <ModalRoot bAllowFullSize>
      <div
        className="gtm-popup"
        style={{
          boxSizing: 'border-box',
          width: 'calc(100vw - 56px)',
          height: 'calc(100vh - 72px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        <style>{`.gtm-popup, .gtm-popup * { box-sizing: border-box; }`}</style>
        <div style={{ flex: 'none' }}>{header}</div>
        <div
          className="gtm-body"
          style={{
            flex: 1,
            minHeight: 0,
            overflowX: 'hidden',
            overflowY: scroll ? 'auto' : 'hidden'
          }}
        >
          {body}
        </div>
      </div>
    </ModalRoot>,
    getDesktopWindow(),
    {
      strTitle: PLUGIN_TITLE,
      bForcePopOut: true,
      bHideMainWindowForPopouts: false,
      popupWidth: width,
      popupHeight: height,
      fnOnClose: () => {
        if (openWindow === modal) openWindow = null;
      }
    }
  );
  openWindow = modal;
}

export function openChangeThemeWindow(appId: number, gameName?: string) {
  const state = themeState;
  if (!state || !appId) return;
  show(
    <Header subtitle={gameName} />,
    <AudioLoaderCompatStateContextProvider AudioLoaderCompatStateClass={state}>
      <AppIdContext.Provider value={appId}>
        <ChangeTheme embedded />
      </AppIdContext.Provider>
    </AudioLoaderCompatStateContextProvider>,
    1000,
    760,
    false
  );
}

export function openSettingsWindow() {
  show(
    <Header subtitle={translate('settings')} />,
    <Settings />,
    600,
    760,
    true
  );
}

export function closeDesktopWindows() {
  try {
    openWindow?.Close();
  } catch {
    /* already closed */
  }
  openWindow = null;
}
