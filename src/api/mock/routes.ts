import { isValidPermissionKey, permissionScope } from '../admin/authorization'
import type {
  Binding,
  CursorPage,
  Group,
  GroupMember,
  ImportResponse,
  ImportRowResult,
  InvitationResponse,
  PermissionRecord,
  ProvisionCredentialsResponse,
  Role,
  RolePermissionsResponse,
  SessionInfo,
  Team,
  UserStatus
} from '../types'
import { hasGrant } from './grants'
import {
  createSession,
  findUser,
  findUserByName,
  mintTokens,
  nextId,
  nowIso,
  randomHex,
  recordAudit,
  revokeUserSessions,
  sessionsOf,
  toAdminUser,
  toAdminUserSummary,
  toProfile,
  type MockRole,
  type MockSession,
  type MockState,
  type MockUser
} from './state'

/**
 * Route table of the development mock. It answers the same method + path +
 * query combinations the typed modules under `src/api/` issue, with the field
 * spellings of the Go implementation (see `src/api/types.ts`) rather than the
 * published `openapi.yaml`.
 *
 * Everything is in-memory: each collection is a plain array, mutations update
 * it, and the opaque collections page with `{items, next_cursor}` exactly like
 * the service (the audit log keeps its integer cursor).
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface MockRequest {
  method: HttpMethod
  /** Path after the API prefix, normalised (leading `/`, no trailing slash). */
  path: string
  query: URLSearchParams
  headers: Headers
  /** Parsed JSON body, the raw string for `text/csv`, or `undefined`. */
  body: unknown
}

export type MockHandler = (request: MockRequest, params: Record<string, string>) => Response

export interface MockRoute {
  method: HttpMethod
  /** `:name` captures a whole segment. */
  pattern: string
  handler: MockHandler
}

/* ------------------------------------------------------------------ *
 * Response helpers
 * ------------------------------------------------------------------ */

const PROBLEM_TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  423: 'Locked',
  429: 'Too Many Requests',
  500: 'Internal Server Error'
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function noContent(): Response {
  return new Response(null, { status: 204 })
}

/** RFC 9457 `application/problem+json`, matching the service's envelope. */
export function problem(status: number, detail: string, extra?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: PROBLEM_TITLES[status] ?? 'Request Failed',
      status,
      detail,
      ...extra
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } }
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The service's password policy: at least 12 characters with a letter and a digit. */
function isStrongPassword(value: string): boolean {
  return value.length >= 12 && /[A-Za-z]/.test(value) && /\d/.test(value)
}

function normalizeBackupCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Codes are issued as `xxxx-xxxx-xxxx-xxxx` but compared in their de-dashed form. */
function matchesBackupCode(codes: readonly string[], value: string): boolean {
  const wanted = normalizeBackupCode(value)
  return codes.some((code) => normalizeBackupCode(code) === wanted)
}

function pageLimit(query: URLSearchParams): number | null {
  const raw = query.get('limit')
  if (raw === null || raw === '') return 100
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) return null
  return Math.min(value, 1000)
}

/** Cursor page: the opaque cursor is the previous page's last id; empty = end. */
function pageSlice<T>(
  items: readonly T[],
  cursor: string | null,
  limit: number,
  idOf: (item: T) => string
): CursorPage<T> {
  let start = 0
  if (cursor) {
    const index = items.findIndex((item) => idOf(item) === cursor)
    start = index >= 0 ? index + 1 : 0
  }
  const page = items.slice(start, start + limit)
  const next = start + page.length < items.length ? idOf(page[page.length - 1]) : ''
  return { items: page, next_cursor: next }
}

/* ------------------------------------------------------------------ *
 * Authentication and authorization
 * ------------------------------------------------------------------ */

interface Identity {
  user: MockUser
}

type Auth = Identity | Response

/** Narrowing predicate: any handler result union is checked against `Response`. */
function isDenied(value: unknown): value is Response {
  return value instanceof Response
}

