'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { ApiError, getApiClient } from '@/lib/client/api-client';
import type {
  ConfigResponse,
  JobOrphan,
  JobRecord,
  ProjectDetail,
  ProjectSummary
} from '@/lib/api-types';
import { PersistenceKeys, readLocal, writeLocal } from '@/lib/client/persistence';
import type { DetailRoute } from '@/lib/client/routes';

export type SettingsSection = 'llm' | 'library' | 'cache' | 'cost' | 'behavior' | 'about';
export type OnboardingStep = 'welcome' | 'llm' | 'add-project';

export interface ToastItem {
  id: string;
  severity: 'success' | 'info' | 'warning' | 'error';
  title: string;
  body?: string;
  action?: { label: string; route: DetailRoute };
}

/**
 * A cancel-request snapshot used by the StatusBar Cancel button + the
 * AppShell-level CancelConfirmationModal. When non-null, the modal renders;
 * when null, no cancel UX is in flight.
 */
export interface CancelRequest {
  jobId: string;
  label: string;
  /** True when the job is an AI generation (cost-disclosure copy required). */
  isAi: boolean;
}

interface UiState {
  sidebarCollapsed: boolean;
  panelWidths: { left: number; middle: number };
  activeProjectSlug: string | null;
  activeDepName: string | null;
  detailRoute: DetailRoute | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  addProjectOpen: boolean;
  onboardingActive: boolean;
  onboardingStep: OnboardingStep;
}

type UiAction =
  | { type: 'setSidebarCollapsed'; collapsed: boolean }
  | { type: 'setPanelWidths'; widths: { left: number; middle: number } }
  | { type: 'selectProject'; slug: string | null }
  | { type: 'selectDep'; name: string | null }
  | { type: 'navigate'; route: DetailRoute | null }
  | { type: 'openSettings'; section?: SettingsSection }
  | { type: 'closeSettings' }
  | { type: 'openAddProject' }
  | { type: 'closeAddProject' }
  | { type: 'setOnboarding'; active: boolean; step?: OnboardingStep }
  | { type: 'advanceOnboarding'; step: OnboardingStep };

function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'setSidebarCollapsed':
      return { ...state, sidebarCollapsed: action.collapsed };
    case 'setPanelWidths':
      return { ...state, panelWidths: action.widths };
    case 'selectProject': {
      // Switching to a *different* project clears the active dep + route per
      // Decision D3. When the slug is unchanged we keep them so hydration
      // restoring `detailRoute` from localStorage isn't undone by the
      // first-mount auto-select effect (which dispatches the same slug we
      // just hydrated).
      if (action.slug === state.activeProjectSlug) return state;
      // First-mount auto-select runs after hydration: if a detailRoute is
      // already present, preserve it (the user's last view).
      if (state.activeProjectSlug === null && state.detailRoute !== null) {
        return {
          ...state,
          activeProjectSlug: action.slug,
          activeDepName: state.detailRoute.depName
        };
      }
      return {
        ...state,
        activeProjectSlug: action.slug,
        activeDepName: null,
        detailRoute: null
      };
    }
    case 'selectDep':
      // Selecting a dep resets the right-panel view to [A] for that dep.
      return {
        ...state,
        activeDepName: action.name,
        detailRoute: action.name === null ? null : { kind: 'A', depName: action.name }
      };
    case 'navigate':
      return {
        ...state,
        detailRoute: action.route,
        activeDepName: action.route?.depName ?? state.activeDepName
      };
    case 'openSettings':
      return {
        ...state,
        settingsOpen: true,
        settingsSection: action.section ?? state.settingsSection
      };
    case 'closeSettings':
      return { ...state, settingsOpen: false };
    case 'openAddProject':
      return { ...state, addProjectOpen: true };
    case 'closeAddProject':
      return { ...state, addProjectOpen: false };
    case 'setOnboarding':
      return {
        ...state,
        onboardingActive: action.active,
        onboardingStep: action.step ?? state.onboardingStep
      };
    case 'advanceOnboarding':
      return { ...state, onboardingStep: action.step };
    default:
      return state;
  }
}

interface AppContextValue extends UiState {
  config: ConfigResponse | null;
  configLoading: boolean;
  configError: string | null;
  projects: ProjectSummary[];
  projectsLoading: boolean;
  projectsError: string | null;
  activeProject: ProjectDetail | null;
  activeProjectLoading: boolean;
  activeProjectError: string | null;
  activeProjectRefreshing: boolean;
  jobs: JobRecord[];
  orphans: JobOrphan[];
  toasts: ToastItem[];
  cancelRequest: CancelRequest | null;

