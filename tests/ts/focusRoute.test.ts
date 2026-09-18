import { describe, it, expect } from 'vitest';
import {
  getDetailRouteAppId,
  isFocusPlaybackRoute
} from '../../src/components/focusedGameThemePlayer';

describe('focus player routes', () => {
  it('keeps playing on the library and game detail pages', () => {
    expect(isFocusPlaybackRoute('/library/home')).toBe(true);
    expect(isFocusPlaybackRoute('/library/app/620')).toBe(true);
    expect(isFocusPlaybackRoute(null)).toBe(true);
  });

  it('stays silent on the change theme page', () => {
    expect(isFocusPlaybackRoute('/gamethememusic/620')).toBe(false);
  });

  it('reads the game from the detail page route', () => {
    expect(getDetailRouteAppId('/library/app/620')).toBe(620);
    expect(getDetailRouteAppId('/routes/library/app/3141592653/tab/x')).toBe(
      3141592653
    );
    expect(getDetailRouteAppId('/library/home')).toBeNull();
    expect(getDetailRouteAppId('/library/app/0')).toBeNull();
    expect(getDetailRouteAppId(null)).toBeNull();
  });
});
