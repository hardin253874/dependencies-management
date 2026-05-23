/**
 * MD + HTML renderer unit tests (Stage 4 / §9.3 downloads).
 *
 * Pure-function assertions on the output strings — no filesystem.
 */
import { describe, it, expect } from 'vitest';
import {
  renderUpdateReportMd,
  renderUpdateReportHtml,
  renderDeepUpdateReportMd,
  renderDeepUpdateReportHtml
} from '@/lib/reports/render';
import type {
  DeepUpdateReportDetail,
  RelatedUpgradeDetail,
  UpdateReportDetail,
  UsageDetail
} from '@/lib/api-types';

const META = {
  slug: 'my-app-abc',
  name: 'react',
  generatedAt: '2026-05-23T10:00:00Z',
  source: 'anthropic:claude-opus-4-7'
};

const FIXTURE_D: UpdateReportDetail = {
  fromVersion: '18.3.1',
  toVersion: '19.0.0',
  summary: 'React 19 introduces concurrent rendering improvements.',
  riskLevel: 'medium',
  resolverCheck: {
    kind: 'enabled',
    wouldResolve: true,
    conflicts: [],
    legacyPeerDepsUsed: false
  },
  coUpgradeDeps: [
    {
      name: 'react-dom',
      currentVersion: '18.3.1',
      suggestedVersion: '19.0.0',
      required: true,
      reason: 'peer-dep',
      explanation: 'Lockstep with react.'
    }
  ],
  breakingChanges: [
    {
      title: 'New JSX transform',
      description: 'TS configs must enable `react-jsx`.',
      affectsFilesInProject: true
    }
  ],
  filesToModify: [
    { path: 'src/App.tsx', brief: 'Update JSX runtime', estimatedChangeSize: 'small' }
  ],
  recommendations: ['Run tests after upgrade'],
  cost: {
    inputTokens: 1234,
    outputTokens: 567,
    model: 'claude-opus-4-7',
    costEstimateUsd: 0.0123
  }
};

const FIXTURE_DEEP: DeepUpdateReportDetail = {
  fromVersion: '17.0.2',
  toVersion: '19.0.0',
  lockfileStateHashShort: 'abc12',
  summary: 'Deep summary',
  riskLevel: 'high',
  narrative:
    'First paragraph of narrative.\n\nSecond paragraph with more depth.',
  estimatedEffort: 'large',
  lockfileSummary: {
    totalPackages: 1500,
    packagesByDirectDep: { react: 12 },
    peerDepsOnTarget: [
      {
        package: 'react-router',
        version: '6.0.0',
        peerRange: '^17.0.0',
        satisfiedByCandidate: false
      }
    ]
  },
  transitiveDelta: {
    packagesAdded: [{ name: 'new-pkg', version: '1.0.0' }],
    packagesRemoved: [],
    packagesUpgraded: []
  },
  cveDelta: {
    newCves: [
      {
        id: 'CVE-2026-0001',
        package: 'foo',
        severity: 'high',
        summary: 'XSS in foo'
      }
    ],
    resolvedCves: [
      {
        id: 'CVE-2024-9999',
        package: 'bar',
        severity: 'medium',
        summary: 'DoS in bar'
      }
    ]
  },
  criticalBlockers: [
    {
      title: 'react-router peer conflict',
      description: 'react-router 6.0.0 requires react ^17.0.0',
      package: 'react-router'
    }
  ],
  suggestedUpgradeOrder: [
    { step: 1, action: 'Upgrade react-router', rationale: 'Resolves peer constraint' },
    { step: 2, action: 'Upgrade react', rationale: 'Target dep' }
  ],
  resolverCheck: {
    kind: 'disabled',
    reason: 'failure',
    failureMessage: 'Resolver run failed: no npm binary'
  },
  coUpgradeDeps: []
};

describe('renderUpdateReportMd', () => {
  it('contains the heading, version line, and risk level', () => {
    const md = renderUpdateReportMd(META, FIXTURE_D);
    expect(md).toContain('# Update Report — react');
    expect(md).toContain('**Upgrade:** 18.3.1 → 19.0.0');
    expect(md).toContain('**Risk:** medium');
    expect(md).toContain('## Resolver Check');
    expect(md).toContain('Would resolve cleanly');
  });

  it('renders the co-upgrade table', () => {
    const md = renderUpdateReportMd(META, FIXTURE_D);
    expect(md).toContain('## Co-Upgrade Dependencies');
    expect(md).toContain('react-dom');
    expect(md).toContain('| Package | Current | Suggested | Required | Reason | Explanation |');
  });

  it('renders breaking changes and files-to-modify', () => {
    const md = renderUpdateReportMd(META, FIXTURE_D);
    expect(md).toContain('### New JSX transform');
    expect(md).toContain('## Files to Modify');
    expect(md).toContain('`src/App.tsx`');
  });

  it('renders cost block', () => {
    const md = renderUpdateReportMd(META, FIXTURE_D);
    expect(md).toContain('## Cost');
    expect(md).toContain('claude-opus-4-7');
    expect(md).toContain('1234 in / 567 out');
    expect(md).toContain('$0.012300');
  });
});

