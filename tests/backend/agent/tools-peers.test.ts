import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSandbox, type Sandbox } from '../helpers/sandbox';
import { buildAgentFixture, type BuiltFixture } from '../helpers/agentFixture';
import { writeProjectFile } from '../helpers/graphFixture';
import { createToolRegistry } from '@/core/agent/registry';
import { peerTools } from '@/core/agent/tools/peers';
import type { PackumentLike } from '@/core/agent/types';

let sandbox: Sandbox;
let fx: BuiltFixture;
const reg = createToolRegistry(peerTools());

const packument: PackumentLike = {
  name: 'react-dom',
  versions: {
    '18.2.0': {
      peerDependencies: { react: '^18.2.0', scheduler: '>=0.23', 'missing-peer': '^1.0.0' },
      peerDependenciesMeta: { 'missing-peer': { optional: true } }
    }
  }
};

beforeAll(async () => {
  sandbox = await createSandbox('agent-tools-peers');
  fx = await buildAgentFixture(sandbox, 'wrapper-module', {
    prepare: async (root) => {
      await writeProjectFile(root, 'package.json', JSON.stringify({ name: 'w', dependencies: { react: '^17.0.2', scheduler: '^0.23.0' } }));
      await writeProjectFile(root, 'node_modules/react/package.json', JSON.stringify({ name: 'react', version: '17.0.2' }));
    }
  });
}, 60_000);

afterAll(async () => {
  fx.graph.close();
  await sandbox.dispose();
});

describe('peer_requirements (4a.5)', () => {
  it('satisfied / unsatisfied / missing peers', async () => {
    const ctx = fx.ctx({ intel: { fetchPackument: async () => packument } });
    const r = await reg.call('peer_requirements', { pkg: 'react-dom', version: '18.2.0' }, ctx);
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual({
      pkg: 'react-dom',
      version: '18.2.0',
      peers: [
        { name: 'missing-peer', range: '^1.0.0', optional: true, declared: null, installed: null, satisfied: null },
        { name: 'react', range: '^18.2.0', optional: false, declared: '^17.0.2', installed: '17.0.2', satisfied: false },
        { name: 'scheduler', range: '>=0.23', optional: false, declared: '^0.23.0', installed: null, satisfied: true }
      ]
    });
  });

  it('registry timeout / failure → isError with a clear message, not a throw', async () => {
    const ctx = fx.ctx({
      intel: {
        fetchPackument: async () => {
          throw new Error('timeout after 15000 ms');
        }
      }
    });
    const r = await reg.call('peer_requirements', { pkg: 'react-dom', version: '18.2.0' }, ctx);
    expect(r).toEqual({ isError: true, truncated: false, content: 'peer_requirements failed: registry lookup for react-dom failed: timeout after 15000 ms' });
  });

  it('unknown version and no registry → isError', async () => {
    const withReg = fx.ctx({ intel: { fetchPackument: async () => packument } });
    expect((await reg.call('peer_requirements', { pkg: 'react-dom', version: '99.0.0' }, withReg)).content).toMatch(/not in the registry/);
    expect((await reg.call('peer_requirements', { pkg: 'react-dom', version: '18.2.0' }, fx.ctx())).content).toMatch(/not available/);
  });
});