  dispatch: (action: UiAction) => void;

  toggleSidebar: () => void;
  setPanelWidths: (widths: { left: number; middle: number }) => void;
  selectProject: (slug: string | null) => void;
  selectDep: (name: string | null) => void;
  navigate: (route: DetailRoute | null) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  openAddProject: () => void;
  closeAddProject: () => void;

  refreshConfig: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  refreshActiveProject: () => Promise<void>;
  refreshActiveProjectFromDisk: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  registerProject: (path: string, acknowledgeWorkspaces?: boolean) => Promise<string>;

  dismissToast: (id: string) => void;
  /** Publish a toast immediately (used by view bodies for ad-hoc feedback). */
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;

  /** StatusBar Cancel button → AppShell-level confirmation modal. */
  requestCancel: (req: CancelRequest) => void;
  /** Modal "Keep running" → clear the request. */
  clearCancelRequest: () => void;
  /** Modal "Cancel job" → POST DELETE + clear the request. */
  confirmCancel: () => Promise<void>;

  /** Orphan banner actions (Stage 2 carry-over M3). */
  discardOrphan: (slug: string, jobId: string) => Promise<void>;
  rerunOrphan: (orphan: JobOrphan) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

const DEFAULT_PANEL_WIDTHS = { left: 280, middle: 380 };

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(uiReducer, undefined, () => ({
    sidebarCollapsed: false,
    panelWidths: DEFAULT_PANEL_WIDTHS,
    activeProjectSlug: null,
    activeDepName: null,
    detailRoute: null,
    settingsOpen: false,
    settingsSection: 'llm' as SettingsSection,
    addProjectOpen: false,
    onboardingActive: false,
    onboardingStep: 'welcome' as OnboardingStep
  }));

  // Hydrate persisted UI state from localStorage on mount (avoids SSR mismatch).
  useEffect(() => {
    const storedCollapsed = readLocal<boolean>(PersistenceKeys.sidebarCollapsed, false);
    const storedWidths = readLocal<{ left: number; middle: number }>(
      PersistenceKeys.panelWidths,
      DEFAULT_PANEL_WIDTHS
    );
    if (storedCollapsed) dispatch({ type: 'setSidebarCollapsed', collapsed: true });
    if (storedWidths.left !== DEFAULT_PANEL_WIDTHS.left || storedWidths.middle !== DEFAULT_PANEL_WIDTHS.middle) {
      dispatch({ type: 'setPanelWidths', widths: storedWidths });
    }
    const storedRoute = readLocal<DetailRoute | null>(PersistenceKeys.detailRoute, null);
    if (storedRoute) {
      dispatch({ type: 'navigate', route: storedRoute });
    }
  }, []);

  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const [activeProject, setActiveProject] = useState<ProjectDetail | null>(null);
  const [activeProjectLoading, setActiveProjectLoading] = useState(false);
  const [activeProjectError, setActiveProjectError] = useState<string | null>(null);
  const [activeProjectRefreshing, setActiveProjectRefreshing] = useState(false);

  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [orphans, setOrphans] = useState<JobOrphan[]>([]);
  const previousJobsRef = useRef<Map<string, JobRecord>>(new Map());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeqRef = useRef(0);
  const [cancelRequest, setCancelRequest] = useState<CancelRequest | null>(null);

  const bootedRef = useRef(false);

