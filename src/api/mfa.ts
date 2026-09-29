import { clientError, isApiError, messageForError } from './errors'
import {
  beginPasskeyRegistration,
  confirmTotp,
  disableTotp,
  enrollTotp,
  finishPasskeyRegistration,
  regenerateBackupCodes
} from './me'
import type {
  PasskeyRegistrationFinishRequest,
  PublicKeyCredentialCreationOptionsJSON
} from './types'

/**
 * Two-factor and passkey operations a signed-in user drives from the browser.
 *
 * HTTP lives in `./me`; this module owns what cannot be expressed as a wire
 * call: the TOTP code/secret handling, the one-time backup-code payloads, and
 * the WebAuthn registration ceremony (`navigator.credentials.create`), which is
 * only reachable from a browser. Secrets and codes are kept in memory for the
 * lifetime of the component — nothing here touches `localStorage`.
 */

/* ------------------------------------------------------------------ *
 * One-time codes
 * ------------------------------------------------------------------ */

/** A TOTP code as produced by an authenticator app. */
export function normalizeTotpCode(value: string): string {
  return value.replace(/\s+/g, '')
}

export function isTotpCode(value: string): boolean {
  return /^\d{6}$/.test(normalizeTotpCode(value))
}

/**
 * Backup codes are issued as `xxxx-xxxx-xxxx-xxxx`; the service compares the
 * de-dashed lower-case form, so pasted separators are stripped here.
 */
export function normalizeBackupCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isBackupCode(value: string): boolean {
  return normalizeBackupCode(value).length === 16
}

/**
 * Normalizes whichever secret the user pasted: a 6-digit TOTP code is kept
 * as-is, anything else is treated as a backup code.
 */
export function normalizeMfaCode(value: string): string {
  const trimmed = value.trim()
  if (isTotpCode(trimmed)) return normalizeTotpCode(trimmed)
  return normalizeBackupCode(trimmed)
}

export function totpCodeError(value: string): string | null {
  if (!value.trim()) return '请输入验证器显示的验证码。'
  if (!isTotpCode(value)) return '验证码应为 6 位数字。'
  return null
}

export function mfaCodeError(value: string): string | null {
  if (!value.trim()) return '请输入动态验证码或备用码。'
  if (!isTotpCode(value) && !isBackupCode(value)) {
    return '请输入 6 位动态验证码，或 16 位备用码。'
  }
  return null
}

/* ------------------------------------------------------------------ *
 * TOTP enrolment
 * ------------------------------------------------------------------ */

export interface TotpEnrollment {
  /** Base32 secret exactly as the service returned it. */
  secret: string
  /** Same secret in 4-character blocks, for manual entry into an authenticator app. */
  groupedSecret: string
  /** `otpauth://totp/...` provisioning URI. */
  otpauthUrl: string
}

/**
 * Starts (or restarts) enrolment. Calling it again replaces the pending secret,
 * so a user who mistyped the key can regenerate without disabling anything.
 * `409 totp_already_enabled` means an active credential already exists.
 */
export async function beginTotpEnrollment(): Promise<TotpEnrollment> {
  const response = await enrollTotp()
  return {
    secret: response.secret,
    // Blocked in fours: the layout authenticator apps show for manual entry.
    groupedSecret: response.secret.replace(/(.{4})/g, '$1 ').trim(),
    otpauthUrl: response.otpauth_url
  }
}

/** Activates the pending enrolment; resolves with the backup codes, shown once. */
export async function verifyTotpEnrollment(code: string): Promise<string[]> {
  if (!isTotpCode(code)) throw clientError('client_invalid_totp_code', '验证码格式不正确')
  const response = await confirmTotp({ code: normalizeTotpCode(code) })
  return response.backup_codes ?? []
}

/** Accepts a current TOTP code or one unused backup code. */
export async function disableTotpWithCode(code: string): Promise<void> {
  if (!isTotpCode(code) && !isBackupCode(code)) {
    throw clientError('client_invalid_mfa_code', '验证码格式不正确')
  }
  await disableTotp({ code: normalizeMfaCode(code) })
}

