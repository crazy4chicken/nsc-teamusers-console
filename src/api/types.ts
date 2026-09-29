/**
 * Wire types for the nsc-teamusers HTTP API.
 *
 * These types follow the Go implementation (`internal/httpapi`, `internal/authn`),
 * which differs from the published `openapi.yaml` in several places; where they
 * disagree the implementation wins and the deviation is noted inline.
 *
 * Timestamps are RFC 3339 strings as produced by `encoding/json` (`time.Time`);
 * nullable columns are modelled as `T | null`.
 */

/* ------------------------------------------------------------------ *
 * Errors (RFC 9457 application/problem+json)
 * ------------------------------------------------------------------ */

/** Raw problem+json body. `detail` carries a stable code or a message. */
export interface ProblemDetails {
  /** Always `about:blank` for this service. */
  type: string
  title: string
  status: number
  /** Stable machine code (`authentication failed`) or human text (`account_locked`). */
  detail: string
  /** Request id, present when the middleware created one. */
  instance?: string
  /**
   * Undocumented extra member on the `403 password_change_required` body
   * (`writePasswordChangeRequired`); used as bearer for `POST /me/password` only.
   */
  change_token?: string
  /** uncertain: field-level validation errors are not part of the documented envelope. */
  [extension: string]: unknown
}

/* ------------------------------------------------------------------ *
 * Auth plane
 * ------------------------------------------------------------------ */

export interface TokenPair {
  access_token: string
  refresh_token: string
  token_type: 'Bearer' | string
  /** Seconds until `access_token` expires; 600 for user tokens (10 minutes). */
  expires_in: number
}

/** Undocumented in openapi.yaml: `POST /auth/login` replies 200 with this body when TOTP is enrolled. */
export interface MfaChallengeResponse {
  mfa_required: true
  /** Short-lived (5 min) token with `purpose: "mfa"`. */
  mfa_token: string
}

export type LoginResponse = TokenPair | MfaChallengeResponse

export interface LoginRequest {
  username: string
  password: string
}

export interface MfaLoginRequest {
  mfa_token: string
  /** TOTP code (6 digits) or a backup code. */
  code: string
}

export interface RefreshRequest {
  refresh_token: string
}

export interface LogoutRequest {
  refresh_token: string
}

export interface RegisterRequest {
  username: string
  email: string
  password: string
  display_name: string
}

/** `POST /auth/register` answers 201 Created (the spec wrongly documents 200). */
export interface RegisterResponse {
  id: string
  /** `pending` in approval mode; `active` when registration is `open`. */
  status: UserStatus
}

export interface VerifyEmailRequest {
  token: string
}

export interface PasswordResetRequestRequest {
  /** Username or email. Always answers 204, even when rate limited. */
  login: string
}

export interface PasswordResetConfirmRequest {
  token: string
  new_password: string
}

export interface InviteAcceptRequest {
  token: string
  password: string
  /** uncertain: documented as nullable, so both absent and null are accepted. */
  display_name?: string | null
}

/* ------------------------------------------------------------------ *
 * WebAuthn (values are base64url strings, not ArrayBuffers)
 * ------------------------------------------------------------------ */

export interface PublicKeyCredentialDescriptorJSON {
  type: 'public-key'
  /** Base64url credential id (unpadded). */
  id: string
  /** uncertain: not emitted by the service today. */
  transports?: string[]
}

export interface PublicKeyCredentialRequestOptionsJSON {
  /** Base64url challenge. */
  challenge: string
  /** Always 300000 (5 minutes) for passkey login. */
  timeout?: number
  rpId?: string
  /** Empty/absent for discoverable (usernameless) login. */
  allowCredentials?: PublicKeyCredentialDescriptorJSON[]
  /** uncertain: not emitted by the service today. */
  userVerification?: string
}

export interface PasskeyLoginBeginResponse {
  publicKey: PublicKeyCredentialRequestOptionsJSON
}

