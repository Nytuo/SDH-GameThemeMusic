import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { call } from '@decky/api';

const mockCall = call as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  mockCall.mockReset();
});

async function load() {
  return await import('../../src/hooks/useSettings');
}

describe('useSettings', () => {
  it('loads saved settings from the backend once', async () => {
    mockCall.mockResolvedValue({
      defaultMuted: true,
      volume: 0.2,
      homepageFocusMode: true
    });
    const { useSettings } = await load();
    const a = renderHook(() => useSettings());
    const b = renderHook(() => useSettings());
    expect(a.result.current.isLoading).toBe(true);

    await waitFor(() => expect(a.result.current.isLoading).toBe(false));
    expect(a.result.current.settings.volume).toBe(0.2);
    expect(b.result.current.settings.defaultMuted).toBe(true);
    expect(
      mockCall.mock.calls.filter((c) => c[0] === 'get_setting')
    ).toHaveLength(1);
  });

  it('persists and broadcasts changes', async () => {
    const { useSettings, defaultSettings } = await load();
    mockCall.mockImplementation(async (method: string) =>
      method === 'get_setting' ? defaultSettings : undefined
    );
    const a = renderHook(() => useSettings());
    const b = renderHook(() => useSettings());
    await waitFor(() => expect(a.result.current.isLoading).toBe(false));

    act(() => a.result.current.setVolume(0.7));
    expect(b.result.current.settings.volume).toBe(0.7);
    await waitFor(() =>
      expect(mockCall).toHaveBeenCalledWith(
        'set_setting',
        'settings',
        expect.objectContaining({ volume: 0.7 })
      )
    );
  });

  it('writes once after a burst of slider changes', async () => {
    const { useSettings, defaultSettings } = await load();
    mockCall.mockImplementation(async (method: string) =>
      method === 'get_setting' ? defaultSettings : undefined
    );
    const a = renderHook(() => useSettings());
    await waitFor(() => expect(a.result.current.isLoading).toBe(false));

    act(() => {
      for (let v = 1; v <= 20; v++) a.result.current.setVolume(v / 100);
    });
    await waitFor(() =>
      expect(
        mockCall.mock.calls.filter((c) => c[0] === 'set_setting')
      ).toHaveLength(1)
    );
    const saved = mockCall.mock.calls.find((c) => c[0] === 'set_setting');
    expect(saved?.[2].volume).toBe(0.2);
  });

  it('exposes the new settings with defaults', async () => {
    const { defaultSettings } = await load();
    expect(defaultSettings.autoFallback).toBe(true);
    expect(defaultSettings.playInDesktopMode).toBe(false);
  });

  it('getSettingsSnapshot follows changes outside React', async () => {
    const { useSettings, defaultSettings, getSettingsSnapshot } = await load();
    mockCall.mockImplementation(async (method: string) =>
      method === 'get_setting' ? defaultSettings : undefined
    );
    const a = renderHook(() => useSettings());
    await waitFor(() => expect(a.result.current.isLoading).toBe(false));
    act(() => a.result.current.setPlayInDesktopMode(true));
    expect(getSettingsSnapshot().playInDesktopMode).toBe(true);
  });
});

describe('useSettings resilience', () => {
  it('falls back to defaults when loading fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockCall.mockRejectedValue(new Error('backend down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { useSettings, defaultSettings } = await load();
    const { result } = renderHook(() => useSettings());
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.settings).toEqual(defaultSettings);
    // it retried before giving up
    expect(
      mockCall.mock.calls.filter((c) => c[0] === 'get_setting').length
    ).toBeGreaterThan(1);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('does not overwrite stored settings when loading failed once', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockCall
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue({ volume: 0.3 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { useSettings } = await load();
    const { result } = renderHook(() => useSettings());
    await vi.advanceTimersByTimeAsync(3_000);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.settings.volume).toBe(0.3);
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('fills in settings missing from older saves', async () => {
    mockCall.mockResolvedValue({ volume: 0.4 });
    const { useSettings, defaultSettings } = await load();
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.settings).toEqual({
      ...defaultSettings,
      volume: 0.4
    });
  });
});