function bearerToken(request: MockRequest): string {
  const header = request.headers.get('Authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/** Resolves the caller for the `/me` and admin planes (user-kind access tokens only). */
function authenticate(state: MockState, request: MockRequest, plane: 'me' | 'admin'): Auth {
  const denied =
    plane === 'me' ? 'an authenticated user subject is required' : 'an authenticated subject is required'
  const token = bearerToken(request)
  if (!token) return problem(401, denied)
  const entry = state.accessTokens.get(token)
  if (!entry || entry.expires_at <= Date.now()) return problem(401, denied)
  const user = findUser(state, entry.user_id)
  if (!user || user.status !== 'active') return problem(401, denied)
  return { user }
}

/**
 * `iam:<area>:any` for the whole area, or `iam:<area>:team` when the target
 * team is resolvable and the caller belongs to it. `null` means denied.
 */
function allowArea(user: MockUser, area: string, teamId: string | null): 'any' | 'team' | null {
  if (hasGrant(user.grants, `iam:${area}:any`)) return 'any'
  if (teamId && hasGrant(user.grants, `iam:${area}:team`) && user.team_ids.includes(teamId)) return 'team'
  return null
}

function requireArea(
  user: MockUser,
  area: string,
  teamId: string | null
): 'any' | 'team' | Response {
  const scope = allowArea(user, area, teamId)
  return scope ?? problem(403, 'insufficient_permissions')
}

function notFoundUser(): Response {
  return problem(404, 'the requested user was not found')
}

/* ------------------------------------------------------------------ *
 * Projections
 * ------------------------------------------------------------------ */

function sessionWire(session: MockSession): SessionInfo {
  return { id: session.id, created_at: session.created_at, expires_at: session.expires_at }
}

function roleWire(role: MockRole): Role {
  return { id: role.id, team_id: role.team_id, name: role.name }
}

function permissionWire(record: PermissionRecord): PermissionRecord {
  return { ...record }
}

/** Wraps a handler so a fixture bug surfaces as a diagnosable 500 instead of a network error. */
function guarded(handler: MockHandler): MockHandler {
  return (request, params) => {
    try {
      return handler(request, params)
    } catch (error) {
      return problem(500, 'mock_backend_error', {
        mock_error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

/* ------------------------------------------------------------------ *
 * Auth plane
 * ------------------------------------------------------------------ */

function handleLogin(state: MockState, request: MockRequest): Response {
  const body = asRecord(request.body)
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return problem(400, 'request body must be valid JSON')
  }
  const user = findUserByName(state, body.username)
  if (!user) return problem(401, 'authentication failed')
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    return problem(423, 'account_locked')
  }
  if (user.password !== body.password) {
    user.failed_logins += 1
    if (user.failed_logins >= 5) {
      user.locked_until = new Date(Date.now() + 15 * 60_000).toISOString()
      return problem(423, 'account_locked')
    }
    return problem(401, 'authentication failed')
  }
  if (user.status === 'pending' || user.status === 'invited') return problem(403, 'account_pending')
  if (user.status === 'disabled') return problem(401, 'authentication failed')

  user.failed_logins = 0
  user.updated_at = nowIso()

  if (user.must_change_password) {
    const changeToken = `change-${randomHex()}`
    state.changeTokens.set(changeToken, user.id)
    return problem(403, 'password_change_required', { change_token: changeToken })
  }
  if (user.totp.enabled) {
    const mfaToken = `mfa-${randomHex()}`
    state.mfaTokens.set(mfaToken, { user_id: user.id, expires_at: Date.now() + 300_000 })
    return json(200, { mfa_required: true, mfa_token: mfaToken })
  }
  const session = createSession(state, user)
  recordAudit(state, {
    actor_id: user.id,
    target: user.id,
    action: 'auth.login',
    team_id: null,
    diff: null
  })
  return json(200, mintTokens(state, user, session.id))
}

function handleLoginMfa(state: MockState, request: MockRequest): Response {
  const body = asRecord(request.body)
  if (!body || typeof body.mfa_token !== 'string' || typeof body.code !== 'string') {
    return problem(400, 'request body must be valid JSON')
  }
  const challenge = state.mfaTokens.get(body.mfa_token)
  if (!challenge || challenge.expires_at <= Date.now()) return problem(401, 'authentication failed')
  const user = findUser(state, challenge.user_id)
  if (!user) return problem(401, 'authentication failed')

  const code = body.code.trim()
  // A mock cannot verify a real TOTP: the fixed demo code stands in for the
  // authenticator app, and the seeded backup codes are accepted as-is.
  const accepted = code === '123456' || matchesBackupCode(user.totp.backup_codes, code)
  if (!accepted) {
    user.failed_logins += 1
    if (user.failed_logins >= 5) {
      user.locked_until = new Date(Date.now() + 15 * 60_000).toISOString()
      return problem(423, 'account_locked')
    }
    return problem(401, 'authentication failed')
  }

  user.failed_logins = 0
  state.mfaTokens.delete(body.mfa_token)
  const session = createSession(state, user)
  recordAudit(state, {
    actor_id: user.id,
    target: user.id,
    action: 'auth.login',
    team_id: null,
    diff: { mfa: true }
  })
  return json(200, mintTokens(state, user, session.id))
}

function handleRefresh(state: MockState, request: MockRequest): Response {
  const body = asRecord(request.body)
  const token = body ? optionalString(body.refresh_token) : null
  if (!token) return problem(400, 'request body must be valid JSON')
  const entry = state.refreshTokens.get(token)
  if (!entry) return problem(401, 'authentication failed')
  const user = findUser(state, entry.user_id)
  const sessionAlive = state.sessions.some((session) => session.id === entry.session_id)
  if (!user || user.status !== 'active' || !sessionAlive) return problem(401, 'authentication failed')
  state.refreshTokens.delete(token)
  return json(200, mintTokens(state, user, entry.session_id))
}

function handleLogout(state: MockState, request: MockRequest): Response {
  const body = asRecord(request.body)
  const token = body ? optionalString(body.refresh_token) : null
  if (token) {
    const entry = state.refreshTokens.get(token)
    if (entry) {
      state.refreshTokens.delete(token)
      state.sessions = state.sessions.filter((session) => session.id !== entry.session_id)
    }
  }
  return noContent()
}

function handleRegister(state: MockState, request: MockRequest): Response {
  const body = asRecord(request.body)
  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return problem(400, 'request body must be valid JSON')
  }
  if (findUserByName(state, body.username)) return problem(409, 'username or email already exists')
  if (!isStrongPassword(body.password)) return problem(422, 'weak_password')
  const user: MockUser = {
    id: nextId(state),
    username: body.username,
    email: optionalString(body.email),
    display_name: optionalString(body.display_name) ?? body.username,
    status: 'active',
    perm_ver: 1,
    failed_logins: 0,
    email_verified_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    approved_at: null,
    approved_by: null,
    locked_until: null,
    password: body.password,
    grants: [],
    must_change_password: false,
    team_ids: [],
    totp: { enabled: false, pending_secret: null, backup_codes: [] }
  }
  state.users.push(user)
  recordAudit(state, {
    actor_id: user.id,
    target: user.id,
    action: 'user.register',
    team_id: null,
    diff: null
  })
  return json(201, { id: user.id, status: user.status })
}

function randomBase32Secret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let secret = ''
  for (let index = 0; index < 32; index += 1) {
    secret += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return secret
}

function randomBackupCodes(): string[] {
  const codes: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const raw = randomHex().slice(0, 16)
    codes.push(
      `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`
    )
  }
  return codes
}

function authRoutes(state: MockState): MockRoute[] {
  return [
    { method: 'POST', pattern: '/auth/login', handler: (request) => handleLogin(state, request) },
    { method: 'POST', pattern: '/auth/login/mfa', handler: (request) => handleLoginMfa(state, request) },
    { method: 'POST', pattern: '/auth/refresh', handler: (request) => handleRefresh(state, request) },
    { method: 'POST', pattern: '/auth/logout', handler: (request) => handleLogout(state, request) },
    { method: 'POST', pattern: '/auth/register', handler: (request) => handleRegister(state, request) },
    { method: 'POST', pattern: '/auth/verify-email', handler: () => noContent() },
    { method: 'POST', pattern: '/auth/password-reset/request', handler: () => noContent() },
    {
      method: 'POST',
      pattern: '/auth/password-reset/confirm',
      handler: (request) => {
        const body = asRecord(request.body)
        const password = body ? optionalString(body.new_password) : null
        if (!password || !isStrongPassword(password)) return problem(422, 'weak_password')
        return noContent()
      }
    },
    {
      method: 'POST',
      pattern: '/auth/invite/accept',
      handler: (request) => {
        const body = asRecord(request.body)
        const password = body ? optionalString(body.password) : null
        if (!password) return problem(400, 'request body must be valid JSON')
        if (!isStrongPassword(password)) return problem(422, 'weak_password')
        return noContent()
      }
    },
    {
      method: 'POST',
      pattern: '/auth/passkey/login/begin',
      handler: (request) => {
        const body = asRecord(request.body)
        const username = body ? optionalString(body.username) : null
        const user = username ? findUserByName(state, username) : undefined
        return json(200, {
          publicKey: {
            challenge: `mock-challenge-${randomHex()}`,
            timeout: 300_000,
            rpId: globalThis.location.hostname,
            allowCredentials: (user ? state.passkeys.get(user.id) ?? [] : []).map((passkey) => ({
              type: 'public-key',
              id: passkey.id
            }))
          }
        })
      }
    },
    {
      method: 'POST',
      pattern: '/auth/passkey/login/finish',
      handler: (request) => {
        const body = asRecord(request.body)
        const credentialId = body ? optionalString(body.id) : null
        const owner = [...state.passkeys.entries()].find(([, passkeys]) =>
          passkeys.some((passkey) => passkey.id === credentialId)
        )
        const user = owner ? findUser(state, owner[0]) : undefined
        if (!user || user.status !== 'active') return problem(401, 'authentication failed')
        const session = createSession(state, user)
        return json(200, mintTokens(state, user, session.id))
      }
    }
  ]
}

/* ------------------------------------------------------------------ *
 * Self-service plane
 * ------------------------------------------------------------------ */

function handleChangePassword(state: MockState, request: MockRequest): Response {
  const token = bearerToken(request)
  const changeOwner = token ? state.changeTokens.get(token) : undefined
  const regular = authenticate(state, request, 'me')
  const user = changeOwner ? findUser(state, changeOwner) : isDenied(regular) ? undefined : regular.user
  if (!user) return isDenied(regular) ? regular : problem(401, 'an authenticated user subject is required')

  const body = asRecord(request.body)
  const newPassword = body ? optionalString(body.new_password) : null
  if (!newPassword) return problem(400, 'request body must be valid JSON')
  if (!changeOwner && optionalString(body?.current_password) !== user.password) {
    return problem(401, 'invalid_credentials')
  }
  if (!isStrongPassword(newPassword)) return problem(422, 'weak_password')

  user.password = newPassword
  user.must_change_password = false
  user.perm_ver += 1
  user.updated_at = nowIso()
  revokeUserSessions(state, user.id)
  if (changeOwner) state.changeTokens.delete(changeOwner)
  recordAudit(state, {
    actor_id: user.id,
    target: user.id,
    action: 'user.password.change',
    team_id: null,
    diff: null
  })
  return json(200, { message: 'password changed', sessions_revoked: true })
}

function meRoutes(state: MockState): MockRoute[] {
  const me = (request: MockRequest) => authenticate(state, request, 'me')

  return [
    {
      method: 'GET',
      pattern: '/me',
      handler: (request) => {
        const auth = me(request)
        return isDenied(auth) ? auth : json(200, toProfile(auth.user))
      }
    },
    {
      method: 'PATCH',
      pattern: '/me',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        const body = asRecord(request.body)
        const username = body ? optionalString(body.username) : null
        const displayName = body ? optionalString(body.display_name) : null
        if (!username && !displayName) {
          return problem(400, 'at least one of username or display_name is required')
        }
        if (username) {
          const clash = findUserByName(state, username)
          if (clash && clash.id !== auth.user.id) return problem(409, 'username or email already exists')
          auth.user.username = username
        }
        if (displayName) auth.user.display_name = displayName
        auth.user.updated_at = nowIso()
        return json(200, toProfile(auth.user))
      }
    },
    {
      method: 'DELETE',
      pattern: '/me',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        const body = asRecord(request.body)
        if (optionalString(body?.password) !== auth.user.password) {
          return problem(401, 'invalid_credentials')
        }
        auth.user.status = 'disabled'
        auth.user.perm_ver += 1
        auth.user.email = null
        auth.user.display_name = '已注销账户'
        revokeUserSessions(state, auth.user.id)
        return noContent()
      }
    },
    { method: 'POST', pattern: '/me/password', handler: (request) => handleChangePassword(state, request) },
    {
      method: 'POST',
      pattern: '/me/email',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        const body = asRecord(request.body)
        if (optionalString(body?.password) !== auth.user.password) {
          return problem(401, 'invalid_credentials')
        }
        return noContent()
      }
    },
    { method: 'POST', pattern: '/me/email/confirm', handler: () => noContent() },
    {
      method: 'GET',
      pattern: '/me/export',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        const user = auth.user
        const memberships = user.team_ids.map((teamId) => ({
          team_id: teamId,
          group_id:
            state.groupMembers.find(
              (member) =>
                member.user_id === user.id &&
                state.groups.some((group) => group.id === member.group_id && group.team_id === teamId)
            )?.group_id ?? null
        }))
        return json(200, {
          profile: toProfile(user),
          memberships,
          effective_permissions: [...user.grants],
          active_sessions: sessionsOf(state, user.id).map(sessionWire),
          totp_enabled: user.totp.enabled,
          passkey_count: state.passkeys.get(user.id)?.length ?? 0
        })
      }
    },
    {
      method: 'GET',
      pattern: '/me/sessions',
      handler: (request) => {
        const auth = me(request)
        return isDenied(auth) ? auth : json(200, sessionsOf(state, auth.user.id).map(sessionWire))
      }
    },
    {
      method: 'DELETE',
      pattern: '/me/sessions/:id',
      handler: (request, params) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        const session = state.sessions.find(
          (candidate) => candidate.id === params.id && candidate.user_id === auth.user.id
        )
        if (!session) return problem(404, 'the requested resource was not found')
        state.sessions = state.sessions.filter((candidate) => candidate.id !== session.id)
        for (const [token, entry] of state.refreshTokens) {
          if (entry.session_id === session.id) state.refreshTokens.delete(token)
        }
        return noContent()
      }
    },
    {
      method: 'POST',
      pattern: '/me/totp/enroll',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        if (auth.user.totp.enabled) return problem(409, 'totp_already_enabled')
        const secret = randomBase32Secret()
        auth.user.totp.pending_secret = secret
        return json(200, {
          secret,
          otpauth_url: `otpauth://totp/teamusers:${auth.user.username}?secret=${secret}&issuer=teamusers`
        })
      }
    },
    {
      method: 'POST',
      pattern: '/me/totp/confirm',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        if (auth.user.totp.enabled) return problem(409, 'totp_already_enabled')
        const body = asRecord(request.body)
        const code = body ? optionalString(body.code) : null
        // Any 6-digit code is accepted: the mock has no authenticator to match.
        if (!code || !/^\d{6}$/.test(code.trim())) return problem(401, 'authentication failed')
        auth.user.totp.enabled = true
        auth.user.totp.pending_secret = null
        auth.user.totp.backup_codes = randomBackupCodes()
        return json(200, { backup_codes: [...auth.user.totp.backup_codes] })
      }
    },
    {
      method: 'POST',
      pattern: '/me/totp/backup-codes',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        if (!auth.user.totp.enabled) return problem(404, 'mfa_not_enrolled')
        const body = asRecord(request.body)
        if (optionalString(body?.password) !== auth.user.password) {
          return problem(401, 'invalid_credentials')
        }
        auth.user.totp.backup_codes = randomBackupCodes()
        return json(200, { backup_codes: [...auth.user.totp.backup_codes] })
      }
    },
    {
      method: 'DELETE',
      pattern: '/me/totp',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        if (!auth.user.totp.enabled) return problem(404, 'mfa_not_enrolled')
        const body = asRecord(request.body)
        const code = body ? optionalString(body.code) : null
        if (!code) return problem(400, 'request body must be valid JSON')
        const ok = /^\d{6}$/.test(code.trim()) || matchesBackupCode(auth.user.totp.backup_codes, code)
        if (!ok) return problem(401, 'authentication failed')
        auth.user.totp = { enabled: false, pending_secret: null, backup_codes: [] }
        recordAudit(state, {
          actor_id: auth.user.id,
          target: auth.user.id,
          action: 'user.totp.disable',
          team_id: null,
          diff: null
        })
        return noContent()
      }
    },
    {
      method: 'GET',
      pattern: '/me/passkeys',
      handler: (request) => {
        const auth = me(request)
        return isDenied(auth) ? auth : json(200, state.passkeys.get(auth.user.id) ?? [])
      }
    },
    {
      method: 'POST',
      pattern: '/me/passkeys/register/begin',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        return json(200, {
          publicKey: {
            challenge: `mock-challenge-${randomHex()}`,
            rp: { id: globalThis.location.hostname, name: 'teamusers' },
            user: {
              id: `user-handle-${auth.user.id}`,
              name: auth.user.username,
              displayName: auth.user.display_name
            },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            attestation: 'none',
            timeout: 300_000
          }
        })
      }
    },
    {
      method: 'POST',
      pattern: '/me/passkeys/register/finish',
      handler: (request) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        const body = asRecord(request.body)
        const id = body ? optionalString(body.id) : null
        if (!id) return problem(400, 'invalid WebAuthn response')
        const passkeys = state.passkeys.get(auth.user.id) ?? []
        if (!passkeys.some((passkey) => passkey.id === id)) {
          passkeys.push({ id, created_at: nowIso() })
          state.passkeys.set(auth.user.id, passkeys)
        }
        return noContent()
      }
    },
    {
      method: 'DELETE',
      pattern: '/me/passkeys/:credID',
      handler: (request, params) => {
        const auth = me(request)
        if (isDenied(auth)) return auth
        const passkeys = state.passkeys.get(auth.user.id) ?? []
        const remaining = passkeys.filter((passkey) => passkey.id !== params.credID)
        if (remaining.length === passkeys.length) {
          return problem(404, 'the requested passkey was not found')
        }
        state.passkeys.set(auth.user.id, remaining)
        return noContent()
      }
    }
  ]
}

