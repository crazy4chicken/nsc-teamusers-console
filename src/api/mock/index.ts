import { apiBaseUrl, setTransport } from '../client'
import { buildRoutes, problem } from './routes'
import type { HttpMethod, MockRoute } from './routes'
import { createMockState, restoreMockState, snapshotMockState } from './state'

/**
 * Development-only mock backend.
 *
 * Installed from `src/main.ts` behind `import.meta.env.DEV && TUCONSOLE_MOCK === '1'`
 * through a dynamic `import()`, so this whole directory is code-split away and
 * never reachable in a production build. It replaces exactly the network call
 * of `src/api/client.ts` (`setTransport`): URL building, bearer injection,
 * `Idempotency-Key`, problem+json decoding, timeouts and the single
 * refresh-and-retry stay in the client.
 *
 * Login fixtures (see `README.md`): `admin` / `Admin-pass-1234` for the full
 * console, `mfa` / `Mfa-pass-1234` for the TOTP challenge, `firstlogin` /
 * `First-pass-1234` for the forced password change, `teamadmin` /
 * `Team-pass-1234` for the team-scoped 403s and `viewer` / `Viewer-pass-1234`
 * for a narrowed menu.
 *
 * State is snapshotted into `sessionStorage` after every mutating request and
 * restored on the next page load, so a reload keeps fixtures *and* sessions: the
 * console holds its access token in memory by design and resumes through the
 * refresh token in `sessionStorage`, which only works while the mock still knows
 * that session. Closing the tab clears both and reseeds the fixtures.
 */

export { MOCK_GRANTS, MOCK_TEAM_ADMIN_GRANTS, MOCK_VIEWER_GRANTS } from './grants'

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

interface CompiledRoute extends MockRoute {
  segments: string[]
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value)
}

function splitPath(url: string): { path: string; query: URLSearchParams } {
  const parsed = new URL(url, globalThis.location.origin)
  const base = apiBaseUrl()
  const withoutBase = base && parsed.pathname.startsWith(base)
    ? parsed.pathname.slice(base.length)
    : parsed.pathname
  const trimmed = withoutBase.replace(/\/+$/, '')
  return { path: trimmed.length === 0 ? '/' : trimmed, query: parsed.searchParams }
}

function decodeBody(body: BodyInit | null | undefined, contentType: string): unknown {
  if (typeof body !== 'string' || body.length === 0) return undefined
  if (!contentType.includes('json')) return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function matchRoute(
  routes: readonly CompiledRoute[],
  method: HttpMethod,
  path: string
): { route: CompiledRoute; params: Record<string, string> } | null {
  const parts = path.split('/').filter((segment) => segment.length > 0)
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== parts.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let index = 0; index < parts.length; index += 1) {
      const segment = route.segments[index]
      if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[index])
      else if (segment !== parts[index]) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return null
}

/**
 * Installer-owned snapshot key. The mock's session state has to outlive a
 * document load: the console keeps its access token in memory and resumes with
 * the refresh token from `sessionStorage`, so a fresh mock state on every load
 * would reject that token and silently end the session.
 */
const STATE_STORAGE_KEY = 'nsc-teamusers.mock.state'

function readStateSnapshot(): string | null {
  try {
    return sessionStorage.getItem(STATE_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStateSnapshot(snapshot: string): void {
  try {
    sessionStorage.setItem(STATE_STORAGE_KEY, snapshot)
  } catch {
    // Storage unavailable or full: the mock then behaves like a per-load one.
  }
}

/**
 * Installs the in-memory transport. The seed lives in `./state`; the grant set
 * of the primary `admin` fixture is the single exported `MOCK_GRANTS` constant.
 */
export function installMockBackend(): void {
  const state = restoreMockState(readStateSnapshot()) ?? createMockState()
  const routes: CompiledRoute[] = buildRoutes(state).map((route) => ({
    ...route,
    segments: route.pattern.split('/').filter((segment) => segment.length > 0)
  }))

  setTransport(async (input, init) => {
    const rawMethod = (init.method ?? 'GET').toUpperCase()
    const method: HttpMethod = isHttpMethod(rawMethod) ? rawMethod : 'GET'
    const { path, query } = splitPath(input)
    const headers = new Headers(init.headers)
    const body = decodeBody(init.body, headers.get('Content-Type') ?? '')
    const match = matchRoute(routes, method, path)
    const response = match
      ? match.route.handler({ method, path, query, headers, body }, match.params)
      : problem(404, 'the requested resource was not found')
    // Only non-GET requests can change state, so those are what get snapshotted.
    if (method !== 'GET') writeStateSnapshot(snapshotMockState(state))
    return response
  })
}
