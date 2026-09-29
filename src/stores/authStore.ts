import { computed, reactive, readonly } from 'vue'

import * as authApi from '@/api/auth'
import { setAuthHandlers } from '@/api/client'
import { ApiError, clientError, messageForError } from '@/api/errors'
import * as meApi from '@/api/me'
import type { Profile, TokenPair } from '@/api/types'

/**
 * Authentication and session plane.
 *
 * Storage policy: the access token and its expiry never leave this module
 * (memory only, 10 minute lifetime), while the opaque refresh token lives in
 * `sessionStorage` so a tab reload can resume the session without a
 * localStorage decision. Nothing else is persisted.
 */

const REFRESH_TOKEN_STORAGE_KEY = 'nsc-teamusers.refresh_token'
/** Renew slightly before the real expiry so a request never races the 10 minute TTL. */
const EXPIRY_SKEW_MS = 30_000

export type AuthStatus = 'anonymous' | 'authenticating' | 'authenticated'

/** Which step the login screen must present next. */
export type LoginStep = 'authenticated' | 'mfa_required' | 'password_change_required'

const session = reactive({
  user: null as Profile | null,
  permissions: [] as string[],
  status: 'anonymous' as AuthStatus,
  /** Set when the profile could not be loaded although the session is valid. */
  identityError: null as string | null
})

let accessToken: string | null = null
let accessTokenExpiresAt = 0
let pendingMfaToken: string | null = null
let pendingChangeToken: string | null = null
let pendingUsername: string | null = null
let pendingPassword: string | null = null
let bootstrapInFlight: Promise<boolean> | null = null

function readStoredRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_TOKEN_STORAGE_KEY)
  } catch {
    // Storage can be unavailable (private mode, blocked cookies): the session
    // then simply does not survive a reload.
    return null
  }
}

function writeStoredRefreshToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token)
    else sessionStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY)
  } catch {
    /* see readStoredRefreshToken */
  }
}

function storeTokens(tokens: TokenPair): void {
  accessToken = tokens.access_token
  accessTokenExpiresAt = Date.now() + Math.max(tokens.expires_in, 0) * 1000
  writeStoredRefreshToken(tokens.refresh_token)
  session.status = 'authenticated'
}

export function clearSession(): void {
  accessToken = null
  accessTokenExpiresAt = 0
  pendingMfaToken = null
  pendingChangeToken = null
  pendingUsername = null
  pendingPassword = null
  session.user = null
  session.permissions = []
  session.identityError = null
  session.status = 'anonymous'
  writeStoredRefreshToken(null)
}

/** Mirrors `/me` plus the permission keys from `/me/export`. */
async function loadIdentity(): Promise<void> {
  try {
    const [profile, exported] = await Promise.all([meApi.getProfile(), meApi.exportAccount()])
    session.user = profile
    session.permissions = exported.effective_permissions ?? []
    session.identityError = null
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearSession()
      throw error
    }
    // The session itself is still usable; surface the failure without dropping it.
    session.identityError = messageForError(error)
  }
}

export function hasRefreshToken(): boolean {
  return readStoredRefreshToken() !== null
}

/**
 * Rotates the refresh token and stores the new pair. Tokens only — identity
 * loading is the caller's job, which keeps a failing `/me` from re-entering
 * the client's refresh-and-retry hook.
 */
export async function refresh(): Promise<boolean> {
  const token = readStoredRefreshToken()
  if (!token) {
    clearSession()
    return false
  }
  try {
    storeTokens(await authApi.refresh(token))
    return true
  } catch {
    // Rotation failure (expired, family cap, reuse detection) always ends the session.
    clearSession()
    return false
  }
}

/**
 * Restores a session from `sessionStorage`. Idempotent and single-flight: the
 * router guard and the app bootstrap may both await it.
 */
export function bootstrap(): Promise<boolean> {
  if (!bootstrapInFlight) {
    bootstrapInFlight = (async () => {
      if (session.status === 'authenticated') return true
      if (!hasRefreshToken()) return false
      if (!(await refresh())) return false
      await loadIdentity()
      return true
    })().finally(() => {
      bootstrapInFlight = null
    })
  }
  return bootstrapInFlight
}

/** Access token valid for at least another `EXPIRY_SKEW_MS`, or a renewed one, or `null`. */
export async function ensureFreshToken(): Promise<string | null> {
  if (accessToken && Date.now() < accessTokenExpiresAt - EXPIRY_SKEW_MS) return accessToken
  if (!(await refresh())) return null
  return accessToken
}