/* ------------------------------------------------------------------ *
 * Administrative plane — users, sessions, invitations
 * ------------------------------------------------------------------ */

function handleBatchUsers(state: MockState, actorId: string, request: MockRequest): Response {
  const body = asRecord(request.body)
  const op = body ? body.op : undefined
  const ids = body && Array.isArray(body.ids) ? body.ids : null
  if (op !== 'enable' && op !== 'disable') return problem(400, 'op must be disable or enable')
  if (!ids) return problem(400, 'request body must be valid JSON')
  if (ids.length > 500) return problem(422, 'a maximum of 500 ids is allowed')

  const results = ids.map((rawId) => {
    const id = String(rawId)
    const user = findUser(state, id)
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return { id, ok: false, error: 'invalid_id' }
    if (!user) return { id, ok: false, error: 'not_found' }
    if (op === 'disable') {
      user.status = 'disabled'
      user.perm_ver += 1
      revokeUserSessions(state, user.id)
    } else {
      user.status = 'active'
    }
    user.updated_at = nowIso()
    return { id, ok: true }
  })

  recordAudit(state, {
    actor_id: actorId,
    target: `${results.filter((result) => result.ok).length}`,
    action: `user.batch.${op}`,
    team_id: null,
    diff: { ids: ids.length }
  })
  return json(200, { results })
}

