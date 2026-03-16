import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from './Layout';

function renderLayout(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Layout>
        <div>Page content</div>
      </Layout>
    </MemoryRouter>
  );
}

describe('Layout', () => {
  it('renders the OpenHive v2 heading', () => {
    renderLayout();
    expect(screen.getByText('OpenHive v2')).not.toBeNull();
  });

  it('renders all 8 navigation links', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /teams/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /agents/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /containers/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /tasks/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /logs/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /integrations/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /settings/i })).not.toBeNull();
  });

  it('renders children inside main content area', () => {
    renderLayout();
    expect(screen.getByText('Page content')).not.toBeNull();
  });

  it('marks the active nav link for the current path', () => {
    renderLayout('/agents');
    const agentsLink = screen.getByRole('link', { name: /agents/i });
    // Active link has bg-gray-800 class
    expect(agentsLink.className).toContain('bg-gray-800');
  });

  it('settings link is separated with a border divider', () => {
    const { container } = renderLayout();
    const settingsLink = screen.getByRole('link', { name: /settings/i });
    // Settings link is wrapped in a div with border-l class
    const wrapper = settingsLink.parentElement;
    expect(wrapper?.className).toContain('border-l');
  });
});
