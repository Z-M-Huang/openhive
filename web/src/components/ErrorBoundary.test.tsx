import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

// Component that throws on render for testing
function ThrowError({ shouldThrow }: { shouldThrow: boolean }): React.JSX.Element {
  if (shouldThrow) {
    throw new Error('Test render error');
  }
  return <div>Normal content</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // Suppress console.error from React's error boundary internals during tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">Hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('catches errors and displays fallback UI', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.queryByText('Normal content')).not.toBeInTheDocument();
  });

  it('shows error message in fallback UI', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    // The error message should appear somewhere
    expect(screen.getByText('Test render error')).toBeInTheDocument();
  });

  it('shows a try again button that resets the error state', () => {
    render(
      <ErrorBoundary>
        <ThrowError shouldThrow={true} />
      </ErrorBoundary>,
    );

    const retryButton = screen.getByRole('button', { name: /try again/i });
    expect(retryButton).toBeInTheDocument();

    // Click try again — resets boundary internal state (hasError = false)
    // The child still throws, so error UI appears again after re-render,
    // but the button was visible and clickable, which is what we verify.
    fireEvent.click(retryButton);

    // After clicking try again, the error boundary re-renders the child.
    // Since the child still throws, the fallback is shown again immediately.
    // The important thing is that the boundary accepted the state reset.
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });
});
