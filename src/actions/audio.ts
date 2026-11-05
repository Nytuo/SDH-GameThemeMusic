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

  /**
   * First playable search result for a game. Does not download it; callers
   * decide whether to (e.g. in the background).
   */
  async getAudio(
    appName: string,
    isCancelled: () => boolean = () => false
  ): Promise<{ videoId: string; audioUrl: string } | undefined> {
    const videos = this.getSearchResults(appName + ' Theme Music');
    let tried = 0;
    for await (const video of videos) {
      if (isCancelled() || tried++ >= 5) return undefined;
      const audioUrl = await this.getAudioUrlFromVideo(video);
      if (audioUrl?.length) {
        return { audioUrl, videoId: video.id };
      }
    }
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isYouTubeUrl(url: string) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

export function isSoundCloudUrl(url: string) {
  const host = hostOf(url);
  return host === 'soundcloud.com' || host.endsWith('.soundcloud.com');
}

/** A web page (not a playable file) that yt-dlp has to resolve. */
function isYtDlpPage(url: string) {
  return isYouTubeUrl(url) || isSoundCloudUrl(url);
}

type YtDlpSource = 'youtube' | 'soundcloud';

/** YouTube and SoundCloud, both searched and resolved through yt-dlp. */
export class YtDlpAudioResolver extends AudioResolver {
  constructor(private readonly source: YtDlpSource = 'youtube') {
    super();
  }

  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<MediaContentPreview> {
    let searchId: string | null | undefined;
    try {
      searchId = await call<[string, string], string | null>(
        'search_yt',
        searchTerm,
        this.source
      );
      if (!searchId) return;
      let result = await call<[string], MediaContentPreview | null>(
        'next_yt_result',
        searchId
      );
      while (result) {
        yield result;
        result = await call<[string], MediaContentPreview | null>(
          'next_yt_result',
          searchId
        );
      }
    } catch (err) {
      console.error('YtDlp search error:', err);
    } finally {
      // Also runs when the consumer stops early, so no yt-dlp process is
      // left running behind a search nobody reads.
      if (searchId) {
        call<[string]>('close_search', searchId).catch(() => {});
      }
    }
  }

  async getAudioUrlFromVideo(video: MediaContent): Promise<string | undefined> {
    if (video.url && !isYtDlpPage(video.url)) {
      return video.url;
    }
    try {
      const result = await call<[string], string | null>(
        'single_yt_url',
        video.id
      );
      return result || undefined;
    } catch (e) {
      console.error('YtDlp resolve error:', e);
      return undefined;
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

interface PreviewResult {
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  artist: string;
  album: string;
  duration: number;
}

/** Streaming services that only expose short preview clips. */
class PreviewAudioResolver extends AudioResolver {
  constructor(
    private readonly searchMethod: string,
    private readonly label: string
  ) {
    super();
  }

  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<MediaContentPreview> {
    try {
      const results = await call<[string, number], PreviewResult[]>(
        this.searchMethod,
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
      console.error(`${this.label} search error:`, err);
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
      console.error(`${this.label} local music URL error:`, e);
      return undefined;
    }
  }

  async downloadAudio(video: MediaContent): Promise<boolean> {
    try {
      await call<[string, string]>('download_url', video.url ?? '', video.id);
      return true;
    } catch (e) {
      console.error(`${this.label} download error:`, e);
      return false;
    }
  }
}

export class ITunesAudioResolver extends PreviewAudioResolver {
  constructor() {
    super('search_itunes', 'iTunes');
  }
}

export class DeezerAudioResolver extends PreviewAudioResolver {
  constructor() {
    super('search_deezer', 'Deezer');
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
      if (audioSrc) {
        return audioSrc.startsWith('data:') ? audioSrc : khinsiderUrl(audioSrc);
      }

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

export type AudioProvider =
  | 'ytdlp'
  | 'soundcloud'
  | 'itunes'
  | 'deezer'
  | 'khinsider'
  | 'local';

/** Source tabs, in display order. */
export const SEARCH_PROVIDERS: AudioProvider[] = [
  'ytdlp',
  'soundcloud',
  'itunes',
  'deezer',
  'khinsider',
  'local'
];

/**
 * Order in which sources are tried when a game's music is picked
 * automatically: YouTube first, the rest only as fallbacks.
 */
export const AUTO_PROVIDERS: AudioProvider[] = [
  'ytdlp',
  'khinsider',
  'soundcloud',
  'deezer',
  'itunes'
];

export function getProviderFromId(videoId: string): AudioProvider {
  if (videoId.startsWith('itunes_')) return 'itunes';
  if (videoId.startsWith('deezer_')) return 'deezer';
  if (videoId.startsWith('local_')) return 'local';
  if (isSoundCloudUrl(videoId)) return 'soundcloud';
  if (/^https?:\/\//.test(videoId) && !isYouTubeUrl(videoId)) {
    return 'khinsider';
  }
  return 'ytdlp';
}

export function getResolver(provider: AudioProvider): AudioResolver {
  switch (provider) {
    case 'itunes':
      return new ITunesAudioResolver();
    case 'deezer':
      return new DeezerAudioResolver();
    case 'local':
      return new LocalMusicAudioResolver();
    case 'khinsider':
      return new KhinsiderAudioResolver();
    case 'soundcloud':
      return new YtDlpAudioResolver('soundcloud');
    case 'ytdlp':
    default:
      return new YtDlpAudioResolver('youtube');
  }
}

export function getResolverForVideoId(videoId: string): AudioResolver {
  return getResolver(getProviderFromId(videoId));
}

export type AutoAudio = {
  videoId: string;
  audioUrl: string;
  provider: AudioProvider;
};

/**
 * Pick a theme for a game: the first playable result of the first source
 * that has one. With `fallback` off only the first source (YouTube) is used.
 */
export async function findAutoAudio(
  appName: string,
  options: { fallback?: boolean; isCancelled?: () => boolean } = {}
): Promise<AutoAudio | undefined> {
  const { fallback = true, isCancelled = () => false } = options;
  const providers = fallback ? AUTO_PROVIDERS : AUTO_PROVIDERS.slice(0, 1);
  for (const provider of providers) {
    if (isCancelled()) return undefined;
    try {
      const found = await getResolver(provider).getAudio(appName, isCancelled);
      if (found?.audioUrl.length) return { ...found, provider };
    } catch (e) {
      console.error(`[GameThemeMusic] ${provider} auto search failed`, e);
    }
  }
  return undefined;
}
