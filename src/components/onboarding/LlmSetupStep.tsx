'use client';

import { useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import { Button } from '../modals/Button';
import { useAppContext } from '../AppContext';
import { MODEL_OPTIONS as MODELS, defaultModel } from '@/lib/llm/models';
import styles from './Card.module.css';

interface Props {
  onContinue: () => void;
}

export function LlmSetupStep({ onContinue }: Props): JSX.Element {
  const { refreshConfig } = useAppContext();
  // v2 D8: Anthropic is the only provider, so there is no provider picker.
  const provider = 'anthropic' as const;
  const [model, setModel] = useState<string>(defaultModel('anthropic'));
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onTest = async () => {
    setTestStatus('testing');
    setTestMsg(null);
    try {
      const result = await getApiClient().testApiKey({ provider, apiKey });
      setTestStatus(result.ok ? 'ok' : 'error');
      setTestMsg(result.message);
    } catch (err) {
      setTestStatus('error');
      setTestMsg(
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Test failed'
      );
    }
  };

  const onSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const patched = await getApiClient().patchConfig({ llm: { provider, model } });
      await getApiClient().setApiKey({ provider, apiKey });
      await refreshConfig(patched.notices);
      onContinue();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to save';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="llm-title">
      <h1 id="llm-title" className={styles.title}>
        Pick your LLM
      </h1>
      <p className={styles.subtitle}>
        Paste your Anthropic API key and pick a model. The key is stored locally in your{' '}
        <code>.env</code> file.
      </p>


      <label className={styles.field}>
        <span className={styles.label}>Model</span>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={{
            height: 32,
            padding: '0 var(--space-2)',
            background: 'var(--color-surface)',
            border: 'var(--border-width-thin) solid var(--color-border-strong)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-base)'
          }}
          data-testid="onboarding-model"
        >
          {MODELS[provider].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        <span className={styles.label}>API key</span>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input
            type={reveal ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste API key"
            style={{
              flex: 1,
              height: 32,
              padding: '0 var(--space-3)',
              background: 'var(--color-surface)',
              border: 'var(--border-width-thin) solid var(--color-border-strong)',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-family-mono)',
              fontSize: 'var(--text-base)'
            }}
            autoComplete="off"
            data-testid="onboarding-apikey"
          />
          <button
            type="button"
            aria-label={reveal ? 'Hide API key' : 'Reveal API key'}
            aria-pressed={reveal}
            onClick={() => setReveal(!reveal)}
            style={{
              width: 32,
              height: 32,
              background: 'var(--color-surface)',
              border: 'var(--border-width-thin) solid var(--color-border-strong)',
              borderRadius: 'var(--radius-md)'
            }}
          >
            <span aria-hidden="true">{reveal ? '🙈' : '👁'}</span>
          </button>
        </div>
      </label>

      {testStatus === 'ok' && testMsg && (
        <p style={{ margin: 0, color: 'var(--color-status-green-text)', fontSize: 'var(--text-sm)' }}>
          {testMsg}
        </p>
      )}
      {testStatus === 'error' && testMsg && (
        <p style={{ margin: 0, color: 'var(--color-status-red-text)', fontSize: 'var(--text-sm)' }}>
          {testMsg}
        </p>
      )}
      {error && (
        <p
          role="alert"
          style={{ margin: 0, color: 'var(--color-status-red-text)', fontSize: 'var(--text-sm)' }}
        >
          {error}
        </p>
      )}

      <div className={styles.actions} style={{ marginTop: 'var(--space-5)' }}>
        <Button onClick={onTest} disabled={!apiKey || testStatus === 'testing'}>
          {testStatus === 'testing' ? 'Testing…' : 'Test key'}
        </Button>
        <Button
          tone="primary"
          onClick={onSubmit}
          disabled={!apiKey || submitting}
          data-testid="onboarding-llm-continue"
        >
          {submitting ? 'Saving…' : 'Continue'}
        </Button>
      </div>
    </section>
  );
}
