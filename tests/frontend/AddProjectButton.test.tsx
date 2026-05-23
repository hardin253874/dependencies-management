import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddProjectButton } from '@/components/LeftPanel/AddProjectButton';

describe('AddProjectButton', () => {
  it('renders text label when expanded', () => {
    render(<AddProjectButton collapsed={false} onClick={vi.fn()} />);
    expect(screen.getByText('Add project')).toBeInTheDocument();
  });

  it('renders icon-only when collapsed', () => {
    render(<AddProjectButton collapsed={true} onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add project' })).toBeInTheDocument();
  });

  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(<AddProjectButton collapsed={false} onClick={onClick} />);
    await userEvent.click(screen.getByTestId('add-project-button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
