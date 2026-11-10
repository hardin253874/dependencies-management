/**
 * Agent [D-Deep] seed prompt (V2_STAGE4_SPEC 4a.10). The v1 deep prompt (all
 * pre-computed lockfile / transitive / CVE facts) stays the authoritative
 * fact block; the agent sections add the code graph and the exploration
 * instructions. System prompt and version are shared with the [D] agent
 * (`agent-update-report.ts`).
 */
import { renderDeepUpdateReportPrompt, type DeepUpdateReportPromptInput } from './deep-update-report';
import { renderTemplate } from './mustache';

export interface AgentDeepSeedInput {
  promptInput: DeepUpdateReportPromptInput;
  graphSummaryLines: string[];
  usageLines: string[];
  apiDiffLines: string[];
  maxToolCalls: number;
  submitTool: string;
}

const AGENT_SECTION = `

CODE GRAPH
{{#each graphSummaryLines}}- {{this}}
{{/each}}
WHO USES THE PACKAGE (from the graph; via = direct | reexport | wrapper)
{{#each usageLines}}- {{this}}
{{/each}}
PACKAGE API DIFF
{{#each apiDiffLines}}- {{this}}
{{/each}}
{{^apiDiffLines}}- not available
{{/apiDiffLines}}
AGENT INSTRUCTIONS
- The facts above are authoritative. Use the tools (at most {{maxToolCalls}} tool calls) to
  check how the project actually uses the package and its dependents: usage sites,
  wrappers, entry points, tests, peer requirements of the target version, the API diff.
- Base criticalBlockers and suggestedUpgradeOrder on that evidence; name the package
  each blocker belongs to.
- Then call \`{{submitTool}}\` exactly once.`;

export function renderAgentDeepSeed(input: AgentDeepSeedInput): string {
  return (
    renderDeepUpdateReportPrompt(input.promptInput) +
    renderTemplate(AGENT_SECTION, {
      graphSummaryLines: input.graphSummaryLines,
      usageLines: input.usageLines,
      apiDiffLines: input.apiDiffLines,
      maxToolCalls: input.maxToolCalls,
      submitTool: input.submitTool
    })
  );
}
