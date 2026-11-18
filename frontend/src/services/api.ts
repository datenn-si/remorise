import { apiErrorMessage, CONNECTION_ERROR_MESSAGE } from '../lib/errors';

// API calls go to the page's own origin: in development the Vite server
// proxies /api and /health to the backend (see vite.config.ts), which
// keeps API calls working when the dev UI is opened from another
// device, and in production the backend serves the page itself.

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function apiUrl(path: string): string {
  return path;
}

export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = readCode(body);
  return new ApiError(response.status, apiErrorMessage(response.status, code), code);
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError(0, CONNECTION_ERROR_MESSAGE, 'timeout');
    }
    throw new ApiError(0, CONNECTION_ERROR_MESSAGE, 'network');
  }
  if (!response.ok) throw await apiErrorFromResponse(response);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      response.status,
      'サーバーの応答を読み取れませんでした。',
      'invalid_response',
    );
  }
}

export function getHealth(signal?: AbortSignal): Promise<{ status: string }> {
  return request('/health', { signal });
}

function readCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const detail = (body as { detail?: unknown }).detail;
  if (Array.isArray(detail)) return 'validation_error';
  if (detail && typeof detail === 'object' && 'code' in detail) {
    const code = (detail as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
