import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoltaInfoCard } from '@/components/MiddlePanel/VoltaInfoCard';

describe('VoltaInfoCard', () => {
  it('renders node + npm versions for an npm project', () => {
    render(
      <VoltaInfoCard
        volta={{ node: '18.19.0', npm: '10.2.3', yarn: null }}
        packageManager="npm"
      />
    );
    expect(screen.getByText('Volta toolchain')).toBeInTheDocument();
    expect(screen.getByText('Node 18.19.0 · npm 10.2.3')).toBeInTheDocument();
  });

  it('falls back to em-dash when node is missing', () => {
    render(
      <VoltaInfoCard
        volta={{ node: null, npm: null, yarn: null }}
        packageManager="npm"
      />
    );
    expect(screen.getByText(/Node —/)).toBeInTheDocument();
  });
});
