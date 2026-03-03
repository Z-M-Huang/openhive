import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle, getInitialTheme, applyTheme } from './ThemeToggle';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

// Mock matchMedia
const matchMediaMock = (matches: boolean) =>
  vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

describe('getInitialTheme', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });
    localStorageMock.clear();
  });

  it('returns stored theme when set to dark', () => {
    localStorageMock.setItem('openhive-theme', 'dark');
    expect(getInitialTheme()).toBe('dark');
  });

  it('returns stored theme when set to light', () => {
    localStorageMock.setItem('openhive-theme', 'light');
    expect(getInitialTheme()).toBe('light');
  });

  it('falls back to system preference (dark) when no stored value', () => {
    window.matchMedia = matchMediaMock(true);
    expect(getInitialTheme()).toBe('dark');
  });

  it('falls back to system preference (light) when no stored value', () => {
    window.matchMedia = matchMediaMock(false);
    expect(getInitialTheme()).toBe('light');
  });
});

describe('applyTheme', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });
    localStorageMock.clear();
    document.documentElement.classList.remove('dark');
  });

  it('adds dark class to documentElement for dark theme', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class from documentElement for light theme', () => {
    document.documentElement.classList.add('dark');
    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('persists theme to localStorage', () => {
    applyTheme('dark');
    expect(localStorageMock.getItem('openhive-theme')).toBe('dark');
  });
});

describe('ThemeToggle', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });
    localStorageMock.clear();
    window.matchMedia = matchMediaMock(false); // default to light
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    document.documentElement.classList.remove('dark');
  });

  it('renders toggle button with accessible label', () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('data-testid', 'theme-toggle');
    // Label changes based on current theme
    expect(button).toHaveAttribute('aria-label');
  });

  it('toggles from light to dark on click', () => {
    localStorageMock.setItem('openhive-theme', 'light');
    render(<ThemeToggle />);

    const button = screen.getByTestId('theme-toggle');
    expect(button).toHaveAttribute('aria-label', 'Switch to dark mode');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-label', 'Switch to light mode');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles from dark to light on click', () => {
    localStorageMock.setItem('openhive-theme', 'dark');
    render(<ThemeToggle />);

    const button = screen.getByTestId('theme-toggle');
    expect(button).toHaveAttribute('aria-label', 'Switch to light mode');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-label', 'Switch to dark mode');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('persists theme to localStorage on toggle', () => {
    localStorageMock.setItem('openhive-theme', 'light');
    render(<ThemeToggle />);

    fireEvent.click(screen.getByTestId('theme-toggle'));

    expect(localStorageMock.getItem('openhive-theme')).toBe('dark');
  });
});
