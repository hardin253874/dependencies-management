import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DependencyRow } from '@/components/MiddlePanel/DependencyRow';

describe('DependencyRow', () => {
  const dep = {
    name: 'react',
    section: 'dependencies' as const,
    declaredRange: '^18.2.0',
    installedVersion: '18.2.0',
    badges: {
      outdatedSeverity: null,
      hasCve: null,
      deprecated: false,
      lastScannedAt: null
    }
  };

  it('renders name, declared range and installed version', () => {
    render(<DependencyRow dep={dep} active={false} onClick={vi.fn()} />);
    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.getByText('^18.2.0')).toBeInTheDocument();
    expect(screen.getByText('18.2.0')).toBeInTheDocument();
  });

  it('uses aria-pressed=true when active', () => {
    render(<DependencyRow dep={dep} active={true} onClick={vi.fn()} />);
    const row = screen.getByTestId('dep-row-react');
    expect(row).toHaveAttribute('aria-pressed', 'true');
  });

  it('emits onClick when selected', async () => {
    const onClick = vi.fn();
    render(<DependencyRow dep={dep} active={false} onClick={onClick} />);
    await userEvent.click(screen.getByTestId('dep-row-react'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
