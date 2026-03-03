import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '../../lib/utils';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'openhive-theme';

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    // localStorage may be unavailable
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Theme toggle button that switches between dark and light mode.
 * Persists selection to localStorage and applies the `dark` class to <html>.
 */
export function ThemeToggle({ className }: { className?: string }): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = (): void => {
    setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <button
      type="button"
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={toggle}
      className={cn(
        'rounded-md p-2 hover:bg-accent hover:text-accent-foreground transition-colors',
        className,
      )}
      data-testid="theme-toggle"
    >
      {theme === 'dark' ? (
        <Sun className="h-4 w-4" aria-hidden />
      ) : (
        <Moon className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}

/** Exported for testing */
export { getInitialTheme, applyTheme };
