import { http } from './client'
import type {
  BackupCodesResponse,
  ChangeEmailRequest,
  ChangePasswordRequest,
  ChangePasswordResponse,
  ConfirmEmailRequest,
  DeleteAccountRequest,
  ExportResponse,
  PasskeyInfo,
  PasskeyRegisterBeginResponse,
  PasskeyRegistrationFinishRequest,
  Profile,
  SessionInfo,
  TotpConfirmRequest,
  TotpDisableRequest,
  TotpEnrollResponse,
  TotpBackupCodesRequest,
  UpdateProfileRequest
} from './types'

/**
 * The `/me/*` self-service plane. Every call needs a user-kind access token
 * (`requireMeSubject` rejects service subjects with 401).
 */

export async function getProfile(): Promise<Profile> {
  return await http.get<Profile>('/me')
}

export async function updateProfile(payload: UpdateProfileRequest): Promise<Profile> {
  return await http.patch<Profile>('/me', payload)
}

/** Irreversible: anonymizes and disables the account. */
export async function deleteAccount(payload: DeleteAccountRequest): Promise<void> {
  await http.delete<void>('/me', payload, { responseType: 'none' })
}

/**
 * Changes the password; the service revokes every session, so callers must
 * re-authenticate afterwards.
 *
 * `options.changeToken` authorizes the forced first-login change: the
 * `change_token` from the 403 login response is accepted as bearer on this
 * endpoint only, and the refresh-retry is disabled for it (a refresh would
 * replace the bearer the service expects).
 */
export async function changePassword(
  payload: ChangePasswordRequest,
  options: { changeToken?: string } = {}
): Promise<ChangePasswordResponse> {
  const requestOptions = options.changeToken
    ? { token: options.changeToken, auth: false }
    : undefined
  return await http.post<ChangePasswordResponse>('/me/password', payload, requestOptions)
}

export async function requestEmailChange(payload: ChangeEmailRequest): Promise<void> {
  await http.post<void>('/me/email', payload, { responseType: 'none' })
}

export async function confirmEmailChange(payload: ConfirmEmailRequest | string): Promise<void> {
  const body: ConfirmEmailRequest = typeof payload === 'string' ? { token: payload } : payload
  await http.post<void>('/me/email/confirm', body, { responseType: 'none' })
}

/** Data-portability export; also the only source of `effective_permissions` for the SPA. */
export async function exportAccount(): Promise<ExportResponse> {
  return await http.get<ExportResponse>('/me/export')
}

/** Not paginated: the service returns a bare array. */
export async function listSessions(): Promise<SessionInfo[]> {
  return await http.get<SessionInfo[]>('/me/sessions')
}

export async function revokeSession(sessionId: string): Promise<void> {
  await http.delete<void>(`/me/sessions/${encodeURIComponent(sessionId)}`, undefined, {
    responseType: 'none'
  })
}

/** Per-session outcome of `revokeAllSessions`; `error` is whatever the delete threw. */
export interface RevokedSessionsResult {
  revoked: string[]
  failed: Array<{ id: string; error: unknown }>
}

/**
 * Revokes every refresh session of the caller.
 *
 * The self-service plane has no bulk endpoint (`DELETE /me/sessions` does not
 * exist), so the list is read and each id deleted in turn. Revoking the session
 * this browser is using is unavoidable when the caller asks for all of them —
 * its refresh token dies with the rest, which is why the caller has to sign out
 * afterwards. Individual failures are collected instead of aborting, so a
 * partially revoked list is still reported honestly.
 */
export async function revokeAllSessions(): Promise<RevokedSessionsResult> {
  const sessions = await listSessions()
  const revoked: string[] = []
  const failed: RevokedSessionsResult['failed'] = []

  for (const session of sessions) {
    try {
      await revokeSession(session.id)
      revoked.push(session.id)
    } catch (error) {
      failed.push({ id: session.id, error })
    }
  }

  return { revoked, failed }
}

export async function enrollTotp(): Promise<TotpEnrollResponse> {
  return await http.post<TotpEnrollResponse>('/me/totp/enroll')
}

/** Returns the backup codes exactly once. */
export async function confirmTotp(payload: TotpConfirmRequest): Promise<BackupCodesResponse> {
  return await http.post<BackupCodesResponse>('/me/totp/confirm', payload)
}

export async function regenerateBackupCodes(payload: TotpBackupCodesRequest): Promise<BackupCodesResponse> {
  return await http.post<BackupCodesResponse>('/me/totp/backup-codes', payload)
}

export async function disableTotp(payload: TotpDisableRequest): Promise<void> {
  await http.delete<void>('/me/totp', payload, { responseType: 'none' })
}

/** Not paginated: the service returns a bare array of `{id, created_at}`. */
export async function listPasskeys(): Promise<PasskeyInfo[]> {
  return await http.get<PasskeyInfo[]>('/me/passkeys')
}

export async function beginPasskeyRegistration(): Promise<PasskeyRegisterBeginResponse> {
  return await http.post<PasskeyRegisterBeginResponse>('/me/passkeys/register/begin')
}

export async function finishPasskeyRegistration(payload: PasskeyRegistrationFinishRequest): Promise<void> {
  await http.post<void>('/me/passkeys/register/finish', payload, { responseType: 'none' })
}

/** `credentialId` is the unpadded base64url id returned by `listPasskeys`. */
export async function deletePasskey(credentialId: string): Promise<void> {
  await http.delete<void>(`/me/passkeys/${encodeURIComponent(credentialId)}`, undefined, {
    responseType: 'none'
  })
}
