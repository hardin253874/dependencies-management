'use client';

import { useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import { useAppContext } from '../../AppContext';
import styles from './BehaviorSettings.module.css';

/**
 * Settings → Behavior. Two persistent toggles (Wireframe 19):
 *   1. "Show Deep Analyze cost warning" — `_config.json.ui.showDeepAnalyzeWarning`
 *   2. "Enable resolver check" (kill-switch) — `_config.json.features.resolverCheckEnabled`
 *
 * Both PATCH `/api/config`. The kill-switch takes effect without restart
 * (spec §7.7); the BE re-reads `_config.json` on every relevant request.
 */
export function BehaviorSettings(): JSX.Element {
  const { config, refreshConfig } = useAppContext();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showWarning = config?.ui.showDeepAnalyzeWarning ?? true;
  const resolverEnabled = config?.features.resolverCheckEnabled ?? true;

  const onToggleShowWarning = async (next: boolean) => {
    setPending('show-warning');
    setError(null);
    try {
      await getApiClient().patchConfig({ ui: { showDeepAnalyzeWarning: next } });
      await refreshConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update setting');
    } finally {
      setPending(null);
    }
  };

  const onToggleResolver = async (next: boolean) => {
    setPending('resolver');
    setError(null);
    try {
      await getApiClient().patchConfig({ features: { resolverCheckEnabled: next } });
      await refreshConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update setting');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={styles.pane}>
      <h3 className={styles.heading}>Behavior</h3>

      <div className={styles.field}>
        <label className={styles.row}>
          <input
            type="checkbox"
            checked={showWarning}
            disabled={pending === 'show-warning'}
            onChange={(e) => void onToggleShowWarning(e.target.checked)}
            data-testid="toggle-show-deep-warning"
          />
          <span className={styles.label}>Show Deep Analyze cost warning</span>
        </label>
        <p className={styles.helpText}>
          Confirms estimated cost before the first Deep Analyze per project.
        </p>
      </div>

      <hr className={styles.divider} />

      <div className={styles.field}>
        <label className={styles.row}>
          <input
            type="checkbox"
            checked={resolverEnabled}
            disabled={pending === 'resolver'}
            onChange={(e) => void onToggleResolver(e.target.checked)}
            data-testid="toggle-resolver-enabled"
          />
          <span className={styles.label}>Enable resolver check</span>
        </label>
        <p className={styles.helpText}>
          Used in Update Reports. Disabling skips <code>npm install --dry-run</code>{' '}
          checks. Yarn projects are not affected by this toggle.
        </p>
      </div>

      {error && (
        <p className={styles.error} role="alert" data-testid="behavior-error">
          {error}
        </p>
      )}
    </div>
  );
}
