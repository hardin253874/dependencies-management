import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '@/components/modals/Modal';

describe('Modal', () => {
  it('renders when open and uses dialog role', () => {
    render(
      <Modal open={true} title="Hello" onClose={vi.fn()}>
        Body
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <Modal open={false} title="Hello" onClose={vi.fn()}>
        Body
      </Modal>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls onClose when Esc is pressed', async () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} title="Hello" onClose={onClose}>
        Body
      </Modal>
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    render(
      <Modal open={true} title="Hello" onClose={onClose}>
        Body
      </Modal>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
