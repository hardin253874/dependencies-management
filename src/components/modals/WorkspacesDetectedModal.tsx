'use client';

import { Modal } from './Modal';
import { Button } from './Button';

interface Props {
  open: boolean;
  onProceed: () => void;
  onCancel: () => void;
}

export function WorkspacesDetectedModal({
  open,
  onProceed,
  onCancel
}: Props): JSX.Element | null {
  return (
    <Modal
      open={open}
      title="Workspaces detected"
      onClose={onCancel}
      closeOnEsc={true}
      nested
      maxWidth={420}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button tone="primary" onClick={onProceed}>
            Proceed
          </Button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 'var(--line-height-normal)' }}>
        The selected project declares <code>workspaces</code> in its{' '}
        <code>package.json</code>.
      </p>
      <p style={{ margin: 'var(--space-2) 0 0', lineHeight: 'var(--line-height-normal)' }}>
        v1 will analyze only the root <code>package.json</code>. Sub-packages will not
        be analyzed.
      </p>
    </Modal>
  );
}
