import { call } from '@decky/api';
import {
  DialogButton,
  Focusable,
  ModalRoot,
  PanelSection,
  PanelSectionRow,
  showModal,
  TextField
} from '@decky/ui';
import { useState } from 'react';
import useTranslations from '../../hooks/useTranslations';
import FileBrowser from './fileBrowser';

const MessageModalContent = ({
  title,
  message,
  closeLabel,
  closeModal
}: {
  title: string;
  message: string;
  closeLabel: string;
  closeModal?: () => void;
}) => (
  <ModalRoot>
    <div style={{ padding: 24, textAlign: 'center' }}>
      <h3>{title}</h3>
      <div style={{ margin: '16px 0' }}>{message}</div>
      <DialogButton onClick={closeModal}>{closeLabel}</DialogButton>
    </div>
  </ModalRoot>
);

export default function LocalMusicImport({
  selectNewAudio,
  onImported
}: {
  selectNewAudio?: (audio: {
    title: string;
    videoId: string;
    audioUrl: string;
  }) => Promise<void>;
  onImported?: () => void;
}) {
  const t = useTranslations();
  const [customName, setCustomName] = useState('');
  const [lastImported, setLastImported] = useState('');
  const [showBrowser, setShowBrowser] = useState(false);

  function showMessage(title: string, message: string) {
    showModal(
      <MessageModalContent
        title={title}
        message={message}
        closeLabel={t('close')}
      />
    );
  }

  async function handleFileSelect(filePath: string, fileName: string) {
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    try {
      // The backend never overwrites: it picks a free name and returns the id.
      const id = await call<[string, string], string | null>(
        'import_local_music',
        filePath,
        customName.trim()
      );
      if (!id) {
        showMessage(t('importFailed'), t('importFailedDetail'));
        return;
      }
      setLastImported(customName.trim() || baseName);
      setCustomName('');
      onImported?.();
      if (selectNewAudio) {
        const url = await call<[string], string | null>(
          'get_local_music_url',
          id
        );
        if (!url) {
          showMessage(t('importFailed'), t('importFailedDetail'));
          return;
        }
        await selectNewAudio({
          title: id.replace(/^local_/, ''),
          videoId: id,
          audioUrl: url
        });
      }
      showMessage(t('importSuccess'), t('importSuccessDetail'));
    } catch (e) {
      console.error('[GameThemeMusic] Import failed', e);
      showMessage(t('importFailed'), String(e));
    }
  }

  return (
    <>
      <DialogButton
        style={{ marginBottom: 12, alignSelf: 'flex-start' }}
        onClick={() => setShowBrowser((v) => !v)}
      >
        {showBrowser ? t('hideImportPanel') : t('showImportPanel')}
      </DialogButton>
      {showBrowser && (
        <PanelSection title={t('importMusic')}>
          <PanelSectionRow>
            <Focusable
              style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              <TextField
                label={t('importCustomName')}
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
              {lastImported && (
                <div
                  style={{
                    fontSize: '12px',
                    opacity: 0.7,
                    padding: '8px',
                    background: 'rgba(100, 200, 100, 0.1)',
                    borderRadius: '4px'
                  }}
                >
                  {t('lastImported', { name: lastImported })}
                </div>
              )}
            </Focusable>
          </PanelSectionRow>
          <PanelSectionRow>
            <FileBrowser onFileSelected={handleFileSelect} />
          </PanelSectionRow>
        </PanelSection>
      )}
    </>
  );
}
