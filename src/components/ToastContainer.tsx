'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppContext } from './AppContext';
import type { ToastItem } from './AppContext';
import styles from './ToastContainer.module.css';

const AUTO_DISMISS_MS = 8000;

/**
 * Bottom-right toast container (UI_DESIGN.md §2.7 / §7).
 * Each toast auto-dismisses after 8s (paused on hover). Up to 3 visible.
 */
export function ToastContainer(): JSX.Element | null {
  const { toasts, dismissToast, navigate } = useAppContext();

  if (typeof document === 'undefined') return null;
  if (toasts.length === 0) return null;

  return createPortal(
    <div
      role="region"
      aria-label="Notifications"
      className={styles.container}
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          toast={toast}
          onDismiss={() => dismissToast(toast.id)}
          onAction={() => {
            if (toast.action) {
              navigate(toast.action.route);
            }
            dismissToast(toast.id);
          }}
        />
      ))}
    </div>,
    document.body
  );
}

interface ToastProps {
  toast: ToastItem;
  onDismiss: () => void;
  onAction: () => void;
}

function Toast({ toast, onDismiss, onAction }: ToastProps): JSX.Element {
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useRef<number>(AUTO_DISMISS_MS);
  const startedAt = useRef<number>(Date.now());

  const start = () => {
    startedAt.current = Date.now();
    dismissTimer.current = setTimeout(onDismiss, remaining.current);
  };
  const pause = () => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
      remaining.current -= Date.now() - startedAt.current;
    }
  };

  useEffect(() => {
    start();
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAlert = toast.severity === 'warning' || toast.severity === 'error';

  return (
    <div
      role={isAlert ? 'alert' : 'status'}
      className={[styles.toast, styles[`sev_${toast.severity}`]].join(' ')}
      onMouseEnter={pause}
      onMouseLeave={start}
      data-testid={`toast-${toast.id}`}
    >
      <span aria-hidden="true" className={styles.glyph}>
        {toast.severity === 'success'
          ? '✓'
          : toast.severity === 'warning'
            ? '⚠'
            : toast.severity === 'error'
              ? '!'
              : 'i'}
      </span>
      <div className={styles.text}>
        <p className={styles.title}>{toast.title}</p>
        {toast.body && <p className={styles.body}>{toast.body}</p>}
      </div>
      {toast.action && (
        <button
          type="button"
          className={styles.action}
          onClick={onAction}
          data-testid={`toast-action-${toast.id}`}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss notification"
        className={styles.close}
        onClick={onDismiss}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
