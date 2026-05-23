/**
 * Peer-dep satisfaction algorithm (spec §11.6).
 *
 * For each transitive package whose `peerDependencies` declare the target dep,
 * parse the peer-dep semver range and compute
 * `semver.satisfies(candidateTargetVersion, peerRange)`.
 *
 * The output is pre-attached to the LLM input contract — the LLM narrates only,
 * it does NOT compute. This is the deterministic-first principle from §3.4.
 *
 * Pure function; no I/O. Caller resolves the (name, version) pairs + their
 * peer-dep maps from a packument or lockfile parse upstream.
 */
import semver from 'semver';
import type { PeerDepOnTarget } from '../api-types';

export interface PeerDepSatInput {
  /** Name of the dep being upgraded. */
  targetName: string;
  /** Candidate post-upgrade version. */
  candidateTargetVersion: string;
  /** Transitive packages from the lockfile to inspect, with their peer-dep maps. */
  transitives: Array<{
    name: string;
    version: string;
    /** peerDependencies declared by this package's installed version. */
    peerDependencies?: Record<string, string>;
  }>;
}

export function computePeerDepSatisfaction(input: PeerDepSatInput): PeerDepOnTarget[] {
  const out: PeerDepOnTarget[] = [];
  for (const t of input.transitives) {
    const peer = t.peerDependencies?.[input.targetName];
    if (peer === undefined) continue;
    let satisfied = false;
    try {
      const valid = semver.validRange(peer, { loose: true, includePrerelease: true });
      if (valid !== null) {
        satisfied = semver.satisfies(input.candidateTargetVersion, valid, {
          includePrerelease: true
        });
      }
    } catch {
      satisfied = false;
    }
    out.push({
      package: t.name,
      version: t.version,
      peerRange: peer,
      satisfiedByCandidate: satisfied
    });
  }
  // Deterministic ordering so the LLM input + cache key are stable.
  out.sort((a, b) => {
    if (a.package !== b.package) return a.package.localeCompare(b.package);
    if (a.version !== b.version) return a.version.localeCompare(b.version);
    return a.peerRange.localeCompare(b.peerRange);
  });
  return out;
}