function parseCsv(body: unknown): Response | string {
  if (typeof body !== 'string') return problem(415, 'Content-Type must be text/csv')
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0 || lines[0].trim() !== 'username,email,display_name,password') {
    return problem(400, 'CSV header must be username,email,display_name,password')
  }
  return lines.slice(1).join('\n')
}

function handleImportUsers(state: MockState, request: MockRequest): Response {
  const parsed = parseCsv(request.body)
  if (parsed instanceof Response) return parsed
  const rows = parsed.length === 0 ? [] : parsed.split('\n')
  if (rows.length > 500) return problem(422, 'a maximum of 500 rows is allowed')

  const results: ImportRowResult[] = rows.map((row, index) => {
    const [username = '', email = '', displayName = '', password = ''] = row.split(',')
    const rowNumber = index + 2
    if (!username.trim()) return { row: rowNumber, username, ok: false, error: 'username is required' }
    if (findUserByName(state, username)) {
      return { row: rowNumber, username, ok: false, error: 'username or email already exists' }
    }
    if (!isStrongPassword(password)) return { row: rowNumber, username, ok: false, error: 'weak_password' }
    const user: MockUser = {
      id: nextId(state),
      username: username.trim(),
      email: email.trim() || null,
      display_name: displayName.trim() || username.trim(),
      status: 'active',
      perm_ver: 1,
      failed_logins: 0,
      email_verified_at: nowIso(),
      created_at: nowIso(),
      updated_at: nowIso(),
      approved_at: nowIso(),
      approved_by: null,
      locked_until: null,
      password,
      grants: [],
      must_change_password: false,
      team_ids: [],
      totp: { enabled: false, pending_secret: null, backup_codes: [] }
    }
    state.users.push(user)
    return { row: rowNumber, username: user.username, ok: true, id: user.id }
  })

  const response: ImportResponse = { results }
  return json(200, response)
}

