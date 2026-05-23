/**
 * Reads and writes `library/_projects.json`. This file holds the registry of
 * all registered target projects. It is NOT wrapped in an envelope (per §8.3).
 */
import { atomicWriteJson, readJson, pathExists } from './atomic';
import { projectsFilePath } from '../paths';

export type PackageManager = 'npm' | 'yarn-classic' | 'yarn-berry';

export interface ProjectRegistryEntry {
  slug: string;
  name: string;
  absolutePath: string;
  packageManager: PackageManager;
  addedAt: string;
  workspacesDetected: boolean;
}

export interface ProjectsRegistry {
  schemaVersion: 1;
  projects: ProjectRegistryEntry[];
}

const EMPTY: ProjectsRegistry = { schemaVersion: 1, projects: [] };

export async function readProjects(): Promise<ProjectsRegistry> {
  const fp = projectsFilePath();
  if (!(await pathExists(fp))) return { ...EMPTY, projects: [] };
  const raw = await readJson<ProjectsRegistry>(fp);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.projects)) {
    throw new Error(`Invalid _projects.json shape`);
  }
  return raw;
}

export async function writeProjects(reg: ProjectsRegistry): Promise<void> {
  await atomicWriteJson(projectsFilePath(), reg);
}

export async function addProject(entry: ProjectRegistryEntry): Promise<ProjectsRegistry> {
  const reg = await readProjects();
  reg.projects.push(entry);
  await writeProjects(reg);
  return reg;
}

export async function removeProject(slug: string): Promise<ProjectsRegistry> {
  const reg = await readProjects();
  reg.projects = reg.projects.filter((p) => p.slug !== slug);
  await writeProjects(reg);
  return reg;
}

export async function findBySlug(slug: string): Promise<ProjectRegistryEntry | null> {
  const reg = await readProjects();
  return reg.projects.find((p) => p.slug === slug) ?? null;
}

export async function findByPath(absolutePath: string): Promise<ProjectRegistryEntry | null> {
  const reg = await readProjects();
  return reg.projects.find((p) => p.absolutePath === absolutePath) ?? null;
}

export async function updateProject(
  slug: string,
  patch: Partial<Omit<ProjectRegistryEntry, 'slug'>>
): Promise<ProjectRegistryEntry> {
  const reg = await readProjects();
  const idx = reg.projects.findIndex((p) => p.slug === slug);
  if (idx === -1) throw new Error(`Project not found: ${slug}`);
  reg.projects[idx] = { ...reg.projects[idx]!, ...patch };
  await writeProjects(reg);
  return reg.projects[idx]!;
}
