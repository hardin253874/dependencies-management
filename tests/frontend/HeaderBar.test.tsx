import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers/renderWithProviders';
import { HeaderBar } from '@/components/HeaderBar';

describe('HeaderBar', () => {
  it('renders the app title', () => {
    renderWithProviders(<HeaderBar />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByText('Dependencies Agent')).toBeInTheDocument();
  });

  it('renders the Settings button by default', () => {
    renderWithProviders(<HeaderBar />);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('hides the Settings button in minimal mode', () => {
    renderWithProviders(<HeaderBar minimal />);
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });
});
