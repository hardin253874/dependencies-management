'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Modal.module.css';

interface ModalProps {
  open: boolean;
  title: string;
  /** ID used for aria-labelledby. */
  titleId?: string;
  onClose: () => void;
  /** If true, Esc does nothing (used for Workspaces modal where Esc = Cancel button). */
  closeOnEsc?: boolean;
  /** If true, click on scrim closes the modal. */
  closeOnScrim?: boolean;
  /** Optional max-width override (px). */
  maxWidth?: number;
  /** Optional second-tier modal flag — darker scrim. */
  nested?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  title,
  titleId,
  onClose,
  closeOnEsc = true,
  closeOnScrim = false,
  maxWidth = 560,
  nested = false,
  children,
  footer
}: ModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Move focus to the first interactive element or the dialog itself.
    const focusable = dialog?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    (focusable ?? dialog)?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEsc) {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusables = dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose, closeOnEsc]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const labelId = titleId ?? `modal-title-${title.replace(/\s+/g, '-').toLowerCase()}`;

  return createPortal(
    <div
      className={[styles.scrim, nested ? styles.scrimNested : ''].filter(Boolean).join(' ')}
      onMouseDown={(e) => {
        if (closeOnScrim && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        className={styles.dialog}
        style={{ maxWidth }}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className={styles.header}>
          <h2 id={labelId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Close"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
