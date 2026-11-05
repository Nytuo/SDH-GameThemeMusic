import { DialogButton, Focusable, Tabs } from '@decky/ui';
import { useAppId } from '../../hooks/useAppId';
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

type SourceResults = { term: string; items: MediaContentPreview[] };
type ProviderResults = Partial<Record<AudioProvider, SourceResults>>;

/** Show the first results as soon as there are a few, instead of waiting. */
const FIRST_PAINT_COUNT = 4;

export function isAudioProvider(value: unknown): value is AudioProvider {
  return SEARCH_PROVIDERS.includes(value as AudioProvider);
}

export default function ChangeTheme({
  embedded = false
}: { embedded?: boolean } = {}) {
  const [currentTab, setCurrentTab] = useState<string>('change-music-tab');
  const t = useTranslations();
  const { settings, isLoading: settingsLoading, setLastSource } = useSettings();
  const appid = useAppId();
  const appName = getAppName(appid);

  const [results, setResults] = useState<ProviderResults>({});
  const [loadingProvider, setLoadingProvider] = useState<AudioProvider | null>(
    null
  );
  // Bumped when the local library changes so the Local tab lists it again.
  const [libraryVersion, setLibraryVersion] = useState(0);
  const initialSearch = appName?.concat(' main theme') ?? '';
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [pickedSource, setPickedSource] = useState<AudioProvider | null>(null);

  const source: AudioProvider =
    pickedSource ??
    (isAudioProvider(settings.lastSource) ? settings.lastSource : 'ytdlp');

  function changeSource(next: AudioProvider) {
    setPickedSource(next);
    setLastSource(next);
  }

  // Only the selected source is searched; others are searched when opened.
  useEffect(() => {
    if (settingsLoading) return;
    const isLocal = source === 'local';
    // The local library is listed whole, whatever was searched for.
    const term = isLocal ? '' : searchTerm;
    if (!isLocal && !term.length) return;
    if (results[source]?.term === term && !isLocal) return;

    let ignore = false;
    setLoadingProvider(source);

    (async () => {
      const seen = new Set<string>();
      const found: MediaContentPreview[] = [];
      const publish = () => {
        if (!ignore) {
          setResults((old) => ({
            ...old,
            [source]: { term, items: [...found] }
          }));
        }
      };
      try {
        for await (const video of getResolver(source).getSearchResults(term)) {
          if (ignore) break;
          if (!video?.id || seen.has(video.id)) continue;
          seen.add(video.id);
          found.push(video);
          if (found.length === FIRST_PAINT_COUNT) publish();
        }
      } catch (e) {
        console.error(`Error searching ${source}:`, e);
      } finally {
        publish();
        if (!ignore) setLoadingProvider(null);
      }
    })();

    return () => {
      ignore = true;
    };
  }, [searchTerm, source, settingsLoading, libraryVersion]);

  // A new search term invalidates every source's results.
  useEffect(() => {
    setResults((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([provider]) => provider === 'local')
      )
    );
  }, [searchTerm]);

  function setInitialSearch() {
    setSearchTerm(initialSearch);
    return initialSearch;
  }

  const tabs = [
    {
      title: t('changeThemeMusic'),
      content: (
        <ChangePage
          videos={results[source]?.items ?? []}
          loading={loadingProvider === source}
          source={source}
          setSource={changeSource}
          customSearch={setSearchTerm}
          currentSearch={searchTerm}
          setInitialSearch={setInitialSearch}
          onLibraryChanged={() => setLibraryVersion((v) => v + 1)}
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
  ];

  // The gamepad-style Tabs are made for the full-screen UI; the desktop popup
  // gets a plain button row instead.
  if (embedded) {
    const active = tabs.find((tab) => tab.id === currentTab) ?? tabs[0];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Focusable
          style={{
            display: 'flex',
            gap: '8px',
            flex: 'none',
            margin: '0 0 14px'
          }}
        >
          {tabs.map((tab) => (
            <DialogButton
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              style={{
                width: 'auto',
                minWidth: 'auto',
                padding: '8px 20px',
                fontWeight: tab.id === active.id ? 700 : 400,
                background: tab.id === active.id ? '#1a9fff' : undefined,
                color: tab.id === active.id ? '#fff' : undefined
              }}
            >
              {tab.title}
            </DialogButton>
          ))}
        </Focusable>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {active.content}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '40px', height: 'calc(100% - 40px)' }}>
      <Tabs
        autoFocusContents
        activeTab={currentTab}
        onShowTab={setCurrentTab}
        tabs={tabs}
      />
    </div>
  );
}
