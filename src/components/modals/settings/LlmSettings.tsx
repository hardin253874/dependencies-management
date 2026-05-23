'use client';

import { useEffect, useState } from 'react';
import type { LlmProvider } from '@/lib/api-types';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import { Button } from '../Button';
import { useAppContext } from '../../AppContext';
import styles from './LlmSettings.module.css';

/**
 * Available model lists per provider. Order = recency, most capable first.
 * The first entry is treated as the default when a provider is selected.
 *
 * Note: provider-published "active" model lists may evolve. v1.x will move
 * this to a BE endpoint (`GET /api/llm/models?provider=...`). For Stage 3 we
 * ship a static list covering the current generations.
 */
const MODEL_OPTIONS: Record<LlmProvider, string[]> = {
  anthropic: [
    'claude-opus-4-7',
    'claude-opus-4-1',
    'claude-sonnet-4-5',
    'claude-sonnet-4-1',
    'claude-haiku-4-1'
  ],
  openai: ['gpt-5.5', 'gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini']
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type TestState = { status: 'idle' | 'testing' | 'ok' | 'error'; message?: string };

export function LlmSettings(): JSX.Element {
  const { config, refreshConfig } = useAppContext();
  const [provider, setProvider] = useState<LlmProvider>(config?.llm.provider ?? 'anthropic');
  const [model, setModel] = useState<string>(
    config?.llm.model ?? MODEL_OPTIONS.anthropic[0]!
  );
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });

  useEffect(() => {
    if (config) {
      setProvider(config.llm.provider);
      setModel(config.llm.model);
    }
  }, [config]);

  const hasKey =
    provider === 'anthropic'
      ? Boolean(config?.apiKeys.hasAnthropicKey)
      : Boolean(config?.apiKeys.hasOpenAIKey);

  const onProviderChange = async (next: LlmProvider) => {
    setProvider(next);
    const defaultModel = MODEL_OPTIONS[next][0]!;
    setModel(defaultModel);
    try {
      await getApiClient().patchConfig({ llm: { provider: next, model: defaultModel } });
      await refreshConfig();
    } catch (err) {
      setSaveState('error');
      console.error(err);
    }
  };

  const onModelChange = async (next: string) => {
    setModel(next);
    try {
      await getApiClient().patchConfig({ llm: { provider, model: next } });
      await refreshConfig();
    } catch (err) {
      setSaveState('error');
      console.error(err);
    }
  };

  const onSaveKey = async () => {
    if (!apiKey) return;
    setSaveState('saving');
    try {
      await getApiClient().setApiKey({ provider, apiKey });
      setSaveState('saved');
      setApiKey('');
      await refreshConfig();
    } catch (err) {
      setSaveState('error');
      console.error(err);
    }
  };

  const onTestKey = async () => {
    setTestState({ status: 'testing' });
    try {
      const result = await getApiClient().testApiKey({ provider, apiKey: apiKey || '' });
      setTestState({
        status: result.ok ? 'ok' : 'error',
        message: result.message
      });
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Test failed';
      setTestState({ status: 'error', message });
    }
  };

  return (
    <div className={styles.pane}>
      <h3 className={styles.heading}>LLM</h3>

      <fieldset className={styles.field}>
        <legend className={styles.label}>Provider</legend>
        <label className={styles.radio}>
          <input
            type="radio"
            name="provider"
            value="anthropic"
            checked={provider === 'anthropic'}
            onChange={() => onProviderChange('anthropic')}
            data-testid="provider-anthropic"
          />
          Anthropic
        </label>
        <label className={styles.radio}>
          <input
            type="radio"
            name="provider"
            value="openai"
            checked={provider === 'openai'}
            onChange={() => onProviderChange('openai')}
            data-testid="provider-openai"
          />
          OpenAI
        </label>
      </fieldset>

      <label className={styles.field}>
        <span className={styles.label}>Model</span>
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          className={styles.select}
          data-testid="model-select"
        >
          {MODEL_OPTIONS[provider].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.field}>
        <div className={styles.keyHeader}>
          <span className={styles.label}>API key</span>
          {hasKey ? (
            <span className={styles.keySet}>✓ Key set</span>
          ) : (
            <span className={styles.keyMissing}>No key</span>
          )}
        </div>
        <div className={styles.keyRow}>
          <input
            type={reveal ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste API key"
            className={styles.keyInput}
            autoComplete="off"
            data-testid="api-key-input"
          />
          <button
            type="button"
            className={styles.eye}
            aria-label={reveal ? 'Hide API key' : 'Reveal API key'}
            aria-pressed={reveal}
            onClick={() => setReveal(!reveal)}
          >
            <span aria-hidden="true">{reveal ? '🙈' : '👁'}</span>
          </button>
        </div>
        <div className={styles.actions}>
          <Button onClick={onTestKey} disabled={!apiKey || testState.status === 'testing'}>
            {testState.status === 'testing' ? 'Testing…' : 'Test key'}
          </Button>
          <Button
            tone="primary"
            onClick={onSaveKey}
            disabled={!apiKey || saveState === 'saving'}
            data-testid="save-api-key"
          >
            {saveState === 'saving' ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {testState.status === 'ok' && (
          <p className={styles.testOk}>{testState.message ?? 'Key works.'}</p>
        )}
        {testState.status === 'error' && (
          <p className={styles.testErr}>{testState.message ?? 'Key test failed.'}</p>
        )}
        {saveState === 'saved' && <p className={styles.testOk}>Key saved.</p>}
        {saveState === 'error' && <p className={styles.testErr}>Failed to save key.</p>}
      </div>

      <hr className={styles.divider} />

      <p className={styles.note}>
        Token budgets are configured via <code>.env</code>. Editing budgets requires a
        server restart.
      </p>
    </div>
  );
}
