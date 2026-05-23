import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectList } from '@/components/LeftPanel/ProjectList';

describe('ProjectList', () => {
  it('renders empty state when no projects', () => {
    render(
      <ProjectList
        projects={[]}
        loading={false}
        activeSlug={null}
        collapsed={false}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onRelocate={vi.fn()}
        onRemove={vi.fn()}
        refreshing={false}
      />
    );
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
  });

  it('renders project rows when present', () => {
    render(
      <ProjectList
        projects={[
          {
            slug: 'a',
            name: 'my-app',
            path: '/x',
            packageManager: 'npm',
            depCount: 42,
            lastScanAt: null,
            pathExists: true
          }
        ]}
        loading={false}
        activeSlug={null}
        collapsed={false}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onRelocate={vi.fn()}
        onRemove={vi.fn()}
        refreshing={false}
      />
    );
    expect(screen.getByText('my-app')).toBeInTheDocument();
  });

  it('marks active project with aria-current', () => {
    render(
      <ProjectList
        projects={[
          {
            slug: 'a',
            name: 'my-app',
            path: '/x',
            packageManager: 'npm',
            depCount: 1,
            lastScanAt: null,
            pathExists: true
          }
        ]}
        loading={false}
        activeSlug="a"
        collapsed={false}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onRelocate={vi.fn()}
        onRemove={vi.fn()}
        refreshing={false}
      />
    );
    expect(screen.getByTestId('project-row-a')).toHaveAttribute('aria-current', 'page');
  });

  it('emits select on row click', async () => {
    const onSelect = vi.fn();
    render(
      <ProjectList
        projects={[
          {
            slug: 'a',
            name: 'my-app',
            path: '/x',
            packageManager: 'npm',
            depCount: 1,
            lastScanAt: null,
            pathExists: true
          }
        ]}
        loading={false}
        activeSlug={null}
        collapsed={false}
        onSelect={onSelect}
        onRefresh={vi.fn()}
        onRelocate={vi.fn()}
        onRemove={vi.fn()}
        refreshing={false}
      />
    );
    await userEvent.click(screen.getByTestId('project-row-a'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('renders initials when collapsed', () => {
    render(
      <ProjectList
        projects={[
          {
            slug: 'a',
            name: 'my app',
            path: '/x',
            packageManager: 'npm',
            depCount: 1,
            lastScanAt: null,
            pathExists: true
          }
        ]}
        loading={false}
        activeSlug={null}
        collapsed={true}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onRelocate={vi.fn()}
        onRemove={vi.fn()}
        refreshing={false}
      />
    );
    expect(screen.getByText('MA')).toBeInTheDocument();
  });
});
