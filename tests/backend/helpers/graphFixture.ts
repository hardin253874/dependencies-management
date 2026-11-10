/**
 * Graph fixtures (V2_STAGE3_SPEC 3a fixture convention).
 *
 * Fixtures live in `test-fixtures/graph/<name>/`. Git ignores `node_modules/`
 * and `.env` at any depth, and a committed `.gitignore` inside a fixture would
 * hide the fixture's own files from git. So fixtures store `_node_modules/`
 * and `_gitignore`, and this helper renames them while copying into the
 * sandbox. Tests never build a graph on the committed fixture folder itself.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Sandbox } from './sandbox';

export const GRAPH_FIXTURES_ROOT = path.join(process.cwd(), 'test-fixtures', 'graph');

const RENAMES: Readonly<Record<string, string>> = Object.freeze({
  _node_modules: 'node_modules',
  _gitignore: '.gitignore'
});

export interface GraphFixture {
  projectRoot: string;
  /** Under `sandbox.libraryRoot`, never inside the project root. */
  dbPath: string;
}

async function renameMarkers(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const target = RENAMES[entry.name];
    const finalPath = target === undefined ? full : path.join(dir, target);
    if (target !== undefined) await fs.rename(full, finalPath);
    if (entry.isDirectory()) await renameMarkers(finalPath);
  }
}

export async function copyGraphFixture(sandbox: Sandbox, name: string, as: string = name): Promise<GraphFixture> {
  const src = path.join(GRAPH_FIXTURES_ROOT, name);
  const projectRoot = path.join(await sandbox.scratch(), as);
  await fs.cp(src, projectRoot, { recursive: true });
  await renameMarkers(projectRoot);
  return { projectRoot, dbPath: path.join(sandbox.libraryRoot, as, 'graph.db') };
}

/** Writes a file (creating parent dirs) under the project root. Test setup only. */
export async function writeProjectFile(projectRoot: string, rel: string, content: string | Buffer): Promise<void> {
  const full = path.join(projectRoot, ...rel.split('/'));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}