export async function login(username: string, password: string): Promise<LoginStep> {
  session.status = 'authenticating'
  try {
    const result = await authApi.login({ username, password })

    if (result.step === 'authenticated') {
      storeTokens(result.tokens)
      await loadIdentity()
      return 'authenticated'
    }

    if (result.step === 'mfa_required') {
      pendingMfaToken = result.mfaToken
      pendingUsername = username
      session.status = 'anonymous'
      return 'mfa_required'
    }

    pendingChangeToken = result.changeToken
    pendingUsername = username
    pendingPassword = password
    session.status = 'anonymous'
    return 'password_change_required'
  } catch (error) {
    session.status = 'anonymous'
    throw error
  }
}

/** Second step of an MFA login; `code` is a TOTP code or a backup code. */
export async function completeMfa(code: string): Promise<void> {
  if (!pendingMfaToken) throw clientError('client_no_mfa_challenge')
  const tokens = await authApi.loginMfa({ mfa_token: pendingMfaToken, code })
  pendingMfaToken = null
  storeTokens(tokens)
  await loadIdentity()
}

/**
 * Adopts a token pair issued outside the password flow (a passkey assertion).
 * The tokens take the same storage path as a password login; when the identity
 * load fails the session is dropped again and the error is rethrown, so the
 * caller never ends up half signed in.
 */
export async function adoptTokens(tokens: TokenPair): Promise<void> {
  storeTokens(tokens)
  try {
    await loadIdentity()
  } catch (error) {
    clearSession()
    throw error
  }
}

/**
 * Finishes the forced first-login password change with the `change_token` from
 * the login response, then signs in again: the service revokes every session on
 * a password change, and the new password may itself require MFA.
 */
export async function completeForcedPasswordChange(newPassword: string): Promise<LoginStep> {
  const changeToken = pendingChangeToken
  const username = pendingUsername
  const currentPassword = pendingPassword
  if (!changeToken || !username) throw clientError('client_no_change_token')

  await meApi.changePassword(
    currentPassword
      ? { new_password: newPassword, current_password: currentPassword }
      : { new_password: newPassword },
    { changeToken }
  )
  pendingChangeToken = null
  pendingPassword = null
  session.status = 'anonymous'
  return await login(username, newPassword)
}

/** Revokes the refresh-token family server-side; local state is cleared regardless. */
export async function logout(): Promise<void> {
  const token = readStoredRefreshToken()
  if (token) {
    try {
      await authApi.logout(token)
    } catch {
      /* Best effort: an unreachable server must not keep the client signed in. */
    }
  }
  clearSession()
}

/** A grant matches when it is equal to `required`, or uses `*` inside a segment. */
function permissionMatches(granted: string, required: string): boolean {
  const key = granted.startsWith('!') ? granted.slice(1) : granted
  const grantSegments = key.split(':')
  const requiredSegments = required.split(':')
  if (grantSegments.length !== requiredSegments.length) return false
  return grantSegments.every(
    (segment, index) => segment === '*' || segment === requiredSegments[index]
  )
}

/**
 * Advisory check against the permission keys from `/me/export` (the only
 * browser-reachable source of a user's own grants). An explicit deny wins over
 * an allow, matching the server's evaluation. The server remains authoritative:
 * screens must still handle `403 insufficient_permissions`.
 */
export function hasPermission(required: string): boolean {
  const grants = session.permissions.filter((grant) => permissionMatches(grant, required))
  if (grants.some((grant) => grant.startsWith('!'))) return false
  return grants.length > 0
}

/** True when at least one of the alternative grants is held. */
export function hasAnyPermission(required: string[]): boolean {
  return required.some((key) => hasPermission(key))
}

setAuthHandlers({
  getAccessToken: () => accessToken,
  refresh
})

export const authStore = {
  state: readonly(session),
  isAuthenticated: computed(() => session.status === 'authenticated'),
  currentUser: computed(() => session.user),
  permissions: computed(() => session.permissions),
  hasPermission,
  hasAnyPermission,
  hasRefreshToken,
  bootstrap,
  login,
  completeMfa,
  adoptTokens,
  completeForcedPasswordChange,
  refresh,
  logout,
  ensureFreshToken,
  clearSession
}