function adminUserRoutes(state: MockState): MockRoute[] {
  const adminUser = (request: MockRequest) => authenticate(state, request, 'admin')

  return [
    {
      method: 'GET',
      pattern: '/users',
      handler: (request) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const limit = pageLimit(request.query)
        if (limit === null) return problem(400, 'limit must be a positive integer')
        const page = pageSlice(
          state.users.map(toAdminUserSummary),
          request.query.get('cursor'),
          limit,
          (user) => user.id
        )
        return json(200, page)
      }
    },
    {
      method: 'POST',
      pattern: '/users',
      handler: (request) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const body = asRecord(request.body)
        const username = body ? optionalString(body.username) : null
        const displayName = body ? optionalString(body.display_name) : null
        if (!username || !displayName) return problem(400, 'request body must be valid JSON')
        const password = body ? optionalString(body.password) ?? optionalString(body.initial_password) : null
        if (!password) return problem(422, 'weak_password')
        if (!isStrongPassword(password)) return problem(422, 'weak_password')
        if (findUserByName(state, username)) return problem(409, 'username or email already exists')

        const user: MockUser = {
          id: nextId(state),
          username,
          email: body ? optionalString(body.email) : null,
          display_name: displayName,
          status: 'active',
          perm_ver: 1,
          failed_logins: 0,
          email_verified_at: nowIso(),
          created_at: nowIso(),
          updated_at: nowIso(),
          approved_at: nowIso(),
          approved_by: auth.user.id,
          locked_until: null,
          password,
          grants: [],
          must_change_password: true,
          team_ids: [],
          totp: { enabled: false, pending_secret: null, backup_codes: [] }
        }
        state.users.push(user)
        recordAudit(state, {
          actor_id: auth.user.id,
          target: user.id,
          action: 'user.create',
          team_id: null,
          diff: { username: user.username }
        })
        return json(200, toAdminUser(user))
      }
    },
    {
      method: 'POST',
      pattern: '/users/batch',
      handler: (request) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        return handleBatchUsers(state, auth.user.id, request)
      }
    },
    { method: 'POST', pattern: '/users/import', handler: (request) => handleImportUsers(state, request) },
    {
      method: 'GET',
      pattern: '/users/:id',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const user = findUser(state, params.id)
        return user ? json(200, toAdminUser(user)) : notFoundUser()
      }
    },
    {
      method: 'PATCH',
      pattern: '/users/:id',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const user = findUser(state, params.id)
        if (!user) return notFoundUser()
        const body = asRecord(request.body)
        if (!body) return problem(400, 'request body must be valid JSON')
        const username = optionalString(body.username)
        const displayName = optionalString(body.display_name)
        const hasEmail = 'email' in body
        const email = hasEmail ? optionalString(body.email) : undefined
        const status = body.status
        if (username === null && displayName === null && email === undefined && status === undefined) {
          return problem(400, 'at least one of username or display_name is required')
        }
        if (status !== undefined && status !== 'active' && status !== 'disabled') {
          return problem(400, 'status must be active or disabled')
        }
        if (username) {
          const clash = findUserByName(state, username)
          if (clash && clash.id !== user.id) return problem(409, 'username or email already exists')
          user.username = username
        }
        if (displayName) user.display_name = displayName
        if (hasEmail) user.email = email ?? null
        if (status !== undefined) user.status = status as UserStatus
        user.updated_at = nowIso()
        return json(200, toAdminUser(user))
      }
    },
    {
      method: 'DELETE',
      pattern: '/users/:id',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        if (!findUser(state, params.id)) return notFoundUser()
        state.users = state.users.filter((user) => user.id !== params.id)
        state.sessions = state.sessions.filter((session) => session.user_id !== params.id)
        state.bindings = state.bindings.filter(
          (binding) => !(binding.subject_kind === 'user' && binding.subject_id === params.id)
        )
        state.groupMembers = state.groupMembers.filter((member) => member.user_id !== params.id)
        state.passkeys.delete(params.id)
        recordAudit(state, {
          actor_id: auth.user.id,
          target: params.id,
          action: 'user.delete',
          team_id: null,
          diff: null
        })
        return noContent()
      }
    },
    {
      method: 'POST',
      pattern: '/users/:id/disable',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const user = findUser(state, params.id)
        if (!user) return notFoundUser()
        user.status = 'disabled'
        user.locked_until = null
        user.failed_logins = 0
        user.perm_ver += 1
        user.updated_at = nowIso()
        revokeUserSessions(state, user.id)
        recordAudit(state, {
          actor_id: auth.user.id,
          target: user.id,
          action: 'user.disable',
          team_id: null,
          diff: null
        })
        return json(200, toAdminUser(user))
      }
    },
    {
      method: 'POST',
      pattern: '/users/:id/approve',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const user = findUser(state, params.id)
        if (!user) return notFoundUser()
        if (!user.email_verified_at) return problem(422, 'email_not_verified')
        user.status = 'active'
        user.approved_at = nowIso()
        user.approved_by = auth.user.id
        user.updated_at = nowIso()
        recordAudit(state, {
          actor_id: auth.user.id,
          target: user.id,
          action: 'user.approve',
          team_id: null,
          diff: null
        })
        return json(200, toAdminUser(user))
      }
    },
    {
      method: 'POST',
      pattern: '/users/:id/credentials',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const user = findUser(state, params.id)
        if (!user) return notFoundUser()
        const body = asRecord(request.body)
        const kind = body ? body.kind : undefined
        if (kind !== 'password' && kind !== 'service') {
          return problem(400, 'kind must be password or service')
        }
        const response: ProvisionCredentialsResponse = {
          kind,
          user_id: user.id,
          username: user.username
        }
        if (kind === 'password') {
          const password = body ? optionalString(body.password) : null
          if (!password || !isStrongPassword(password)) return problem(422, 'weak_password')
          user.password = password
          user.must_change_password = false
          user.perm_ver += 1
          revokeUserSessions(state, user.id)
        } else {
          response.client_id = `svc-${user.username}`
          response.client_secret = randomHex()
        }
        recordAudit(state, {
          actor_id: auth.user.id,
          target: user.id,
          action: `user.credentials.${kind}`,
          team_id: null,
          diff: null
        })
        return json(200, response)
      }
    },
    {
      method: 'DELETE',
      pattern: '/users/:id/totp',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const user = findUser(state, params.id)
        if (!user) return notFoundUser()
        user.totp = { enabled: false, pending_secret: null, backup_codes: [] }
        recordAudit(state, {
          actor_id: auth.user.id,
          target: user.id,
          action: 'admin.totp_reset',
          team_id: null,
          diff: null
        })
        return noContent()
      }
    },
    {
      method: 'GET',
      pattern: '/users/:id/sessions',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'sessions', null)
        if (isDenied(denied)) return denied
        if (!findUser(state, params.id)) return notFoundUser()
        return json(200, sessionsOf(state, params.id).map(sessionWire))
      }
    },
    {
      method: 'DELETE',
      pattern: '/users/:id/sessions',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'sessions', null)
        if (isDenied(denied)) return denied
        if (!findUser(state, params.id)) return notFoundUser()
        revokeUserSessions(state, params.id)
        return noContent()
      }
    },
    {
      method: 'DELETE',
      pattern: '/users/:id/sessions/:sid',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'sessions', null)
        if (isDenied(denied)) return denied
        const session = state.sessions.find(
          (candidate) => candidate.id === params.sid && candidate.user_id === params.id
        )
        if (!session) return problem(404, 'the requested resource was not found')
        state.sessions = state.sessions.filter((candidate) => candidate.id !== session.id)
        for (const [token, entry] of state.refreshTokens) {
          if (entry.session_id === session.id) state.refreshTokens.delete(token)
        }
        return noContent()
      }
    },
    {
      method: 'POST',
      pattern: '/invitations',
      handler: (request) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const body = asRecord(request.body)
        const username = body ? optionalString(body.username) : null
        if (!username) return problem(400, 'request body must be valid JSON')
        if (findUserByName(state, username)) return problem(409, 'username or email already exists')
        const user: MockUser = {
          id: nextId(state),
          username,
          email: body ? optionalString(body.email) : null,
          display_name: body ? optionalString(body.display_name) ?? username : username,
          status: 'invited',
          perm_ver: 1,
          failed_logins: 0,
          email_verified_at: null,
          created_at: nowIso(),
          updated_at: nowIso(),
          approved_at: null,
          approved_by: null,
          locked_until: null,
          password: '',
          grants: [],
          must_change_password: true,
          team_ids: [],
          totp: { enabled: false, pending_secret: null, backup_codes: [] }
        }
        state.users.push(user)
        const response: InvitationResponse = { id: user.id, status: 'invited' }
        return json(200, response)
      }
    },
    {
      method: 'POST',
      pattern: '/invitations/:userID/resend',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const user = findUser(state, params.userID)
        if (!user) return notFoundUser()
        if (user.status !== 'invited') return problem(422, 'account is not invited')
        return noContent()
      }
    },
    {
      method: 'DELETE',
      pattern: '/invitations/:userID',
      handler: (request, params) => {
        const auth = adminUser(request)
        if (isDenied(auth)) return auth
        const denied = requireArea(auth.user, 'users', null)
        if (isDenied(denied)) return denied
        const user = findUser(state, params.userID)
        if (!user) return notFoundUser()
        if (user.status !== 'invited') return problem(422, 'account is not invited')
        state.users = state.users.filter((candidate) => candidate.id !== user.id)
        return noContent()
      }
    }
  ]
}

