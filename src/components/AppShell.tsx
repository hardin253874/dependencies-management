'use client';

import { useAppContext } from './AppContext';
import { HeaderBar } from './HeaderBar';
import { LeftPanel } from './LeftPanel/LeftPanel';
import { MiddlePanel } from './MiddlePanel/MiddlePanel';
import { RightPanel } from './RightPanel/RightPanel';
import { StatusBar } from './StatusBar';
import { Divider } from './Divider';
import { OnboardingFlow } from './onboarding/OnboardingFlow';
import { SettingsModal } from './modals/SettingsModal';
import { AddProjectModal } from './modals/AddProjectModal';
import { CancelConfirmationModal } from './modals/CancelConfirmationModal';
import { ToastContainer } from './ToastContainer';
import styles from './AppShell.module.css';

export function AppShell(): JSX.Element {
  const {
    sidebarCollapsed,
    panelWidths,
    setPanelWidths,
    onboardingActive,
    settingsOpen,
    addProjectOpen
  } = useAppContext();

  const leftWidth = sidebarCollapsed ? 56 : panelWidths.left;
  const middleWidth = panelWidths.middle;

  if (onboardingActive) {
    return (
      <div className={styles.shell}>
        <HeaderBar minimal />
        <main id="main" className={styles.onboardingMain}>
          <OnboardingFlow />
        </main>
        <SettingsModal open={settingsOpen} />
        <AddProjectModal open={addProjectOpen} />
        <CancelConfirmationModal />
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <HeaderBar />
      {/* The #main anchor is the skip-link target. Always present, in both
          onboarding and three-panel modes (Stage 1 carry-over M5). */}
      <div
        id="main"
        className={styles.panels}
        style={
          {
            ['--left-width' as string]: `${leftWidth}px`,
            ['--middle-width' as string]: `${middleWidth}px`
          } as React.CSSProperties
        }
      >
        <LeftPanel />
        <Divider
          orientation="vertical"
          ariaLabel="Resize left panel"
          ariaControls="middle-panel"
          value={leftWidth}
          min={sidebarCollapsed ? 56 : 200}
          max={sidebarCollapsed ? 56 : 400}
          disabled={sidebarCollapsed}
          onChange={(next) => setPanelWidths({ left: next, middle: middleWidth })}
        />
        <MiddlePanel />
        <Divider
          orientation="vertical"
          ariaLabel="Resize middle panel"
          ariaControls="right-panel"
          value={middleWidth}
          min={280}
          max={600}
          onChange={(next) => setPanelWidths({ left: leftWidth, middle: next })}
        />
        <RightPanel />
      </div>
      <StatusBar />
      <SettingsModal open={settingsOpen} />
      <AddProjectModal open={addProjectOpen} />
      <CancelConfirmationModal />
      <ToastContainer />
    </div>
  );
}
