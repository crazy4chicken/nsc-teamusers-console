import { http, newIdempotencyKey } from '@/api/client'
import { pageQuery, type PageQuery } from '@/api/pagination'
import type {
  AdminUser,
  AdminUserSummary,
  CreateInvitationRequest,
  CreateUserRequest,
  CursorPage,
  InvitationResponse,
  ProvisionCredentialsRequest,
  ProvisionCredentialsResponse,
  SessionInfo,
  UpdateUserRequest
} from '@/api/types'

/**
 * Administrative user plane: `/users`, `/users/{id}/…` and `/invitations`.
 *
 * `GET /users` accepts only `cursor` and `limit` — the handler implements no
 * search, status filter or sort parameter, so the list screens are search-free
 * by construction.
 *
 * Grants: everything here needs `iam:users:any` except the session
 * sub-resources, which need `iam:sessions:any`.
 *
 * Mutating calls carry an `Idempotency-Key`; the service fingerprints key plus
 * body plus credential, so a retried submit replays instead of repeating.
 * `POST` requests get their key from the client automatically; `PATCH`/`DELETE`
 * requests send one explicitly.
 */

/** First page when `cursor` is omitted; `limit` defaults to the service value (100). */
export async function listUsers(page: PageQuery = {}): Promise<CursorPage<AdminUserSummary>> {
  return await http.get<CursorPage<AdminUserSummary>>('/users', { query: pageQuery(page) })
}

export async function getUser(userId: string): Promise<AdminUser> {
  return await http.get<AdminUser>(`/users/${encodeURIComponent(userId)}`)
}

/** Creates an active user. `password` takes precedence over `initial_password`. */
export async function createUser(payload: CreateUserRequest): Promise<AdminUser> {
  return await http.post<AdminUser>('/users', payload)
}

/** At least one field must be present; the service rejects an empty patch. */
export async function updateUser(userId: string, payload: UpdateUserRequest): Promise<AdminUser> {
  return await http.patch<AdminUser>(`/users/${encodeURIComponent(userId)}`, payload, {
    idempotencyKey: newIdempotencyKey()
  })
}

/** Hard delete: cascades to sessions, bindings and memberships. */
export async function deleteUser(userId: string): Promise<void> {
  await http.delete<void>(`/users/${encodeURIComponent(userId)}`, undefined, {
    idempotencyKey: newIdempotencyKey(),
    responseType: 'none'
  })
}

/** Lock switch: resets the lockout, revokes every session and bumps `perm_ver`. */
export async function disableUser(userId: string): Promise<AdminUser> {
  return await http.post<AdminUser>(`/users/${encodeURIComponent(userId)}/disable`)
}

/** Approves a `pending` account; answers 422 `email_not_verified` otherwise. */
export async function approveUser(userId: string): Promise<AdminUser> {
  return await http.post<AdminUser>(`/users/${encodeURIComponent(userId)}/approve`)
}

/**
 * Provisions or rotates a password (`kind: "password"`) or a service secret
 * (`kind: "service"`). A service response carries the one-time secret.
 */
export async function provisionCredentials(
  userId: string,
  payload: ProvisionCredentialsRequest
): Promise<ProvisionCredentialsResponse> {
  return await http.post<ProvisionCredentialsResponse>(
    `/users/${encodeURIComponent(userId)}/credentials`,
    payload
  )
}

/** Admin MFA reset; audited as `admin.totp_reset`. */
export async function resetUserTotp(userId: string): Promise<void> {
  await http.delete<void>(`/users/${encodeURIComponent(userId)}/totp`, undefined, {
    idempotencyKey: newIdempotencyKey(),
    responseType: 'none'
  })
}

/** Not paginated: the service returns a bare array. Requires `iam:sessions:any`. */
export async function listUserSessions(userId: string): Promise<SessionInfo[]> {
  return await http.get<SessionInfo[]>(`/users/${encodeURIComponent(userId)}/sessions`)
}

/** Revokes one session; a session belonging to another user answers 404. */
export async function revokeUserSession(userId: string, sessionId: string): Promise<void> {
  await http.delete<void>(
    `/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`,
    undefined,
    { idempotencyKey: newIdempotencyKey(), responseType: 'none' }
  )
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await http.delete<void>(`/users/${encodeURIComponent(userId)}/sessions`, undefined, {
    idempotencyKey: newIdempotencyKey(),
    responseType: 'none'
  })
}

/**
 * Creates an `invited` user and issues a one-time token. There is no invitation
 * list endpoint: invitations are found in `/users` by `status: "invited"`.
 */
export async function createInvitation(payload: CreateInvitationRequest): Promise<InvitationResponse> {
  return await http.post<InvitationResponse>('/invitations', payload)
}

/** Reissues the invitation token; 422 `account is not invited` for any other status. */
export async function resendInvitation(userId: string): Promise<void> {
  await http.post<void>(`/invitations/${encodeURIComponent(userId)}/resend`, undefined, {
    responseType: 'none'
  })
}

/** Cancels an invitation by deleting the invited user; 422 for any other status. */
export async function cancelInvitation(userId: string): Promise<void> {
  await http.delete<void>(`/invitations/${encodeURIComponent(userId)}`, undefined, {
    idempotencyKey: newIdempotencyKey(),
    responseType: 'none'
  })
}
