/**
 * Co-upgrade candidate algorithm (spec §11.5).
 *
 * Computes the union of three sources of "deps that probably need to move
 * with the target":
 *   (a) Packages in the same project whose `peerDependencies` declare the
 *       target dep.
 *   (b) Packages in the baked-in common-pairing static table.
 *   (c) Packages whose installed version's peer range explicitly does NOT
 *       satisfy the candidate target version (via `semver.satisfies`).
 *
 * Inputs the algorithm needs but doesn't fetch itself:
 *   - For each direct dep: its installed version's `peerDependencies`
 *     (fetched from the registry packument).
 *   - For the target dep at `toVersion`: its `peerDependencies` (also from
 *     the packument).
 *
 * Callers (the view [D] route handler) gather these and pass them in. This
 * function is pure — no network, no filesystem — so it's trivial to unit-test.
 *
 * Output is the candidate list that flows into the LLM input contract. The
 * LLM categorizes `required` vs `optional` and writes the explanation; the
 * algorithm provides the raw candidate set deterministically.
 */
import semver from 'semver';
import type { CoUpgradeCandidate } from './prompts/update-report';

/**
 * Static common-pairing map (spec §11.5 + §13 iteration point #8).
 *
 * Initial educated guesses; refine as we observe real upgrades. Keys are the
 * target dep name; values are packages typically upgraded together.
 *
 * IMPORTANT: this is a v0 sketch. Treat the list as "always candidate" — the
 * LLM still decides `required` vs `optional`.
 */
export const COMMON_PAIRING_MAP: Record<string, readonly string[]> = {
  react: ['react-dom', '@types/react', 'react-router'],
  next: ['react', 'react-dom', 'eslint-config-next'],
  jest: ['@types/jest', 'ts-jest'],
  vite: ['@vitejs/plugin-react']
};

export interface InstalledDep {
  name: string;
  installedVersion: string | null;
  /** peerDependencies declared by this dep's installed version. */
  peerDependencies?: Record<string, string>;
}

export interface CoUpgradeInput {
  /** The dep being upgraded. */
  targetName: string;
  /** Target candidate version. */
  toVersion: string;
  /**
   * peerDependencies declared by the target dep AT toVersion. Used for
   * source (a) — "which packages in my project does this target list as
   * peer deps?" Inverted: we check if the candidate target lists OTHER packages
   * AS peers. Stage 3 v0 reads from the target's own peer-deps (i.e., what
   * the candidate target version says it needs alongside it).
   *
   * Note: spec §11.5 (a) is "packages in the same project whose
   * peerDependencies declare the target dep". That's the *direct deps' peerDeps
   * → target* direction. We compute both for source coverage.
   */
  targetPeerDependenciesAtTo?: Record<string, string>;
  /** All direct deps from `project.json`. */
  directDeps: InstalledDep[];
}

export interface CoUpgradeOutput {
  candidates: CoUpgradeCandidate[];
  /** Per-candidate source attribution — helpful for debugging + tests. */
  sources: Record<string, CoUpgradeSource[]>;
}

export type CoUpgradeSource = 'peer-dep' | 'common-pairing' | 'peer-range-conflict';

export function computeCoUpgradeCandidates(input: CoUpgradeInput): CoUpgradeOutput {
  // Map<name, { sources, peerRange }>.
  const acc = new Map<string, { sources: Set<CoUpgradeSource>; declaredPeerDepRange: string | null }>();

  const targetName = input.targetName;
  const directByName = new Map(input.directDeps.map((d) => [d.name, d]));

  // Source (a): direct deps whose peerDependencies declare the target dep.
  for (const dep of input.directDeps) {
    if (dep.name === targetName) continue;
    const peer = dep.peerDependencies?.[targetName];
    if (peer !== undefined) {
      addSource(acc, dep.name, 'peer-dep', peer);
    }
  }

  // Source (a'): direct deps named in the target's own peer-deps (post-toVersion).
  // The candidate target version may declare new peer deps that need to land
  // in lockstep. e.g. react@19 may say `react-dom: ^19`.
  if (input.targetPeerDependenciesAtTo !== undefined) {
    for (const [peerName, peerRange] of Object.entries(input.targetPeerDependenciesAtTo)) {
      if (peerName === targetName) continue;
      if (directByName.has(peerName)) {
        addSource(acc, peerName, 'peer-dep', peerRange);
      }
    }
  }

  // Source (b): common pairing.
  const pairings = COMMON_PAIRING_MAP[targetName] ?? [];
  for (const pairedName of pairings) {
    if (pairedName === targetName) continue;
    if (directByName.has(pairedName)) {
      // Carry forward whatever peer range we already recorded; null otherwise.
      const existing = acc.get(pairedName);
      addSource(acc, pairedName, 'common-pairing', existing?.declaredPeerDepRange ?? null);
    }
  }

  // Source (c): packages whose installed version's peer range CANNOT be
  // satisfied by the target's toVersion. (Conflict means: must co-upgrade.)
  // The peer range is the one captured in source (a). If we know the range,
  // we test it.
  for (const [name, entry] of acc.entries()) {
    if (entry.declaredPeerDepRange === null) continue;
    if (!isValidPeerRange(entry.declaredPeerDepRange)) continue;
    const satisfies = semver.satisfies(input.toVersion, entry.declaredPeerDepRange, { includePrerelease: true });
    if (!satisfies) {
      entry.sources.add('peer-range-conflict');
    }
    void name;
  }

  // Build output sorted by name for determinism (tests + cache key stability).
  const sortedNames = Array.from(acc.keys()).sort();
  const candidates: CoUpgradeCandidate[] = sortedNames.map((name) => ({
    name,
    currentVersion: directByName.get(name)?.installedVersion ?? null,
    declaredPeerDepRange: acc.get(name)!.declaredPeerDepRange
  }));
  const sources: Record<string, CoUpgradeSource[]> = {};
  for (const name of sortedNames) {
    sources[name] = Array.from(acc.get(name)!.sources).sort();
  }

  return { candidates, sources };
}

function addSource(
  acc: Map<string, { sources: Set<CoUpgradeSource>; declaredPeerDepRange: string | null }>,
  name: string,
  source: CoUpgradeSource,
  peerRange: string | null
): void {
  let entry = acc.get(name);
  if (entry === undefined) {
    entry = { sources: new Set(), declaredPeerDepRange: peerRange };
    acc.set(name, entry);
  } else if (entry.declaredPeerDepRange === null && peerRange !== null) {
    entry.declaredPeerDepRange = peerRange;
  }
  entry.sources.add(source);
}

function isValidPeerRange(range: string): boolean {
  // The `semver` package treats some strings (e.g. `*`, `latest`) as valid
  // ranges but they're trivially satisfied. We still attempt validRange so
  // a malformed peer range doesn't crash the algorithm.
  try {
    return semver.validRange(range, { includePrerelease: true, loose: true }) !== null;
  } catch {
    return false;
  }
}