/** Replaces every backup code; requires the account password. */
export async function issueBackupCodes(password: string): Promise<string[]> {
  if (!password) throw clientError('client_missing_password', '请输入密码')
  const response = await regenerateBackupCodes({ password })
  return response.backup_codes ?? []
}

/* ------------------------------------------------------------------ *
 * One-time code presentation
 * ------------------------------------------------------------------ */

export function backupCodesText(codes: string[]): string {
  return [
    '团队用户控制台 · 两步验证备用码',
    `生成时间：${new Date().toLocaleString()}`,
    '',
    ...codes,
    '',
    '每个备用码只能使用一次，请在无法获取动态验证码时使用。',
    '请离线保存，不要截图或发送到聊天工具。'
  ].join('\n')
}

/** Downloads the codes as a local text file; nothing is written to web storage. */
export function downloadBackupCodes(codes: string[]): void {
  const blob = new Blob([backupCodesText(codes)], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `teamusers-backup-codes-${new Date().toISOString().slice(0, 10)}.txt`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Resolves `false` when the browser refuses clipboard access (insecure origin). */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Error wording
 * ------------------------------------------------------------------ */

/** The action a request belongs to, so a 401 can be worded for that action. */
export type MfaAction = 'totp_confirm' | 'totp_disable' | 'backup_codes'

/**
 * The service answers a rejected TOTP code, a rejected backup code and a wrong
 * password alike with 401 (`authentication failed` or `invalid_credentials`),
 * which the shared mapping renders as a sign-in failure. Each action supplies
 * its own wording for that case; everything else keeps the shared mapping.
 */
export function mfaErrorMessage(error: unknown, action: MfaAction): string {
  if (isApiError(error) && error.status === 401) {
    if (action === 'backup_codes') return '密码不正确，请重新输入。'
    if (action === 'totp_disable') return '验证码不正确，或两步验证尚未启用。'
    return '验证码不正确，请核对验证器后重试。'
  }
  return messageForError(error)
}

/* ------------------------------------------------------------------ *
 * WebAuthn registration ceremony
 * ------------------------------------------------------------------ */

/**
 * `go-webauthn` emits `authenticatorSelection` (`residentKey: "required"`),
 * which `PublicKeyCredentialCreationOptionsJSON` in `./types` does not declare.
 * It is forwarded verbatim: dropping it would let the authenticator create a
 * non-discoverable credential, which usernameless login could not find.
 */
interface CreationOptionsExtras {
  authenticatorSelection?: AuthenticatorSelectionCriteria
}

type CreationOptionsWire = PublicKeyCredentialCreationOptionsJSON & CreationOptionsExtras

/** A failure raised by the browser side of the ceremony, already worded for display. */
export class PasskeyCeremonyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PasskeyCeremonyError'
  }
}

/** `undefined` when this browser can run a ceremony at all. */
export function passkeySupportError(): string | null {
  if (typeof window === 'undefined') return '当前环境不支持通行密钥。'
  if (!window.isSecureContext) {
    return '通行密钥需要通过本站的安全网址访问后使用，请确认访问地址无误。'
  }
  if (typeof window.PublicKeyCredential !== 'function') {
    return '当前浏览器不支持通行密钥，请更换较新的浏览器。'
  }
  return null
}

/**
 * Compares the RP ID the service configured with the page's own host name.
 * A browser rejects the ceremony when the RP ID is neither the host nor a
 * registrable suffix of it (`SecurityError` / `NotAllowedError`), so the
 * mismatch is reported before the request is attempted.
 */
export function passkeyOriginError(options: PublicKeyCredentialCreationOptionsJSON): string | null {
  const rpId = options.rp?.id
  if (!rpId || typeof window === 'undefined') return null
  const host = window.location.hostname
  if (host === rpId || host.endsWith(`.${rpId}`)) return null
  return '当前访问地址无法使用通行密钥，请改用本站的标准访问地址，或联系管理员。'
}

