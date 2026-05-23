'use client';

import { useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import type { FsValidationResponse } from '@/lib/api-types';
import { Modal } from './Modal';
import { Button } from './Button';
import { Picker } from './Picker';
import { WorkspacesDetectedModal } from './WorkspacesDetectedModal';
import { useAppContext } from '../AppContext';
import styles from './RelocateProjectModal.module.css';

interface Props {
  open: boolean;
  slug: string;
  projectName: string;
  oldPath: string;
  onClose: () => void;
  onRelocated: () => void;
}

/**
 * Project relocation modal (spec §6.3, Wireframe 26).
 *
 * Triggered from the left-panel orphan banner when a registered project's
 * absolute path is no longer reachable. Reuses the Add-Project Picker for
 * path entry + validation, then PATCHes `/api/projects/:slug/relocate` with
 * the new path. The slug is preserved; all cached library data stays intact.
 */
export function RelocateProjectModal({
  open,
  slug,
  projectName,
  oldPath,
  onClose,
  onRelocated
}: Props): JSX.Element | null {
  const { refreshProjects, refreshActiveProject } = useAppContext();
  const [path, setPath] = useState('');
  const [validation, setValidation] = useState<FsValidationResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [workspacesPrompt, setWorkspacesPrompt] = useState(false);

  const resetAndClose = () => {
    setPath('');
    setValidation(null);
    setSubmitting(false);
    setSubmitError(null);
    setWorkspacesPrompt(false);
    onClose();
  };

  const performSubmit = async (acknowledgeWorkspaces: boolean) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await getApiClient().relocateProject(slug, {
        newPath: path,
        acknowledgeWorkspaces: acknowledgeWorkspaces || undefined
      });
      await refreshProjects();
      await refreshActiveProject();
      onRelocated();
      resetAndClose();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message :
        err instanceof Error ? err.message :
        'Relocation failed.';
      setSubmitError(message);
    } finally {
      setSubmitting(false);
      setWorkspacesPrompt(false);
    }
  };

  const submit = async () => {
    if (!path) return;
    if (validation?.workspacesDetected && !workspacesPrompt) {
      setWorkspacesPrompt(true);
      return;
    }
    await performSubmit(false);
  };

  const canSubmit = Boolean(path && validation?.ok && !submitting);

  return (
    <>
      <Modal
        open={open && !workspacesPrompt}
        title={`Relocate ${projectName}`}
        onClose={resetAndClose}
        maxWidth={640}
        footer={
          <>
            <Button onClick={resetAndClose} data-testid="relocate-cancel">
              Cancel
            </Button>
            <Button
              tone="primary"
              disabled={!canSubmit}
              onClick={() => void submit()}
              data-testid="relocate-submit"
            >
              {submitting ? 'Relocating…' : 'Relocate'}
            </Button>
          </>
        }
      >
        <div className={styles.body}>
          <p className={styles.oldPath}>
            <span className={styles.label}>Old path:</span>{' '}
            <code className={styles.code}>{oldPath}</code>
          </p>
          <p className={styles.helpText}>
            Pick the new folder location. The project slug and cached library
            data are preserved.
          </p>
          <Picker
            initialPath={path}
            onChange={setPath}
            onValidation={setValidation}
          />
          {submitError && (
            <p role="alert" className={styles.error} data-testid="relocate-error">
              {submitError}
            </p>
          )}
        </div>
      </Modal>
      <WorkspacesDetectedModal
        open={workspacesPrompt}
        onProceed={() => void performSubmit(true)}
        onCancel={() => setWorkspacesPrompt(false)}
      />
    </>
  );
}