export interface PasskeyRegistrationParametersJSON {
  type: 'public-key'
  /** `-7` (ES256) is the only advertised algorithm. */
  alg: number
}

export interface PublicKeyCredentialCreationOptionsJSON {
  /** Base64url challenge. */
  challenge: string
  rp: { id: string; name: string }
  /** `id` is the base64url user handle, not the ULID. */
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: PasskeyRegistrationParametersJSON[]
  attestation: 'none' | string
  /** uncertain: not emitted by the service today. */
  timeout?: number
  /** uncertain: not emitted by the service today. */
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[]
}

export interface PasskeyRegisterBeginResponse {
  publicKey: PublicKeyCredentialCreationOptionsJSON
}

export interface PasskeyRegistrationFinishRequest {
  id: string
  rawId: string
  type: 'public-key' | string
  response: {
    clientDataJSON: string
    attestationObject: string
  }
}

export interface PasskeyLoginFinishRequest {
  id: string
  rawId: string
  type: 'public-key' | string
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
  }
  /** Only sent for discoverable login. */
  userHandle?: string | null
}

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

/** uncertain: `pending` and `invited` are the non-active states seen in the handlers. */
export type UserStatus = 'active' | 'disabled' | 'pending' | 'invited'

/** `GET /me` — the caller's own profile. */
export interface Profile {
  id: string
  username: string
  display_name: string
  status: UserStatus
  email: string | null
  email_verified_at: string | null
  created_at: string
}

export interface UpdateProfileRequest {
  username?: string
  display_name?: string
}

export interface DeleteAccountRequest {
  password: string
}

export interface ChangePasswordRequest {
  /**
   * Required for the ordinary signed-in change. Whether the forced-change
   * (`change_token`) flow also requires it is not stated by the spec/handlers;
   * the client sends it when it has it.
   */
  current_password?: string
  new_password: string
}

export interface ChangePasswordResponse {
  message: string
  /** Always true: changing the password revokes every session. */
  sessions_revoked: boolean
}

export interface ChangeEmailRequest {
  new_email: string
  password: string
}

export interface ConfirmEmailRequest {
  token: string
}

/* ------------------------------------------------------------------ *
 * Sessions (never paginated — bare arrays)
 * ------------------------------------------------------------------ */

export interface SessionInfo {
  id: string
  created_at: string
  /** uncertain: null for a session without a family cap. */
  expires_at: string | null
}

/* ------------------------------------------------------------------ *
 * MFA / passkeys (self-service)
 * ------------------------------------------------------------------ */

export interface TotpEnrollResponse {
  secret: string
  /** `otpauth://totp/teamusers:<username>?secret=...&issuer=teamusers` */
  otpauth_url: string
}

export interface TotpConfirmRequest {
  code: string
}

export interface BackupCodesResponse {
  /** Returned once; 10 codes of the shape `xxxx-xxxx-xxxx-xxxx`. */
  backup_codes: string[]
}

export interface TotpBackupCodesRequest {
  password: string
}

export interface TotpDisableRequest {
  /** Current TOTP code or an unused backup code. */
  code: string
}

export interface PasskeyInfo {
  /** Unpadded base64url credential id. */
  id: string
  created_at: string
}

/* ------------------------------------------------------------------ *
 * Self-service export
 * ------------------------------------------------------------------ */

export interface Membership {
  team_id: string
  /** uncertain: null for a team-wide membership without a group. */
  group_id: string | null
}

export interface ExportResponse {
  profile: Profile
  memberships: Membership[]
  /** The caller's own effective permission keys — the only browser-reachable source for nav gating. */
  effective_permissions: string[]
  active_sessions: SessionInfo[]
  totp_enabled: boolean
  passkey_count: number
}

/* ------------------------------------------------------------------ *
 * Administration: teams, groups, roles, permissions, bindings
 * ------------------------------------------------------------------ */

export interface Team {
  id: string
  slug: string
  name: string
  status: string
  created_at: string
}

