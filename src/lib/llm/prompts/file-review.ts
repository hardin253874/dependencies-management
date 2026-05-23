/**
 * View [E] — File-Level AI Review prompt + tool schema (spec §11, Appendix A.2).
 *
 * v0 draft. Owner per spec §11.7: PM + Designer draft changes;
 * orchestrator + end user review each change.
 *
 * Token budget: defaults to TOKEN_BUDGET_FILE_REVIEW_IN / _OUT from env.
 * Content truncation: see ./truncate.ts.
 */
import type { JsonSchemaObject, ToolSchema } from '../client';
import type { CveSeverity } from '../../api-types';
import { renderTemplate } from './mustache';

export const FILE_REVIEW_TOOL_NAME = 'submit_file_review';

export const FILE_REVIEW_TOOL_SCHEMA: ToolSchema = {
  name: FILE_REVIEW_TOOL_NAME,
  description:
    'Submit a structured review of how a single source file uses a specific dependency. ' +
    'Return only what can be verified from the file content; do not invent issues.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'depUsageQuality', 'findings'],
    properties: {
      summary: {
        type: 'string',
        description: '1–2 sentence overview of how the file uses the dependency.'
      },
      depUsageQuality: {
        type: 'string',
        enum: ['good', 'outdated', 'incorrect', 'risky', 'unknown'],
        description: 'Overall assessment of the file\'s usage of the dep.'
      },
      findings: {
        type: 'array',
        description: 'Specific findings, one entry per actionable issue. Empty array when usage is clean.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'severity', 'message'],
          properties: {
            kind: {
              type: 'string',
              enum: [
                'outdated-pattern',
                'incorrect-usage',
                'security-risk',
                'deprecation-warning',
                'performance',
                'info'
              ]
            },
            severity: {
              type: 'string',
              enum: ['info', 'low', 'medium', 'high', 'critical']
            },
            message: { type: 'string', description: 'Brief description of the issue.' },
            line: { type: 'integer', description: '1-based line number from the supplied file content.' },
            suggestion: { type: 'string', description: 'Optional suggested fix.' },
            confidence: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Confidence in this finding; default high.'
            }
          }
        } as JsonSchemaObject
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------

export interface FileReviewPromptInput {
  dep: {
    name: string;
    installedVersion: string | null;
    latestVersion: string | null;
    deprecation: { message: string } | null;
    currentCves: Array<{ id: string; severity: CveSeverity; summary: string }>;
  };
  file: {
    path: string;
    content: string;
    truncated: boolean;
    /** Static import statements extracted server-side. */
    importStatements: string[];
    /** File extension hint for the code fence (e.g. 'ts', 'tsx'). */
    extension: string;
  };
}

// ---------------------------------------------------------------------------
// Tool output contract (matches the schema above)
// ---------------------------------------------------------------------------
//
// Aligns with the canonical types in `src/lib/api-types.ts`:
//   `DepUsageQuality`, `FindingKind`, `FindingSeverity`, `ReviewFinding`.
// Re-exporting here keeps prompt/test code self-contained without a circular
// import shim.

import type { DepUsageQuality, FindingKind, FindingSeverity, ReviewFinding } from '../../api-types';

export type { DepUsageQuality, FindingKind, FindingSeverity, ReviewFinding };

export interface FileReviewToolOutput {
  summary: string;
  depUsageQuality: DepUsageQuality;
  findings: ReviewFinding[];
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const TEMPLATE = `Analyze how the file uses the dependency \`{{dep.name}}\` and report findings.

DEPENDENCY METADATA
- Name: {{dep.name}}
- Installed: {{dep.installedVersion}} | Latest: {{dep.latestVersion}}
{{#if dep.deprecation}}
- DEPRECATED: {{dep.deprecation.message}}
{{/if}}
{{#if dep.currentCves}}
- Known CVEs in installed version:
{{#each dep.currentCves}}  - {{id}} ({{severity}}): {{summary}}
{{/each}}
{{/if}}

IMPORT STATEMENTS FOUND IN FILE
{{#each file.importStatements}}  {{this}}
{{/each}}

FILE: {{file.path}}{{#if file.truncated}} (truncated for length){{/if}}
\`\`\`{{file.extension}}
{{file.content}}
\`\`\`

INSTRUCTIONS
- Read the file. Identify every usage site of \`{{dep.name}}\`.
- Report only what you can verify in the file. If usage looks correct and modern,
  return an empty findings array — do not invent issues to fill space.
- For each finding, give the 1-based line number from the file above.
- If the file is truncated and key information is missing, set the relevant
  finding's confidence to "low".`;

export function renderFileReviewPrompt(input: FileReviewPromptInput): string {
  return renderTemplate(TEMPLATE, input as unknown as Record<string, unknown>);
}