describe('renderUpdateReportHtml', () => {
  it('emits valid-looking HTML envelope', () => {
    const html = renderUpdateReportHtml(META, FIXTURE_D);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<title>Update Report — react');
    expect(html).toContain('<h1>Update Report — react');
    expect(html).toContain('</body></html>');
    expect(html).toContain('class="risk-medium"');
  });

  it('escapes HTML in user content', () => {
    const malicious: UpdateReportDetail = {
      ...FIXTURE_D,
      summary: '<script>alert(1)</script>',
      breakingChanges: [
        { title: '<img onerror=x>', description: '"quotes"', affectsFilesInProject: true }
      ]
    };
    const html = renderUpdateReportHtml(META, malicious);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img onerror=x&gt;');
    expect(html).toContain('&quot;quotes&quot;');
  });

  it('renders the disabled resolver banner when kind=disabled', () => {
    const disabledFixture: UpdateReportDetail = {
      ...FIXTURE_D,
      resolverCheck: { kind: 'disabled', reason: 'kill-switch' }
    };
    const html = renderUpdateReportHtml(META, disabledFixture);
    expect(html).toContain('class="disabled-banner"');
    expect(html).toContain('Kill-switch');
  });
});

// ---------------------------------------------------------------------------
// Extended report — related deps upgrade + their usage (new sections)
// ---------------------------------------------------------------------------

const RELATED_UPGRADE: RelatedUpgradeDetail = {
  viewedDep: 'react',
  fromVersion: '18.3.1',
  toVersion: '19.0.0',
  globalNotes:
    'Upgrade react-dom in lockstep. Bump @types/react to track the major.',
  recommendations: [
    {
      name: 'react-dom',
      installedVersion: '18.3.1',
      relations: [{ kind: 'inbound-peer-dep', range: '^18.0.0', satisfiedAtTarget: false }],
      deterministicVerdict: 'breaks',
      action: 'upgrade',
      suggestedVersion: '19.0.0',
      severity: 'major',
      migrationNotes: 'Lockstep with react.',
      confidence: 'high'
    },
    {
      name: '@types/react',
      installedVersion: '18.0.0',
      relations: [{ kind: 'naming', range: null, satisfiedAtTarget: null }],
      deterministicVerdict: 'unknown',
      action: 'upgrade',
      suggestedVersion: '19.x',
      severity: 'major',
      migrationNotes: 'Track react major.',
      confidence: 'medium'
    },
    {
      name: 'lodash',
      installedVersion: '4.17.21',
      relations: [],
      deterministicVerdict: 'compatible',
      action: 'keep',
      suggestedVersion: null,
      severity: 'none',
      migrationNotes: '',
      confidence: 'high'
    }
  ]
};

const RELATED_UPGRADE_META = {
  generatedAt: '2026-05-24T01:00:00Z',
  source: 'anthropic:claude-opus-4-7'
};

const RELATED_USAGE: Record<string, UsageDetail> = {
  'react-dom': {
    files: [
      {
        path: 'src/index.tsx',
        pathHash: 'aaa111',
        category: 'prod',
        importStatements: ["import ReactDOM from 'react-dom'"],
        importCount: 1
      }
    ],
    dynamicImports: [],
    totalFiles: 1,
    declaredButUnused: false,
    oversizedSkipped: []
  },
  '@types/react': {
    files: [],
    dynamicImports: [],
    totalFiles: 0,
    declaredButUnused: true,
    oversizedSkipped: []
  }
  // Note: `lodash` deliberately missing — renderer must show stub.
};

describe('renderUpdateReportMd with extended context', () => {
  it('omits the related-deps sections when no extras provided', () => {
    const md = renderUpdateReportMd(META, FIXTURE_D);
    expect(md).not.toContain('## Related Deps Upgrade Impact');
    expect(md).not.toContain('## Related Deps Usage');
  });

  it('renders the related-deps upgrade table when relatedUpgrade is provided', () => {
    const md = renderUpdateReportMd(META, FIXTURE_D, {
      relatedUpgrade: RELATED_UPGRADE,
      relatedUpgradeMeta: RELATED_UPGRADE_META
    });
    expect(md).toContain('## Related Deps Upgrade Impact');
    expect(md).toContain('| Dep | Installed | Action | Target | Severity | Confidence | Notes |');
    expect(md).toContain('react-dom');
    expect(md).toContain('19.0.0');
    expect(md).toContain('Track react major.');
    expect(md).toContain('Bump @types/react to track the major.');
  });

  it('renders related-deps usage with file lists, "unused", and missing-cache stubs', () => {
    const md = renderUpdateReportMd(META, FIXTURE_D, {
      relatedUpgrade: RELATED_UPGRADE,
      relatedUpgradeMeta: RELATED_UPGRADE_META,
      relatedUsage: RELATED_USAGE
    });
    expect(md).toContain('## Related Deps Usage');
    // react-dom: file list rendered
    expect(md).toContain('### `react-dom` — 1 file used');
    expect(md).toContain('`src/index.tsx`');
    // @types/react: marked unused
    expect(md).toContain('### `@types/react` — _unused_');
    // lodash: no usage cache → stub
    expect(md).toContain('### `lodash`');
    expect(md).toContain('No usage cache. Run the related-deps usage scan in view [C].');
  });
});

