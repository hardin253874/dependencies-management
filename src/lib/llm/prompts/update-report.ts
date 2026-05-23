/**
 * View [D] — Update Analyze Report prompt + tool schema
 * (spec §11, Appendix A.3).
 *
 * v0 draft. Owner per spec §11.7: PM + Designer draft changes;
 * orchestrator + end user review each change.
 *
 * Token budget: defaults to TOKEN_BUDGET_UPDATE_REPORT_IN / _OUT.
 */
import type { JsonSchemaObject, ToolSchema } from '../client';
import { renderTemplate } from './mustache';

export const UPDATE_REPORT_TOOL_NAME = 'submit_update_report';

export const UPDATE_REPORT_TOOL_SCHEMA: ToolSchema = {
  name: UPDATE_REPORT_TOOL_NAME,
  description:
    'Submit a structured upgrade-impact report for a single direct dependency, ' +
    'given pre-computed resolver, co-upgrade candidate, and affected-file inputs.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'riskLevel', 'breakingChanges', 'coUpgradeDeps', 'filesToModify', 'recommendations'],
    properties: {
      summary: { type: 'string', description: 'One-paragraph summary of the upgrade picture.' },
      riskLevel: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Conservative — prefer "high" if uncertain.'
      },
      breakingChanges: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'description', 'affectsFilesInProject'],
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            affectsFilesInProject: { type: 'boolean' }
          }
        } as JsonSchemaObject
      },
      coUpgradeDeps: {
        type: 'array',
        description: 'Direct deps that must (or should) move together. Based on the provided candidate list.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'currentVersion', 'suggestedVersion', 'required', 'reason', 'explanation'],
          properties: {
            name: { type: 'string' },
            currentVersion: { type: 'string' },
            suggestedVersion: { type: 'string' },
            required: { type: 'boolean' },
            reason: {
              type: 'string',
              enum: ['peer-dep', 'common-pairing', 'co-version', 'ecosystem']
            },
            explanation: { type: 'string' }
          }
        } as JsonSchemaObject
      },
      filesToModify: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'brief', 'estimatedChangeSize'],
          properties: {
            path: { type: 'string' },
            brief: { type: 'string', description: 'One sentence on what likely needs to change.' },
            estimatedChangeSize: { type: 'string', enum: ['small', 'medium', 'large'] }
          }
        } as JsonSchemaObject
      },
      recommendations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional ordered recommendations to surface in the UI.'
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Input contract (matches spec Appendix A.3)
// ---------------------------------------------------------------------------
//
// Re-exports the canonical types from `src/lib/api-types.ts` so callers don't
// pull from two places.

import type { ResolverConflict } from '../../api-types';

export type { ResolverConflict };

export interface ResolverCheckInput {
  wouldResolve: boolean;
  conflicts: ResolverConflict[];
  legacyPeerDepsUsed: boolean;
  /** Optional reason for skip (kill-switch / yarn / failure). Renders banner-side. */
  disabledReason?: string | null;
}

export interface CoUpgradeCandidate {
  name: string;
  currentVersion: string | null;
  /** Peer-dep range the candidate declares for the target (when known). */
  declaredPeerDepRange: string | null;
}

export interface AffectedFile {
  path: string;
  importStatements: string[];
  importCount: number;
}

export interface UpdateReportPromptInput {
  dep: {
    name: string;
    fromVersion: string;
    toVersion: string;
    releaseNotesBetween: string | null;
  };
  /** Null when resolver disabled (yarn / kill-switch / failure). */
  resolverCheck: ResolverCheckInput | null;
  candidateCoUpgrades: CoUpgradeCandidate[];
  affectedFiles: AffectedFile[];
}

// ---------------------------------------------------------------------------
// Tool output contract (matches the schema above + canonical FE types)
// ---------------------------------------------------------------------------
//
// Aligns with `UpdateReportDetail` minus the deterministic fields (fromVersion,
// toVersion, resolverCheck) which the BE pre-fills.

import type { BreakingChange, CoUpgradeDep, FileToModify, RiskLevel } from '../../api-types';

export type { BreakingChange, CoUpgradeDep, FileToModify, RiskLevel };

export interface UpdateReportToolOutput {
  summary: string;
  riskLevel: RiskLevel;
  breakingChanges: BreakingChange[];
  coUpgradeDeps: CoUpgradeDep[];
  filesToModify: FileToModify[];
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const TEMPLATE = `Produce an upgrade impact report for \`{{dep.name}}\` from {{dep.fromVersion}}
to {{dep.toVersion}}.

RESOLVER CHECK
{{#if resolverCheck}}
- Would resolve cleanly: {{resolverCheck.wouldResolve}}
- Required --legacy-peer-deps: {{resolverCheck.legacyPeerDepsUsed}}
{{#if resolverCheck.conflicts}}
- Conflicts:
{{#each resolverCheck.conflicts}}  - {{package}}: {{reason}}
{{/each}}
{{/if}}
{{/if}}
{{^resolverCheck}}
- Resolver check unavailable.
{{/resolverCheck}}

CANDIDATE CO-UPGRADE DEPS
{{#each candidateCoUpgrades}}  - {{name}}@{{currentVersion}}{{#if declaredPeerDepRange}} - declares peer {{../dep.name}} {{declaredPeerDepRange}}{{/if}}
{{/each}}

AFFECTED FILES ({{affectedFiles.length}} files import this dep)
{{#each affectedFiles}}
  - {{path}} ({{importCount}} imports)
{{#each importStatements}}    {{this}}
{{/each}}
{{/each}}

{{#if dep.releaseNotesBetween}}
RELEASE NOTES BETWEEN VERSIONS
{{dep.releaseNotesBetween}}
{{/if}}

INSTRUCTIONS
- Determine which candidate co-upgrade deps are REQUIRED vs OPTIONAL based on:
  resolver conflicts -> required; peer-dep constraint violated -> required;
  common ecosystem pairing -> optional.
- For each affected file, write a 1-sentence brief on what likely needs to change.
  Base briefs on the import statements shown. Do NOT speculate about file contents
  you cannot see.
- Risk level:
  - "low":    pure additive change, no breaking changes affect this project
  - "medium": breaking changes exist but affect a small surface
  - "high":   breaking changes affect many files OR resolver has conflicts
- If release notes are missing, surface that uncertainty in your explanation
  fields. Prefer "high" risk if uncertain.`;

export function renderUpdateReportPrompt(input: UpdateReportPromptInput): string {
  return renderTemplate(TEMPLATE, input as unknown as Record<string, unknown>);
}

/** Affected-files normalization — the candidateCoUpgrades array is special-cased
 *  by the template (it iterates and embeds a parent-context lookup) so we add
 *  no further synthesis here. Exposed for tests + callers. */
export function buildAffectedFiles(usageFiles: AffectedFile[]): AffectedFile[] {
  return usageFiles.map((f) => ({
    path: f.path,
    importStatements: [...f.importStatements],
    importCount: f.importCount
  }));
}
