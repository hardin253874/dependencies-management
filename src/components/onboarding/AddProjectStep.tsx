'use client';

import { useState } from 'react';
import type { FsValidationResponse } from '@/lib/api-types';
import { ApiError } from '@/lib/client/api-client';
import { Button } from '../modals/Button';
import { Picker } from '../modals/Picker';
import { WorkspacesDetectedModal } from '../modals/WorkspacesDetectedModal';
import { useAppContext } from '../AppContext';
import styles from './Card.module.css';

export function AddProjectStep(): JSX.Element {
  const { registerProject } = useAppContext();
  const [path, setPath] = useState('');
  const [validation, setValidation] = useState<FsValidationResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspacesPrompt, setWorkspacesPrompt] = useState(false);

  const performSubmit = async (acknowledgeWorkspaces: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      await registerProject(path, acknowledgeWorkspaces);
      // The provider will detect that projects.length > 0 and exit onboarding.
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to add project'
      );
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
    void performSubmit(true);
  };

  return (
    <>
      <section className={styles.card} aria-labelledby="add-title">
        <h1 id="add-title" className={styles.title}>
          Add your first project
        </h1>
        <p className={styles.subtitle}>
          Point at the root folder of a Next.js, React, or general JS/TS project. The
          agent reads <code>package.json</code> and the lockfile — never writing.
        </p>

        <Picker initialPath={path} onChange={setPath} onValidation={setValidation} />

        {error && (
          <p
            role="alert"
            style={{
              margin: 'var(--space-3) 0 0',
              color: 'var(--color-status-red-text)',
              fontSize: 'var(--text-sm)'
            }}
          >
            {error}
          </p>
        )}

        <div className={styles.actions} style={{ marginTop: 'var(--space-5)' }}>
          <Button
            tone="primary"
            disabled={!path || !validation?.ok || submitting}
            onClick={submit}
            data-testid="onboarding-add-project"
          >
            {submitting ? 'Adding…' : 'Add project'}
          </Button>
        </div>
      </section>
      <WorkspacesDetectedModal
        open={workspacesPrompt}
        onProceed={onWorkspacesProceed}
        onCancel={() => setWorkspacesPrompt(false)}
      />
    </>
  );
}
