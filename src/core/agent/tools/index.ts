/**
 * The full v2 read-only tool set (V2_STAGE4_SPEC 4a.1–4a.5). One list, used
 * by the agent loop in-process and by the Stage 4b MCP adapter.
 */
import { createToolRegistry, type ToolRegistry } from '../registry';
import type { AgentToolDef } from '../types';
import { apiDiffTools } from './apiDiff';
import { fileTools } from './files';
import { graphTools } from './graph';
import { peerTools } from './peers';

export function readToolDefs(): AgentToolDef[] {
  return [...graphTools(), ...fileTools(), ...apiDiffTools(), ...peerTools()];
}

export function createReadToolRegistry(): ToolRegistry {
  return createToolRegistry(readToolDefs());
}
