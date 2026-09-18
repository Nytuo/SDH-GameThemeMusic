import { describe, it, expect, vi, beforeEach } from 'vitest';
import { call } from '@decky/api';
import {
  getProviderFromId,
  getResolver,
  getResolverForVideoId,
  ITunesAudioResolver,
  KhinsiderAudioResolver,
  LocalMusicAudioResolver,
  resolveDownloadHref,
  YtDlpAudioResolver
} from '../../src/actions/audio';

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
    ['', 'ytdlp'],
    ['https://www.youtube.com/watch?v=abc', 'ytdlp'],
    ['https://youtu.be/abc', 'ytdlp'],
    [
      'https://downloads.khinsider.com/game-soundtracks/album/x/01.mp3',
      'khinsider'
    ]
  ])('%s -> %s', (id, provider) => {
    expect(getProviderFromId(id)).toBe(provider);
  });

  it('getResolverForVideoId picks the matching resolver class', () => {
    expect(getResolverForVideoId('itunes_1')).toBeInstanceOf(
      ITunesAudioResolver
    );
    expect(getResolverForVideoId('local_1')).toBeInstanceOf(
      LocalMusicAudioResolver
    );
    expect(getResolverForVideoId('abc')).toBeInstanceOf(YtDlpAudioResolver);
    expect(
      getResolverForVideoId('https://downloads.khinsider.com/album/a/b')
    ).toBeInstanceOf(KhinsiderAudioResolver);
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

  it('downloads via the backend lookup when no url is known', async () => {
    mockCall.mockResolvedValue(undefined);
    expect(await getResolver('itunes').downloadAudio({ id: 'itunes_1' })).toBe(
      true
    );
    expect(mockCall).toHaveBeenCalledWith('download_url', '', 'itunes_1');
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
  it('returns the first playable result without downloading it', async () => {
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
    expect(mockCall).not.toHaveBeenCalledWith('download_yt_audio', 'good');
  });

  it('stops when cancelled', async () => {
    mockCall.mockImplementation(async (method: string) =>
      method === 'next_yt_result'
        ? { id: 'a', title: 'a', thumbnail: '' }
        : method === 'single_yt_url'
          ? 'https://a'
          : undefined
    );
    expect(
      await getResolver('ytdlp').getAudio('Zelda', () => true)
    ).toBeUndefined();
    expect(mockCall).not.toHaveBeenCalledWith('single_yt_url', 'a');
  });

  it('gives up after a few unplayable results', async () => {
    mockCall.mockImplementation(async (method: string) =>
      method === 'next_yt_result'
        ? { id: 'x', title: 'x', thumbnail: '' }
        : null
    );
    expect(await getResolver('ytdlp').getAudio('Zelda')).toBeUndefined();
    expect(
      mockCall.mock.calls.filter((c) => c[0] === 'single_yt_url').length
    ).toBe(5);
  });

  it('returns undefined when nothing is playable', async () => {
    mockCall.mockImplementation(async (method: string) =>
      method === 'next_yt_result' ? null : undefined
    );
    expect(await getResolver('ytdlp').getAudio('Nothing')).toBeUndefined();
  });
});

describe('KHInsider resolver', () => {
  const albumPage = `
    <table>
      <tr><td><img src="/cover.jpg"></td>
      <td><a href="/game-soundtracks/album/zelda">Zelda OST</a></td></tr>
    </table>`;
  const tracksPage = `
    <table id="songlist">
      <tr><td class="clickable-row"><a href="/game-soundtracks/album/zelda/01.mp3">Title Theme</a></td></tr>
      <tr><td class="clickable-row"><a href="/game-soundtracks/album/zelda/02.mp3">Overworld</a></td></tr>
    </table>`;
  const trackPage = `<audio src="https://vgm.cdn/zelda/01.mp3"></audio>`;

  it('scrapes albums then tracks', async () => {
    mockCall.mockImplementation(async (method: string, url: string) => {
      if (method !== 'fetch_url') throw new Error(method);
      if (url.includes('/search')) return albumPage;
      if (url.endsWith('/album/zelda')) return tracksPage;
      return '';
    });
    const out = await collect(
      getResolver('khinsider').getSearchResults('Zelda')
    );
    expect(out).toEqual([
      {
        id: 'https://downloads.khinsider.com/game-soundtracks/album/zelda/01.mp3',
        title: 'Title Theme (Zelda OST)',
        thumbnail: 'https://downloads.khinsider.com/cover.jpg'
      },
      {
        id: 'https://downloads.khinsider.com/game-soundtracks/album/zelda/02.mp3',
        title: 'Overworld (Zelda OST)',
        thumbnail: 'https://downloads.khinsider.com/cover.jpg'
      }
    ]);
  });

  it('prefers an already downloaded file', async () => {
    mockCall.mockImplementation(async (method: string) =>
      method === 'local_audio_url' ? 'data:audio/mpeg;base64,AA' : ''
    );
    expect(
      await getResolver('khinsider').getAudioUrlFromVideo({ id: 'https://x' })
    ).toBe('data:audio/mpeg;base64,AA');
  });

  it('extracts the audio source from the track page', async () => {
    mockCall.mockImplementation(async (method: string) =>
      method === 'fetch_url' ? trackPage : null
    );
    expect(
      await getResolver('khinsider').getAudioUrlFromVideo({ id: 'https://x' })
    ).toBe('https://vgm.cdn/zelda/01.mp3');
  });

  it('downloadAudio resolves then downloads', async () => {
    mockCall.mockImplementation(async (method: string) => {
      if (method === 'local_audio_exists') return false;
      if (method === 'local_audio_url') return null;
      if (method === 'fetch_url') return trackPage;
      return undefined;
    });
    expect(
      await getResolver('khinsider').downloadAudio({ id: 'https://x' })
    ).toBe(true);
    expect(mockCall).toHaveBeenCalledWith(
      'download_url',
      'https://vgm.cdn/zelda/01.mp3',
      'https://x'
    );
  });
});

describe('resolveDownloadHref', () => {
  it('accepts supported audio extensions', () => {
    expect(resolveDownloadHref('/download/track.mp3')).toBe(
      'https://downloads.khinsider.com/download/track.mp3'
    );
    expect(resolveDownloadHref('https://cdn.example.com/track.ogg')).toBe(
      'https://cdn.example.com/track.ogg'
    );
  });

  it('rejects non-audio extensions and empty values', () => {
    expect(resolveDownloadHref('/download/track.zip')).toBeUndefined();
    expect(resolveDownloadHref(null)).toBeUndefined();
    expect(resolveDownloadHref('')).toBeUndefined();
  });
});
