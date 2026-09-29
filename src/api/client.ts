import { ApiError, apiErrorFromProblem, transportError } from './errors'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue | QueryValue[]>

export interface RequestOptions {
  /** Path relative to the API base prefix, e.g. `/me/sessions`. */
  path: string
  method?: HttpMethod
  query?: QueryParams
  /** JSON-encoded unless `json` is `false`. */
  body?: unknown
  /**
   * Serialization of `body`. JSON by default; `false` sends the body verbatim
   * (used for the `text/csv` user import) and requires `contentType`.
   */
  json?: boolean
  contentType?: string
  /** `false` skips the bearer header entirely (public endpoints). */
  auth?: boolean
  /** Explicit bearer, e.g. the one-time `change_token`. Also disables the refresh retry. */
  token?: string | null
  headers?: Record<string, string>
  /** Sent as `Idempotency-Key`; generated per logical submit when omitted on POST. */
  idempotencyKey?: string
  signal?: AbortSignal
  /** Defaults to 30s; `0` disables the client-side timeout. */
  timeoutMs?: number
  /** How to decode a 2xx body. Defaults to `json`. */
  responseType?: 'json' | 'text' | 'none'
}

export type VerbOptions = Omit<RequestOptions, 'path' | 'method' | 'body'>

const DEFAULT_BASE_URL = '/iam'
const DEFAULT_TIMEOUT_MS = 30_000

let baseUrl = stripTrailingSlashes(import.meta.env.VITE_API_BASE ?? DEFAULT_BASE_URL)
let tokenProvider: (() => string | null) | null = null
let refreshHandler: (() => Promise<boolean>) | null = null
let refreshInFlight: Promise<boolean> | null = null

/**
 * Development seam: an in-memory transport installed by `src/api/mock` so the
 * console can be driven without the IAM service running. The default is the real
 * `fetch`, so production and every build without `VITE_MOCK=1` behave exactly as
 * before; the mock module is only ever reached through a dev-guarded dynamic
 * import, so it is never part of a production bundle. The seam replaces exactly
 * the network call and nothing else: URL building, bearer injection, idempotency
 * keys, problem+json decoding, timeout handling and the single refresh-and-retry
 * all stay in `request`/`dispatch`.
 */
type Transport = (input: string, init: RequestInit) => Promise<Response>

const fetchTransport: Transport = globalThis.fetch.bind(globalThis)
let transport: Transport = fetchTransport

/** Installed by the mock module; pass `null` to restore `fetch`. */
export function setTransport(next: Transport | null): void {
  transport = next ?? fetchTransport
}

function stripTrailingSlashes(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** Overrides the API prefix. Exists for tests/embedded deployments; defaults to `VITE_API_BASE`. */
export function setApiBaseUrl(value: string): void {
  baseUrl = stripTrailingSlashes(value)
}

export function apiBaseUrl(): string {
  return baseUrl
}

/**
 * Registered by the auth store: how to read the in-memory access token, and how
 * to obtain a new one. `refresh` MUST resolve to `true` only when a usable
 * access token is available afterwards.
 */
export function setAuthHandlers(handlers: {
  getAccessToken: () => string | null
  refresh: () => Promise<boolean>
}): void {
  tokenProvider = handlers.getAccessToken
  refreshHandler = handlers.refresh
}

/** One key per logical submit, reused verbatim when the request is retried. */
export function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  const random = () => Math.floor(Math.random() * 0x100000000).toString(36)
  return `${Date.now().toString(36)}-${random()}-${random()}`
}

/**
 * Calls `refresh` at most once across all concurrent 401s: every waiter shares
 * the same promise, and a fresh cycle starts only after the previous one settles.
 */
function refreshOnce(): Promise<boolean> {
  if (!refreshHandler) return Promise.resolve(false)
  if (!refreshInFlight) {
    refreshInFlight = refreshHandler()
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null
      })
  }
  return refreshInFlight
}

