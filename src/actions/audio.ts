import { call } from '@decky/api';
import { MediaContent, MediaContentPreview } from '../../types/media';

abstract class AudioResolver {
  abstract getSearchResults(
    searchTerm: string
  ): AsyncIterable<MediaContentPreview>;
  abstract getAudioUrlFromVideo(
    video: MediaContent
  ): Promise<string | undefined>;
  abstract downloadAudio(video: MediaContent): Promise<boolean>;

  async isDownloaded(video: MediaContent): Promise<boolean> {
    try {
      return await call<[string], boolean>('local_audio_exists', video.id);
    } catch (e) {
      console.error('local_audio_exists error:', e);
      return false;
    }
  }

  async getAudio(
    appName: string
  ): Promise<{ videoId: string; audioUrl: string } | undefined> {
    const videos = this.getSearchResults(appName + ' Theme Music');
    for await (const video of videos) {
      const audioUrl = await this.getAudioUrlFromVideo(video);
      if (audioUrl?.length) {
        if (!video.id.startsWith('local_')) {
          await this.downloadAudio(video);
        }
        return { audioUrl, videoId: video.id };
      }
    }
    return undefined;
  }
}

function isYouTubeUrl(url: string) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

export class YtDlpAudioResolver extends AudioResolver {
  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<MediaContentPreview> {
    try {
      await call<[string]>('search_yt', searchTerm);
      let result = await call<[], MediaContentPreview | null>('next_yt_result');
      while (result) {
        yield result;
        result = await call<[], MediaContentPreview | null>('next_yt_result');
      }
      return;
    } catch (err) {
      console.error('YtDlp search error:', err);
    }
    return;
  }

  async getAudioUrlFromVideo(video: MediaContent): Promise<string | undefined> {
    if (video.url && !isYouTubeUrl(video.url)) {
      return video.url;
    } else {
      const result = await call<[string], string | null>(
        'single_yt_url',
        video.id
      );
      return result || undefined;
    }
  }

  async downloadAudio(video: MediaContent): Promise<boolean> {
    try {
      await call<[string]>('download_yt_audio', video.id);
      return true;
    } catch (e) {
      console.error('YtDlp download error:', e);
      return false;
    }
  }
}

interface ITunesResult {
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  artist: string;
  album: string;
  duration: number;
}

export class ITunesAudioResolver extends AudioResolver {
  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<MediaContentPreview> {
    try {
      const results = await call<[string, number], ITunesResult[]>(
        'search_itunes',
        searchTerm,
        10
      );

      if (results && results.length > 0) {
        for (const result of results) {
          yield {
            id: result.id,
            title: result.title,
            thumbnail: result.thumbnail,
            url: result.url
          };
        }
      }
    } catch (err) {
      console.error('iTunes search error:', err);
    }
    return;
  }

  async getAudioUrlFromVideo(video: MediaContent): Promise<string | undefined> {
    if (video.url && video.url.startsWith('http')) {
      return video.url;
    }
    try {
      const url = await call<[string], string | null>(
        'local_audio_url',
        video.id
      );
      return url || undefined;
    } catch (e) {
      console.error('iTunes local music URL error:', e);
      return undefined;
    }
  }

  async downloadAudio(video: MediaContent): Promise<boolean> {
    try {
      await call<[string, string]>('download_url', video.url ?? '', video.id);
      return true;
    } catch (e) {
      console.error('iTunes download error:', e);
      return false;
    }
  }
}

export class LocalMusicAudioResolver extends AudioResolver {
  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<MediaContentPreview> {
    try {
      const results = await call<
        [string, number],
        { id: string; title: string; thumbnail?: string; url?: string }[]
      >('search_local_music', searchTerm, 100);

      if (results && results.length > 0) {
        for (const result of results) {
          yield {
            id: result.id,
            title: result.title,
            thumbnail: result.thumbnail || '',
            url: result.url || ''
          };
        }
      }
    } catch (err) {
      console.error('Local music search error:', err);
    }
    return;
  }

