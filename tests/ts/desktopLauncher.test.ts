import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from '@decky/ui';

const opened = vi.hoisted(() => ({
  change: vi.fn(),
  settings: vi.fn(),
  closeAll: vi.fn(),
  win: undefined as unknown
}));

vi.mock('../../src/lib/desktopWindows', () => ({
  getDesktopWindow: () => opened.win,
  openChangeThemeWindow: opened.change,
  openSettingsWindow: opened.settings,
  closeDesktopWindows: opened.closeAll
}));
vi.mock('../../src/lib/playbackGuard', () => ({ isDesktopUI: () => true }));
vi.mock('../../src/lib/desktopPlayer', () => ({
  getDesktopAppId: () => appId
}));
vi.mock('../../src/lib/themeResolver', () => ({
  getAppName: () => 'Portal'
}));

let appId: number | null = null;
let playInDesktopMode = true;
vi.mock('../../src/hooks/useSettings', () => ({
  getSettingsSnapshot: () => ({ playInDesktopMode })
}));

import { getAudioChannel, isThemeMuted } from '../../src/lib/audioChannel';
import { startDesktopLauncher } from '../../src/lib/desktopLauncher';

const labels = () => ({
  changeMusic: 'Change music',
  settings: 'Settings',
  mute: 'Mute',
  unmute: 'Unmute'
});
const bar = () =>
  opened.win &&
  (opened.win as Window).document.getElementById('gtm-sidebar-buttons');

describe('desktop launcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    opened.change.mockReset();
    opened.settings.mockReset();
    opened.closeAll.mockReset();
    opened.win = window;
    appId = 220;
    playInDesktopMode = true;
    (Router as any).WindowStore = {};
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('adds two buttons that open the change page and the settings', () => {
    const stop = startDesktopLauncher(labels);
    const root = bar()!;
    expect(root).toBeTruthy();
    const buttons = root.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[1].title).toBe('Change music');

    buttons[1].click();
    expect(opened.change).toHaveBeenCalledWith(220, 'Portal');
    buttons[2].click();
    expect(opened.settings).toHaveBeenCalled();
    stop();
  });

  it('mute button silences the theme channel and toggles back', () => {
    const stop = startDesktopLauncher(labels);
    const mute = bar()!.querySelector<HTMLButtonElement>('[data-role="mute"]')!;
    expect(mute.title).toBe('Mute');
    mute.click();
    expect(isThemeMuted()).toBe(true);
    expect(getAudioChannel('theme').element.muted).toBe(true);
    expect(mute.title).toBe('Unmute');
    mute.click();
    expect(isThemeMuted()).toBe(false);
    expect(getAudioChannel('theme').element.muted).toBe(false);
    stop();
  });

  it('sits in the library sidebar row next to the search box when found', () => {
    document.body.innerHTML =
      '<div id="row"><div><div class="DialogInput_Wrapper"><input class="DialogInput"></div></div><div class="tool-tip-source"></div></div>';
    const stop = startDesktopLauncher(labels);
    const row = document.getElementById('row')!;
    expect(bar()!.parentElement).toBe(row);
    expect(document.body.style.position).toBe('');
    stop();
    expect(document.getElementById('row')!.children).toHaveLength(2);
  });

  it('floats in a corner when the sidebar row is not found', () => {
    const stop = startDesktopLauncher(labels);
    expect(bar()!.parentElement).toBe(document.body);
    expect(bar()!.style.position).toBe('fixed');
    stop();
  });

  it('hides the change button when no game page is open', () => {
    const stop = startDesktopLauncher(labels);
    const change = bar()!.querySelector<HTMLElement>('[data-role="change"]')!;
    expect(change.style.display).toBe('flex');
    appId = null;
    vi.advanceTimersByTime(1100);
    expect(change.style.display).toBe('none');
    stop();
  });

  it('does not duplicate the bar and re-adds it if the page removed it', () => {
    const stop = startDesktopLauncher(labels);
    vi.advanceTimersByTime(3500);
    expect(document.querySelectorAll('#gtm-sidebar-buttons')).toHaveLength(1);
    bar()!.remove();
    vi.advanceTimersByTime(1100);
    expect(document.querySelectorAll('#gtm-sidebar-buttons')).toHaveLength(1);
    stop();
  });

  it('stays away until desktop playback is enabled, and follows the setting', () => {
    playInDesktopMode = false;
    const stop = startDesktopLauncher(labels);
    expect(bar()).toBeNull();
    playInDesktopMode = true;
    vi.advanceTimersByTime(1100);
    expect(bar()).toBeTruthy();
    playInDesktopMode = false;
    vi.advanceTimersByTime(1100);
    expect(bar()).toBeNull();
    stop();
  });

  it('cleans up on stop', () => {
    const stop = startDesktopLauncher(labels);
    stop();
    expect(bar()).toBeNull();
    expect(opened.closeAll).toHaveBeenCalled();
  });
});