  const refreshConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const result = await getApiClient().getConfig();
      setConfig(result);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : 'Failed to load config');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const result = await getApiClient().listProjects();
      setProjects(result.projects);
    } catch (err) {
      setProjectsError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const refreshActiveProject = useCallback(async () => {
    if (!state.activeProjectSlug) {
      setActiveProject(null);
      return;
    }
    setActiveProjectLoading(true);
    setActiveProjectError(null);
    try {
      const result = await getApiClient().getProjectDetail(state.activeProjectSlug);
      setActiveProject(result);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_CACHED') {
        setActiveProject(null);
      } else {
        setActiveProjectError(err instanceof Error ? err.message : 'Failed to load project');
      }
    } finally {
      setActiveProjectLoading(false);
    }
  }, [state.activeProjectSlug]);

  const refreshJobs = useCallback(async () => {
    try {
      const result = await getApiClient().listJobs();
      setJobs(result.jobs);
      setOrphans(result.orphans ?? []);
    } catch {
      // Status bar is non-critical; ignore failure.
    }
  }, []);

  const registerProject = useCallback(
    async (path: string, acknowledgeWorkspaces = false) => {
      const { slug } = await getApiClient().addProject({
        path,
        acknowledgeWorkspaces: acknowledgeWorkspaces || undefined
      });
      await refreshProjects();
      dispatch({ type: 'selectProject', slug });
      return slug;
    },
    [refreshProjects]
  );

  /**
   * Trigger the Stage 1 BE `POST /api/projects/:slug/refresh` endpoint
   * (re-reads package.json + lockfile) for the currently-active project.
   * Sets a `refreshing` flag for UI spinners and re-fetches the project
   * detail when the POST returns.
   */
  const refreshActiveProjectFromDisk = useCallback(async () => {
    if (!state.activeProjectSlug) return;
    setActiveProjectRefreshing(true);
    setActiveProjectError(null);
    try {
      await getApiClient().refreshProject(state.activeProjectSlug);
      await refreshActiveProject();
      await refreshProjects();
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Refresh failed';
      setActiveProjectError(message);
    } finally {
      setActiveProjectRefreshing(false);
    }
  }, [state.activeProjectSlug, refreshActiveProject, refreshProjects]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    setToasts((prev) => {
      // Max 3 toasts on screen (UI_DESIGN.md §2.7); FIFO eviction.
      const next: ToastItem[] = [
        ...prev,
        { ...toast, id: `toast-${++toastSeqRef.current}` }
      ];
      while (next.length > 3) next.shift();
      return next;
    });
  }, []);

  const requestCancel = useCallback((req: CancelRequest) => {
    setCancelRequest(req);
  }, []);

  const clearCancelRequest = useCallback(() => {
    setCancelRequest(null);
  }, []);

  const confirmCancel = useCallback(async () => {
    const req = cancelRequest;
    if (!req) return;
    try {
      await getApiClient().cancelJob(req.jobId);
    } catch (err) {
      pushToast({
        severity: 'error',
        title: 'Cancel failed',
        body: err instanceof Error ? err.message : 'Could not cancel job.'
      });
    } finally {
      setCancelRequest(null);
      void refreshJobs();
    }
  }, [cancelRequest, pushToast, refreshJobs]);

  const discardOrphan = useCallback(
    async (slug: string, jobId: string) => {
      try {
        await getApiClient().discardOrphan(slug, jobId);
      } catch (err) {
        pushToast({
          severity: 'error',
          title: 'Discard failed',
          body: err instanceof Error ? err.message : 'Could not discard orphan.'
        });
        return;
      }
      // Optimistically remove from local state; refresh will reconcile.
      setOrphans((prev) => prev.filter((o) => !(o.slug === slug && o.jobId === jobId)));
      void refreshJobs();
    },
    [pushToast, refreshJobs]
  );

  /**
   * Re-run an orphan by POST'ing to the appropriate refresh endpoint inferred
   * from `resourceKey`. The kind/resourceKey convention emitted by the BE
   * (`src/lib/jobs/queue.ts`) is documented in spec §10.10 + Stage 2 review.
   *
   * Format: `<kind>:<slug>:<name>[:<version>|:<from>:<to>|:<pathHash>]`
   *   deps:<slug>:<name>
   *   versions:<slug>:<name>:<version>
   *   usage:<slug>:<name>
   *   reports:<slug>:<name>:<from>:<to>
   *   file-reviews:<slug>:<name>:<pathHash>
   *   refresh:<slug>     (Phase-1 sync refresh)
   */
  const rerunOrphan = useCallback(
    async (orphan: JobOrphan) => {
      const parts = orphan.resourceKey.split(':');
      const client = getApiClient();
      try {
        const [kind, slug, ...rest] = parts;
        if (kind === 'deps' && rest[0]) {
          await client.refreshDepDetail(slug!, rest[0]);
        } else if (kind === 'versions' && rest[0] && rest[1]) {
          await client.refreshVersionDetail(slug!, rest[0], rest[1]);
        } else if (kind === 'usage' && rest[0]) {
          await client.refreshUsageDetail(slug!, rest[0]);
        } else if (kind === 'reports' && rest[0] && rest[1] && rest[2]) {
          await client.refreshUpdateReport(slug!, rest[0], rest[1], rest[2]);
        } else if (kind === 'deep-reports' && rest[0] && rest[1] && rest[2]) {
          await client.refreshDeepUpdateReport(slug!, rest[0], rest[1], rest[2]);
        } else if (kind === 'file-reviews' && rest[0] && rest[1]) {
          await client.refreshFileReview(slug!, rest[0], rest[1]);
        } else if (kind === 'refresh') {
          await client.refreshProject(slug!);
        } else {
          throw new Error(`Unsupported orphan resourceKey: ${orphan.resourceKey}`);
        }
        // Drop the journal entry now that we've started fresh.
        await client.discardOrphan(orphan.slug, orphan.jobId);
        setOrphans((prev) =>
          prev.filter((o) => !(o.slug === orphan.slug && o.jobId === orphan.jobId))
        );
        void refreshJobs();
      } catch (err) {
        pushToast({
          severity: 'error',
          title: 'Re-run failed',
          body: err instanceof Error ? err.message : 'Could not re-run job.'
        });
      }
    },
    [pushToast, refreshJobs]
  );

  // Boot sequence: CSRF token, then config, projects, jobs.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    void (async () => {
      try {
        await getApiClient().getCsrfToken();
      } catch {
        // Boot continues; mutating actions will refetch the token lazily.
      }
      await refreshConfig();
      await refreshProjects();
      await refreshJobs();
    })();
  }, [refreshConfig, refreshProjects, refreshJobs]);

  // When config + project list arrive, decide whether to enter onboarding.
  useEffect(() => {
    if (configLoading || projectsLoading) return;
    if (!config) return;
    const hasKey = config.apiKeys.hasAnthropicKey || config.apiKeys.hasOpenAIKey;
    const needsOnboarding = !hasKey || projects.length === 0;
    if (needsOnboarding) {
      dispatch({
        type: 'setOnboarding',
        active: true,
        step: !hasKey ? 'welcome' : 'add-project'
      });
    } else {
      dispatch({ type: 'setOnboarding', active: false });
    }
  }, [config, configLoading, projects.length, projectsLoading]);

  // Auto-select first project when none active and at least one exists.
  useEffect(() => {
    if (state.activeProjectSlug || projects.length === 0) return;
    dispatch({ type: 'selectProject', slug: projects[0]!.slug });
  }, [projects, state.activeProjectSlug]);

  // Load active project detail when slug changes.
  useEffect(() => {
    void refreshActiveProject();
  }, [refreshActiveProject]);

  // Persist sidebar collapse + panel widths.
  useEffect(() => {
    writeLocal(PersistenceKeys.sidebarCollapsed, state.sidebarCollapsed);
  }, [state.sidebarCollapsed]);

  useEffect(() => {
    writeLocal(PersistenceKeys.panelWidths, state.panelWidths);
  }, [state.panelWidths]);

  // Persist the right-panel route so reload restores the last view.
  useEffect(() => {
    writeLocal(PersistenceKeys.detailRoute, state.detailRoute);
  }, [state.detailRoute]);

  /**
   * Watch `jobs` for transitions running → done / error / cancelled. If the
   * user has navigated away from the running view, surface a toast. Per
   * spec §7.10 + UI_DESIGN.md §2.7. The previousJobsRef map records last-seen
   * state per jobId so we don't emit duplicate toasts on each refresh.
   */
  useEffect(() => {
    const prev = previousJobsRef.current;
    const next = new Map<string, JobRecord>();
    for (const job of jobs) next.set(job.jobId, job);

    for (const [jobId, current] of next) {
      const before = prev.get(jobId);
      const justFinished =
        (before === undefined && (current.state === 'done' || current.state === 'error')) ||
        (before !== undefined &&
          (before.state === 'running' || before.state === 'queued') &&
          (current.state === 'done' || current.state === 'error' || current.state === 'cancelled'));
      if (!justFinished) continue;
      // Only emit toasts for project-scoped jobs the user has navigated past.
      if (!current.slug) continue;
      // Skip toasts when the user is still looking at the resource (e.g., the
      // current view matches the job's target dep). Resource keys are emitted
      // by BE as `<kind>:<slug>:<name>[:...]` — parts[2] is the dep name.
      const resourceParts = current.resourceKey.split(':');
      const targetDep = resourceParts.length >= 3 ? resourceParts[2] ?? null : null;
      const userIsOnSameDep =
        targetDep !== null && state.detailRoute?.depName === targetDep;
      if (userIsOnSameDep && state.activeProjectSlug === current.slug) continue;

      if (current.state === 'done' && targetDep) {
        // Generic completion toast with an action that navigates to the result.
        // resourceKey format (BE convention):
        //   deps:<slug>:<name>
        //   versions:<slug>:<name>:<version>
        //   usage:<slug>:<name>
        //   reports:<slug>:<name>:<from>:<to>
        //   file-reviews:<slug>:<name>:<pathHash>
        const kind = resourceParts[0];
        const depSeg = resourceParts[2] ?? targetDep;
        let viewLabel = 'Result';
        let route: DetailRoute = { kind: 'A', depName: depSeg };
        if (kind === 'deps') {
          viewLabel = 'Detail';
          route = { kind: 'A', depName: depSeg };
        } else if (kind === 'versions' && resourceParts[3]) {
          viewLabel = 'Version';
          route = { kind: 'B', depName: depSeg, version: resourceParts[3]! };
        } else if (kind === 'usage') {
          viewLabel = 'Usage';
          route = { kind: 'C', depName: depSeg };
        } else if (kind === 'reports' && resourceParts[3] && resourceParts[4]) {
          viewLabel = 'Update report';
          route = {
            kind: 'D',
            depName: depSeg,
            fromVersion: resourceParts[3]!,
            toVersion: resourceParts[4]!
          };
        } else if (kind === 'deep-reports' && resourceParts[3] && resourceParts[4]) {
          viewLabel = 'Deep report';
          route = {
            kind: 'D-deep',
            depName: depSeg,
            fromVersion: resourceParts[3]!,
            toVersion: resourceParts[4]!
          };
        } else if (kind === 'file-reviews' && resourceParts[3]) {
          viewLabel = 'File review';
          route = {
            kind: 'E',
            depName: depSeg,
            pathHash: resourceParts[3]!,
            filePath: depSeg
          };
        }
        pushToast({
          severity: 'success',
          title: `${viewLabel} ready`,
          body: depSeg,
          action: { label: 'View', route }
        });
      } else if (current.state === 'error' && current.error) {
        pushToast({
          severity: 'error',
          title: 'Job failed',
          body: current.error.message
        });
      }
    }

    previousJobsRef.current = next;
  }, [jobs, state.detailRoute, state.activeProjectSlug, pushToast]);

  // Convenience action wrappers.
  const toggleSidebar = useCallback(
    () => dispatch({ type: 'setSidebarCollapsed', collapsed: !state.sidebarCollapsed }),
    [state.sidebarCollapsed]
  );
  const setPanelWidths = useCallback(
    (widths: { left: number; middle: number }) =>
      dispatch({ type: 'setPanelWidths', widths }),
    []
  );
  const selectProject = useCallback(
    (slug: string | null) => dispatch({ type: 'selectProject', slug }),
    []
  );
  const selectDep = useCallback(
    (name: string | null) => dispatch({ type: 'selectDep', name }),
    []
  );
  const navigate = useCallback(
    (route: DetailRoute | null) => dispatch({ type: 'navigate', route }),
    []
  );
  const openSettings = useCallback(
    (section?: SettingsSection) => dispatch({ type: 'openSettings', section }),
    []
  );
  const closeSettings = useCallback(() => dispatch({ type: 'closeSettings' }), []);
  const openAddProject = useCallback(() => dispatch({ type: 'openAddProject' }), []);
  const closeAddProject = useCallback(() => dispatch({ type: 'closeAddProject' }), []);

  const value = useMemo<AppContextValue>(
    () => ({
      ...state,
      config,
      configLoading,
      configError,
      projects,
      projectsLoading,
      projectsError,
      activeProject,
      activeProjectLoading,
      activeProjectError,
      activeProjectRefreshing,
      jobs,
      orphans,
      toasts,
      cancelRequest,
      dispatch,
      toggleSidebar,
      setPanelWidths,
      selectProject,
      selectDep,
      navigate,
      openSettings,
      closeSettings,
      openAddProject,
      closeAddProject,
      refreshConfig,
      refreshProjects,
      refreshActiveProject,
      refreshActiveProjectFromDisk,
      refreshJobs,
      registerProject,
      dismissToast,
      pushToast,
      requestCancel,
      clearCancelRequest,
      confirmCancel,
      discardOrphan,
      rerunOrphan
    }),
    [
      state,
      config,
      configLoading,
      configError,
      projects,
      projectsLoading,
      projectsError,
      activeProject,
      activeProjectLoading,
      activeProjectError,
      activeProjectRefreshing,
      jobs,
      orphans,
      toasts,
      cancelRequest,
      toggleSidebar,
      setPanelWidths,
      selectProject,
      selectDep,
      navigate,
      openSettings,
      closeSettings,
      openAddProject,
      closeAddProject,
      refreshConfig,
      refreshProjects,
      refreshActiveProject,
      refreshActiveProjectFromDisk,
      refreshJobs,
      registerProject,
      dismissToast,
      pushToast,
      requestCancel,
      clearCancelRequest,
      confirmCancel,
      discardOrphan,
      rerunOrphan
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useAppContext must be used inside <AppProvider>');
  }
  return ctx;
}
