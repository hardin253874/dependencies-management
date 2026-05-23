'use client';

import { useAppContext } from '../AppContext';
import { buildBreadcrumb } from '@/lib/client/routes';
import { Breadcrumb } from './Breadcrumb';
import { DependencyDetailView } from './DependencyDetailView';
import { VersionMappingView } from './VersionMappingView';
import { UsageView } from './UsageView';
import { UpdateReportView } from './UpdateReportView';
import { DeepUpdateReportView } from './DeepUpdateReportView';
import { FileReviewView } from './FileReviewView';
import styles from './DetailPanel.module.css';

/**
 * Right-panel container. Owns the breadcrumb + view switch; each view body
 * owns its own chrome (freshness line, regenerate button) because the
 * regenerate target endpoint varies per view.
 */
export function DetailPanel(): JSX.Element {
  const { activeProjectSlug, detailRoute, navigate, activeDepName } = useAppContext();

  if (!activeProjectSlug) {
    return <EmptyState message="Pick a project to see details." />;
  }

  if (!detailRoute) {
    return (
      <EmptyState
        message={
          activeDepName
            ? `No view for ${activeDepName}.`
            : 'Pick a dependency to see details.'
        }
      />
    );
  }

  const segments = buildBreadcrumb(detailRoute);

  return (
    <div className={styles.wrap}>
      <div className={styles.chrome}>
        <Breadcrumb segments={segments} onNavigate={navigate} />
      </div>
      <div className={styles.scroll}>
        {detailRoute.kind === 'A' && (
          <DependencyDetailView slug={activeProjectSlug} depName={detailRoute.depName} />
        )}
        {detailRoute.kind === 'B' && (
          <VersionMappingView
            slug={activeProjectSlug}
            depName={detailRoute.depName}
            version={detailRoute.version}
          />
        )}
        {detailRoute.kind === 'C' && (
          <UsageView slug={activeProjectSlug} depName={detailRoute.depName} />
        )}
        {detailRoute.kind === 'D' && (
          <UpdateReportView
            slug={activeProjectSlug}
            depName={detailRoute.depName}
            fromVersion={detailRoute.fromVersion}
            toVersion={detailRoute.toVersion}
          />
        )}
        {detailRoute.kind === 'D-deep' && (
          <DeepUpdateReportView
            slug={activeProjectSlug}
            depName={detailRoute.depName}
            fromVersion={detailRoute.fromVersion}
            toVersion={detailRoute.toVersion}
          />
        )}
        {detailRoute.kind === 'E' && (
          <FileReviewView
            slug={activeProjectSlug}
            depName={detailRoute.depName}
            pathHash={detailRoute.pathHash}
            filePath={detailRoute.filePath}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }): JSX.Element {
  return (
    <div className={styles.empty} role="status">
      {message}
    </div>
  );
}
