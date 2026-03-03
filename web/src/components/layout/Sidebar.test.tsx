import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';

function renderSidebar(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  it('renders the OpenHive brand name', () => {
    renderSidebar();
    expect(screen.getByText('OpenHive')).toBeInTheDocument();
  });

  it('renders all navigation links', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /teams/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /logs/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('Dashboard link points to root path', () => {
    renderSidebar();
    const dashboardLink = screen.getByRole('link', { name: /dashboard/i });
    expect(dashboardLink).toHaveAttribute('href', '/');
  });

  it('Teams link points to /teams', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: /teams/i })).toHaveAttribute('href', '/teams');
  });

  it('Tasks link points to /tasks', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: /tasks/i })).toHaveAttribute('href', '/tasks');
  });

  it('Logs link points to /logs', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: /logs/i })).toHaveAttribute('href', '/logs');
  });

  it('Settings link points to /settings', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings');
  });

  it('renders with sidebar data-testid', () => {
    renderSidebar();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('renders navigation landmark', () => {
    renderSidebar();
    expect(screen.getByRole('navigation', { name: /main navigation/i })).toBeInTheDocument();
  });
});