  async getAudioUrlFromVideo(video: MediaContent): Promise<string | undefined> {
    try {
      const url = await call<[string], string | null>(
        'get_local_music_url',
        video.id
      );
      return url || undefined;
    } catch (e) {
      console.error('Local music URL error:', e);
      return undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async downloadAudio(_video: MediaContent): Promise<boolean> {
    return true;
  }

  async isDownloaded(): Promise<boolean> {
    return true;
  }
}

const KHINSIDER_BASE = 'https://downloads.khinsider.com';
const KHINSIDER_NO_COVER = `${KHINSIDER_BASE}/images/no-cover.png`;

function khinsiderUrl(href: string) {
  return href.startsWith('http') ? href : `${KHINSIDER_BASE}${href}`;
}

export function resolveDownloadHref(href: string | null): string | undefined {
  if (!href || !/\.(mp3|ogg|flac|m4a|wav|aac|opus)$/i.test(href)) {
    return undefined;
  }
  return khinsiderUrl(href);
}

async function fetchDoc(url: string): Promise<Document | null> {
  try {
    const html = await call<[string], string>('fetch_url', url);
    if (!html) return null;
    return new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
}

export class KhinsiderAudioResolver extends AudioResolver {
  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<MediaContentPreview> {
    const searchUrl = (query: string) =>
      `${KHINSIDER_BASE}/search?search=${encodeURIComponent(query)}`;

    try {
      let doc = await fetchDoc(searchUrl(searchTerm));

      if (
        !doc ||
        (doc.querySelectorAll('a[href*="/album/"]').length === 0 &&
          doc.querySelectorAll('.playlistItem, #songlist, .clickable-row')
            .length === 0)
      ) {
        const baseName = searchTerm.replace(
          /\s+(Theme Music|Main Theme|Soundtrack|OST)$/i,
          ''
        );
        if (baseName !== searchTerm) {
          doc = await fetchDoc(searchUrl(baseName));
        }
      }

      if (!doc) return;

      const seenAlbumHrefs = new Set<string>();
      const topAlbums: { url: string; title: string; thumbnail: string }[] = [];

      for (const link of Array.from(
        doc.querySelectorAll('a[href*="/game-soundtracks/album/"]')
      )) {
        const href = link.getAttribute('href');
        if (!href || seenAlbumHrefs.has(href)) continue;
        seenAlbumHrefs.add(href);

        let title = link.textContent?.trim();
        const row = (link as HTMLElement).closest('tr');
        if (!title && row) {
          title = Array.from(row.querySelectorAll('td'))
            .map((td) => td.textContent?.trim())
            .filter((t) => t && t.length > 2)[0];
        }

        let thumbnail = KHINSIDER_NO_COVER;
        const img = row?.querySelector('img');
        if (img?.getAttribute('src')) {
          thumbnail = khinsiderUrl(img.getAttribute('src') as string);
        }
        topAlbums.push({
          url: khinsiderUrl(href),
          title: title || 'Unknown Album',
          thumbnail
        });
        if (topAlbums.length >= 8) break;
      }

      const seenTrackHrefs = new Set<string>();
      const albumResponses = await Promise.all(
        topAlbums.map(async (album) => {
          const albumDoc = await fetchDoc(album.url);
          if (!albumDoc) return [];

          const results: MediaContentPreview[] = [];
          const trackLinks = Array.from(
            albumDoc.querySelectorAll(
              '.playlistItem td.clickable-row a, #songlist td.clickable-row a'
            )
          );
          for (const trackLink of trackLinks) {
            const href = trackLink.getAttribute('href');
            if (!href || seenTrackHrefs.has(href)) continue;
            seenTrackHrefs.add(href);
            results.push({
              id: khinsiderUrl(href),
              title: `${trackLink.textContent?.trim() || 'Track'} (${album.title})`,
              thumbnail: album.thumbnail
            });
          }
          return results;
        })
      );

      for (const batch of albumResponses) {
        for (const track of batch) {
          yield track;
        }
      }

      if (topAlbums.length === 0) {
        for (const track of Array.from(
          doc.querySelectorAll('.playlistItem a, .clickable-row a, #songlist a')
        )) {
          const href = track.getAttribute('href');
          if (
            !href ||
            href.includes('/search') ||
            !href.includes('/album/') ||
            seenTrackHrefs.has(href)
          )
            continue;
          seenTrackHrefs.add(href);

          const title = track.textContent?.trim();
          if (!title || title.length < 2) continue;

          yield {
            id: khinsiderUrl(href),
            title,
            thumbnail: KHINSIDER_NO_COVER
          };
          if (seenTrackHrefs.size >= 30) break;
        }
      }
    } catch (err) {
      console.error('KHInsider search failed:', err);
    }
  }

  async getAudioUrlFromVideo(video: MediaContent): Promise<string | undefined> {
    try {
      const localUrl = await call<[string], string | null>(
        'local_audio_url',
        video.id
      );
      if (localUrl) return localUrl;

      const doc = await fetchDoc(video.id);
      if (!doc) return undefined;

      const audio = doc.querySelector('audio');
      const audioSrc =
        audio?.getAttribute('src') ||
        audio?.querySelector('source')?.getAttribute('src');
      if (audioSrc) return audioSrc;

      const downloadLink = doc
        .querySelector('a .songDownloadLink')
        ?.closest('a');
      const downloadHref = resolveDownloadHref(
        downloadLink?.getAttribute('href') ?? null
      );
      if (downloadHref) return downloadHref;

      for (const link of Array.from(doc.querySelectorAll('a'))) {
        const href = resolveDownloadHref(link.getAttribute('href'));
        if (href) return href;
      }
      return undefined;
    } catch (e) {
      console.error('KHInsider audio fetch failed:', e);
      return undefined;
    }
  }

  async downloadAudio(video: MediaContent): Promise<boolean> {
    try {
      if (await this.isDownloaded(video)) return true;
      const url =
        video.url && !video.url.startsWith('data:')
          ? video.url
          : await this.getAudioUrlFromVideo(video);
      if (!url) return false;
      if (url.startsWith('data:')) return true;
      await call<[string, string]>('download_url', url, video.id);
      return true;
    } catch (e) {
      console.error('KHInsider download error:', e);
      return false;
    }
  }
}

export type AudioProvider = 'ytdlp' | 'itunes' | 'local' | 'khinsider';

export const SEARCH_PROVIDERS: AudioProvider[] = [
  'ytdlp',
  'itunes',
  'khinsider',
  'local'
];

export function getProviderFromId(videoId: string): AudioProvider {
  if (videoId.startsWith('itunes_')) return 'itunes';
  if (videoId.startsWith('local_')) return 'local';
  if (/^https?:\/\//.test(videoId) && !isYouTubeUrl(videoId)) {
    return 'khinsider';
  }
  return 'ytdlp';
}

export function getResolver(provider: AudioProvider): AudioResolver {
  switch (provider) {
    case 'itunes':
      return new ITunesAudioResolver();
    case 'local':
      return new LocalMusicAudioResolver();
    case 'khinsider':
      return new KhinsiderAudioResolver();
    case 'ytdlp':
    default:
      return new YtDlpAudioResolver();
  }
}

export function getResolverForVideoId(videoId: string): AudioResolver {
  return getResolver(getProviderFromId(videoId));
}
