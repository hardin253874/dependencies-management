'use client';

import { useState } from 'react';
import type { FsValidationResponse } from '@/lib/api-types';
import { ApiError } from '@/lib/client/api-client';
import { Modal } from './Modal';
import { Button } from './Button';
import { Picker } from './Picker';
import { WorkspacesDetectedModal } from './WorkspacesDetectedModal';
import { useAppContext } from '../AppContext';

interface Props {
  open: boolean;
}

export function AddProjectModal({ open }: Props): JSX.Element | null {
  const { closeAddProject, registerProject } = useAppContext();
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
    closeAddProject();
  };

  const performSubmit = async (acknowledgeWorkspaces: boolean) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await registerProject(path, acknowledgeWorkspaces);
      resetAndClose();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to add project';
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

  const onWorkspacesProceed = () => {
    // User acknowledged the workspaces warning; forward the flag this time.
    void performSubmit(true);
  };

  const canSubmit = Boolean(path && validation?.ok && !submitting);

  return (
    <>
      <Modal
        open={open && !workspacesPrompt}
        title="Add project"
        onClose={resetAndClose}
        maxWidth={640}
        footer={
          <>
            <Button onClick={resetAndClose}>Cancel</Button>
            <Button
              tone="primary"
              disabled={!canSubmit}
              onClick={submit}
              data-testid="add-project-submit"
            >
              {submitting ? 'Adding…' : 'Add'}
            </Button>
          </>
        }
      >
        <Picker initialPath={path} onChange={setPath} onValidation={setValidation} />
        {submitError && (
          <p
            role="alert"
            style={{
              margin: 'var(--space-3) 0 0',
              fontSize: 'var(--text-sm)',
              color: 'var(--color-status-red-text)'
            }}
          >
            {submitError}
          </p>
        )}
      </Modal>
      <WorkspacesDetectedModal
        open={workspacesPrompt}
        onProceed={onWorkspacesProceed}
        onCancel={() => setWorkspacesPrompt(false)}
      />
    </>
  );
}
