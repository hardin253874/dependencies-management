'use client';

import { Modal } from './Modal';
import { Button } from './Button';
import { useAppContext } from '../AppContext';

/**
 * Spec §7.9 + WIREFRAMES.md Wireframe 27. Triggered from the StatusBar Cancel
 * button. Cost-disclosure line (verbatim) is shown only for AI jobs.
 *
 * Body copy (do NOT paraphrase the cost-disclosure line):
 *   Cancel '{{jobLabel}}'?
 *   Note: any tokens already consumed by the in-flight LLM call are billed.
 *   [ Keep running ]   [ Cancel job ]
 *
 * Per Apple-style restraint, the destructive action ("Cancel job") is a
 * secondary text-style button with red text — not a filled red button.
 */
export function CancelConfirmationModal(): JSX.Element | null {
  const { cancelRequest, clearCancelRequest, confirmCancel } = useAppContext();
  if (!cancelRequest) return null;

  return (
    <Modal
      open
      title={`Cancel '${cancelRequest.label}'?`}
      onClose={clearCancelRequest}
      closeOnEsc
      maxWidth={420}
      footer={
        <>
          <Button onClick={clearCancelRequest} data-testid="cancel-modal-keep">
            Keep running
          </Button>
          <Button
            tone="destructive"
            onClick={() => {
              void confirmCancel();
            }}
            data-testid="cancel-modal-confirm"
          >
            Cancel job
          </Button>
        </>
      }
    >
      {cancelRequest.isAi && (
        <p
          style={{ margin: 0, lineHeight: 'var(--line-height-normal)' }}
          data-testid="cancel-cost-disclosure"
        >
          Note: any tokens already consumed by the in-flight LLM call are billed.
        </p>
      )}
      {!cancelRequest.isAi && (
        <p
          style={{ margin: 0, lineHeight: 'var(--line-height-normal)' }}
          data-testid="cancel-deterministic-body"
        >
          The job will stop. Previously cached results are preserved.
        </p>
      )}
    </Modal>
  );
}
