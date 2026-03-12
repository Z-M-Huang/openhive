/**
 * TanStack Query hooks for the OpenHive API.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getHealth,
  getTeams,
  getTeam,
  createTeam,
  deleteTeam,
  getTasks,
  getTask,
  getTaskEvents,
  createTask,
  updateTask,
  getLogs,
  getWebhooks,
  deleteWebhook,
} from '@/services/api';

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
    refetchInterval: 5000, // Refresh every 5 seconds
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function useTeams() {
  return useQuery({
    queryKey: ['teams'],
    queryFn: getTeams,
  });
}

export function useTeam(slug: string) {
  return useQuery({
    queryKey: ['teams', slug],
    queryFn: () => getTeam(slug),
    enabled: !!slug,
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTeam,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteTeam,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function useTasks(params?: {
  status?: string;
  team?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ['tasks', params],
    queryFn: () => getTasks(params),
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: ['tasks', id],
    queryFn: () => getTask(id),
    enabled: !!id,
  });
}

export function useTaskEvents(id: string) {
  return useQuery({
    queryKey: ['tasks', id, 'events'],
    queryFn: () => getTaskEvents(id),
    enabled: !!id,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createTask,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof updateTask>[1] }) =>
      updateTask(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export function useLogs(params?: {
  level?: number;
  eventType?: string;
  component?: string;
  teamSlug?: string;
  taskId?: string;
  agentAid?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ['logs', params],
    queryFn: () => getLogs(params),
  });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export function useWebhooks() {
  return useQuery({
    queryKey: ['webhooks'],
    queryFn: getWebhooks,
  });
}

export function useDeleteWebhook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
}