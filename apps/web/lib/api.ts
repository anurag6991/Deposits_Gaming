'use client';

/**
 * The API client.
 *
 * The access token is held in memory only, never in localStorage. A token in
 * localStorage is readable by any script on the page, which turns one XSS bug
 * into a stolen credential. The refresh token lives in an httpOnly cookie the
 * browser cannot read at all, so a page reload recovers the session by calling
 * /auth/refresh rather than by persisting anything sensitive.
 */

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  // Collapse concurrent 401s into a single refresh. Without this, five parallel
  // requests expiring together fire five refreshes, and rotation means four of
  // them present an already-rotated token — which the API correctly treats as
  // reuse and revokes the whole session.
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) return null;
      const body = await res.json();
      accessToken = body?.data?.accessToken ?? null;
      return accessToken;
    } catch {
      return null;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see it.
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();

  return refreshing;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** FormData for uploads; sent without a JSON content-type. */
  form?: FormData;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers,
      body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
    });
  };

  let res = await send(accessToken);

  // One retry after a silent refresh, so an expired access token never surfaces
  // as an error the user has to react to.
  if (res.status === 401 && accessToken !== null) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await send(fresh);
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok || body?.success === false) {
    throw new ApiError(
      res.status,
      body?.code ?? 'INTERNAL',
      body?.message ?? 'Something went wrong.',
      body?.fields,
    );
  }

  return body.data as T;
}

export async function bootstrapSession(): Promise<boolean> {
  const token = await refreshAccessToken();
  return token !== null;
}
