/**
 * API client for OpenHive backend.
 * All endpoints are under /api/v1/.
 */

const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiResponse<T> {
  data: T;
  error?: {
    code: string;
    message: string;
  };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  const json = (await response.json()) as ApiResponse<T>;

  if (!response.ok) {
    const code = json.error?.code ?? 'UNKNOWN_ERROR';
    const message = json.error?.message ?? `HTTP ${response.status}`;
    throw new ApiError(response.status, code, message);
  }

  return json.data;
}

export const api = {
  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return request<T>('GET', path, undefined, signal);
  },
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return request<T>('POST', path, body, signal);
  },
  put<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return request<T>('PUT', path, body, signal);
  },
  delete<T>(path: string, signal?: AbortSignal): Promise<T> {
    return request<T>('DELETE', path, undefined, signal);
  },
};
