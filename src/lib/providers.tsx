import { ReactElement } from 'react';
import { FaCompactDisc, FaFolder, FaHeadphones } from 'react-icons/fa';
import { SiApplemusic, SiSoundcloud, SiYoutubemusic } from 'react-icons/si';
import { AudioProvider } from '../actions/audio';

export type ProviderInfo = {
  color: string;
  label: string;
  /** Provider only offers short preview clips, not full tracks. */
  preview: boolean;
  icon: (size?: number) => ReactElement;
};

export const PROVIDER_INFO: Record<AudioProvider, ProviderInfo> = {
  ytdlp: {
    color: '#e62117',
    label: 'YouTube',
    preview: false,
    icon: (size = 16) => <SiYoutubemusic size={size} />
  },
  soundcloud: {
    color: '#ff5500',
    label: 'SoundCloud',
    preview: false,
    icon: (size = 16) => <SiSoundcloud size={size} />
  },
  itunes: {
    color: '#d82d2d',
    label: 'Apple Music',
    preview: true,
    icon: (size = 16) => <SiApplemusic size={size} />
  },
  deezer: {
    color: '#a238ff',
    label: 'Deezer',
    preview: true,
    icon: (size = 16) => <FaHeadphones size={size} />
  },
  khinsider: {
    color: '#2d6fd8',
    label: 'KHInsider',
    preview: false,
    icon: (size = 16) => <FaCompactDisc size={size} />
  },
  local: {
    color: '#3a8f3a',
    label: 'Local',
    preview: false,
    icon: (size = 16) => <FaFolder size={size} />
  }
};