describe('renderUpdateReportHtml with extended context', () => {
  it('omits the related-deps sections when no extras provided', () => {
    const html = renderUpdateReportHtml(META, FIXTURE_D);
    expect(html).not.toContain('Related Deps Upgrade Impact');
    expect(html).not.toContain('Related Deps Usage');
  });

  it('renders the related-deps upgrade table when relatedUpgrade is provided', () => {
    const html = renderUpdateReportHtml(META, FIXTURE_D, {
      relatedUpgrade: RELATED_UPGRADE,
      relatedUpgradeMeta: RELATED_UPGRADE_META
    });
    expect(html).toContain('<h2>Related Deps Upgrade Impact</h2>');
    expect(html).toContain('<th>Dep</th>');
    expect(html).toContain('<code>react-dom</code>');
    expect(html).toContain('Track react major.');
    // Action pills color-coded via class.
    expect(html).toContain('class="good">keep</td>');
    expect(html).toContain('class="risk-medium">upgrade</td>');
  });

  it('renders related-deps usage HTML with file lists + unused tag + missing stub', () => {
    const html = renderUpdateReportHtml(META, FIXTURE_D, {
      relatedUpgrade: RELATED_UPGRADE,
      relatedUpgradeMeta: RELATED_UPGRADE_META,
      relatedUsage: RELATED_USAGE
    });
    expect(html).toContain('<h2>Related Deps Usage</h2>');
    expect(html).toContain('<code>react-dom</code> — 1 file used');
    expect(html).toContain('src/index.tsx');
    expect(html).toContain('<code>@types/react</code> — <em>unused</em>');
    expect(html).toContain('No usage cache.');
  });

  it('escapes HTML in related-dep migration notes (XSS guard)', () => {
    const malicious: RelatedUpgradeDetail = {
      ...RELATED_UPGRADE,
      globalNotes: '<script>alert(1)</script>',
      recommendations: [
        {
          ...RELATED_UPGRADE.recommendations[0]!,
          migrationNotes: '<img onerror=x>'
        }
      ]
    };
    const html = renderUpdateReportHtml(META, FIXTURE_D, {
      relatedUpgrade: malicious,
      relatedUpgradeMeta: RELATED_UPGRADE_META
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img onerror=x&gt;');
  });
});

describe('renderDeepUpdateReportMd', () => {
  it('renders all main sections', () => {
    const md = renderDeepUpdateReportMd(META, FIXTURE_DEEP);
    expect(md).toContain('# Deep Update Report — react');
    expect(md).toContain('**Risk:** high');
    expect(md).toContain('**Estimated Effort:** large');
    expect(md).toContain('**Lockfile state:** abc12');
    expect(md).toContain('## Lockfile Summary');
    expect(md).toContain('## Transitive Delta');
    expect(md).toContain('## CVE Delta');
    expect(md).toContain('## Critical Blockers');
    expect(md).toContain('## Suggested Upgrade Order');
  });

  it('shows the peer-dep table with satisfaction column', () => {
    const md = renderDeepUpdateReportMd(META, FIXTURE_DEEP);
    expect(md).toContain('| react-router | 6.0.0 | ^17.0.0 | NO |');
  });

  it('lists new vs resolved CVEs', () => {
    const md = renderDeepUpdateReportMd(META, FIXTURE_DEEP);
    expect(md).toContain('### New CVEs');
    expect(md).toContain('CVE-2026-0001');
    expect(md).toContain('### Resolved CVEs');
    expect(md).toContain('CVE-2024-9999');
  });
});

describe('renderDeepUpdateReportHtml', () => {
  it('produces parseable HTML with peer-deps table', () => {
    const html = renderDeepUpdateReportHtml(META, FIXTURE_DEEP);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<h1>Deep Update Report — react</h1>');
    expect(html).toContain('class="risk-high"');
    expect(html).toContain('<code>react-router</code>');
    expect(html).toContain('<span class="bad">NO</span>');
    expect(html).toContain('CVE-2026-0001');
  });

  it('splits multi-paragraph narrative into <p> blocks', () => {
    const html = renderDeepUpdateReportHtml(META, FIXTURE_DEEP);
    expect(html).toContain('<p>First paragraph of narrative.</p>');
    expect(html).toContain('<p>Second paragraph with more depth.</p>');
  });
});
