import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { Layout } from './components/layout/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';

// Route-level code splitting for better initial load performance
const Dashboard = React.lazy(() =>
  import('./pages/Dashboard').then(m => ({ default: m.Dashboard })),
);
const Teams = React.lazy(() =>
  import('./pages/Teams').then(m => ({ default: m.Teams })),
);
const Tasks = React.lazy(() =>
  import('./pages/Tasks').then(m => ({ default: m.Tasks })),
);
const Logs = React.lazy(() =>
  import('./pages/Logs').then(m => ({ default: m.Logs })),
);
const Settings = React.lazy(() =>
  import('./pages/Settings').then(m => ({ default: m.Settings })),
);

function PageLoader(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center h-32">
      <p className="text-sm text-muted-foreground">Loading...</p>
    </div>
  );
}

/**
 * Root application component.
 * Wraps everything in QueryClientProvider + BrowserRouter.
 * Uses React.lazy for route-level code splitting.
 */
export function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route
                index
                element={
                  <Suspense fallback={<PageLoader />}>
                    <Dashboard />
                  </Suspense>
                }
              />
              <Route
                path="teams"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <Teams />
                  </Suspense>
                }
              />
              <Route
                path="tasks"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <Tasks />
                  </Suspense>
                }
              />
              <Route
                path="logs"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <Logs />
                  </Suspense>
                }
              />
              <Route
                path="settings"
                element={
                  <Suspense fallback={<PageLoader />}>
                    <Settings />
                  </Suspense>
                }
              />
              {/* Catch-all: redirect unknown paths to dashboard */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
