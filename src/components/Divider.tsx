'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './Divider.module.css';

interface DividerProps {
  orientation: 'vertical' | 'horizontal';
  ariaLabel: string;
  ariaControls?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}

const KEY_STEP = 8;
const KEY_STEP_BIG = 32;

export function Divider({
  orientation,
  ariaLabel,
  ariaControls,
  value,
  min,
  max,
  step = 1,
  disabled = false,
  onChange
}: DividerProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ pointer: number; value: number } | null>(null);

  const clamp = useCallback(
    (next: number) => Math.max(min, Math.min(max, Math.round(next / step) * step)),
    [min, max, step]
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      setDragging(true);
      startRef.current = {
        pointer: orientation === 'vertical' ? event.clientX : event.clientY,
        value
      };
    },
    [orientation, value, disabled]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!startRef.current) return;
      const pointer = orientation === 'vertical' ? event.clientX : event.clientY;
      const delta = pointer - startRef.current.pointer;
      onChange(clamp(startRef.current.value + delta));
    },
    [orientation, onChange, clamp]
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
      startRef.current = null;
      setDragging(false);
    },
    []
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      let next = value;
      const big = event.shiftKey;
      const stepAmount = big ? KEY_STEP_BIG : KEY_STEP;
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          next = value - stepAmount;
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          next = value + stepAmount;
          break;
        case 'Home':
          next = min;
          break;
        case 'End':
          next = max;
          break;
        default:
          return;
      }
      event.preventDefault();
      onChange(clamp(next));
    },
    [value, min, max, disabled, onChange, clamp]
  );

  // Ensure value stays in range when min/max change (e.g., on collapse).
  useEffect(() => {
    const clamped = clamp(value);
    if (clamped !== value) onChange(clamped);
  }, [value, clamp, onChange]);

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className={[
        styles.divider,
        orientation === 'vertical' ? styles.vertical : styles.horizontal,
        dragging ? styles.dragging : '',
        disabled ? styles.disabled : ''
      ]
        .filter(Boolean)
        .join(' ')}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={handleKeyDown}
    />
  );
}