/* ------------------------------------------------------------------ *
 * Administrative plane — teams, groups, roles, permissions, bindings, audit
 * ------------------------------------------------------------------ */

function adminAuthorizationRoutes(state: MockState): MockRoute[] {
  const admin = (request: MockRequest) => authenticate(state, request, 'admin')

  const withArea = (
    request: MockRequest,
    area: string,
    teamId: string | null
  ): { user: MockUser; scope: 'any' | 'team' } | Response => {
    const auth = admin(request)
    if (isDenied(auth)) return auth
    const scope = allowArea(auth.user, area, teamId)
    if (!scope) return problem(403, 'insufficient_permissions')
    return { user: auth.user, scope }
  }

  return [
    {
      method: 'GET',
      pattern: '/teams',
      handler: (request) => {
        const granted = withArea(request, 'teams', null)
        if (isDenied(granted)) return granted
        const limit = pageLimit(request.query)
        if (limit === null) return problem(400, 'limit must be a positive integer')
        return json(200, pageSlice(state.teams, request.query.get('cursor'), limit, (team) => team.id))
      }
    },
    {
      method: 'POST',
      pattern: '/teams',
      handler: (request) => {
        const granted = withArea(request, 'teams', null)
        if (isDenied(granted)) return granted
        const body = asRecord(request.body)
        const slug = body ? optionalString(body.slug) : null
        const name = body ? optionalString(body.name) : null
        if (!slug || !name) return problem(400, 'request body must be valid JSON')
        if (state.teams.some((team) => team.slug === slug)) return problem(409, 'slug already exists')
        const team: Team = {
          id: nextId(state),
          slug,
          name,
          status: body ? optionalString(body.status) ?? 'active' : 'active',
          created_at: nowIso()
        }
        state.teams.push(team)
        recordAudit(state, {
          actor_id: granted.user.id,
          target: team.id,
          action: 'team.create',
          team_id: team.id,
          diff: { name: team.name }
        })
        return json(200, team)
      }
    },
    {
      method: 'GET',
      pattern: '/teams/:id',
      handler: (request, params) => {
        const granted = withArea(request, 'teams', params.id)
        if (isDenied(granted)) return granted
        const team = state.teams.find((candidate) => candidate.id === params.id)
        return team ? json(200, team) : problem(404, 'the requested resource was not found')
      }
    },
    {
      method: 'PATCH',
      pattern: '/teams/:id',
      handler: (request, params) => {
        const granted = withArea(request, 'teams', params.id)
        if (isDenied(granted)) return granted
        const team = state.teams.find((candidate) => candidate.id === params.id)
        if (!team) return problem(404, 'the requested resource was not found')
        const body = asRecord(request.body)
        if (!body) return problem(400, 'request body must be valid JSON')
        const name = optionalString(body.name)
        const slug = optionalString(body.slug)
        const status = optionalString(body.status)
        if (!name && !slug && !status) return problem(400, 'at least one field is required')
        if (name) team.name = name
        if (slug) team.slug = slug
        if (status) team.status = status
        return json(200, team)
      }
    },
    {
      method: 'DELETE',
      pattern: '/teams/:id',
      handler: (request, params) => {
        const granted = withArea(request, 'teams', params.id)
        if (isDenied(granted)) return granted
        if (!state.teams.some((team) => team.id === params.id)) {
          return problem(404, 'the requested resource was not found')
        }
        state.teams = state.teams.filter((team) => team.id !== params.id)
        state.groups = state.groups.filter((group) => group.team_id !== params.id)
        state.groupMembers = state.groupMembers.filter((member) => member.team_id !== params.id)
        state.roles = state.roles.filter((role) => role.team_id !== params.id)
        state.bindings = state.bindings.filter((binding) => binding.team_id !== params.id)
        return noContent()
      }
    },

    {
      method: 'GET',
      pattern: '/groups',
      handler: (request) => {
        const teamId = optionalString(request.query.get('team_id'))
        if (!teamId) return problem(400, 'team_id is required')
        const granted = withArea(request, 'groups', teamId)
        if (isDenied(granted)) return granted
        const limit = pageLimit(request.query)
        if (limit === null) return problem(400, 'limit must be a positive integer')
        const groups = state.groups.filter((group) => group.team_id === teamId)
        return json(200, pageSlice(groups, request.query.get('cursor'), limit, (group) => group.id))
      }
    },
    {
      method: 'POST',
      pattern: '/groups',
      handler: (request) => {
        const body = asRecord(request.body)
        const teamId = body ? optionalString(body.team_id) : null
        const name = body ? optionalString(body.name) : null
        if (!teamId || !name) return problem(400, 'request body must be valid JSON')
        const granted = withArea(request, 'groups', teamId)
        if (isDenied(granted)) return granted
        if (!state.teams.some((team) => team.id === teamId)) {
          return problem(404, 'the requested resource was not found')
        }
        const group: Group = { id: nextId(state), team_id: teamId, name }
        state.groups.push(group)
        return json(200, group)
      }
    },
    {
      method: 'GET',
      pattern: '/groups/:id',
      handler: (request, params) => {
        const group = state.groups.find((candidate) => candidate.id === params.id)
        if (!group) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'groups', group.team_id)
        return isDenied(granted) ? granted : json(200, group)
      }
    },
    {
      method: 'PATCH',
      pattern: '/groups/:id',
      handler: (request, params) => {
        const group = state.groups.find((candidate) => candidate.id === params.id)
        if (!group) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'groups', group.team_id)
        if (isDenied(granted)) return granted
        const body = asRecord(request.body)
        if (!body) return problem(400, 'request body must be valid JSON')
        const name = optionalString(body.name)
        const teamId = optionalString(body.team_id)
        if (!name && !teamId) return problem(400, 'at least one field is required')
        if (teamId) {
          const moved = withArea(request, 'groups', teamId)
          if (isDenied(moved)) return moved
          group.team_id = teamId
          for (const member of state.groupMembers) {
            if (member.group_id === group.id) member.team_id = teamId
          }
        }
        if (name) group.name = name
        return json(200, group)
      }
    },
    {
      method: 'DELETE',
      pattern: '/groups/:id',
      handler: (request, params) => {
        const group = state.groups.find((candidate) => candidate.id === params.id)
        if (!group) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'groups', group.team_id)
        if (isDenied(granted)) return granted
        state.groups = state.groups.filter((candidate) => candidate.id !== group.id)
        state.groupMembers = state.groupMembers.filter((member) => member.group_id !== group.id)
        state.bindings = state.bindings.filter(
          (binding) => !(binding.subject_kind === 'group' && binding.subject_id === group.id)
        )
        return noContent()
      }
    },
    {
      method: 'PUT',
      pattern: '/groups/:id/members',
      handler: (request, params) => {
        const group = state.groups.find((candidate) => candidate.id === params.id)
        if (!group) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'groups', group.team_id)
        if (isDenied(granted)) return granted
        const body = asRecord(request.body)
        const userId = body ? optionalString(body.user_id) : null
        if (!userId) return problem(400, 'request body must be valid JSON')
        if (!findUser(state, userId)) return notFoundUser()
        const expiresAt = body && typeof body.expires_at === 'string' ? body.expires_at : null
        const existing = state.groupMembers.find(
          (member) => member.group_id === group.id && member.user_id === userId
        )
        if (existing) {
          existing.expires_at = expiresAt
        } else {
          state.groupMembers.push({
            team_id: group.team_id,
            group_id: group.id,
            user_id: userId,
            expires_at: expiresAt
          })
        }
        const member: GroupMember = {
          team_id: group.team_id,
          group_id: group.id,
          user_id: userId,
          expires_at: expiresAt
        }
        return json(200, member)
      }
    },
    {
      method: 'DELETE',
      pattern: '/groups/:id/members/:userID',
      handler: (request, params) => {
        const group = state.groups.find((candidate) => candidate.id === params.id)
        if (!group) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'groups', group.team_id)
        if (isDenied(granted)) return granted
        const before = state.groupMembers.length
        state.groupMembers = state.groupMembers.filter(
          (member) => !(member.group_id === group.id && member.user_id === params.userID)
        )
        if (state.groupMembers.length === before) {
          return problem(404, 'the requested resource was not found')
        }
        return noContent()
      }
    },
    {
      method: 'DELETE',
      pattern: '/groups/:id/members',
      handler: (request, params) => {
        const group = state.groups.find((candidate) => candidate.id === params.id)
        if (!group) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'groups', group.team_id)
        if (isDenied(granted)) return granted
        const body = asRecord(request.body)
        const userId = body ? optionalString(body.user_id) : null
        if (!userId) return problem(400, 'request body must be valid JSON')
        state.groupMembers = state.groupMembers.filter(
          (member) => !(member.group_id === group.id && member.user_id === userId)
        )
        return noContent()
      }
    },
    {
      method: 'POST',
      pattern: '/groups/:id/members/batch',
      handler: (request, params) => {
        const group = state.groups.find((candidate) => candidate.id === params.id)
        if (!group) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'groups', group.team_id)
        if (isDenied(granted)) return granted
        const body = asRecord(request.body)
        const ids = body && Array.isArray(body.user_ids) ? body.user_ids : null
        if (!ids) return problem(400, 'request body must be valid JSON')
        if (ids.length > 500) return problem(422, 'a maximum of 500 user_ids is allowed')
        const results = ids.map((rawId) => {
          const id = String(rawId)
          if (!findUser(state, id)) return { id, ok: false, error: 'not_found' }
          const exists = state.groupMembers.some(
            (member) => member.group_id === group.id && member.user_id === id
          )
          if (exists) return { id, ok: false, error: 'already_member' }
          state.groupMembers.push({
            team_id: group.team_id,
            group_id: group.id,
            user_id: id,
            expires_at: null
          })
          return { id, ok: true }
        })
        return json(200, { results })
      }
    },

    {
      method: 'GET',
      pattern: '/roles',
      handler: (request) => {
        const teamId = optionalString(request.query.get('team_id'))
        const granted = withArea(request, 'roles', teamId)
        if (isDenied(granted)) return granted
        const limit = pageLimit(request.query)
        if (limit === null) return problem(400, 'limit must be a positive integer')
        const roles = teamId
          ? state.roles.filter((role) => role.team_id === teamId)
          : state.roles
        return json(
          200,
          pageSlice(roles.map(roleWire), request.query.get('cursor'), limit, (role) => role.id)
        )
      }
    },
    {
      method: 'POST',
      pattern: '/roles',
      handler: (request) => {
        const body = asRecord(request.body)
        const name = body ? optionalString(body.name) : null
        const teamId = body ? optionalString(body.team_id) : null
        if (!name) return problem(400, 'request body must be valid JSON')
        const granted = withArea(request, 'roles', teamId)
        if (isDenied(granted)) return granted
        if (teamId && !state.teams.some((team) => team.id === teamId)) {
          return problem(404, 'the requested resource was not found')
        }
        const role: MockRole = { id: nextId(state), team_id: teamId, name, permissions: [] }
        state.roles.push(role)
        return json(200, roleWire(role))
      }
    },
    {
      method: 'GET',
      pattern: '/roles/:id',
      handler: (request, params) => {
        const role = state.roles.find((candidate) => candidate.id === params.id)
        if (!role) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'roles', role.team_id)
        return isDenied(granted) ? granted : json(200, roleWire(role))
      }
    },
    {
      method: 'PATCH',
      pattern: '/roles/:id',
      handler: (request, params) => {
        const role = state.roles.find((candidate) => candidate.id === params.id)
        if (!role) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'roles', role.team_id)
        if (isDenied(granted)) return granted
        const body = asRecord(request.body)
        if (!body) return problem(400, 'request body must be valid JSON')
        const name = optionalString(body.name)
        const teamId = optionalString(body.team_id)
        if (!name && !teamId) return problem(400, 'at least one field is required')
        if (teamId && granted.scope !== 'any') {
          return problem(403, 'insufficient_permissions')
        }
        if (teamId) {
          const moved = withArea(request, 'roles', teamId)
          if (isDenied(moved)) return moved
          role.team_id = teamId
        }
        if (name) role.name = name
        return json(200, roleWire(role))
      }
    },
    {
      method: 'DELETE',
      pattern: '/roles/:id',
      handler: (request, params) => {
        const role = state.roles.find((candidate) => candidate.id === params.id)
        if (!role) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'roles', role.team_id)
        if (isDenied(granted)) return granted
        state.roles = state.roles.filter((candidate) => candidate.id !== role.id)
        state.bindings = state.bindings.filter((binding) => binding.role_id !== role.id)
        return noContent()
      }
    },
    {
      method: 'PUT',
      pattern: '/roles/:id/permissions',
      handler: (request, params) => {
        const role = state.roles.find((candidate) => candidate.id === params.id)
        if (!role) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'roles', role.team_id)
        if (isDenied(granted)) return granted
        const body = asRecord(request.body)
        const raw = body
          ? Array.isArray(body.permission_keys)
            ? body.permission_keys
            : Array.isArray(body.permissions)
              ? body.permissions
              : null
          : null
        if (!raw) return problem(400, 'request body must be valid JSON')
        const keys = raw.map((key) => String(key))

        for (const key of keys) {
          if (!isValidPermissionKey(key)) {
            return problem(422, 'permission must use resource:action:scope grammar')
          }
          if (!state.permissions.some((record) => record.key === key)) {
            return problem(422, `permission is not registered: ${key}`)
          }
        }
        if (granted.scope === 'team' && keys.some((key) => permissionScope(key) !== 'team')) {
          return problem(403, 'insufficient_permissions')
        }

        role.permissions = keys
        recordAudit(state, {
          actor_id: granted.user.id,
          target: role.id,
          action: 'role.permissions.replace',
          team_id: role.team_id,
          diff: { permissions: keys }
        })
        const response: RolePermissionsResponse = { role_id: role.id, permissions: [...keys] }
        return json(200, response)
      }
    },

    {
      method: 'GET',
      pattern: '/permissions',
      handler: (request) => {
        const granted = withArea(request, 'permissions', null)
        if (isDenied(granted)) return granted
        const limit = pageLimit(request.query)
        if (limit === null) return problem(400, 'limit must be a positive integer')
        return json(
          200,
          pageSlice(
            state.permissions.map(permissionWire),
            request.query.get('cursor'),
            limit,
            (record) => record.key
          )
        )
      }
    },
    {
      method: 'POST',
      pattern: '/permissions',
      handler: (request) => {
        const granted = withArea(request, 'permissions', null)
        if (isDenied(granted)) return granted
        const body = asRecord(request.body)
        const key = body ? optionalString(body.key) : null
        const registeredBy = body ? optionalString(body.registered_by) : null
        if (!key || !registeredBy) return problem(400, 'request body must be valid JSON')
        if (!isValidPermissionKey(key)) {
          return problem(422, 'permission must use resource:action:scope grammar')
        }
        const existing = state.permissions.find((record) => record.key === key)
        if (existing) {
          existing.description = body ? optionalString(body.description) ?? existing.description : existing.description
          existing.registered_by = registeredBy
          return json(200, permissionWire(existing))
        }
        const record: PermissionRecord = {
          key,
          description: body ? optionalString(body.description) ?? '' : '',
          registered_by: registeredBy,
          created_at: nowIso()
        }
        state.permissions.push(record)
        return json(200, permissionWire(record))
      }
    },

    {
      method: 'GET',
      pattern: '/bindings',
      handler: (request) => {
        const granted = withArea(request, 'bindings', null)
        if (isDenied(granted)) return granted
        const subjectKind = optionalString(request.query.get('subject_kind'))
        const subjectId = optionalString(request.query.get('subject_id'))
        if (!subjectKind || !subjectId) {
          return problem(400, 'subject_kind and subject_id are required')
        }
        const limit = pageLimit(request.query)
        if (limit === null) return problem(400, 'limit must be a positive integer')
        const bindings = state.bindings.filter(
          (binding) => binding.subject_kind === subjectKind && binding.subject_id === subjectId
        )
        return json(
          200,
          pageSlice(bindings, request.query.get('cursor'), limit, (binding) => binding.id)
        )
      }
    },
    {
      method: 'POST',
      pattern: '/bindings',
      handler: (request) => {
        const body = asRecord(request.body)
        const roleId = body ? optionalString(body.role_id) : null
        const subjectKind = body ? optionalString(body.subject_kind) : null
        const subjectId = body ? optionalString(body.subject_id) : null
        if (!roleId || !subjectKind || !subjectId) {
          return problem(400, 'request body must be valid JSON')
        }
        const role = state.roles.find((candidate) => candidate.id === roleId)
        if (!role) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'bindings', role.team_id)
        if (isDenied(granted)) return granted
        if (subjectKind === 'user' && !findUser(state, subjectId)) return notFoundUser()
        if (subjectKind === 'group' && !state.groups.some((group) => group.id === subjectId)) {
          return problem(404, 'the requested resource was not found')
        }
        const binding: Binding = {
          id: nextId(state),
          team_id: role.team_id,
          role_id: role.id,
          subject_kind: subjectKind === 'group' ? 'group' : 'user',
          subject_id: subjectId,
          condition: body ? optionalString(body.condition) ?? '' : '',
          expires_at: body && typeof body.expires_at === 'string' ? body.expires_at : null
        }
        state.bindings.push(binding)
        recordAudit(state, {
          actor_id: granted.user.id,
          target: binding.id,
          action: 'binding.create',
          team_id: binding.team_id,
          diff: { role_id: binding.role_id }
        })
        return json(200, binding)
      }
    },
    {
      method: 'DELETE',
      pattern: '/bindings/:id',
      handler: (request, params) => {
        const binding = state.bindings.find((candidate) => candidate.id === params.id)
        if (!binding) return problem(404, 'the requested resource was not found')
        const granted = withArea(request, 'bindings', binding.team_id)
        if (isDenied(granted)) return granted
        state.bindings = state.bindings.filter((candidate) => candidate.id !== binding.id)
        return noContent()
      }
    },

    {
      method: 'GET',
      pattern: '/audit',
      handler: (request) => {
        const granted = withArea(request, 'audit', null)
        if (isDenied(granted)) return granted
        const limit = pageLimit(request.query)
        if (limit === null) return problem(400, 'limit must be a positive integer')
        const rawCursor = request.query.get('cursor') ?? '0'
        const cursor = Number(rawCursor)
        if (!Number.isInteger(cursor) || cursor < 0) {
          return problem(400, 'cursor must be a non-negative integer')
        }
        const teamId = optionalString(request.query.get('team_id'))
        const remaining = state.audit
          .filter((entry) => entry.id > cursor)
          .filter((entry) => !teamId || entry.team_id === teamId)
        const page = remaining.slice(0, limit)
        const next = remaining.length > page.length ? page[page.length - 1].id : 0
        return json(200, { items: page.map((entry) => ({ ...entry })), next_cursor: next })
      }
    }
  ]
}

/** Every route the console can reach, ordered so specific patterns win. */
export function buildRoutes(state: MockState): MockRoute[] {
  const routes = [
    ...authRoutes(state),
    ...meRoutes(state),
    ...adminUserRoutes(state),
    ...adminAuthorizationRoutes(state)
  ].map((route) => ({ ...route, handler: guarded(route.handler) }))

  return routes.sort((a, b) => {
    const paramsA = a.pattern.split('/').filter((segment) => segment.startsWith(':')).length
    const paramsB = b.pattern.split('/').filter((segment) => segment.startsWith(':')).length
    if (paramsA !== paramsB) return paramsA - paramsB
    return b.pattern.length - a.pattern.length
  })
}
