/**
 * API service functions for the OpenHive web portal.
 */

import type {
  HealthResponse,
  TeamsListResponse,
  TeamDetail,
  TasksListResponse,
  Task,
  TaskEventsResponse,
  LogsResponse,
  WebhooksResponse,
} from '@/types/api';

const API_BASE = '/api';

/**
 * Fetch wrapper with error handling.
 */
async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function getHealth(): Promise<HealthResponse> {
  return fetchApi<HealthResponse>('/health');
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export async function getTeams(): Promise<TeamsListResponse> {
  return fetchApi<TeamsListResponse>('/teams');
}

export async function getTeam(slug: string): Promise<TeamDetail> {
  return fetchApi<TeamDetail>(`/teams/${slug}`);
}

export async function createTeam(slug: string): Promise<{ slug: string; containerId: string; status: string }> {
  return fetchApi('/teams', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  });
}

export async function deleteTeam(slug: string): Promise<{ slug: string; status: string }> {
  return fetchApi(`/teams/${slug}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function getTasks(params?: {
  status?: string;
  team?: string;
  limit?: number;
  offset?: number;
}): Promise<TasksListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.team) searchParams.set('team', params.team);
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());

  const query = searchParams.toString();
  return fetchApi<TasksListResponse>(`/tasks${query ? `?${query}` : ''}`);
}

export async function getTask(id: string): Promise<Task> {
  return fetchApi<Task>(`/tasks/${id}`);
}

export async function getTaskEvents(id: string): Promise<TaskEventsResponse> {
  return fetchApi<TaskEventsResponse>(`/tasks/${id}/events`);
}

export async function createTask(data: {
  team_slug: string;
  title: string;
  prompt: string;
  agent_aid?: string;
  priority?: number;
}): Promise<Task> {
  return fetchApi('/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateTask(id: string, data: {
  status?: string;
  result?: string;
  error?: string;
}): Promise<Task> {
  return fetchApi(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export async function getLogs(params?: {
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
}): Promise<LogsResponse> {
  const searchParams = new URLSearchParams();
  if (params?.level !== undefined) searchParams.set('level', params.level.toString());
  if (params?.eventType) searchParams.set('eventType', params.eventType);
  if (params?.component) searchParams.set('component', params.component);
  if (params?.teamSlug) searchParams.set('teamSlug', params.teamSlug);
  if (params?.taskId) searchParams.set('taskId', params.taskId);
  if (params?.agentAid) searchParams.set('agentAid', params.agentAid);
  if (params?.since) searchParams.set('since', params.since.toString());
  if (params?.until) searchParams.set('until', params.until.toString());
  if (params?.limit) searchParams.set('limit', params.limit.toString());
  if (params?.offset) searchParams.set('offset', params.offset.toString());

  const query = searchParams.toString();
  return fetchApi<LogsResponse>(`/logs${query ? `?${query}` : ''}`);
}

export function getLogStreamUrl(): string {
  return `${API_BASE}/logs/stream`;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export async function getWebhooks(): Promise<WebhooksResponse> {
  return fetchApi<WebhooksResponse>('/v1/hooks');
}

export async function deleteWebhook(id: string): Promise<{ id: string; status: string }> {
  return fetchApi(`/v1/hooks/${id}`, {
    method: 'DELETE',
  });
}