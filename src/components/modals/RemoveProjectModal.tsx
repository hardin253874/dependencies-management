'use client';

import { useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import { Modal } from './Modal';
import { Button } from './Button';
import { useAppContext } from '../AppContext';
import styles from './RemoveProjectModal.module.css';

interface Props {
  open: boolean;
  slug: string;
  projectName: string;
  onClose: () => void;
  onRemoved: () => void;
}

/**
 * Project removal confirmation (spec §6.3). Default behavior is registry-only
 * deletion: the project leaves `_projects.json` but `library/<slug>/` is kept
 * so cached AI reports survive an accidental remove.
 *
 * Opt-in checkbox: "Also delete cached data" passes `deleteData=true` to
 * `DELETE /api/projects/:slug?deleteData=true`.
 */
export function RemoveProjectModal({
  open,
  slug,
  projectName,
  onClose,
  onRemoved
}: Props): JSX.Element | null {
  const { refreshProjects, selectProject } = useAppContext();
  const [deleteData, setDeleteData] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetAndClose = () => {
    setDeleteData(false);
    setSubmitting(false);
    setError(null);
    onClose();
  };

  const onConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await getApiClient().deleteProject(slug, deleteData);
      await refreshProjects();
      selectProject(null);
      onRemoved();
      resetAndClose();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message :
        err instanceof Error ? err.message :
        'Removal failed.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`Remove ${projectName}?`}
      onClose={resetAndClose}
      maxWidth={440}
      footer={
        <>
          <Button onClick={resetAndClose} data-testid="remove-cancel">
            Cancel
          </Button>
          <Button
            tone="destructive"
            onClick={() => void onConfirm()}
            disabled={submitting}
            data-testid="remove-confirm"
          >
            {submitting ? 'Removing…' : 'Remove'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.message}>
          The project will be removed from your project list.
        </p>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={deleteData}
            onChange={(e) => setDeleteData(e.target.checked)}
            data-testid="remove-also-delete-data"
          />
          <span>
            Also delete cached data in <code>library/{slug}/</code>
          </span>
        </label>
        {error && (
          <p role="alert" className={styles.error} data-testid="remove-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
