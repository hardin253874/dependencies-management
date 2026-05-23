/**
 * Markdown + HTML renderers for [D] and [D-Deep] reports (Stage 4 / §9.3 downloads).
 *
 * Design:
 *   - Pure functions, no I/O. Input is the persisted detail; output is a string.
 *   - No external dependencies — handwritten emitters keep the bundle slim and
 *     output deterministic (important for testing).
 *   - HTML is single-file with inline CSS so the user can open it in a browser
 *     or print it without any external assets.
 *
 * Spec references:
 *   - §7.6 view contents drive section ordering
 *   - §9.3 download endpoints + 404 NOT_CACHED contract are handled by the
 *     route handler; this module only renders
 */
import type {
  CveDeltaEntry,
  CveRecord,
  DeepCriticalBlocker,
  DeepUpdateReportDetail,
  DeepUpgradeStep,
  PeerDepOnTarget,
  RelatedDepUpgradeRecommendation,
  RelatedUpgradeDetail,
  ResolverCheckBlock,
  UpdateReportDetail,
  UsageDetail
} from '../api-types';

/**
 * Optional companion-cache inputs accepted by the [D] renderers. Each is
 * best-effort: when the download route can't find the cached envelope, it
 * passes `undefined` and the renderer simply omits that section.
 *
 *  - `relatedUpgrade`  → drives the "Related deps upgrade impact" section
 *    (the cached `RelatedUpgradeDetail` for this `(name, from→to)` pair).
 *  - `relatedUsage`    → map keyed by related dep name with each dep's
 *    cached `UsageDetail`. Drives the per-related-dep file-list section.
 *  - `relatedUpgradeMeta` → generatedAt + source from the envelope wrapping
 *    the related-upgrade payload, so the downloaded report can report its
 *    provenance.
 */
export interface ExtendedReportContext {
  relatedUpgrade?: RelatedUpgradeDetail;
  relatedUpgradeMeta?: { generatedAt: string; source: string };
  relatedUsage?: Record<string, UsageDetail>;
}

// ---------------------------------------------------------------------------
// HTML escape
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Markdown — [D] Update Report
// ---------------------------------------------------------------------------

