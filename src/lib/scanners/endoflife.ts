/**
 * endoflife.date client (spec §10.5.1).
 *
 * Public free API at `https://endoflife.date/api/<product>.json`. Returns an
 * array of release cycles per major version with EOL/LTS dates. Used to
 * enrich the "Related deps in this project" rows with EOL/LTS badges.
 *
 * Storage: project-independent. EOL data is global — one Node fetch serves
 * every project. Cached at `library/_endoflife/<slug>.json` with 7-day TTL.
 *
 * Failure mode: any HTTP / network error → returns `null` and logs at warn.
 * Callers MUST treat `null` as "untracked or unavailable" and degrade
 * gracefully (no eol badge on the row).
 */
import { promises as fs } from 'fs';
import path from 'path';
import semver from 'semver';
import { getLibraryRoot } from '../paths';
import { atomicWriteJson, pathExists } from '../storage/atomic';
import { readEnvelope, writeEnvelope } from '../storage/envelope';
import { getLogger } from '../logger';
import type { EolInfo, EolStatus, FileEnvelope } from '../api-types';

/**
 * Map npm package name → endoflife.date product slug.
 *
 * Initial set: the major frameworks + runtimes the user is most likely to
 * upgrade. Extensible; everything not on the map returns `null` and the row
 * simply lacks the EOL badge. ~95% of npm packages aren't tracked.
 */
const PRODUCT_SLUG_BY_NAME: Record<string, string> = {
  node: 'nodejs',
  nodejs: 'nodejs',
  npm: 'npm',
  yarn: 'yarn',
  next: 'nextjs',
  react: 'react',
  vue: 'vue',
  '@angular/core': 'angular',
  angular: 'angular',
  typescript: 'typescript',
  eslint: 'eslint',
  webpack: 'webpack',
  nuxt: 'nuxt'
};

const CACHE_TTL_HOURS = 24 * 7; // 7 days
const ENVELOPE_VERSION = 1;

/** A single cycle row from endoflife.date. We retain only the fields we use. */
interface EolCycle {
  /** Major version cycle string, e.g. '18' for Node 18.x. */
  cycle: string;
  releaseDate?: string;
  /** ISO date string, or `false` if not yet scheduled, or `true` if already EOL with no date. */
  eol?: string | boolean;
  /** ISO date string, or `false` if no LTS. */
  lts?: string | boolean;
  latest?: string;
}

interface EndoflifeData {
  slug: string;
  cycles: EolCycle[];
  fetchedAt: string;
}

/**
 * Return the endoflife slug for an npm name, or `null` if untracked.
 * Exported so tests / future ecosystem code can introspect the mapping.
 */
export function endoflifeSlugFor(npmName: string): string | null {
  return PRODUCT_SLUG_BY_NAME[npmName] ?? null;
}

/**
 * Fetch + cache the endoflife.date record for a tracked product. Returns
 * `null` for untracked names or on network failure (logs at warn).
 */
export async function getEndoflifeData(npmName: string): Promise<EndoflifeData | null> {
  const slug = endoflifeSlugFor(npmName);
  if (slug === null) return null;

  const cachePath = endoflifeCachePath(slug);
  if (await pathExists(cachePath)) {
    try {
      const env = await readEnvelope<EndoflifeData>(cachePath);
      const ageHours = (Date.now() - new Date(env.generatedAt).getTime()) / 36e5;
      if (ageHours < CACHE_TTL_HOURS) return env.data;
    } catch {
      // fall through to refetch
    }
  }

  try {
    const url = `https://endoflife.date/api/${slug}.json`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) {
      void logEolFailure(slug, `HTTP ${resp.status} ${resp.statusText}`);
      return null;
    }
    const raw = (await resp.json()) as EolCycle[];
    if (!Array.isArray(raw)) {
      void logEolFailure(slug, 'unexpected payload shape (not an array)');
      return null;
    }
    const data: EndoflifeData = {
      slug,
      cycles: raw,
      fetchedAt: new Date().toISOString()
    };
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await writeEnvelope<EndoflifeData>(cachePath, {
      schemaVersion: ENVELOPE_VERSION,
      source: 'endoflife.date',
      ttlHours: CACHE_TTL_HOURS,
      data
    });
    return data;
  } catch (err) {
    void logEolFailure(slug, (err as Error).message);
    return null;
  }
}

/**
 * Compute EOL/LTS status for a tracked dep given its installed version.
 *
 * Returns `null` when the name isn't tracked, the data fetch failed, the
 * installed version can't be parsed, or no matching cycle exists.
 */
export async function computeEolInfo(
  npmName: string,
  installedVersion: string | null
): Promise<EolInfo | null> {
  if (installedVersion === null) return null;
  const data = await getEndoflifeData(npmName);
  if (data === null) return null;
  const major = semver.coerce(installedVersion)?.major;
  if (major === undefined) return null;
  const cycle = data.cycles.find((c) => c.cycle === String(major));
  if (cycle === undefined) return null;

  return {
    cycle: cycle.cycle,
    eolDate: typeof cycle.eol === 'string' ? cycle.eol : null,
    status: statusOfCycle(cycle)
  };
}

function statusOfCycle(cycle: EolCycle): EolStatus {
  const now = Date.now();
  if (typeof cycle.releaseDate === 'string') {
    const releaseMs = Date.parse(cycle.releaseDate);
    if (!Number.isNaN(releaseMs) && releaseMs > now) return 'future';
  }
  if (typeof cycle.eol === 'string') {
    const eolMs = Date.parse(cycle.eol);
    if (!Number.isNaN(eolMs) && eolMs <= now) return 'eol';
  } else if (cycle.eol === true) {
    return 'eol';
  }
  if (typeof cycle.lts === 'string') {
    const ltsMs = Date.parse(cycle.lts);
    if (!Number.isNaN(ltsMs) && ltsMs <= now) return 'lts';
  }
  return 'active';
}

function endoflifeCachePath(slug: string): string {
  return path.join(getLibraryRoot(), '_endoflife', `${slug}.json`);
}

async function logEolFailure(slug: string, reason: string): Promise<void> {
  try {
    const log = await getLogger();
    log.warn(
      { source: 'endoflife.date', slug, reason },
      `endoflife.date fetch failed for ${slug}: ${reason}`
    );
  } catch {
    // logging must never throw
  }
}

/** Test hook — clear the cache directory. */
export async function clearEndoflifeCache(): Promise<void> {
  const dir = path.join(getLibraryRoot(), '_endoflife');
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
