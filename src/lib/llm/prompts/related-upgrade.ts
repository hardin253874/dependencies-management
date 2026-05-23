/**
 * Prompt + tool schema for the "Related deps upgrade analysis" feature
 * (view [B] new section).
 *
 * The viewed dep — typically a toolchain entry like `node` or a framework
 * like `next` — is being considered for an upgrade from `fromVersion` to
 * `toVersion`. The LLM receives:
 *   1. The viewed dep + from/to versions.
 *   2. A pre-computed deterministic verdict per related dep (compatible /
 *      breaks / unknown) so it doesn't have to re-derive semver math.
 *   3. The reasons each dep is "related" (peer-dep, engine, naming).
 *
 * It must return ONE structured payload per related dep: action,
 * suggestedVersion, severity, migrationNotes, confidence — plus a brief
 * `globalNotes` paragraph for cross-dep coupling and ordering.
 *
 * Token budget — this prompt is small (a list of 5–50 deps with metadata),
 * so the existing `updateReport` budget envelope is sufficient. We don't
 * introduce a new budget bucket.
 */
import type { JsonSchemaObject, ToolSchema } from '../client';
import { renderTemplate } from './mustache';

export const RELATED_UPGRADE_TOOL_NAME = 'submit_related_upgrade_analysis';

export const RELATED_UPGRADE_TOOL_SCHEMA: ToolSchema = {
  name: RELATED_UPGRADE_TOOL_NAME,
  description:
    "Submit upgrade recommendations for each related dependency of a target package upgrade. " +
    "For every related dep listed in the input, emit exactly one entry with action, suggestedVersion (when upgrading), severity, and migration notes. " +
    "Order entries the same as the input list. Also emit a short globalNotes paragraph covering cross-dep coupling and recommended ordering.",
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['globalNotes', 'deps'],
    properties: {
      globalNotes: {
        type: 'string',
        description:
          'Brief overall context (1–2 short paragraphs): cross-dep coupling, suggested upgrade ordering, ecosystem-level gotchas.'
      },
      deps: {
        type: 'array',
        description: 'One entry per related dep, in the same order as the input list.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'action', 'suggestedVersion', 'severity', 'migrationNotes', 'confidence'],
          properties: {
            name: {
              type: 'string',
              description: 'Echo of the dep name from the input list.'
            },
            action: {
              type: 'string',
              enum: ['keep', 'upgrade', 'investigate'],
              description:
                '`keep` = installed already compatible, no action needed; ' +
                '`upgrade` = a specific newer version is recommended; ' +
                '`investigate` = compatibility unclear from available data, manual review needed.'
            },
            suggestedVersion: {
              type: 'string',
              description:
                "Recommended target version when action='upgrade' (e.g. '24.5.0' or '15.x'). " +
                "Empty string when action='keep' or 'investigate'."
            },
            severity: {
              type: 'string',
              enum: ['patch', 'minor', 'major', 'none'],
              description: "Semver-diff severity from installed to suggestedVersion. 'none' when action='keep'."
            },
            migrationNotes: {
              type: 'string',
              description:
                '1–3 sentences explaining WHY this action and what the user should check / change. ' +
                'Be concrete: cite breaking changes, peer-dep impacts, version ranges. ' +
                'Empty string allowed when truly trivial.'
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description:
                'Conservative: prefer `low` if the data does not clearly determine the answer.'
            }
          }
        } as JsonSchemaObject
      }
    }
  }
};

export interface RelatedUpgradePromptDep {
  name: string;
  installedVersion: string | null;
  /** Pre-computed deterministic verdict from semver-satisfies on the relation ranges. */
  deterministicVerdict: 'compatible' | 'breaks' | 'unknown';
  /** Human-readable summary lines describing each relation. */
  relationSummaries: string[];
  /** Latest available version per the local packument cache (for context). */
  latestAvailableVersion: string | null;
  /** Latest version's engines map (e.g. `engines.node = '>=18'`). */
  latestEngines: Record<string, string>;
}

export interface RelatedUpgradePromptInput {
  viewedDep: {
    name: string;
    fromVersion: string;
    toVersion: string;
  };
  deps: RelatedUpgradePromptDep[];
}

const TEMPLATE = `You are advising a developer about a single-package upgrade and its impact on RELATED deps in the same project.

UPGRADE CONTEXT
- Viewed dep: {{viewedDep.name}}
- Currently installed: {{viewedDep.fromVersion}}
- Target version: {{viewedDep.toVersion}}

RELATED DEPS ({{deps.length}} total — analyze EACH one in order)
{{#each deps}}
---
[{{name}}] installed={{installedVersion}}{{^installedVersion}}(not in package.json){{/installedVersion}}
- Deterministic verdict: {{deterministicVerdict}}
- Latest known version: {{latestAvailableVersion}}{{^latestAvailableVersion}}unknown{{/latestAvailableVersion}}
- Latest version's engines: {{#each latestEngines}}{{@key}}={{this}} {{/each}}{{^latestEngines}}none{{/latestEngines}}
- Relations:
{{#each relationSummaries}}  - {{this}}
{{/each}}
{{/each}}

INSTRUCTIONS
- For EACH related dep above, decide:
  - action=keep when deterministic verdict is 'compatible' and the installed range comfortably covers the target.
  - action=upgrade when deterministic verdict is 'breaks' OR the installed version is far behind and a known compatible newer version exists.
  - action=investigate when the verdict is 'unknown' or available data is insufficient to make a confident call.
- For action=upgrade:
  - suggestedVersion: use the latest known version when it satisfies the constraint, otherwise the lowest version known to do so.
    For naming relations (e.g. @types/node) suggest tracking the viewed dep's major (e.g. '24.x').
  - severity: semver-diff from installed to suggestedVersion.
- migrationNotes (1–3 sentences): cite the SPECIFIC reason — peer-dep range, engines.node bound, known breaking changes in the target version, ecosystem norms (e.g. "@types/X tracks X major").
- confidence: 'low' whenever the available data does not clearly justify a specific suggestedVersion. NEVER fabricate version numbers — say 'investigate' + 'low' instead.
- globalNotes: 1–2 short paragraphs — call out cross-dep coupling (e.g. "react and react-dom must move together"), recommended ordering (e.g. "upgrade @types/node first, then ESLint rules, then build tools"), and ecosystem-level pitfalls specific to this upgrade.
- Emit deps in the SAME ORDER as the input list. Do not skip any. Do not invent extras.
`;

export function renderRelatedUpgradePrompt(input: RelatedUpgradePromptInput): string {
  return renderTemplate(TEMPLATE, input as unknown as Record<string, unknown>);
}

export interface RelatedUpgradeToolOutput {
  globalNotes: string;
  deps: Array<{
    name: string;
    action: 'keep' | 'upgrade' | 'investigate';
    suggestedVersion: string;
    severity: 'patch' | 'minor' | 'major' | 'none';
    migrationNotes: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
}
