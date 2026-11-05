import {
  ButtonItem,
  ConfirmModal,
  Menu,
  MenuItem,
  PanelSection,
  PanelSectionRow,
  ProgressBarWithInfo,
  showContextMenu,
  showModal,
  ShowModalResult,
  SliderField,
  ToggleField
} from '@decky/ui';
import { useState } from 'react';
import { SiCrowdin, SiDiscord, SiGithub, SiKofi } from 'react-icons/si';
import { useSettings } from '../../hooks/useSettings';
import useTranslations from '../../hooks/useTranslations';
import {
  FaDownload,
  FaExclamationTriangle,
  FaUndo,
  FaSave,
  FaSync,
  FaVolumeMute,
  FaVolumeUp
} from 'react-icons/fa';
import {
  clearCache,
  clearDownloads,
  exportCache,
  getFullCache,
  importCache,
  listCacheBackups
} from '../../cache/musicCache';
import { call, toaster } from '@decky/api';
import { getResolverForVideoId } from '../../actions/audio';
import PanelSocialButton from './socialButton';

/** "backup-2026-11-05 10-12-03" -> "2026-11-05 10:12:03" */
export function formatBackupName(name: string): string {
  const match = name.match(
    /^backup-(\d{4}-\d{2}-\d{2}) (\d{2})-(\d{2})-(\d{2})$/
  );
  return match ? `${match[1]} ${match[2]}:${match[3]}:${match[4]}` : name;
}

