'use client';

import { useEffect, useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import type { LibrarySizeResponse, LogsClearResponse } from '@/lib/api-types';
import { Button } from '../Button';
import styles from './LibrarySettings.module.css';

/**
 * Settings → Library section (spec §7.7, Wireframe 16).
 *
 * Calls `GET /api/library/size` for the total + per-category byte counts.
 * Provides best-effort "Open in file explorer" via `POST /api/library/open`
 * and a destructive "Clear all logs" via `POST /api/logs/clear`.
 *
 * Per spec §7.7, the library folder path is read-only in v1; mutability ships
 * in v1.1.
 */
export function LibrarySettings(): JSX.Element {
  const [size, setSize] = useState<LibrarySizeResponse | null>(null);
  const [sizeLoading, setSizeLoading] = useState(true);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openMessage, setOpenMessage] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<LogsClearResponse | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);

  const loadSize = async () => {
    setSizeLoading(true);
    setSizeError(null);
    try {
      const res = await getApiClient().getLibrarySize();
      setSize(res);
    } catch (err) {
      setSizeError(err instanceof Error ? err.message : 'Failed to load library size.');
    } finally {
      setSizeLoading(false);
    }
  };

  useEffect(() => {
    void loadSize();
  }, []);

  const onOpenInExplorer = async () => {
    setOpening(true);
    setOpenMessage(null);
    try {
      // The library root path is not surfaced to the FE (BE owns it). The BE
      // resolves the path itself on this best-effort endpoint.
      const res = await getApiClient().openInExplorer('library');
      setOpenMessage(res.message ?? (res.ok ? 'Opened.' : 'Could not open file explorer.'));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 501)) {
        setOpenMessage('Open the library folder manually from your file explorer.');
      } else {
        setOpenMessage(err instanceof Error ? err.message : 'Could not open file explorer.');
      }
    } finally {
      setOpening(false);
    }
  };

  const onClearLogs = async () => {
    setClearing(true);
    setClearResult(null);
    setClearError(null);
    try {
      const res = await getApiClient().clearLogs();
      setClearResult(res);
      await loadSize();
    } catch (err) {
      setClearError(err instanceof Error ? err.message : 'Failed to clear logs.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className={styles.pane}>
      <h3 className={styles.heading}>Library</h3>

      <div className={styles.field}>
        <p className={styles.label}>Library folder</p>
        <p className={styles.helpText}>
          Path is set by the agent. Mutability ships in v1.1.
        </p>
        <Button
          onClick={() => void onOpenInExplorer()}
          disabled={opening}
          data-testid="open-in-explorer"
        >
          {opening ? 'Opening…' : 'Open in file explorer'}
        </Button>
        {openMessage && (
          <p className={styles.statusInfo} role="status" data-testid="open-message">
            {openMessage}
          </p>
        )}
      </div>

      <hr className={styles.divider} />

      <div className={styles.field}>
        <p className={styles.label}>Total size</p>
        {sizeLoading && (
          <p className={styles.statusInfo} role="status">
            Loading…
          </p>
        )}
        {sizeError && (
          <p className={styles.statusError} role="alert" data-testid="library-size-error">
            {sizeError}
          </p>
        )}
        {size && (
          <>
            <p className={styles.totalValue} data-testid="library-total-size">
              {formatBytes(size.totalBytes)}
            </p>
            <ul className={styles.breakdown}>
              {Object.entries(size.byKind).map(([kind, bytes]) => (
                <li
                  key={kind}
                  className={styles.breakdownRow}
                  data-testid={`library-byKind-${kind}`}
                >
                  <span className={styles.kind}>{kind}</span>
                  <span className={styles.kindBytes}>{formatBytes(bytes)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <hr className={styles.divider} />

      <div className={styles.field}>
        <p className={styles.label}>Logs</p>
        <Button
          onClick={() => void onClearLogs()}
          disabled={clearing}
          tone="destructive"
          data-testid="clear-logs"
        >
          {clearing ? 'Clearing…' : 'Clear all logs'}
        </Button>
        {clearResult && (
          <p className={styles.statusOk} role="status" data-testid="clear-logs-result">
            Removed {clearResult.filesRemoved} file
            {clearResult.filesRemoved === 1 ? '' : 's'} ({formatBytes(clearResult.bytesRemoved)}).
          </p>
        )}
        {clearError && (
          <p className={styles.statusError} role="alert" data-testid="clear-logs-error">
            {clearError}
          </p>
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(Math.max(1, n)) / 3));
  const value = n / Math.pow(1000, i);
  // Keep 1 decimal for KB+, 0 for bytes.
  const formatted = i === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${formatted} ${units[i]}`;
}
