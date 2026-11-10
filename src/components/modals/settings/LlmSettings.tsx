'use client';

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import { Button } from '../Button';
import { useAppContext } from '../../AppContext';
import { DEFAULT_AGENT_MODEL, MODEL_OPTIONS, defaultModel } from '@/lib/llm/models';
import styles from './LlmSettings.module.css';
import { JudgeSettings } from './JudgeSettings';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type TestState = { status: 'idle' | 'testing' | 'ok' | 'error'; message?: string };

export function LlmSettings(): JSX.Element {
  const { config, refreshConfig } = useAppContext();
  // v2 D8: Anthropic is the only provider, so there is no provider picker.
  const provider = 'anthropic' as const;
  const [model, setModel] = useState<string>(
    config?.llm.model ?? defaultModel('anthropic')
  );
  // D32: the agent engine's [D] / [D-Deep] model; an older server omits it (= its default).
  const [agentModel, setAgentModel] = useState<string>(config?.llm.agentModel ?? DEFAULT_AGENT_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });

  useEffect(() => {
    if (config) {
      setModel(config.llm.model);
      setAgentModel(config.llm.agentModel ?? DEFAULT_AGENT_MODEL);
    }
  }, [config]);

  const hasKey = Boolean(config?.apiKeys.hasAnthropicKey);

  const onModelChange = async (next: string) => {
    setModel(next);
    try {
      const patched = await getApiClient().patchConfig({ llm: { provider, model: next } });
      await refreshConfig(patched.notices);
    } catch (err) {
      setSaveState('error');
      console.error(err);
    }
  };

  const onAgentModelChange = async (next: string) => {
    setAgentModel(next);
    try {
      const patched = await getApiClient().patchConfig({ llm: { agentModel: next } });
      await refreshConfig(patched.notices);
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

      <div className={styles.field}>
        <span className={styles.label}>Provider</span>
        <span data-testid="provider-name">Anthropic</span>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Model (file review, CVE impact, related upgrade, v1 reports)</span>
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

      <label className={styles.field}>
        <span className={styles.label}>Agent report model ([D] Update Report, [D-Deep] Deep Report)</span>
        <select
          value={agentModel}
          onChange={(e) => onAgentModelChange(e.target.value)}
          className={styles.select}
          data-testid="agent-model-select"
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

      <JudgeSettings />

      <hr className={styles.divider} />

      <p className={styles.note}>
        Token budgets are configured via <code>.env</code>. Editing budgets requires a
        server restart.
      </p>
    </div>
  );
}
