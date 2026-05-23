'use client';

import { useState, useCallback, useEffect } from 'react';
import type { DependencyEntry } from '@/lib/api-types';
import { PersistenceKeys, readLocal, writeLocal } from '@/lib/client/persistence';
import { DependencyRow } from './DependencyRow';
import styles from './DependencyList.module.css';

type GroupKey = 'volta' | 'dependencies' | 'devDependencies';

interface ExpandedGroups {
  volta: boolean;
  dependencies: boolean;
  devDependencies: boolean;
}

interface Props {
  groups: {
    volta: DependencyEntry[];
    dependencies: DependencyEntry[];
    devDependencies: DependencyEntry[];
  };
  activeDep: string | null;
  onSelectDep: (name: string) => void;
}

const DEFAULT_EXPANDED: ExpandedGroups = {
  volta: true,
  dependencies: true,
  devDependencies: true
};

const GROUP_ORDER: readonly GroupKey[] = ['volta', 'dependencies', 'devDependencies'] as const;

export function DependencyList({ groups, activeDep, onSelectDep }: Props): JSX.Element {
  const [expanded, setExpanded] = useState<ExpandedGroups>(() => {
    // Persistence may pre-date the `volta` group; merge with defaults so a
    // missing key reads as expanded rather than undefined.
    const persisted = readLocal<Partial<ExpandedGroups>>(
      PersistenceKeys.expandedGroups,
      DEFAULT_EXPANDED
    );
    return { ...DEFAULT_EXPANDED, ...persisted };
  });

  useEffect(() => {
    writeLocal(PersistenceKeys.expandedGroups, expanded);
  }, [expanded]);

  const toggle = useCallback((group: GroupKey) => {
    setExpanded((prev) => ({ ...prev, [group]: !prev[group] }));
  }, []);

  const total =
    groups.volta.length + groups.dependencies.length + groups.devDependencies.length;
  if (total === 0) {
    return (
      <div className={styles.empty} role="status">
        No dependencies declared in this project.
      </div>
    );
  }

  return (
    <div className={styles.scrollWrap}>
      {GROUP_ORDER.map((group) => {
        const rows = groups[group];
        if (rows.length === 0) return null;
        const isExpanded = expanded[group];
        return (
          <section key={group} className={styles.group}>
            <button
              type="button"
              className={styles.groupHeader}
              aria-expanded={isExpanded}
              onClick={() => toggle(group)}
            >
              <span aria-hidden="true" className={styles.chevron}>
                {isExpanded ? '▾' : '▸'}
              </span>
              <span className={styles.groupName}>{group}</span>
              <span className={styles.groupCount}>({rows.length})</span>
            </button>
            {isExpanded && (
              <ul role="list" className={styles.rowList}>
                {rows.map((dep) => (
                  <li role="listitem" key={`${dep.section}:${dep.name}`}>
                    <DependencyRow
                      dep={dep}
                      active={activeDep === dep.name}
                      onClick={() => onSelectDep(dep.name)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
