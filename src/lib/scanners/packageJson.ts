/**
 * package.json parsing for Phase 1 scan (spec §10.1).
 *
 * Extracts: dependencies, devDependencies, volta toolchain pins, workspaces flag.
 * Spec §2.1: `volta` is toolchain metadata, NOT a dependency category.
 */
import { promises as fs } from 'fs';
import path from 'path';

export interface ParsedPackageJson {
  name: string | null;
  version: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  workspacesDetected: boolean;
  volta: { node: string | null; npm: string | null; yarn: string | null } | null;
}

export async function readPackageJson(projectDir: string): Promise<ParsedPackageJson> {
  const fp = path.join(projectDir, 'package.json');
  const raw = await fs.readFile(fp, 'utf8');
  const json = JSON.parse(raw) as Record<string, unknown>;

  const name = typeof json.name === 'string' ? json.name : null;
  const version = typeof json.version === 'string' ? json.version : null;

  const dependencies = normalizeRecord(json.dependencies);
  const devDependencies = normalizeRecord(json.devDependencies);

  // Spec §6.2 step 4: workspaces is detected from package.json `workspaces` field.
  // Both array form (`["packages/*"]`) and object form (`{ packages: [...] }`) count.
  const workspacesField = json.workspaces;
  const workspacesDetected =
    Array.isArray(workspacesField) ||
    (typeof workspacesField === 'object' && workspacesField !== null);

  let volta: ParsedPackageJson['volta'] = null;
  if (typeof json.volta === 'object' && json.volta !== null) {
    const v = json.volta as Record<string, unknown>;
    volta = {
      node: typeof v.node === 'string' ? v.node : null,
      npm: typeof v.npm === 'string' ? v.npm : null,
      yarn: typeof v.yarn === 'string' ? v.yarn : null
    };
  }

  return { name, version, dependencies, devDependencies, workspacesDetected, volta };
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}
