'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import type { FsEntry, FsValidationResponse } from '@/lib/api-types';
import { Button } from './Button';
import styles from './Picker.module.css';

interface PickerProps {
  initialPath?: string;
  onChange: (path: string) => void;
  /** Notify parent when validation state changes (used to enable Submit). */
  onValidation: (result: FsValidationResponse | null) => void;
}

const VALIDATE_DEBOUNCE = 400;

export function Picker({
  initialPath = '',
  onChange,
  onValidation
}: PickerProps): JSX.Element {
  const [path, setPath] = useState(initialPath);
  const [showTree, setShowTree] = useState(false);
  const [validation, setValidation] = useState<FsValidationResponse | null>(null);
  const [validating, setValidating] = useState(false);
  const [autocomplete, setAutocomplete] = useState<FsEntry[]>([]);
  const [acIndex, setAcIndex] = useState(-1);
  const validateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Each new validate / autocomplete supersedes any in-flight request via an
  // AbortController; on unmount, the cleanup below aborts whatever is still
  // pending. Addresses Stage 1 Major finding M2.
  const validateAbortRef = useRef<AbortController | null>(null);
  const acAbortRef = useRef<AbortController | null>(null);

  const runValidate = useCallback(
    async (next: string) => {
      if (!next || !next.trim()) {
        setValidation(null);
        onValidation(null);
        return;
      }
      // Cancel any prior inflight validate before issuing the next one.
      validateAbortRef.current?.abort();
      const controller = new AbortController();
      validateAbortRef.current = controller;
      setValidating(true);
      try {
        const res = await getApiClient().validateFs(next, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setValidation(res);
        onValidation(res);
      } catch (err) {
        if (controller.signal.aborted || (err as Error).name === 'AbortError') return;
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Validation failed';
        const failure: FsValidationResponse = {
          ok: false,
          code: 'PATH_NOT_FOUND',
          message
        };
        setValidation(failure);
        onValidation(failure);
      } finally {
        if (!controller.signal.aborted) {
          setValidating(false);
        }
      }
    },
    [onValidation]
  );

  const runAutocomplete = useCallback(async (next: string) => {
    if (!next) {
      setAutocomplete([]);
      return;
    }
    acAbortRef.current?.abort();
    const controller = new AbortController();
    acAbortRef.current = controller;
    try {
      // Look up children of the parent directory of the typed value.
      // Crude but matches the wireframe behavior — full path with suggestions
      // showing similar siblings/children.
      const candidate = next.replace(/\\/g, '/');
      const slash = candidate.lastIndexOf('/');
      const parent = slash >= 0 ? candidate.slice(0, slash) || '/' : candidate;
      const res = await getApiClient().listFs(parent, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const prefix = candidate.toLowerCase();
      const filtered = res.entries
        .filter((e) => e.isDirectory && e.path.toLowerCase().startsWith(prefix))
        .slice(0, 8);
      setAutocomplete(filtered);
    } catch {
      if (!controller.signal.aborted) setAutocomplete([]);
    }
  }, []);

  const handleInputChange = (next: string) => {
    setPath(next);
    onChange(next);
    setAcIndex(-1);
    if (validateTimer.current) clearTimeout(validateTimer.current);
    validateTimer.current = setTimeout(() => void runValidate(next), VALIDATE_DEBOUNCE);
    if (acTimer.current) clearTimeout(acTimer.current);
    acTimer.current = setTimeout(() => void runAutocomplete(next), 200);
  };

  const selectAutocomplete = (entry: FsEntry) => {
    setPath(entry.path);
    onChange(entry.path);
    setAutocomplete([]);
    void runValidate(entry.path);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (autocomplete.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAcIndex((prev) => Math.min(autocomplete.length - 1, prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAcIndex((prev) => Math.max(-1, prev - 1));
    } else if (e.key === 'Enter' && acIndex >= 0) {
      e.preventDefault();
      selectAutocomplete(autocomplete[acIndex]!);
    } else if (e.key === 'Escape') {
      setAutocomplete([]);
    }
  };

  useEffect(() => {
    return () => {
      if (validateTimer.current) clearTimeout(validateTimer.current);
      if (acTimer.current) clearTimeout(acTimer.current);
      // Abort any in-flight validate / autocomplete on unmount so state is not
      // updated after the component is gone (Stage 1 carry-over M2).
      validateAbortRef.current?.abort();
      acAbortRef.current?.abort();
    };
  }, []);

  return (
    <div className={styles.picker}>
      <div className={styles.row}>
        <label className={styles.label}>
          <span className={styles.labelText}>Project folder path</span>
          <input
            type="text"
            value={path}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="C:\\Users\\you\\projects\\my-app"
            className={styles.input}
            spellCheck={false}
            autoComplete="off"
            data-testid="picker-input"
          />
        </label>
        <Button onClick={() => setShowTree((v) => !v)}>
          {showTree ? 'Hide tree' : 'Browse'}
        </Button>
      </div>

      {autocomplete.length > 0 && (
        <ul className={styles.autocomplete} role="listbox">
          {autocomplete.map((entry, i) => (
            <li
              role="option"
              aria-selected={i === acIndex}
              key={entry.path}
              className={[styles.acItem, i === acIndex ? styles.acItemActive : '']
                .filter(Boolean)
                .join(' ')}
              onMouseDown={(e) => {
                e.preventDefault();
                selectAutocomplete(entry);
              }}
            >
              <span aria-hidden="true">▸ </span>
              {entry.path}
            </li>
          ))}
        </ul>
      )}

      {showTree && (
        <TreeBrowser
          onSelect={(p) => {
            setPath(p);
            onChange(p);
            void runValidate(p);
          }}
        />
      )}

      <ValidationDisplay validation={validation} validating={validating} />
    </div>
  );
}

function ValidationDisplay({
  validation,
  validating
}: {
  validation: FsValidationResponse | null;
  validating: boolean;
}): JSX.Element | null {
  if (validating) {
    return <p className={styles.statusInfo}>Checking path…</p>;
  }
  if (!validation) return null;
  if (validation.ok) {
    return (
      <p className={styles.statusOk}>
        ✓ {validation.message}
        {validation.warning ? ` — ${validation.warning}` : ''}
      </p>
    );
  }
  return <p className={styles.statusError}>{validation.message}</p>;
}

interface TreeNodeState {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  expanded: Set<string>;
  loading: Set<string>;
  childrenByPath: Map<string, FsEntry[]>;
}

function TreeBrowser({
  onSelect
}: {
  onSelect: (path: string) => void;
}): JSX.Element {
  const [state, setState] = useState<TreeNodeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        // Empty path → backend returns top-level filesystem roots (drives on
        // Windows, '/' on Unix). Each root then expands like a normal folder.
        const res = await getApiClient().listFs('');
        setState({
          path: res.path,
          parent: res.parent,
          entries: res.entries.filter((e) => e.isDirectory),
          expanded: new Set(),
          loading: new Set(),
          childrenByPath: new Map()
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load filesystem');
      }
    })();
  }, []);

  const toggle = useCallback(async (path: string) => {
    setState((prev) => {
      if (!prev) return prev;
      const expanded = new Set(prev.expanded);
      if (expanded.has(path)) {
        expanded.delete(path);
        return { ...prev, expanded };
      }
      expanded.add(path);
      return { ...prev, expanded };
    });

    setState((prev) => {
      if (!prev) return prev;
      if (prev.childrenByPath.has(path)) return prev;
      const loading = new Set(prev.loading);
      loading.add(path);
      return { ...prev, loading };
    });

    try {
      const res = await getApiClient().listFs(path);
      setState((prev) => {
        if (!prev) return prev;
        const next = new Map(prev.childrenByPath);
        next.set(
          path,
          res.entries.filter((e) => e.isDirectory)
        );
        const loading = new Set(prev.loading);
        loading.delete(path);
        return { ...prev, childrenByPath: next, loading };
      });
    } catch {
      setState((prev) => {
        if (!prev) return prev;
        const loading = new Set(prev.loading);
        loading.delete(path);
        return { ...prev, loading };
      });
    }
  }, []);

  if (error) {
    return <p className={styles.statusError}>{error}</p>;
  }
  if (!state) {
    return <p className={styles.statusInfo}>Loading filesystem…</p>;
  }

  // When `state.path === ''` the backend returned filesystem roots (drives on
  // Windows, '/' on Unix). Render each root as its own top-level row so the
  // user can navigate into any drive. For any other path we keep the
  // single-root render (one expandable parent + its children) so re-rooting
  // the tree at a specific folder still works.
  const isRootsView = state.path === '';

  return (
    <div role="tree" className={styles.tree} aria-label="Filesystem">
      {isRootsView ? (
        state.entries.map((entry) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            expanded={state.expanded}
            loading={state.loading}
            nodeChildren={state.childrenByPath}
            depth={0}
            onToggle={toggle}
            onSelect={onSelect}
          />
        ))
      ) : (
        <TreeRow
          entry={{ name: state.path, path: state.path, isDirectory: true }}
          expanded={state.expanded}
          loading={state.loading}
          nodeChildren={state.childrenByPath}
          depth={0}
          onToggle={toggle}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

interface TreeRowProps {
  entry: FsEntry;
  expanded: Set<string>;
  loading: Set<string>;
  /** Cached children keyed by parent path. Named to avoid the React `children` prop. */
  nodeChildren: Map<string, FsEntry[]>;
  depth: number;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

function TreeRow({
  entry,
  expanded,
  loading,
  nodeChildren,
  depth,
  onToggle,
  onSelect
}: TreeRowProps): JSX.Element {
  const isExpanded = expanded.has(entry.path);
  const isLoading = loading.has(entry.path);
  const childList = nodeChildren.get(entry.path);

  return (
    <div
      role="treeitem"
      aria-expanded={isExpanded}
      aria-selected={false}
      aria-level={depth + 1}
    >
      <div className={styles.treeRow} style={{ paddingLeft: depth * 16 }}>
        <button
          type="button"
          className={styles.treeChevron}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
          onClick={() => onToggle(entry.path)}
        >
          <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
        </button>
        <button
          type="button"
          className={styles.treeName}
          onClick={() => onSelect(entry.path)}
          title={entry.path}
        >
          {entry.name}
        </button>
      </div>
      {isExpanded && (
        <div role="group">
          {isLoading && <p className={styles.statusInfo}>Loading…</p>}
          {childList?.map((child) => (
            <TreeRow
              key={child.path}
              entry={child}
              expanded={expanded}
              loading={loading}
              nodeChildren={nodeChildren}
              depth={depth + 1}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
