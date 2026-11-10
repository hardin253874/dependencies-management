'use client';

/**
 * Settings → LLM → "Jev (TypeSafe)" (v2 Stage 5b.9).
 *
 * Global switches (`_config.json` `judge`): Jev on/off, the model router and
 * each judgment J1–J8 with the data it sends. Per-project block for the
 * active project: privacy (missing = treated as private, D30), "Jev for this
 * project", and the J1–J3 source opt-in for a private project. Key presence
 * only (`hasTypesafeKey`); the key itself is set in `.env`.
 */
import type { JSX } from 'react';
import { useState } from 'react';
import { getApiClient } from '@/lib/client/api-client';
import { useAppContext } from '../../AppContext';
import type { JudgeFlag, JudgeSwitchesDto, ProjectPrivacy } from '@/lib/api-types';
import styles from './LlmSettings.module.css';

const FLAGS: ReadonlyArray<{ flag: JudgeFlag; label: string; data: string }> = [
  { flag: 'J1', label: 'J1 rank files for context', data: 'source snippets' },
  { flag: 'J2', label: 'J2 evidence check on report claims', data: 'source snippets' },
  { flag: 'J3', label: 'J3 per-CVE triage (fallback)', data: 'source snippets' },
  { flag: 'J4', label: 'J4 rename candidates in api_diff', data: 'public .d.ts signatures' },
  { flag: 'J5', label: 'J5 co-upgrade suggestions', data: 'metadata only' },
  { flag: 'J6', label: 'J6 related deps with unknown ranges', data: 'metadata only' },
  { flag: 'J7', label: 'J7 estimated CVE severity', data: 'public advisory text' },
  { flag: 'J8', label: 'J8 findings suggestions (eval only)', data: 'public report text' }
];

const OFF: JudgeSwitchesDto = { enabled: false, router: false, flags: { J1: false, J2: false, J3: false, J4: false, J5: false, J6: false, J7: false, J8: false } };

export function JudgeSettings(): JSX.Element {
  const { config, refreshConfig, projects, activeProjectSlug, refreshProjects, pushToast } = useAppContext();
  const [busy, setBusy] = useState(false);
  const judge = config?.judge ?? OFF;
  const hasKey = Boolean(config?.apiKeys.hasTypesafeKey);
  const project = projects.find((p) => p.slug === activeProjectSlug) ?? null;

  const patch = async (p: { enabled?: boolean; router?: boolean; flags?: Partial<Record<JudgeFlag, boolean>> }) => {
    setBusy(true);
    try {
      const res = await getApiClient().patchConfig({ judge: p });
      await refreshConfig(res.notices);
    } catch (err) {
      pushToast({ severity: 'error', title: 'Could not save Jev settings', body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const patchProject = async (p: { privacy?: ProjectPrivacy | null; judge?: 'on' | 'off'; judgeSourceOptIn?: boolean }) => {
    if (project === null) return;
    setBusy(true);
    try {
      await getApiClient().patchProjectSettings(project.slug, p);
      await refreshProjects();
    } catch (err) {
      pushToast({ severity: 'error', title: 'Could not save project settings', body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.field} data-testid="judge-settings">
      <h4 className={styles.label}>Jev (TypeSafe) — optional</h4>
      <p className={styles.note}>
        {hasKey ? '✓ TypeSafe key set (TYPESAFE_API_KEY in .env).' : 'No TypeSafe key (TYPESAFE_API_KEY in .env): Jev stays off.'} Off = today&apos;s behaviour.
        Spend is capped at $0.50 in code.
      </p>
      <label>
        <input type="checkbox" checked={judge.enabled} disabled={busy} onChange={(e) => void patch({ enabled: e.target.checked })} data-testid="judge-enabled" /> Use Jev
      </label>
      <label>
        <input type="checkbox" checked={judge.router} disabled={busy} onChange={(e) => void patch({ router: e.target.checked })} data-testid="judge-router" /> Model router (rules; Jev for unclear cases — metadata only)
      </label>
      <ul className={styles.flagList}>
        {FLAGS.map((f) => (
          <li key={f.flag}>
            <label>
              <input
                type="checkbox"
                checked={judge.flags[f.flag]}
                disabled={busy || !judge.enabled}
                onChange={(e) => void patch({ flags: { [f.flag]: e.target.checked } })}
                data-testid={`judge-flag-${f.flag}`}
              />{' '}
              {f.label} <span className={styles.note}>({f.data})</span>
            </label>
          </li>
        ))}
      </ul>

      {project !== null && (
        <div className={styles.field} data-testid="project-judge-settings">
          <span className={styles.label}>This project: {project.name}</span>
          <label>
            Privacy{' '}
            <select
              value={project.privacy ?? 'unknown'}
              disabled={busy}
              onChange={(e) => void patchProject({ privacy: e.target.value === 'unknown' ? null : (e.target.value as ProjectPrivacy) })}
              data-testid="project-privacy"
            >
              <option value="unknown">not set (treated as private)</option>
              <option value="public">public</option>
              <option value="private">private</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={project.judge !== 'off'} disabled={busy} onChange={(e) => void patchProject({ judge: e.target.checked ? 'on' : 'off' })} data-testid="project-judge" /> Jev for this project
          </label>
          {project.privacy === 'private' && (
            <label>
              <input
                type="checkbox"
                checked={project.judgeSourceOptIn === true}
                disabled={busy}
                onChange={(e) => void patchProject({ judgeSourceOptIn: e.target.checked })}
                data-testid="project-source-opt-in"
              />{' '}
              Allow J1–J3 to send source snippets of this private project
            </label>
          )}
          <p className={styles.note}>Private or not-set projects send nothing to TypeSafe (routing uses rules only), unless the J1–J3 opt-in is ticked.</p>
        </div>
      )}
    </div>
  );
}