export default function Index() {
  const {
    settings,
    setDefaultMuted,
    setVolume,
    setHomepageFocusMode,
    setAutoFallback,
    setPlayInDesktopMode
  } = useSettings();

  const t = useTranslations();
  const [isUpdatingYtDlp, setIsUpdatingYtDlp] = useState(false);

  async function updateYtDlp() {
    setIsUpdatingYtDlp(true);
    try {
      const result = await call<[], { success: boolean; message: string }>(
        'update_yt_dlp'
      );
      toaster.toast({
        title: result.success
          ? t('updateYtDlpSuccess')
          : t('updateYtDlpFailed'),
        body: result.message,
        icon: <FaSync />,
        duration: result.success ? 3000 : 5000
      });
    } catch (error) {
      toaster.toast({
        title: t('updateYtDlpFailed'),
        body: error instanceof Error ? error.message : String(error),
        icon: <FaSync />,
        duration: 5000
      });
    } finally {
      setIsUpdatingYtDlp(false);
    }
  }

  const confirmClearCache = () => {
    showModal(
      <ConfirmModal
        strTitle={t('deleteOverridesConfirm')}
        strDescription={t('deleteOverridesDescription')}
        onOK={clearCache}
      />
    );
  };

  const confirmClearDownloads = () => {
    showModal(
      <ConfirmModal
        strTitle={t('deleteDownloadsConfirm')}
        onOK={async () => {
          try {
            const count = await clearDownloads();
            toaster.toast({
              title: t('deleteDownloads'),
              body: t('deleteDownloadsDone', { num: String(count) }),
              icon: <FaDownload />,
              duration: 1500
            });
          } catch (e) {
            console.error('[GameThemeMusic] Could not delete downloads', e);
          }
        }}
      />
    );
  };

  const confirmRestoreDownloads = async () => {
    const num = Object.values(await getFullCache()).filter(
      (entry) => entry.videoId?.length
    ).length;
    const modal = showModal(
      <ConfirmModal
        strTitle={t('restoreDownloadsConfirm')}
        strDescription={t('restoreDownloadsConfirmDescription', {
          num: num.toString()
        })}
        onOK={() => restoreDownloads(modal)}
      />
    );
  };

  function restoreCache(backup: string) {
    showModal(
      <ConfirmModal
        strTitle={t('restoreOverridesConfirm')}
        strDescription={t('restoreOverridesConfirmDetails')}
        onOK={async () => {
          try {
            await importCache(backup);
            toaster.toast({
              title: t('restoreSuccessful'),
              body: t('restoreSuccessfulDetails'),
              icon: <FaUndo />,
              duration: 1500
            });
          } catch (e) {
            console.error('[GameThemeMusic] Restore failed', e);
            toaster.toast({
              title: t('restoreFailed'),
              body: t('restoreFailedDetails'),
              icon: <FaExclamationTriangle />,
              duration: 3000
            });
          }
        }}
      />
    );
  }

  async function restoreDownloads(modal: ShowModalResult) {
    function getProgressModal(index: number, total: number) {
      const current = index + 1;
      const progress = (current * 100) / total;
      return (
        <ConfirmModal
          bHideCloseIcon={true}
          bOKDisabled={true}
          onCancel={modal.Close}
          strCancelButtonText={t('close')}
          strTitle={
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                width: '100%'
              }}
            >
              {t('restoreDownloadsOperationTitle')}
              <div style={{ marginLeft: 'auto' }}>
                <ProgressBarWithInfo
                  nProgress={progress}
                  sOperationText={t('restoreDownloadsOperation', {
                    current: current.toString(),
                    total: total.toString()
                  })}
                />
              </div>
            </div>
          }
        ></ConfirmModal>
      );
    }

    const cached = Object.values(await getFullCache()).filter(
      (entry) => entry.videoId?.length
    );
    let failed = 0;

    try {
      for (let index = 0; index < cached.length; index++) {
        const videoId = cached[index].videoId as string;
        const resolver = getResolverForVideoId(videoId);
        modal.Update(getProgressModal(index, cached.length));

        try {
          if (await resolver.isDownloaded({ id: videoId })) continue;
          if (!(await resolver.downloadAudio({ id: videoId }))) failed++;
        } catch (e) {
          console.error('[GameThemeMusic] Restore download failed', e);
          failed++;
        }
      }
    } finally {
      modal.Close();
    }
    toaster.toast({
      title: failed ? t('downloadFailed') : t('downloadRestoreSuccessful'),
      body: failed
        ? t('downloadFailedDetail')
        : t('downloadRestoreSuccessfulDetails'),
      icon: <FaDownload />,
      duration: failed ? 3000 : 1500
    });
  }

  return (
    <div>
      <PanelSection title={t('settings')}>
        <PanelSectionRow>
          <SliderField
            label={t('volume')}
            description={t('volumeDescription')}
            value={settings.volume * 100}
            onChange={(newVal: number) => {
              setVolume(newVal / 100);
            }}
            min={0}
            max={100}
            step={1}
            icon={<FaVolumeUp />}
            editableValue
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            icon={<FaVolumeMute />}
            checked={settings.defaultMuted}
            label={t('defaultMuted')}
            description={t('defaultMutedDescription')}
            onChange={(newVal: boolean) => {
              setDefaultMuted(newVal);
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            checked={settings.autoFallback}
            label={t('autoFallback')}
            description={t('autoFallbackDescription')}
            onChange={(newVal: boolean) => {
              setAutoFallback(newVal);
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            checked={settings.playInDesktopMode}
            label={t('playInDesktopMode')}
            description={t('playInDesktopModeDescription')}
            onChange={(newVal: boolean) => {
              setPlayInDesktopMode(newVal);
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            checked={settings.homepageFocusMode}
            label={t('homepageFocusMode')}
            description={t('homepageFocusModeDescription')}
            onChange={(newVal: boolean) => {
              setHomepageFocusMode(newVal);
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            label={t('updateYtDlpLabel')}
            description={t('updateYtDlpDescription')}
            layout="below"
            disabled={isUpdatingYtDlp}
            onClick={updateYtDlp}
          >
            {isUpdatingYtDlp ? t('updating') : t('updateYtDlp')}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            label={t('deleteDownloadsLabel')}
            description={t('deleteDownloadsDescription')}
            layout="below"
            onClick={() => confirmClearDownloads()}
          >
            {t('deleteDownloads')}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            label={t('restoreDownloadsLabel')}
            description={t('restoreDownloadsDescription')}
            bottomSeparator="none"
            layout="below"
            onClick={() => confirmRestoreDownloads()}
          >
            {t('restoreDownloads')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
      <PanelSection title={t('overrides')}>
        <PanelSectionRow>
          <ButtonItem
            label={t('deleteOverridesLabel')}
            bottomSeparator="none"
            layout="below"
            onClick={() => confirmClearCache()}
          >
            {t('deleteOverrides')}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            label={t('backupOverridesLabel')}
            bottomSeparator="none"
            layout="below"
            onClick={async () => {
              try {
                await exportCache();
                toaster.toast({
                  title: t('backupSuccessful'),
                  body: t('backupSuccessfulDetails'),
                  icon: <FaSave />,
                  duration: 1500
                });
              } catch (e) {
                console.error('[GameThemeMusic] Backup failed', e);
                toaster.toast({
                  title: t('backupFailed'),
                  body: t('backupFailedDetails'),
                  icon: <FaExclamationTriangle />,
                  duration: 3000
                });
              }
            }}
          >
            {t('backupOverrides')}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            label={t('restoreOverridesLabel')}
            bottomSeparator="none"
            layout="below"
            onClick={async () => {
              const backups = await listCacheBackups();
              showContextMenu(
                <Menu label={t('restoreOverridesLabel')}>
                  {backups.map((backup) => (
                    <MenuItem
                      tone="positive"
                      onClick={() => restoreCache(backup)}
                      key={backup}
                    >
                      {formatBackupName(backup)}
                    </MenuItem>
                  ))}
                </Menu>
              );
            }}
          >
            {t('restoreOverrides')}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
      <PanelSection title={t('extras')}>
        <PanelSocialButton
          icon={<SiKofi fill="#FF5E5B" />}
          url="https://ko-fi.com/Nytuo"
        >
          Ko-fi
        </PanelSocialButton>
        <PanelSocialButton
          icon={<SiDiscord fill="#5865F2" />}
          url="https://deckbrew.xyz/discord"
        >
          Discord
        </PanelSocialButton>
        <PanelSocialButton
          icon={<SiGithub fill="#f5f5f5" />}
          url="https://github.com/Nytuo/SDH-GameThemeMusic/"
        >
          Github
        </PanelSocialButton>
        <PanelSocialButton
          icon={<SiCrowdin fill="#FFFFFF" />}
          url="https://crowdin.com/project/sdh-gamethememusic"
        >
          {t('helpTranslate')}
        </PanelSocialButton>
      </PanelSection>
    </div>
  );
}
