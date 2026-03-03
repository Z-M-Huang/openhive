import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

// --- Types (mirrors Go domain types) ---

export interface SystemConfig {
  listen_address: string;
  log_level: string;
  data_dir: string;
  workspace_root: string;
}

export interface ChannelConfig {
  enabled: boolean;
  token?: string;
  channel_id?: string;
  store_path?: string;
}

export interface ChannelsConfig {
  discord: ChannelConfig;
  whatsapp: ChannelConfig;
}

export interface MasterConfig {
  system: SystemConfig;
  channels: ChannelsConfig;
}

export interface Provider {
  name: string;
  type: string;
  oauth_token?: string;
  api_key?: string;
  base_url?: string;
}

export interface Agent {
  aid: string;
  name: string;
  role_file?: string;
  model_tier?: string;
  status?: string;
}

export interface AgentHeartbeatStatus {
  aid: string;
  status: 'idle' | 'busy' | 'error' | 'stopped';
  detail?: string;
  elapsed_seconds?: number;
  memory_mb?: number;
}

export interface HeartbeatStatus {
  team_id: string;
  agents: AgentHeartbeatStatus[];
  last_seen: string;
  is_healthy: boolean;
}

export interface Team {
  slug: string;
  tid: string;
  description?: string;
  leader_aid: string;
  parent_slug?: string;
  container_state?: string;
  agents?: Agent[];
  children?: string[];
  heartbeat?: HeartbeatStatus;
}

export interface Task {
  id: string;
  team_slug: string;
  agent_aid?: string;
  jid?: string;
  status: string;
  prompt: string;
  result?: string;
  error?: string;
  created_at: string;
  updated_at: string;
  parent_id?: string;
  subtasks?: Task[];
}

export interface TaskWithSubtree extends Task {
  subtasks: Task[];
}

export interface LogEntry {
  id?: number;
  level: string;
  component: string;
  action?: string;
  message: string;
  team_name?: string;
  agent_aid?: string;
  task_id?: string;
  params?: Record<string, unknown>;
  timestamp: string;
}

export interface LogsResponse {
  entries: LogEntry[];
  total: number;
  has_more: boolean;
}

export interface LogQueryParams {
  level?: string;
  component?: string;
  team?: string;
  agent?: string;
  task_id?: string;
  limit?: number;
  offset?: number;
}

// --- Query hooks ---

export function useConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<MasterConfig>('/config'),
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get<Record<string, Provider>>('/providers'),
  });
}

export function useTeams() {
  return useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<Team[]>('/teams'),
  });
}

export function useTeam(slug: string) {
  return useQuery({
    queryKey: ['teams', slug],
    queryFn: () => api.get<Team>(`/teams/${slug}`),
    enabled: !!slug,
  });
}

export function useTasks(params?: { status?: string; team?: string; limit?: number; offset?: number }) {
  const queryString = params
    ? '?' + new URLSearchParams(
        Object.fromEntries(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ),
      ).toString()
    : '';
  return useQuery({
    queryKey: ['tasks', params],
    queryFn: () => api.get<{ tasks: Task[]; total: number; has_more: boolean }>(`/tasks${queryString}`),
  });
}

export function useTask(id: string) {
  return useQuery({
    queryKey: ['tasks', id],
    queryFn: () => api.get<TaskWithSubtree>(`/tasks/${id}`),
    enabled: !!id,
  });
}

export function useLogs(params: LogQueryParams = {}) {
  const queryString = '?' + new URLSearchParams(
    Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ),
  ).toString();
  return useQuery({
    queryKey: ['logs', params],
    queryFn: () => api.get<LogEntry[]>(`/logs${queryString}`),
    staleTime: 5000, // Logs update frequently
  });
}

// --- Mutation hooks ---

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: Partial<MasterConfig>) => api.put<MasterConfig>('/config', config),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['config'] });
    },
  });
}

export function useUpdateProviders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providers: Record<string, Provider>) => api.put<Record<string, Provider>>('/providers', providers),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

export function useCancelTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.post<Task>(`/tasks/${taskId}/cancel`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (team: { slug: string; leader_aid: string; description?: string }) =>
      api.post<Team>('/teams', team),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.delete<void>(`/teams/${slug}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
    },
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<{ status: string; version: string; uptime: string }>('/health'),
    staleTime: 10000,
  });
}
