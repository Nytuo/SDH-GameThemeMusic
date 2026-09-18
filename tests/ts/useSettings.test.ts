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
    expect(mockCall).toHaveBeenCalledWith(
      'set_setting',
      'settings',
      expect.objectContaining({ volume: 0.7 })
    );
  });
});
