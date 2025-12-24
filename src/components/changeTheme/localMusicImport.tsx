import { call } from '@decky/api';
import {
  ModalRoot,
  PanelSection,
  PanelSectionRow,
  TextField,
  showModal,
  Focusable,
  DialogButton
} from '@decky/ui';
import { useState } from 'react';
import FileBrowser from './fileBrowser';

function showSuccessModal(message: string) {
  showModal(
    <ModalRoot>
      <div style={{ padding: 24, textAlign: 'center' }}>
        <h3>Success</h3>
        <div style={{ margin: '16px 0' }}>{message}</div>
        <DialogButton onClick={() => showModal(null)}>Close</DialogButton>
      </div>
    </ModalRoot>
  );
}

export default function LocalMusicImport({
  selectNewAudio
}: {
  selectNewAudio?: (audio: {
    title: string;
    videoId: string;
    audioUrl: string;
  }) => Promise<void>;
}) {
  const [customName, setCustomName] = useState('');
  const [selectedFile, setSelectedFile] = useState('');

  async function handleFileSelect(_: string, fileName: string) {
    setSelectedFile(fileName);
    if (selectNewAudio) {
      const id = `local_${fileName.replace(/\.[^/.]+$/, '')}`;
      const res = await call<[string], string | null>(
        'get_local_music_url',
        id
      );
      if (res) {
        await selectNewAudio({
          title: fileName.replace(/\.[^/.]+$/, ''),
          videoId: id,
          audioUrl: res
        });
        showSuccessModal('Music imported successfully!');
      }
    }
  }

  const [showLocal, setShowLocal] = useState(false);
  return (
    <>
      <DialogButton
        style={{ marginBottom: 12, alignSelf: 'flex-start' }}
        onClick={() => setShowLocal((v) => !v)}
      >
        {showLocal ? 'Hide Local Import Panel' : 'Show Local Import Panel'}
      </DialogButton>
      {showLocal && (
        <PanelSection title="Import Music from Filesystem">
          <PanelSectionRow>
            <Focusable
              style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              <TextField
                label="Custom Name (Optional)"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
              />
              {selectedFile && (
                <div
                  style={{
                    fontSize: '12px',
                    opacity: 0.7,
                    padding: '8px',
                    background: 'rgba(100, 200, 100, 0.1)',
                    borderRadius: '4px'
                  }}
                >
                  {`Last imported: ${selectedFile}`}
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
