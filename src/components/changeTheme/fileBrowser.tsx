import { call } from '@decky/api';
import {
  DialogButton,
  Focusable,
  PanelSection,
  PanelSectionRow
} from '@decky/ui';
import { useState, useEffect } from 'react';
import { FaFolder, FaMusic, FaLevelUpAlt, FaHome } from 'react-icons/fa';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isAudio: boolean;
}

export default function FileBrowser({
  onFileSelected
}: {
  onFileSelected?: (filePath: string, fileName: string) => void;
}) {
  const isWindows = navigator.platform.startsWith('Win');
  const defaultPath = isWindows ? 'C:\\' : '/home/deck';
  const [currentPath, setCurrentPath] = useState(defaultPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const audioExtensions = [
    '.mp3',
    '.m4a',
    '.webm',
    '.ogg',
    '.wav',
    '.flac',
    '.aac',
    '.opus'
  ];

  useEffect(() => {
    loadDirectory(currentPath).then(() => {
      return;
    });
  }, [currentPath]);

  async function loadDirectory(path: string) {
    setLoading(true);
    setError('');
    try {
      const result = await call<[string], any>('list_directory', path);

      if (result && result.entries) {
        const fileEntries: FileEntry[] = result.entries.map((entry: any) => ({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.is_directory,
          isAudio:
            !entry.is_directory &&
            audioExtensions.some((ext) =>
              entry.name.toLowerCase().endsWith(ext)
            )
        }));

        fileEntries.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });

        setEntries(fileEntries);
      }
    } catch (e) {
      console.error('Failed to load directory:', e);
      setError(`Failed to load directory: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  function goToParent() {
    if (isWindows) {
      const normalized = currentPath.replace(/\\+$/, '');
      const idx = normalized.lastIndexOf('\\');
      if (idx > 2) {
        setCurrentPath(normalized.slice(0, idx));
      } else {
        setCurrentPath(normalized.slice(0, 3));
      }
    } else {
      const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
      setCurrentPath(parent);
    }
  }

  function goToHome() {
    setCurrentPath(defaultPath);
  }

  function handleEntryClick(entry: FileEntry) {
    if (entry.isDirectory) {
      setCurrentPath(entry.path);
    } else if (entry.isAudio && onFileSelected) {
      onFileSelected(entry.path, entry.name);
    }
  }

  return (
    <PanelSection title="Browse Music Files">
      <PanelSectionRow>
        <Focusable
          style={{
            display: 'flex',
            gap: '8px',
            marginBottom: '10px',
            flexWrap: 'wrap',
            alignItems: 'center',
            width: '100%'
          }}
        >
          <DialogButton
            style={{ minWidth: '40px', padding: '8px', flex: '0 0 auto' }}
            onClick={goToHome}
            disabled={loading}
          >
            <FaHome />
          </DialogButton>
          <DialogButton
            style={{ minWidth: '40px', padding: '8px', flex: '0 0 auto' }}
            onClick={goToParent}
            disabled={loading || currentPath === '/'}
          >
            <FaLevelUpAlt />
          </DialogButton>
          <div
            style={{
              flex: '1 1 120px',
              minWidth: 0,
              padding: '8px',
              background: 'rgba(0,0,0,0.2)',
              borderRadius: '4px',
              fontSize: '12px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%'
            }}
          >
            {currentPath}
          </div>
        </Focusable>
      </PanelSectionRow>

      {error && (
        <PanelSectionRow>
          <div style={{ color: '#ff6b6b', fontSize: '12px' }}>{error}</div>
        </PanelSectionRow>
      )}

      <PanelSectionRow>
        <Focusable
          style={{
            maxHeight: '50vh',
            minHeight: '120px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            width: '100%'
          }}
        >
          {loading ? (
            <div style={{ padding: '20px', textAlign: 'center', opacity: 0.7 }}>
              Loading...
            </div>
          ) : entries.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', opacity: 0.7 }}>
              Empty directory
            </div>
          ) : (
            entries.map((entry) => (
              <DialogButton
                key={entry.path}
                style={{
                  justifyContent: 'flex-start',
                  padding: '10px',
                  background: entry.isAudio
                    ? 'rgba(100, 200, 100, 0.1)'
                    : 'rgba(0, 0, 0, 0.2)',
                  borderLeft: entry.isAudio ? '3px solid #64c864' : 'none',
                  width: '100%',
                  minWidth: 0,
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  height: '44px',
                  display: 'flex',
                  alignItems: 'center'
                }}
                onClick={() => handleEntryClick(entry)}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minWidth: 0,
                    width: '100%'
                  }}
                >
                  {entry.isDirectory ? (
                    <FaFolder style={{ color: '#ffd93d' }} />
                  ) : entry.isAudio ? (
                    <FaMusic style={{ color: '#64c864' }} />
                  ) : (
                    <div style={{ width: '16px' }} />
                  )}
                  <span
                    style={{
                      fontSize: '13px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                      flex: 1
                    }}
                  >
                    {entry.name}
                  </span>
                </div>
              </DialogButton>
            ))
          )}
        </Focusable>
      </PanelSectionRow>

      <PanelSectionRow>
        <div style={{ fontSize: '11px', opacity: 0.6, marginTop: '8px' }}>
          Supported: MP3, M4A, WebM, OGG, WAV, FLAC, AAC, OPUS
        </div>
      </PanelSectionRow>
    </PanelSection>
  );
}
