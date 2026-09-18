import { Tabs, useParams } from '@decky/ui';
import { useEffect, useState } from 'react';

import useTranslations from '../../hooks/useTranslations';
import ChangePage from './changePage';
import AboutPage from './aboutPage';
import {
  AudioProvider,
  getResolver,
  SEARCH_PROVIDERS
} from '../../actions/audio';
import { getAppName } from '../../hooks/useThemeMusic';
import { MediaContentPreview } from '../../../types/media';
import GameSettings from './gameSettings';
import { useSettings } from '../../hooks/useSettings';

type ProviderResults = Partial<Record<AudioProvider, MediaContentPreview[]>>;

export default function ChangeTheme() {
  const [currentTab, setCurrentTab] = useState<string>('change-music-tab');
  const t = useTranslations();
  const { isLoading: settingsLoading } = useSettings();
  const { appid } = useParams<{ appid: string }>();
  const appName = getAppName(parseInt(appid));

  const [results, setResults] = useState<ProviderResults>({});
  const [loadingNum, setLoadingNum] = useState(0);
  const initialSearch = appName?.concat(' main theme') ?? '';
  const [searchTerm, setSearchTerm] = useState(initialSearch);

  useEffect(() => {
    if (!searchTerm.length || settingsLoading) return;
    let ignore = false;
    setResults({});

    // Each provider fills its own bucket in one update once it finishes, so
    // fast providers don't wait for slow ones and the list doesn't re-render
    // on every streamed item.
    SEARCH_PROVIDERS.forEach(async (provider) => {
      setLoadingNum((x) => x + 1);
      const seen = new Set<string>();
      const found: MediaContentPreview[] = [];
      try {
        for await (const video of getResolver(provider).getSearchResults(
          searchTerm
        )) {
          if (ignore) break;
          if (!video?.id || seen.has(video.id)) continue;
          seen.add(video.id);
          found.push(video);
        }
      } catch (e) {
        console.error(`Error searching ${provider}:`, e);
      } finally {
        if (!ignore && found.length) {
          setResults((old) => ({ ...old, [provider]: found }));
        }
        setLoadingNum((x) => x - 1);
      }
    });

    return () => {
      ignore = true;
    };
  }, [searchTerm, settingsLoading]);

  const videos = SEARCH_PROVIDERS.flatMap(
    (provider) => results[provider] ?? []
  );

  function setInitialSearch() {
    setSearchTerm(initialSearch);
    return initialSearch;
  }

  return (
    <div
      style={{
        marginTop: '40px',
        height: 'calc(100% - 40px)'
      }}
    >
      <Tabs
        autoFocusContents
        activeTab={currentTab}
        onShowTab={setCurrentTab}
        tabs={[
          {
            title: t('changeThemeMusic'),
            content: (
              <ChangePage
                videos={videos}
                loading={loadingNum > 0}
                customSearch={setSearchTerm}
                currentSearch={searchTerm}
                setInitialSearch={setInitialSearch}
              />
            ),
            id: 'change-music-tab'
          },
          {
            title: t('gameSettings'),
            content: <GameSettings />,
            id: 'game-settings-tab'
          },
          { title: t('about'), content: <AboutPage />, id: 'about-tab' }
        ]}
      />
    </div>
  );
}