function buildUrl(path: string, query: QueryParams | undefined): string {
  const url = /^https?:\/\//i.test(path) || path.startsWith(baseUrl)
    ? path
    : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  if (!query) return url

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue
      search.append(key, String(item))
    }
  }
  const qs = search.toString()
  if (!qs) return url
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`
}

async function dispatch(
  options: RequestOptions,
  url: string,
  bearer: string | null,
  idempotencyKey: string | undefined
): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`)
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)

  let payload: BodyInit | undefined
  if (options.body !== undefined) {
    if (options.json === false) {
      payload = options.body as BodyInit
      if (options.contentType) headers.set('Content-Type', options.contentType)
    } else {
      payload = JSON.stringify(options.body)
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    }
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timedOut = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : undefined
  const relayAbort = () => controller.abort()
  options.signal?.addEventListener('abort', relayAbort)

  try {
    return await transport(url, {
      method: options.method ?? 'GET',
      headers,
      body: payload,
      signal: controller.signal,
      credentials: 'omit'
    })
  } catch {
    if (options.signal?.aborted) throw transportError('abort')
    if (timedOut) throw transportError('timeout')
    throw transportError('network')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', relayAbort)
  }
}

async function errorForResponse(response: Response): Promise<ApiError> {
  const replayed = response.headers.get('Idempotency-Replayed') === 'true'
  const text = await response.text().catch(() => '')
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (body !== null && typeof body === 'object') {
    return apiErrorFromProblem(response.status, body, { title: response.statusText, replayed })
  }
  const printable = text && !text.startsWith('<') ? text.slice(0, 200) : undefined
  return apiErrorFromProblem(response.status, null, {
    title: response.statusText || `HTTP ${response.status}`,
    fallbackDetail: printable,
    replayed
  })
}

async function decode(
  response: Response,
  responseType: RequestOptions['responseType']
): Promise<unknown> {
  if (response.status === 204 || responseType === 'none') return undefined
  const text = await response.text()
  if (responseType === 'text') return text
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError({
      status: response.status,
      title: 'Invalid Response',
      detail: 'invalid_response',
      fields: {}
    })
  }
}

/**
 * The single HTTP entry point: base prefix, JSON codec, bearer injection,
 * `Idempotency-Key`, problem+json decoding, timeout/abort, and exactly one
 * refresh-and-retry on 401 (shared across concurrent callers).
 */
export async function request<T>(options: RequestOptions): Promise<T> {
  const method = options.method ?? 'GET'
  // Generated before the first attempt so a retry after refresh replays the
  // very same logical submit (the service fingerprints key + body + credential).
  const idempotencyKey =
    options.idempotencyKey ?? (method === 'POST' ? newIdempotencyKey() : undefined)
  const url = buildUrl(options.path, options.query)
  const canRetryWithRefresh = options.auth !== false && options.token === undefined

  let attempt = 0
  for (;;) {
    attempt += 1
    const bearer =
      options.token !== undefined
        ? options.token
        : options.auth === false
          ? null
          : (tokenProvider?.() ?? null)

    const response = await dispatch(options, url, bearer, idempotencyKey)

    if (response.status === 401 && attempt === 1 && canRetryWithRefresh) {
      const refreshed = await refreshOnce()
      if (refreshed) continue
    }
    if (!response.ok) throw await errorForResponse(response)
    return (await decode(response, options.responseType)) as T
  }
}

/** Thin verb wrappers over `request`, for terse endpoint modules. */
export const http = {
  get: <T>(path: string, options?: VerbOptions) => request<T>({ ...options, method: 'GET', path }),
  post: <T>(path: string, body?: unknown, options?: VerbOptions) =>
    request<T>({ ...options, method: 'POST', path, body }),
  put: <T>(path: string, body?: unknown, options?: VerbOptions) =>
    request<T>({ ...options, method: 'PUT', path, body }),
  patch: <T>(path: string, body?: unknown, options?: VerbOptions) =>
    request<T>({ ...options, method: 'PATCH', path, body }),
  delete: <T>(path: string, body?: unknown, options?: VerbOptions) =>
    request<T>({ ...options, method: 'DELETE', path, body })
}