export function renderUpdateReportMd(
  meta: { slug: string; name: string; generatedAt: string; source: string },
  detail: UpdateReportDetail,
  extras: ExtendedReportContext = {}
): string {
  const lines: string[] = [];
  lines.push(`# Update Report — ${meta.name}`);
  lines.push('');
  lines.push(`**Upgrade:** ${detail.fromVersion} → ${detail.toVersion}`);
  lines.push(`**Risk:** ${detail.riskLevel}`);
  lines.push(`**Generated:** ${meta.generatedAt}`);
  lines.push(`**Source:** ${meta.source}`);
  lines.push('');
  if (detail.summary !== '') {
    lines.push('## Summary');
    lines.push('');
    lines.push(detail.summary);
    lines.push('');
  }
  lines.push('## Resolver Check');
  lines.push('');
  lines.push(resolverMd(detail.resolverCheck));
  lines.push('');

  if (detail.coUpgradeDeps.length > 0) {
    lines.push('## Co-Upgrade Dependencies');
    lines.push('');
    lines.push('| Package | Current | Suggested | Required | Reason | Explanation |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const dep of detail.coUpgradeDeps) {
      lines.push(
        `| ${mdCell(dep.name)} | ${mdCell(dep.currentVersion)} | ${mdCell(dep.suggestedVersion)} | ${dep.required ? 'yes' : 'no'} | ${mdCell(dep.reason)} | ${mdCell(dep.explanation)} |`
      );
    }
    lines.push('');
  }

  if (detail.breakingChanges.length > 0) {
    lines.push('## Breaking Changes');
    lines.push('');
    for (const b of detail.breakingChanges) {
      lines.push(`### ${b.title}`);
      lines.push('');
      lines.push(b.description);
      lines.push('');
      lines.push(`*Affects files in project: ${b.affectsFilesInProject ? 'yes' : 'no'}*`);
      lines.push('');
    }
  }

  if (detail.filesToModify.length > 0) {
    lines.push('## Files to Modify');
    lines.push('');
    for (const f of detail.filesToModify) {
      lines.push(`- \`${f.path}\` (${f.estimatedChangeSize}): ${f.brief}`);
    }
    lines.push('');
  }

  if (detail.recommendations.length > 0) {
    lines.push('## Recommendations');
    lines.push('');
    for (const r of detail.recommendations) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  // --- Related deps upgrade impact ----------------------------------------
  if (extras.relatedUpgrade !== undefined) {
    appendRelatedUpgradeMd(lines, extras.relatedUpgrade, extras.relatedUpgradeMeta);
  }

  // --- Related deps usage --------------------------------------------------
  // Driven by the related-upgrade recommendations list (canonical name set);
  // for each name we look up its cached UsageDetail and emit either the
  // file list, "declared but unused", or "no usage cache" gracefully.
  if (extras.relatedUpgrade !== undefined && extras.relatedUsage !== undefined) {
    appendRelatedUsageMd(lines, extras.relatedUpgrade.recommendations, extras.relatedUsage);
  }

  if (detail.cost !== undefined) {
    lines.push('## Cost');
    lines.push('');
    lines.push(`Model: ${detail.cost.model}`);
    lines.push(`Tokens: ${detail.cost.inputTokens} in / ${detail.cost.outputTokens} out`);
    lines.push(`Estimated cost: $${detail.cost.costEstimateUsd.toFixed(6)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function appendRelatedUpgradeMd(
  lines: string[],
  detail: RelatedUpgradeDetail,
  meta: ExtendedReportContext['relatedUpgradeMeta']
): void {
  lines.push('## Related Deps Upgrade Impact');
  lines.push('');
  if (meta !== undefined) {
    lines.push(`_Generated ${meta.generatedAt} · source: ${meta.source}_`);
    lines.push('');
  }
  if (detail.globalNotes !== '') {
    lines.push(`> ${detail.globalNotes.split('\n').join('\n> ')}`);
    lines.push('');
  }
  if (detail.recommendations.length === 0) {
    lines.push('_No related deps detected._');
    lines.push('');
    return;
  }
  lines.push('| Dep | Installed | Action | Target | Severity | Confidence | Notes |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of detail.recommendations) {
    lines.push(
      `| ${mdCell(r.name)} | ${mdCell(r.installedVersion ?? '—')} | ${r.action} | ${mdCell(r.suggestedVersion ?? '—')} | ${r.severity} | ${r.confidence} | ${mdCell(r.migrationNotes)} |`
    );
  }
  lines.push('');
}

function appendRelatedUsageMd(
  lines: string[],
  recs: ReadonlyArray<RelatedDepUpgradeRecommendation>,
  usage: Record<string, UsageDetail>
): void {
  lines.push('## Related Deps Usage');
  lines.push('');
  if (recs.length === 0) {
    lines.push('_No related deps detected._');
    lines.push('');
    return;
  }
  for (const r of recs) {
    const u = usage[r.name];
    if (u === undefined) {
      lines.push(`### \`${r.name}\``);
      lines.push('');
      lines.push('_No usage cache. Run the related-deps usage scan in view [C]._');
      lines.push('');
      continue;
    }
    if (u.declaredButUnused) {
      lines.push(`### \`${r.name}\` — _unused_`);
      lines.push('');
      lines.push('Declared but unused: no imports found anywhere in the project.');
      lines.push('');
      continue;
    }
    lines.push(`### \`${r.name}\` — ${u.totalFiles} file${u.totalFiles === 1 ? '' : 's'} used`);
    lines.push('');
    for (const f of u.files) {
      lines.push(`- \`${f.path}\` _[${f.category}]_ — ${f.importCount} import${f.importCount === 1 ? '' : 's'}`);
    }
    lines.push('');
  }
}

function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function resolverMd(block: ResolverCheckBlock): string {
  if (block.kind === 'disabled') {
    let reason = 'unknown';
    if (block.reason === 'kill-switch') reason = 'kill-switch (Settings → Behavior)';
    else if (block.reason === 'yarn') reason = 'Yarn projects not supported in v1';
    else if (block.reason === 'failure') reason = `failure: ${block.failureMessage ?? 'unknown'}`;
    return `_Disabled — ${reason}_`;
  }
  if (block.wouldResolve) {
    return `Would resolve cleanly${block.legacyPeerDepsUsed ? ' (required --legacy-peer-deps)' : ''}.`;
  }
  const parts: string[] = ['**Conflicts:**', ''];
  for (const c of block.conflicts) {
    parts.push(`- \`${c.package}\`: ${c.reason}`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown — [D-Deep] Deep Update Report
// ---------------------------------------------------------------------------

export function renderDeepUpdateReportMd(
  meta: { slug: string; name: string; generatedAt: string; source: string },
  detail: DeepUpdateReportDetail
): string {
  const lines: string[] = [];
  lines.push(`# Deep Update Report — ${meta.name}`);
  lines.push('');
  lines.push(`**Upgrade:** ${detail.fromVersion} → ${detail.toVersion}`);
  lines.push(`**Risk:** ${detail.riskLevel}`);
  lines.push(`**Estimated Effort:** ${detail.estimatedEffort}`);
  lines.push(`**Lockfile state:** ${detail.lockfileStateHashShort}`);
  lines.push(`**Generated:** ${meta.generatedAt}`);
  lines.push(`**Source:** ${meta.source}`);
  lines.push('');
  if (detail.summary !== '') {
    lines.push('## Summary');
    lines.push('');
    lines.push(detail.summary);
    lines.push('');
  }
  if (detail.narrative !== '') {
    lines.push('## Narrative');
    lines.push('');
    lines.push(detail.narrative);
    lines.push('');
  }

  lines.push('## Lockfile Summary');
  lines.push('');
  lines.push(`- Total packages: ${detail.lockfileSummary.totalPackages}`);
  lines.push(
    `- Packages declaring peer-dep on ${meta.name}: ${detail.lockfileSummary.peerDepsOnTarget.length}`
  );
  lines.push('');
  if (detail.lockfileSummary.peerDepsOnTarget.length > 0) {
    lines.push('| Package | Version | Peer Range | Satisfied by candidate |');
    lines.push('| --- | --- | --- | --- |');
    for (const p of detail.lockfileSummary.peerDepsOnTarget) {
      lines.push(
        `| ${mdCell(p.package)} | ${mdCell(p.version)} | ${mdCell(p.peerRange)} | ${p.satisfiedByCandidate ? 'yes' : 'NO'} |`
      );
    }
    lines.push('');
  }

  lines.push('## Transitive Delta');
  lines.push('');
  lines.push(`- Added:    ${detail.transitiveDelta.packagesAdded.length}`);
  lines.push(`- Removed:  ${detail.transitiveDelta.packagesRemoved.length}`);
  lines.push(`- Upgraded: ${detail.transitiveDelta.packagesUpgraded.length}`);
  lines.push('');

  lines.push('## CVE Delta');
  lines.push('');
  lines.push(`- Resolved by upgrade: ${detail.cveDelta.resolvedCves.length}`);
  lines.push(`- New CVEs introduced: ${detail.cveDelta.newCves.length}`);
  lines.push('');
  if (detail.cveDelta.newCves.length > 0) {
    lines.push('### New CVEs');
    lines.push('');
    for (const c of detail.cveDelta.newCves) {
      lines.push(`- ${c.id} (${c.severity}) in ${c.package}: ${c.summary}`);
    }
    lines.push('');
  }
  if (detail.cveDelta.resolvedCves.length > 0) {
    lines.push('### Resolved CVEs');
    lines.push('');
    for (const c of detail.cveDelta.resolvedCves) {
      lines.push(`- ${c.id} (${c.severity}) in ${c.package}: ${c.summary}`);
    }
    lines.push('');
  }

  if (detail.criticalBlockers.length > 0) {
    lines.push('## Critical Blockers');
    lines.push('');
    for (const b of detail.criticalBlockers) {
      lines.push(`### ${b.title} (${b.package})`);
      lines.push('');
      lines.push(b.description);
      lines.push('');
    }
  }

  if (detail.suggestedUpgradeOrder.length > 0) {
    lines.push('## Suggested Upgrade Order');
    lines.push('');
    for (const s of detail.suggestedUpgradeOrder) {
      lines.push(`${s.step}. ${s.action} — _${s.rationale}_`);
    }
    lines.push('');
  }

  lines.push('## Resolver Check');
  lines.push('');
  lines.push(resolverMd(detail.resolverCheck));
  lines.push('');

  if (detail.cost !== undefined) {
    lines.push('## Cost');
    lines.push('');
    lines.push(`Model: ${detail.cost.model}`);
    lines.push(`Tokens: ${detail.cost.inputTokens} in / ${detail.cost.outputTokens} out`);
    lines.push(`Estimated cost: $${detail.cost.costEstimateUsd.toFixed(6)}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTML — [D]
// ---------------------------------------------------------------------------

const HTML_BASE_CSS = `
:root { color-scheme: light; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 880px;
       margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; line-height: 1.55; }
h1 { font-size: 1.85rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.3rem; margin-top: 2rem; border-bottom: 1px solid #e5e5ea; padding-bottom: 0.25rem; }
h3 { font-size: 1.05rem; margin-top: 1.25rem; }
table { border-collapse: collapse; width: 100%; margin: 0.75rem 0 1rem; }
th, td { border: 1px solid #e5e5ea; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.95rem; }
th { background: #f5f5f7; }
code { background: #f5f5f7; padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.92em; }
.meta { color: #6e6e73; margin-bottom: 1.5rem; }
.meta strong { color: #1d1d1f; }
.risk-low { color: #34c759; }
.risk-medium { color: #ff9500; }
.risk-high { color: #ff3b30; }
.risk-critical { color: #ff3b30; font-weight: bold; }
.bad { color: #ff3b30; }
.good { color: #34c759; }
ul { margin-top: 0.5rem; }
li { margin-bottom: 0.25rem; }
section { margin-bottom: 1.25rem; }
.disabled-banner { background: #fff5e6; border: 1px solid #ff9500; padding: 0.6rem 0.85rem; border-radius: 5px; }
.conflict-list { padding-left: 1.25rem; }
.cost { color: #6e6e73; font-size: 0.9rem; }
`;

export function renderUpdateReportHtml(
  meta: { slug: string; name: string; generatedAt: string; source: string },
  detail: UpdateReportDetail,
  extras: ExtendedReportContext = {}
): string {
  const parts: string[] = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en"><head>');
  parts.push('<meta charset="utf-8"/>');
  parts.push(`<title>Update Report — ${esc(meta.name)} ${esc(detail.fromVersion)} → ${esc(detail.toVersion)}</title>`);
  parts.push(`<style>${HTML_BASE_CSS}</style>`);
  parts.push('</head><body>');
  parts.push(`<h1>Update Report — ${esc(meta.name)}</h1>`);
  parts.push('<div class="meta">');
  parts.push(`<strong>Upgrade:</strong> ${esc(detail.fromVersion)} &rarr; ${esc(detail.toVersion)}<br/>`);
  parts.push(`<strong>Risk:</strong> <span class="risk-${detail.riskLevel}">${esc(detail.riskLevel)}</span><br/>`);
  parts.push(`<strong>Generated:</strong> ${esc(meta.generatedAt)}<br/>`);
  parts.push(`<strong>Source:</strong> ${esc(meta.source)}`);
  parts.push('</div>');

  if (detail.summary !== '') {
    parts.push('<section><h2>Summary</h2>');
    parts.push(`<p>${esc(detail.summary)}</p></section>`);
  }

  parts.push('<section><h2>Resolver Check</h2>');
  parts.push(resolverHtml(detail.resolverCheck));
  parts.push('</section>');

  if (detail.coUpgradeDeps.length > 0) {
    parts.push('<section><h2>Co-Upgrade Dependencies</h2>');
    parts.push('<table><thead><tr><th>Package</th><th>Current</th><th>Suggested</th><th>Required</th><th>Reason</th><th>Explanation</th></tr></thead><tbody>');
    for (const d of detail.coUpgradeDeps) {
      parts.push(
        `<tr><td><code>${esc(d.name)}</code></td><td>${esc(d.currentVersion)}</td><td>${esc(d.suggestedVersion)}</td><td>${d.required ? '<span class="bad">yes</span>' : 'no'}</td><td>${esc(d.reason)}</td><td>${esc(d.explanation)}</td></tr>`
      );
    }
    parts.push('</tbody></table></section>');
  }

  if (detail.breakingChanges.length > 0) {
    parts.push('<section><h2>Breaking Changes</h2>');
    for (const b of detail.breakingChanges) {
      parts.push(`<h3>${esc(b.title)}</h3><p>${esc(b.description)}</p>`);
      parts.push(`<p class="meta"><em>Affects files in project: ${b.affectsFilesInProject ? '<span class="bad">yes</span>' : 'no'}</em></p>`);
    }
    parts.push('</section>');
  }

  if (detail.filesToModify.length > 0) {
    parts.push('<section><h2>Files to Modify</h2><ul>');
    for (const f of detail.filesToModify) {
      parts.push(`<li><code>${esc(f.path)}</code> <span class="meta">(${esc(f.estimatedChangeSize)})</span>: ${esc(f.brief)}</li>`);
    }
    parts.push('</ul></section>');
  }

  if (detail.recommendations.length > 0) {
    parts.push('<section><h2>Recommendations</h2><ul>');
    for (const r of detail.recommendations) parts.push(`<li>${esc(r)}</li>`);
    parts.push('</ul></section>');
  }

  if (extras.relatedUpgrade !== undefined) {
    appendRelatedUpgradeHtml(parts, extras.relatedUpgrade, extras.relatedUpgradeMeta);
  }

  if (extras.relatedUpgrade !== undefined && extras.relatedUsage !== undefined) {
    appendRelatedUsageHtml(parts, extras.relatedUpgrade.recommendations, extras.relatedUsage);
  }

  if (detail.cost !== undefined) {
    parts.push('<section class="cost"><h2>Cost</h2>');
    parts.push(`<p>Model: ${esc(detail.cost.model)} • Tokens: ${detail.cost.inputTokens} in / ${detail.cost.outputTokens} out • Estimated cost: $${detail.cost.costEstimateUsd.toFixed(6)}</p>`);
    parts.push('</section>');
  }

  parts.push('</body></html>');
  return parts.join('\n');
}

function appendRelatedUpgradeHtml(
  parts: string[],
  detail: RelatedUpgradeDetail,
  meta: ExtendedReportContext['relatedUpgradeMeta']
): void {
  parts.push('<section><h2>Related Deps Upgrade Impact</h2>');
  if (meta !== undefined) {
    parts.push(`<p class="meta">Generated ${esc(meta.generatedAt)} • source: ${esc(meta.source)}</p>`);
  }
  if (detail.globalNotes !== '') {
    parts.push(`<blockquote>${esc(detail.globalNotes)}</blockquote>`);
  }
  if (detail.recommendations.length === 0) {
    parts.push('<p class="meta">No related deps detected.</p>');
    parts.push('</section>');
    return;
  }
  parts.push(
    '<table><thead><tr><th>Dep</th><th>Installed</th><th>Action</th><th>Target</th><th>Severity</th><th>Confidence</th><th>Notes</th></tr></thead><tbody>'
  );
  for (const r of detail.recommendations) {
    const actionClass =
      r.action === 'keep' ? 'good' : r.action === 'upgrade' ? 'risk-medium' : 'meta';
    parts.push(
      `<tr><td><code>${esc(r.name)}</code></td><td>${esc(r.installedVersion ?? '—')}</td><td class="${actionClass}">${esc(r.action)}</td><td>${esc(r.suggestedVersion ?? '—')}</td><td>${esc(r.severity)}</td><td>${esc(r.confidence)}</td><td>${esc(r.migrationNotes)}</td></tr>`
    );
  }
  parts.push('</tbody></table></section>');
}

function appendRelatedUsageHtml(
  parts: string[],
  recs: ReadonlyArray<RelatedDepUpgradeRecommendation>,
  usage: Record<string, UsageDetail>
): void {
  parts.push('<section><h2>Related Deps Usage</h2>');
  if (recs.length === 0) {
    parts.push('<p class="meta">No related deps detected.</p>');
    parts.push('</section>');
    return;
  }
  for (const r of recs) {
    const u = usage[r.name];
    if (u === undefined) {
      parts.push(`<h3><code>${esc(r.name)}</code></h3>`);
      parts.push('<p class="meta">No usage cache. Run the related-deps usage scan in view [C].</p>');
      continue;
    }
    if (u.declaredButUnused) {
      parts.push(`<h3><code>${esc(r.name)}</code> — <em>unused</em></h3>`);
      parts.push('<p class="meta">Declared but unused: no imports found anywhere in the project.</p>');
      continue;
    }
    parts.push(
      `<h3><code>${esc(r.name)}</code> — ${u.totalFiles} file${u.totalFiles === 1 ? '' : 's'} used</h3>`
    );
    parts.push('<ul>');
    for (const f of u.files) {
      parts.push(
        `<li><code>${esc(f.path)}</code> <span class="meta">[${esc(f.category)}] — ${f.importCount} import${f.importCount === 1 ? '' : 's'}</span></li>`
      );
    }
    parts.push('</ul>');
  }
  parts.push('</section>');
}

function resolverHtml(block: ResolverCheckBlock): string {
  if (block.kind === 'disabled') {
    let reason = 'unknown';
    if (block.reason === 'kill-switch') reason = 'Kill-switch (Settings → Behavior)';
    else if (block.reason === 'yarn') reason = 'Yarn projects not supported in v1';
    else if (block.reason === 'failure') reason = `Failure: ${block.failureMessage ?? 'unknown'}`;
    return `<div class="disabled-banner">Resolver disabled — ${esc(reason)}</div>`;
  }
  if (block.wouldResolve) {
    const tag = block.legacyPeerDepsUsed ? ' (required --legacy-peer-deps)' : '';
    return `<p class="good">Would resolve cleanly${esc(tag)}.</p>`;
  }
  if (block.conflicts.length === 0) {
    return '<p class="bad">Would not resolve — no conflict detail captured.</p>';
  }
  const items = block.conflicts
    .map((c) => `<li><code>${esc(c.package)}</code>: ${esc(c.reason)}</li>`)
    .join('');
  return `<p class="bad">Conflicts:</p><ul class="conflict-list">${items}</ul>`;
}

// ---------------------------------------------------------------------------
// HTML — [D-Deep]
// ---------------------------------------------------------------------------

export function renderDeepUpdateReportHtml(
  meta: { slug: string; name: string; generatedAt: string; source: string },
  detail: DeepUpdateReportDetail
): string {
  const parts: string[] = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="en"><head>');
  parts.push('<meta charset="utf-8"/>');
  parts.push(`<title>Deep Update Report — ${esc(meta.name)} ${esc(detail.fromVersion)} → ${esc(detail.toVersion)}</title>`);
  parts.push(`<style>${HTML_BASE_CSS}</style>`);
  parts.push('</head><body>');
  parts.push(`<h1>Deep Update Report — ${esc(meta.name)}</h1>`);
  parts.push('<div class="meta">');
  parts.push(`<strong>Upgrade:</strong> ${esc(detail.fromVersion)} &rarr; ${esc(detail.toVersion)}<br/>`);
  parts.push(`<strong>Risk:</strong> <span class="risk-${detail.riskLevel}">${esc(detail.riskLevel)}</span><br/>`);
  parts.push(`<strong>Estimated Effort:</strong> ${esc(detail.estimatedEffort)}<br/>`);
  parts.push(`<strong>Lockfile state:</strong> <code>${esc(detail.lockfileStateHashShort)}</code><br/>`);
  parts.push(`<strong>Generated:</strong> ${esc(meta.generatedAt)}<br/>`);
  parts.push(`<strong>Source:</strong> ${esc(meta.source)}`);
  parts.push('</div>');

  if (detail.summary !== '') {
    parts.push('<section><h2>Summary</h2>');
    parts.push(`<p>${esc(detail.summary)}</p></section>`);
  }
  if (detail.narrative !== '') {
    parts.push('<section><h2>Narrative</h2>');
    for (const para of detail.narrative.split(/\n\n+/)) {
      parts.push(`<p>${esc(para)}</p>`);
    }
    parts.push('</section>');
  }

  parts.push('<section><h2>Lockfile Summary</h2>');
  parts.push(`<p>Total packages: ${detail.lockfileSummary.totalPackages}</p>`);
  parts.push(peerDepsTableHtml(detail.lockfileSummary.peerDepsOnTarget, meta.name));
  parts.push('</section>');

  parts.push('<section><h2>Transitive Delta</h2>');
  parts.push('<ul>');
  parts.push(`<li>Added: ${detail.transitiveDelta.packagesAdded.length}</li>`);
  parts.push(`<li>Removed: ${detail.transitiveDelta.packagesRemoved.length}</li>`);
  parts.push(`<li>Upgraded: ${detail.transitiveDelta.packagesUpgraded.length}</li>`);
  parts.push('</ul>');
  parts.push('</section>');

  parts.push('<section><h2>CVE Delta</h2>');
  parts.push(cveListHtml('New CVEs', detail.cveDelta.newCves, 'bad'));
  parts.push(cveListHtml('Resolved CVEs', detail.cveDelta.resolvedCves, 'good'));
  parts.push('</section>');

  if (detail.criticalBlockers.length > 0) {
    parts.push('<section><h2>Critical Blockers</h2>');
    for (const b of detail.criticalBlockers) {
      parts.push(`<h3>${esc(b.title)} <span class="meta">(${esc(b.package)})</span></h3>`);
      parts.push(`<p>${esc(b.description)}</p>`);
    }
    parts.push('</section>');
  }

  if (detail.suggestedUpgradeOrder.length > 0) {
    parts.push('<section><h2>Suggested Upgrade Order</h2><ol>');
    for (const s of detail.suggestedUpgradeOrder) {
      parts.push(`<li><strong>${esc(s.action)}</strong> — <em>${esc(s.rationale)}</em></li>`);
    }
    parts.push('</ol></section>');
  }

  parts.push('<section><h2>Resolver Check</h2>');
  parts.push(resolverHtml(detail.resolverCheck));
  parts.push('</section>');

  if (detail.cost !== undefined) {
    parts.push('<section class="cost"><h2>Cost</h2>');
    parts.push(`<p>Model: ${esc(detail.cost.model)} • Tokens: ${detail.cost.inputTokens} in / ${detail.cost.outputTokens} out • Estimated cost: $${detail.cost.costEstimateUsd.toFixed(6)}</p>`);
    parts.push('</section>');
  }

  parts.push('</body></html>');
  return parts.join('\n');
}

function peerDepsTableHtml(peers: PeerDepOnTarget[], targetName: string): string {
  if (peers.length === 0) {
    return `<p>No transitive packages declare a peer-dep on <code>${esc(targetName)}</code>.</p>`;
  }
  const rows = peers
    .map(
      (p) =>
        `<tr><td><code>${esc(p.package)}</code></td><td>${esc(p.version)}</td><td><code>${esc(p.peerRange)}</code></td><td>${p.satisfiedByCandidate ? '<span class="good">yes</span>' : '<span class="bad">NO</span>'}</td></tr>`
    )
    .join('');
  return `<table><thead><tr><th>Package</th><th>Version</th><th>Peer Range</th><th>Satisfied</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function cveListHtml(label: string, list: CveDeltaEntry[], cls: string): string {
  if (list.length === 0) return `<p>${esc(label)}: 0</p>`;
  const items = list
    .map((c) => `<li><strong>${esc(c.id)}</strong> (${esc(c.severity)}) in <code>${esc(c.package)}</code>: ${esc(c.summary)}</li>`)
    .join('');
  return `<h3 class="${cls}">${esc(label)} (${list.length})</h3><ul>${items}</ul>`;
}

// Reference unused type so lint doesn't complain about CveRecord import (used
// transitively by the api-types module).
void (null as unknown as CveRecord | undefined);
