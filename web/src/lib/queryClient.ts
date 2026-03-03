import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Global TanStack Query client.
 * - staleTime: 30s for stable/rarely-changing data (config, teams).
 * - Retries are disabled for 4xx errors (client errors should not be retried).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000, // 30 seconds
      retry: (failureCount, error) => {
        // Do not retry on client-side errors (4xx)
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
