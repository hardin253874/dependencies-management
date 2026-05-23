/**
 * View [D-Deep] — Deep Update Report prompt + tool schema
 * (spec §11, Appendix A.4).
 *
 * v0 draft per Appendix A.4. Owner per spec §11.7: PM + Designer draft changes;
 * orchestrator + end user review each change.
 *
 * Token budget: defaults to TOKEN_BUDGET_DEEP_REPORT_IN / _OUT.
 *
 * Adaptive narrative length per §7.6:
 *   - low: 1 paragraph
 *   - medium: 2 paragraphs
 *   - high/critical: 3–4 paragraphs
 *
 * The server pre-computes all deterministic data (lockfileSummary,
 * transitiveDelta, cveDelta, peerDepsOnTarget) — the LLM only narrates and
 * judges. Per spec §3.4 "deterministic where possible".
 */
import type { JsonSchemaObject, ToolSchema } from '../client';
import { renderTemplate } from './mustache';
import type {
  CveDelta,
  DeepCriticalBlocker,
  DeepEstimatedEffort,
  DeepRiskLevel,
  DeepUpgradeStep,
  LockfileSummary,
  TransitiveDelta
} from '../../api-types';

export const DEEP_UPDATE_REPORT_TOOL_NAME = 'submit_deep_update_report';

export const DEEP_UPDATE_REPORT_TOOL_SCHEMA: ToolSchema = {
  name: DEEP_UPDATE_REPORT_TOOL_NAME,
  description:
    'Submit a deep upgrade-impact report given pre-computed lockfile summary, ' +
    'transitive delta, CVE delta, and peer-dep satisfaction inputs. The server ' +
    'pre-computes all facts; this tool returns judgment (risk, blockers, order, narrative).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'summary',
      'riskLevel',
      'narrative',
      'estimatedEffort',
      'criticalBlockers',
      'suggestedUpgradeOrder'
    ],
    properties: {
      summary: {
        type: 'string',
        description: 'One-paragraph summary of the deep upgrade picture.'
      },
      riskLevel: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Conservative — prefer "high" or "critical" if uncertain.'
      },
      narrative: {
        type: 'string',
        description:
          'Plain-English narrative of the full upgrade picture. Length scales with ' +
          'riskLevel: 1 paragraph for low, 2 for medium, 3-4 for high/critical.'
      },
      estimatedEffort: {
        type: 'string',
        enum: ['small', 'medium', 'large', 'very-large'],
        description: 'Effort estimation per Appendix A.4 instructions.'
      },
      criticalBlockers: {
        type: 'array',
        description:
          'Peer-dep conflicts where satisfiedByCandidate is false, new high/critical CVEs, ' +
          'or packages that would need replacement instead of upgrade.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'description', 'package'],
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            package: { type: 'string' }
          }
        } as JsonSchemaObject
      },
      suggestedUpgradeOrder: {
        type: 'array',
        description:
          'Ordered steps for the upgrade. Order by dependency topology: deps with no ' +
          'dependents first, target dep last.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['step', 'action', 'rationale'],
          properties: {
            step: { type: 'integer', description: '1-based step number.' },
            action: { type: 'string' },
            rationale: { type: 'string' }
          }
        } as JsonSchemaObject
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Input contract — full L1 + L2 deterministic payload pre-attached.
// ---------------------------------------------------------------------------

export interface DeepUpdateReportPromptInput {
  dep: {
    name: string;
    fromVersion: string;
    toVersion: string;
  };
  lockfileSummary: LockfileSummary;
  transitiveDelta: TransitiveDelta;
  cveDelta: CveDelta;
  /** Carry-over from [D] for context. */
  resolverCheckSummary: string | null;
  /** Co-upgrade candidates (names only, plus required flag). */
  coUpgradeNames: string[];
}

// ---------------------------------------------------------------------------
// Tool output contract — aligns with DeepUpdateReportDetail's AI fields.
// ---------------------------------------------------------------------------

export interface DeepUpdateReportToolOutput {
  summary: string;
  riskLevel: DeepRiskLevel;
  narrative: string;
  estimatedEffort: DeepEstimatedEffort;
  criticalBlockers: DeepCriticalBlocker[];
  suggestedUpgradeOrder: DeepUpgradeStep[];
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const TEMPLATE = `Produce a deep upgrade impact analysis for \`{{dep.name}}\` from
{{dep.fromVersion}} to {{dep.toVersion}}, including the transitive dependency
graph impact.

The following data has been pre-computed deterministically — treat it as
authoritative:

LOCKFILE SUMMARY
- Total packages: {{lockfileSummary.totalPackages}}
{{#if lockfileSummary.peerDepsOnTarget.length}}
- Packages declaring peer-dep on {{dep.name}}:
{{#each lockfileSummary.peerDepsOnTarget}}  - {{package}}@{{version}} - peer {{peerRange}} - satisfied by candidate: {{satisfiedByCandidate}}
{{/each}}
{{/if}}

TRANSITIVE DELTA
- Added:    {{transitiveDelta.packagesAdded.length}}
- Removed:  {{transitiveDelta.packagesRemoved.length}}
- Upgraded: {{transitiveDelta.packagesUpgraded.length}}
{{#if transitiveDelta.packagesAdded.length}}
{{#each transitiveDelta.packagesAdded}}    + {{name}}@{{version}}
{{/each}}
{{/if}}
{{#if transitiveDelta.packagesRemoved.length}}
{{#each transitiveDelta.packagesRemoved}}    - {{name}}@{{version}}
{{/each}}
{{/if}}

CVE DELTA
- Resolved by upgrade: {{cveDelta.resolvedCves.length}}
{{#each cveDelta.resolvedCves}}    - {{id}} in {{package}} ({{severity}}): {{summary}}
{{/each}}
- New CVEs introduced: {{cveDelta.newCves.length}}
{{#each cveDelta.newCves}}    - {{id}} in {{package}} ({{severity}}): {{summary}}
{{/each}}

{{#if resolverCheckSummary}}RESOLVER
{{resolverCheckSummary}}
{{/if}}

{{#if coUpgradeNames.length}}CO-UPGRADE CANDIDATES (from L1 analysis)
{{#each coUpgradeNames}}  - {{this}}
{{/each}}
{{/if}}

INSTRUCTIONS
- Write a 'narrative' explaining the full upgrade picture in plain English. Cover:
  what changes, what risks emerge, what gets fixed, what blockers exist.
  Length: 1 paragraph for low risk, 2 for medium, 3-4 for high or critical.
- Identify CRITICAL BLOCKERS — peer-dep conflicts where satisfiedByCandidate
  is false, new high/critical CVEs, packages that would need replacement.
- Suggest an upgrade ORDER if multiple deps must move. Order by dependency
  topology: deps with no dependents first, target dep last.
- Effort estimation:
  - 'small': <1 day of work
  - 'medium': <1 week
  - 'large': <1 month
  - 'very-large': >1 month or requires architectural change
- Be conservative: prefer 'high' (or 'critical') risk if uncertain; the user
  can override after reading.`;

export function renderDeepUpdateReportPrompt(input: DeepUpdateReportPromptInput): string {
  return renderTemplate(TEMPLATE, input as unknown as Record<string, unknown>);
}
