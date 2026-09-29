import { ApiError } from './errors'
import { http } from './client'
import type {
  InviteAcceptRequest,
  LoginRequest,
  LoginResponse,
  LogoutRequest,
  MfaLoginRequest,
  PasskeyLoginBeginResponse,
  PasskeyLoginFinishRequest,
  PasswordResetConfirmRequest,
  PasswordResetRequestRequest,
  RefreshRequest,
  RegisterRequest,
  RegisterResponse,
  TokenPair,
  VerifyEmailRequest
} from './types'

/**
 * Every `/auth/*` endpoint a browser is allowed to call.
 *
 * Endpoints of this plane that are intentionally not wrapped:
 * - `POST /auth/client-credentials` — public, but it returns a service token
 *   from a client secret; no browser build may hold that secret.
 * - `POST /auth/introspect` — `authenticateBearer(r, "service")`; a user token
 *   is rejected, so it is unreachable from the SPA.
 * - `GET /.well-known/jwks.json` — the console never verifies token signatures
 *   locally (it has no trusted copy of the keys), and no other client-side use
 *   exists for service-issued tokens.
 */

/**
 * Outcome of a password login. The service answers 200 with a token pair, 200
 * with an MFA challenge (undocumented in openapi.yaml), or 403 with
 * `password_change_required` plus an extra `change_token` member.
 */
export type LoginResult =
  | { step: 'authenticated'; tokens: TokenPair }
  | { step: 'mfa_required'; mfaToken: string }
  | { step: 'password_change_required'; changeToken: string; problem: ApiError }

export async function login(payload: LoginRequest): Promise<LoginResult> {
  try {
    const body = await http.post<LoginResponse>('/auth/login', payload, { auth: false })
    if ('mfa_required' in body) return { step: 'mfa_required', mfaToken: body.mfa_token }
    return { step: 'authenticated', tokens: body }
  } catch (error) {
    if (error instanceof ApiError && error.status === 403 && error.changeToken) {
      return { step: 'password_change_required', changeToken: error.changeToken, problem: error }
    }
    throw error
  }
}

/** Second step of an MFA login; `code` is a TOTP code or a backup code. */
export async function loginMfa(payload: MfaLoginRequest): Promise<TokenPair> {
  return await http.post<TokenPair>('/auth/login/mfa', payload, { auth: false })
}

/** Rotates the refresh token; the presented token is revoked by the service. */
export async function refresh(payload: RefreshRequest | string): Promise<TokenPair> {
  const body: RefreshRequest = typeof payload === 'string' ? { refresh_token: payload } : payload
  return await http.post<TokenPair>('/auth/refresh', body, { auth: false })
}

/** Always answers 204, even for unknown or already-revoked tokens. */
export async function logout(payload: LogoutRequest | string): Promise<void> {
  const body: LogoutRequest = typeof payload === 'string' ? { refresh_token: payload } : payload
  await http.post<void>('/auth/logout', body, { auth: false, responseType: 'none' })
}

/** Answers 201 Created (openapi.yaml wrongly documents 200). */
export async function register(payload: RegisterRequest): Promise<RegisterResponse> {
  return await http.post<RegisterResponse>('/auth/register', payload, { auth: false })
}

export async function verifyEmail(payload: VerifyEmailRequest | string): Promise<void> {
  const body: VerifyEmailRequest = typeof payload === 'string' ? { token: payload } : payload
  await http.post<void>('/auth/verify-email', body, { auth: false, responseType: 'none' })
}

/** Never enumerates accounts and always answers 204. */
export async function requestPasswordReset(payload: PasswordResetRequestRequest | string): Promise<void> {
  const body: PasswordResetRequestRequest = typeof payload === 'string' ? { login: payload } : payload
  await http.post<void>('/auth/password-reset/request', body, { auth: false, responseType: 'none' })
}

export async function confirmPasswordReset(payload: PasswordResetConfirmRequest): Promise<void> {
  await http.post<void>('/auth/password-reset/confirm', payload, { auth: false, responseType: 'none' })
}

export async function acceptInvitation(payload: InviteAcceptRequest): Promise<void> {
  await http.post<void>('/auth/invite/accept', payload, { auth: false, responseType: 'none' })
}

/** Omit `username` for a discoverable (usernameless) assertion. */
export async function passkeyLoginBegin(username?: string): Promise<PasskeyLoginBeginResponse> {
  return await http.post<PasskeyLoginBeginResponse>(
    '/auth/passkey/login/begin',
    username ? { username } : undefined,
    { auth: false }
  )
}

export async function passkeyLoginFinish(credential: PasskeyLoginFinishRequest): Promise<TokenPair> {
  return await http.post<TokenPair>('/auth/passkey/login/finish', credential, { auth: false })
}
