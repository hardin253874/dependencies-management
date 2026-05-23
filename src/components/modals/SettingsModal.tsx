'use client';

import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { LlmSettings } from './settings/LlmSettings';
import { AboutSettings } from './settings/AboutSettings';
import { BehaviorSettings } from './settings/BehaviorSettings';
import { LibrarySettings } from './settings/LibrarySettings';
import { CacheSettings } from './settings/CacheSettings';
import { CostSettings } from './settings/CostSettings';
import { useAppContext, type SettingsSection } from '../AppContext';
import styles from './SettingsModal.module.css';

const SECTIONS: ReadonlyArray<{ key: SettingsSection; label: string }> = [
  { key: 'llm', label: 'LLM' },
  { key: 'library', label: 'Library' },
  { key: 'cache', label: 'Cache' },
  { key: 'cost', label: 'Cost' },
  { key: 'behavior', label: 'Behavior' },
  { key: 'about', label: 'About' }
];

interface Props {
  open: boolean;
}

export function SettingsModal({ open }: Props): JSX.Element | null {
  const { closeSettings, settingsSection, dispatch } = useAppContext();
  const [section, setSection] = useState<SettingsSection>(settingsSection);

  // Sync to context when the modal is reopened to a specific section.
  useEffect(() => {
    if (open) setSection(settingsSection);
  }, [open, settingsSection]);

  return (
    <Modal open={open} title="Settings" onClose={closeSettings} maxWidth={720}>
      <div className={styles.layout}>
        <nav className={styles.rail} aria-label="Settings sections">
          <ul role="list">
            {SECTIONS.map((s) => (
              <li role="listitem" key={s.key}>
                <button
                  type="button"
                  aria-current={section === s.key ? 'true' : undefined}
                  className={[
                    styles.railItem,
                    section === s.key ? styles.railItemActive : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    setSection(s.key);
                    dispatch({ type: 'openSettings', section: s.key });
                  }}
                  data-testid={`settings-section-${s.key}`}
                >
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className={styles.pane}>
          {section === 'llm' && <LlmSettings />}
          {section === 'about' && <AboutSettings />}
          {section === 'library' && <LibrarySettings />}
          {section === 'cache' && <CacheSettings />}
          {section === 'cost' && <CostSettings />}
          {section === 'behavior' && <BehaviorSettings />}
        </div>
      </div>
    </Modal>
  );
}
