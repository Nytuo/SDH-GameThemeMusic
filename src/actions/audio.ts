import { call } from '@decky/api';
import { YouTubeVideo, YouTubeVideoPreview } from '../../types/YouTube';

abstract class AudioResolver {
  abstract getSearchResults(
    searchTerm: string
  ): AsyncIterable<YouTubeVideoPreview>;
  abstract getAudioUrlFromVideo(
    video: YouTubeVideo
  ): Promise<string | undefined>;
  abstract downloadAudio(video: YouTubeVideo): Promise<boolean>;

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

class YtDlpAudioResolver extends AudioResolver {
  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<YouTubeVideoPreview> {
    try {
      await call<[string]>('search_yt', searchTerm);
      let result = await call<[], YouTubeVideoPreview | null>('next_yt_result');
      while (result) {
        yield result;
        result = await call<[], YouTubeVideoPreview | null>('next_yt_result');
      }
      return;
    } catch (err) {
      console.error('YtDlp search error:', err);
    }
    return;
  }

  async getAudioUrlFromVideo(video: YouTubeVideo): Promise<string | undefined> {
    if (video.url) {
      return video.url;
    } else {
      const result = await call<[string], string | null>(
        'single_yt_url',
        video.id
      );
      return result || undefined;
    }
  }

  async downloadAudio(video: YouTubeVideo): Promise<boolean> {
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

class ITunesAudioResolver extends AudioResolver {
  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<YouTubeVideoPreview> {
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

  async getAudioUrlFromVideo(video: YouTubeVideo): Promise<string | undefined> {
    if (video.url && video.url.startsWith('http')) {
      return video.url;
    }
    try {
      const url = await call<[string], string | null>(
        'get_local_music_url',
        video.id
      );
      return url || undefined;
    } catch (e) {
      console.error('iTunes local music URL error:', e);
      return undefined;
    }
  }

  async downloadAudio(video: YouTubeVideo): Promise<boolean> {
    if (!video.url) {
      console.error('No URL provided for iTunes audio download');
      return false;
    }
    try {
      await call<[string, string]>('download_url', video.url, video.id);
      return true;
    } catch (e) {
      console.error('iTunes download error:', e);
      return false;
    }
  }
}

class LocalMusicAudioResolver extends AudioResolver {
  async *getSearchResults(
    searchTerm: string
  ): AsyncIterable<YouTubeVideoPreview> {
    try {
      const results = await call<[string, number], any[]>(
        'search_local_music',
        searchTerm,
        100
      );

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

  async getAudioUrlFromVideo(video: YouTubeVideo): Promise<string | undefined> {
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
  async downloadAudio(_video: YouTubeVideo): Promise<boolean> {
    return true;
  }
}

export type AudioProvider = 'ytdlp' | 'itunes' | 'local';

export function getProviderFromId(videoId: string): AudioProvider {
  if (videoId.startsWith('itunes_')) return 'itunes';
  if (videoId.startsWith('local_')) return 'local';
  return 'ytdlp';
}

export function getResolver(provider: AudioProvider): AudioResolver {
  switch (provider) {
    case 'ytdlp':
      return new YtDlpAudioResolver();
    case 'itunes':
      return new ITunesAudioResolver();
    case 'local':
      return new LocalMusicAudioResolver();
    default:
      return new YtDlpAudioResolver();
  }
}

export function getResolverForVideoId(videoId: string): AudioResolver {
  return getResolver(getProviderFromId(videoId));
}