export interface CreateTeamRequest {
  slug: string
  name: string
  status: string
}

export interface UpdateTeamRequest {
  name?: string
  slug?: string
  status?: string | null
}

export interface Group {
  id: string
  team_id: string
  name: string
}

export interface CreateGroupRequest {
  team_id: string
  name: string
}

export interface UpdateGroupRequest {
  name?: string
  team_id?: string | null
}

export interface GroupMember {
  team_id: string
  group_id: string
  user_id: string
  expires_at: string | null
}

export interface GroupMemberRequest {
  user_id: string
  expires_at?: string | null
}

export interface Role {
  id: string
  /** null = platform-wide role. */
  team_id: string | null
  name: string
}

export interface CreateRoleRequest {
  name: string
  team_id: string | null
}

export interface UpdateRoleRequest {
  name?: string
  /** Rejected with 403 when authorized by a `:team` grant. */
  team_id?: string | null
}

export interface RolePermissionsResponse {
  role_id: string
  permissions: string[]
}

export interface PermissionRecord {
  key: string
  description: string
  registered_by: string
  created_at: string
}

export interface RegisterPermissionRequest {
  key: string
  registered_by: string
  description: string
}

export type BindingSubjectKind = 'user' | 'group'

export interface Binding {
  id: string
  team_id: string | null
  role_id: string
  subject_kind: BindingSubjectKind
  subject_id: string
  /** Compiled condition expression, empty when unconditional. */
  condition: string
  expires_at: string | null
}

export interface CreateBindingRequest {
  role_id: string
  subject_kind: BindingSubjectKind
  subject_id: string
  team_id?: string | null
  condition?: string
  expires_at?: string | null
}

/* ------------------------------------------------------------------ *
 * Administration: users, invitations, batch operations
 * ------------------------------------------------------------------ */

export interface AdminUserSummary {
  id: string
  username: string
  email: string | null
  display_name: string
  status: UserStatus
  /** Bumped whenever the user's effective grants change; invalidates access tokens. */
  perm_ver: number
  failed_logins: number
  email_verified_at: string | null
  created_at: string
  updated_at: string
}

export interface AdminUser extends AdminUserSummary {
  approved_at: string | null
  approved_by: string | null
  locked_until: string | null
}

export interface CreateUserRequest {
  username: string
  email?: string | null
  display_name: string
  /** ignored when `initial_password` is present (`password` wins). */
  password?: string
  initial_password?: string
}

export interface UpdateUserRequest {
  username?: string
  email?: string | null
  display_name?: string
  status?: UserStatus
}

export type BatchUserOp = 'enable' | 'disable'

export interface BatchUsersRequest {
  /** At most 500 ids. */
  ids: string[]
  op: BatchUserOp
}

export type BatchItemError = 'invalid_id' | 'not_found' | 'operation_failed' | 'already_member' | string

export interface BatchResult {
  id: string
  ok: boolean
  error?: BatchItemError
}

export interface BatchUsersResponse {
  results: BatchResult[]
}

export interface ImportRowResult {
  row: number
  username: string
  ok: boolean
  id?: string
  error?: string
}

export interface ImportResponse {
  results: ImportRowResult[]
}

export interface ProvisionCredentialsRequest {
  kind: 'password' | 'service'
  password?: string
}

export interface ProvisionCredentialsResponse {
  kind: 'password' | 'service'
  user_id: string
  username: string
  /** uncertain: only a service-credential response carries the one-time secret. */
  client_id?: string
  client_secret?: string
}

export interface CreateInvitationRequest {
  username: string
  email?: string | null
  display_name: string
}

export interface InvitationResponse {
  id: string
  status: UserStatus
}

/* ------------------------------------------------------------------ *
 * Collections
 * ------------------------------------------------------------------ */

export interface CursorPage<T> {
  items: T[]
  /** Empty string means there is no next page. */
  next_cursor: string
}
