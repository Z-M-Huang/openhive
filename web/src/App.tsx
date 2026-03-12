/**
 * Main App component with routing setup.
 */

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '@/components/Layout';
import { Dashboard } from '@/pages/Dashboard';
import { Teams } from '@/pages/Teams';
import { Tasks } from '@/pages/Tasks';
import { Logs } from '@/pages/Logs';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/teams" element={<Teams />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/logs" element={<Logs />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </QueryClientProvider>
  );
}