export function bytesToBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  // Unpadded base64url: the service decodes with `base64.RawURLEncoding`, which
  // rejects `=`. Padding must therefore be stripped, not merely made URL-safe.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Maps the service's JSON options onto the DOM type, decoding only the members
 * WebAuthn requires as `BufferSource`: `challenge`, `user.id` and each
 * `excludeCredentials[].id`. `rp`, `user.name`, `user.displayName`,
 * `pubKeyCredParams`, `timeout`, `attestation` and `authenticatorSelection` are
 * passed through unchanged.
 */
export function toCreationOptions(
  options: PublicKeyCredentialCreationOptionsJSON
): PublicKeyCredentialCreationOptions {
  const wire = options as CreationOptionsWire
  return {
    rp: options.rp,
    user: { ...options.user, id: base64UrlToBytes(options.user.id) },
    challenge: base64UrlToBytes(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams,
    attestation: options.attestation as AttestationConveyancePreference,
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(wire.authenticatorSelection ? { authenticatorSelection: wire.authenticatorSelection } : {}),
    ...(options.excludeCredentials?.length
      ? {
          excludeCredentials: options.excludeCredentials.map((descriptor) => ({
            type: descriptor.type,
            id: base64UrlToBytes(descriptor.id),
            // The service does not emit `transports` today; when it does, the
            // values are already the DOM's `AuthenticatorTransport` strings.
            ...(descriptor.transports?.length
              ? { transports: descriptor.transports as AuthenticatorTransport[] }
              : {})
          }))
        }
      : {})
  }
}

/**
 * Maps the created credential onto the finish request: `id` stays the
 * authenticator's identifier, `rawId` and the two response members are encoded
 * as unpadded base64url, `type` is always `public-key`.
 */
export function toRegistrationPayload(
  credential: PublicKeyCredential
): PasskeyRegistrationFinishRequest {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      attestationObject: bytesToBase64Url(response.attestationObject)
    }
  }
}

function ceremonyMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
      return '操作被取消或超时，请重试。'
    case 'InvalidStateError':
      return '该设备上已存在此账户的通行密钥，可直接用它登录，无需重复注册。'
    case 'NotSupportedError':
      return '当前设备不支持创建通行密钥，请更换设备或浏览器。'
    case 'SecurityError':
      return '当前访问地址无法使用通行密钥，请改用本站的标准访问地址。'
    case 'AbortError':
      return '操作已取消，请重试。'
    default:
      return '通行密钥注册失败，请重试。'
  }
}

/** Worded message for either half of the ceremony: a browser failure or an API failure. */
export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof PasskeyCeremonyError) return error.message
  if (isApiError(error) && error.status === 401) return '登录已过期，请重新登录后再注册通行密钥。'
  return messageForError(error)
}

/**
 * Runs the whole registration ceremony: begin, `navigator.credentials.create`
 * with the server's options, then finish with the encoded attestation.
 * Throws `PasskeyCeremonyError` for browser-side failures and `ApiError` for
 * HTTP failures.
 */
export async function registerPasskey(): Promise<void> {
  const unsupported = passkeySupportError()
  if (unsupported) throw new PasskeyCeremonyError(unsupported)

  const { publicKey } = await beginPasskeyRegistration()
  const mismatch = passkeyOriginError(publicKey)
  if (mismatch) throw new PasskeyCeremonyError(mismatch)

  let credential: Credential | null = null
  try {
    credential = await navigator.credentials.create({ publicKey: toCreationOptions(publicKey) })
  } catch (error) {
    throw new PasskeyCeremonyError(ceremonyMessage(error))
  }

  if (!credential || credential.type !== 'public-key') {
    throw new PasskeyCeremonyError('浏览器未返回通行密钥，注册已取消。')
  }

  await finishPasskeyRegistration(toRegistrationPayload(credential as PublicKeyCredential))
}
