import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('should render OpenHive v2 heading', () => {
    render(<App />);
    expect(screen.getByText('OpenHive v2')).not.toBeNull();
  });

  it('should render navigation links', () => {
    render(<App />);
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /teams/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /tasks/i })).not.toBeNull();
    expect(screen.getByRole('link', { name: /logs/i })).not.toBeNull();
  });
});