import { describe, it, expect, vi, beforeEach } from 'vitest';
import { call } from '@decky/api';
import {
  getProviderFromId,
  getResolver,
  getResolverForVideoId
} from '../src/actions/audio';

const mockCall = call as unknown as ReturnType<typeof vi.fn>;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

beforeEach(() => {
  mockCall.mockReset();
});

describe('getProviderFromId', () => {
  it.each([
    ['itunes_123', 'itunes'],
    ['local_my_song', 'local'],
    ['dQw4w9WgXcQ', 'ytdlp'],
    ['', 'ytdlp']
  ])('%s -> %s', (id, provider) => {
    expect(getProviderFromId(id)).toBe(provider);
  });

  it('getResolverForVideoId returns a resolver for each provider', () => {
    expect(getResolverForVideoId('itunes_1')).toBeDefined();
    expect(getResolverForVideoId('local_1')).toBeDefined();
    expect(getResolverForVideoId('abc')).toBeDefined();
  });
});

describe('YtDlp resolver', () => {
  it('streams results until the backend returns null', async () => {
    const results = [
      { id: 'a', title: 'A', thumbnail: '', url: 'u1' },
      { id: 'b', title: 'B', thumbnail: '', url: 'u2' }
    ];
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'search_yt') return undefined;
      if (method === 'next_yt_result') return results.shift() ?? null;
      throw new Error(method);
    });
    const out = await collect(getResolver('ytdlp').getSearchResults('zelda'));
    expect(out.map((v) => v.id)).toEqual(['a', 'b']);
    expect(mockCall).toHaveBeenCalledWith('search_yt', 'zelda');
  });

  it('swallows backend errors during search', async () => {
    mockCall.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await collect(getResolver('ytdlp').getSearchResults('x'))).toEqual(
      []
    );
    spy.mockRestore();
  });

  it('asks the backend for a stream url when none is known', async () => {
    mockCall.mockResolvedValue('https://stream');
    const url = await getResolver('ytdlp').getAudioUrlFromVideo({ id: 'abc' });
    expect(url).toBe('https://stream');
    expect(mockCall).toHaveBeenCalledWith('single_yt_url', 'abc');
  });

  it('downloadAudio reports failure', async () => {
    mockCall.mockRejectedValue(new Error('fail'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getResolver('ytdlp').downloadAudio({ id: 'abc' })).toBe(false);
    spy.mockRestore();
  });
});

describe('iTunes resolver', () => {
  it('maps backend results', async () => {
    mockCall.mockResolvedValue([
      {
        id: 'itunes_1',
        title: 'T',
        url: 'https://p.m4a',
        thumbnail: 'th',
        artist: 'a',
        album: 'b',
        duration: 30
      }
    ]);
    const out = await collect(getResolver('itunes').getSearchResults('x'));
    expect(out).toEqual([
      { id: 'itunes_1', title: 'T', url: 'https://p.m4a', thumbnail: 'th' }
    ]);
  });

  it('uses the preview url directly when it is http', async () => {
    const url = await getResolver('itunes').getAudioUrlFromVideo({
      id: 'itunes_1',
      url: 'https://p.m4a'
    });
    expect(url).toBe('https://p.m4a');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('falls back to the downloaded local file', async () => {
    mockCall.mockResolvedValue('data:audio/mp4;base64,AAA');
    const url = await getResolver('itunes').getAudioUrlFromVideo({
      id: 'itunes_1'
    });
    expect(url).toBe('data:audio/mp4;base64,AAA');
  });

  it('refuses to download without a url', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getResolver('itunes').downloadAudio({ id: 'itunes_1' })).toBe(
      false
    );
    spy.mockRestore();
  });
});

describe('Local resolver', () => {
  it('lists local files', async () => {
    mockCall.mockResolvedValue([{ id: 'local_a', title: 'a' }]);
    const out = await collect(getResolver('local').getSearchResults(''));
    expect(out).toEqual([
      { id: 'local_a', title: 'a', thumbnail: '', url: '' }
    ]);
  });

  it('downloadAudio is a no-op', async () => {
    expect(await getResolver('local').downloadAudio({ id: 'local_a' })).toBe(
      true
    );
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('AudioResolver.getAudio', () => {
  it('returns the first playable result and downloads it', async () => {
    const results = [
      { id: 'bad', title: 'bad', thumbnail: '', url: '' },
      { id: 'good', title: 'good', thumbnail: '', url: '' }
    ];
    mockCall.mockImplementation(async (method: string, arg: string) => {
      switch (method) {
        case 'search_yt':
          return undefined;
        case 'next_yt_result':
          return results.shift() ?? null;
        case 'single_yt_url':
          return arg === 'good' ? 'https://good' : null;
        case 'download_yt_audio':
          return undefined;
      }
      throw new Error(method);
    });

    const res = await getResolver('ytdlp').getAudio('Zelda');
    expect(res).toEqual({ videoId: 'good', audioUrl: 'https://good' });
    expect(mockCall).toHaveBeenCalledWith('download_yt_audio', 'good');
  });

  it('returns undefined when nothing is playable', async () => {
    mockCall.mockImplementation(async (method: string) =>
      method === 'next_yt_result' ? null : undefined
    );
    expect(await getResolver('ytdlp').getAudio('Nothing')).toBeUndefined();
  });
});
