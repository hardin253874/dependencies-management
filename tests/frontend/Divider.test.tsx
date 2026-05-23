import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Divider } from '@/components/Divider';

describe('Divider', () => {
  it('renders with separator role and orientation', () => {
    render(
      <Divider
        orientation="vertical"
        ariaLabel="Resize left"
        value={200}
        min={100}
        max={400}
        onChange={vi.fn()}
      />
    );
    const sep = screen.getByRole('separator', { name: 'Resize left' });
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    expect(sep).toHaveAttribute('aria-valuenow', '200');
  });

  it('arrow keys adjust the value by 8px', async () => {
    const onChange = vi.fn();
    render(
      <Divider
        orientation="vertical"
        ariaLabel="Resize"
        value={200}
        min={100}
        max={400}
        onChange={onChange}
      />
    );
    const sep = screen.getByRole('separator');
    sep.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith(208);
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith(192);
  });

  it('Shift+Arrow adjusts by 32px', async () => {
    const onChange = vi.fn();
    render(
      <Divider
        orientation="vertical"
        ariaLabel="Resize"
        value={200}
        min={100}
        max={400}
        onChange={onChange}
      />
    );
    const sep = screen.getByRole('separator');
    sep.focus();
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(onChange).toHaveBeenLastCalledWith(232);
  });

  it('clamps to min on Home', async () => {
    const onChange = vi.fn();
    render(
      <Divider
        orientation="vertical"
        ariaLabel="Resize"
        value={200}
        min={100}
        max={400}
        onChange={onChange}
      />
    );
    const sep = screen.getByRole('separator');
    sep.focus();
    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith(100);
  });
});
