import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  SortFilterToolbar,
  type FilterChips
} from '@/components/MiddlePanel/SortFilterToolbar';

const DEFAULT_FILTERS: FilterChips = {
  all: true,
  outdated: false,
  vulnerable: false,
  deprecated: false,
  dev: false,
  runtime: false
};

describe('SortFilterToolbar', () => {
  it('renders search input, sort dropdown, update button', () => {
    render(
      <SortFilterToolbar
        search=""
        onSearchChange={vi.fn()}
        sort="outdatedSeverity"
        onSortChange={vi.fn()}
        filters={DEFAULT_FILTERS}
        onFiltersChange={vi.fn()}
        onUpdateProject={vi.fn()}
        refreshing={false}
      />
    );
    expect(screen.getByTestId('dep-search')).toBeInTheDocument();
    expect(screen.getByText('Outdated severity')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update project from disk' })).toBeInTheDocument();
  });

  it('typing in search calls onSearchChange', async () => {
    const onSearchChange = vi.fn();
    render(
      <SortFilterToolbar
        search=""
        onSearchChange={onSearchChange}
        sort="outdatedSeverity"
        onSortChange={vi.fn()}
        filters={DEFAULT_FILTERS}
        onFiltersChange={vi.fn()}
        onUpdateProject={vi.fn()}
        refreshing={false}
      />
    );
    await userEvent.type(screen.getByTestId('dep-search'), 'rea');
    expect(onSearchChange).toHaveBeenLastCalledWith('rea');
  });

  it('changing the sort dropdown calls onSortChange', async () => {
    const onSortChange = vi.fn();
    render(
      <SortFilterToolbar
        search=""
        onSearchChange={vi.fn()}
        sort="outdatedSeverity"
        onSortChange={onSortChange}
        filters={DEFAULT_FILTERS}
        onFiltersChange={vi.fn()}
        onUpdateProject={vi.fn()}
        refreshing={false}
      />
    );
    await userEvent.selectOptions(screen.getByRole('combobox'), 'name');
    expect(onSortChange).toHaveBeenCalledWith('name');
  });

  it('clicking a filter chip flips selection (chip-toggle wired in Stage 2)', async () => {
    const onFiltersChange = vi.fn();
    render(
      <SortFilterToolbar
        search=""
        onSearchChange={vi.fn()}
        sort="outdatedSeverity"
        onSortChange={vi.fn()}
        filters={DEFAULT_FILTERS}
        onFiltersChange={onFiltersChange}
        onUpdateProject={vi.fn()}
        refreshing={false}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Outdated' }));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ outdated: true, all: false })
    );
  });
});
