/**
 * The window of an app with tabs (lib/host.ts `tabs`) when no project is open: an empty window (its top bar still
 * drags it) and the projects window over it, only with nothing behind to close it to. The project picked opens in its
 * tab. The top bar stays above the projects window's shade, in the window's color like the system's
 * window buttons beside it: its logo opens the app menu, as a project's does.
 */
import React from 'react';
import { studioHost } from '@/lib/host';
import { AppMenu } from './AppMenu';
import { ProjectsPopover } from './ProjectsLibrary';
import { SettingsModal, type SettingsSection } from './settings/SettingsModal';
import { ProjectTabs } from './ProjectTabs';
import tabStyles from './ProjectTabs.module.css';
import { useSettings } from './settings/use-settings';

function LauncherBar({ onSettings, onProjects, onWorkbench }: {
  onSettings: (section: SettingsSection) => void;
  onProjects: () => void;
  onWorkbench?: () => void;
}) {
  /* Stay above the projects window's shade and clear the window's controls. */
  return (
    <div data-titlebar className="fixed inset-x-0 top-0 z-[10045] flex h-8 min-w-0 items-center bg-[var(--bg-titlebar)] px-[6px]" onContextMenu={event => event.preventDefault()}>
      <div aria-hidden className={tabStyles.windowSpace} style={{ width: 'var(--titlebar-logo-x)' }} />
      <div className={tabStyles.system}><AppMenu onSettings={onSettings} /></div>
      <ProjectTabs onProjects={onProjects} onWorkbench={onWorkbench} />
    </div>
  );
}

export function Launcher({ onOpen, onWorkbench }: { onOpen: (projectId: string) => void; onWorkbench?: () => void }) {
  const [settings, setSettings] = useSettings();
  return (
    <>
      <div className="workspace-shell bg-[var(--bg-app)]" />
      <LauncherBar onSettings={setSettings} onProjects={() => {}} onWorkbench={onWorkbench} />
      <ProjectsPopover open currentProjectId="" onOpen={onOpen} onCurrentRemoved={() => {}} />
      <SettingsModal open={settings !== null} section={settings ?? undefined} onClose={() => setSettings(null)} />
    </>
  );
}

export function WorkbenchChrome({ onOpen, projects, onProjects }: {
  onOpen: (projectId: string) => void;
  projects: boolean;
  onProjects: (open: boolean) => void;
}) {
  const [settings, setSettings] = useSettings();
  React.useEffect(() => studioHost?.tabs?.onPick(() => onProjects(true)), [onProjects]);
  return <>
    <LauncherBar onSettings={setSettings} onProjects={() => onProjects(true)} />
    <ProjectsPopover open={projects} currentProjectId="" onOpen={onOpen} onCurrentRemoved={() => {}} onClose={() => onProjects(false)} />
    <SettingsModal open={settings !== null} section={settings ?? undefined} onClose={() => setSettings(null)} />
  </>;
}
