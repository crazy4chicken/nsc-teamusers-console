import { passkeyLoginBegin, passkeyLoginFinish } from './auth'
import { isApiError, messageForError } from './errors'
import { PasskeyCeremonyError, base64UrlToBytes, bytesToBase64Url, passkeySupportError } from './mfa'
import type {
  PasskeyLoginFinishRequest,
  PublicKeyCredentialRequestOptionsJSON,
  TokenPair
} from './types'

/**
 * The unauthenticated passkey login ceremony (`POST /auth/passkey/login/begin`
 * then `/finish`).
 *
 * `./mfa` owns the ceremony a *signed-in* user drives to register a passkey;
 * this module owns the assertion a *signed-out* visitor drives to log in. Both
 * share the base64url codec and the support/origin pre-flight from `./mfa`, so
 * the encoding rules (unpadded base64url, `base64.RawURLEncoding` on the
 * service) exist in exactly one place.
 *
 * Nothing here is persisted: the assertion result travels straight back to the
 * caller as a token pair.
 */

/** Compares the RP ID from the begin response with the page's own host name. */
export function passkeyLoginOriginError(
  options: PublicKeyCredentialRequestOptionsJSON
): string | null {
  const rpId = options.rpId
  if (!rpId || typeof window === 'undefined') return null
  const host = window.location.hostname
  if (host === rpId || host.endsWith(`.${rpId}`)) return null
  return '当前访问地址无法使用通行密钥登录，请改用本站的标准访问地址，或联系管理员。'
}

/**
 * Maps the begin response onto the DOM type, decoding the members WebAuthn
 * requires as `BufferSource`: `challenge` and every `allowCredentials[].id`.
 * `rpId`, `timeout` and `userVerification` are passed through unchanged.
 */
export function toRequestOptions(
  options: PublicKeyCredentialRequestOptionsJSON
): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64UrlToBytes(options.challenge),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.allowCredentials?.length
      ? {
          allowCredentials: options.allowCredentials.map((descriptor) => ({
            type: descriptor.type,
            id: base64UrlToBytes(descriptor.id),
            ...(descriptor.transports?.length
              ? { transports: descriptor.transports as AuthenticatorTransport[] }
              : {})
          }))
        }
      : {}),
    ...(options.userVerification
      ? { userVerification: options.userVerification as UserVerificationRequirement }
      : {})
  }
}

/**
 * Maps the asserted credential onto the finish request: `rawId` and the three
 * response members are encoded as unpadded base64url. `userHandle` is sent only
 * for a discoverable (usernameless) assertion, where the authenticator returns it.
 */
export function toLoginPayload(credential: PublicKeyCredential): PasskeyLoginFinishRequest {
  const response = credential.response as AuthenticatorAssertionResponse
  const userHandle = response.userHandle ? bytesToBase64Url(response.userHandle) : null
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      signature: bytesToBase64Url(response.signature)
    },
    ...(userHandle ? { userHandle } : {})
  }
}

/** Wording for a browser-side assertion failure, keyed by `DOMException.name`. */
function assertionMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
      return '登录被取消或超时，请重试。'
    case 'SecurityError':
      return '当前访问地址无法使用通行密钥登录，请改用本站的标准访问地址。'
    case 'NotSupportedError':
      return '当前设备不支持通行密钥登录，请改用密码登录。'
    case 'AbortError':
      return '操作已取消，请重试。'
    case 'InvalidStateError':
      return '通行密钥状态异常，请重试，或改用密码登录。'
    default:
      return '通行密钥登录失败，请重试，或改用密码登录。'
  }
}

/**
 * Runs the whole assertion: begin (with `username` omitted for a discoverable,
 * usernameless login), the origin pre-flight, `navigator.credentials.get`, then
 * finish with the encoded assertion. Resolves with the token pair the service
 * issued for the asserted credential.
 *
 * Throws `PasskeyCeremonyError` for browser-side failures and `ApiError` for
 * HTTP failures.
 */
export async function loginWithPasskey(username?: string): Promise<TokenPair> {
  const unsupported = passkeySupportError()
  if (unsupported) throw new PasskeyCeremonyError(unsupported)

  const { publicKey } = await passkeyLoginBegin(username)
  const mismatch = passkeyLoginOriginError(publicKey)
  if (mismatch) throw new PasskeyCeremonyError(mismatch)

  let credential: Credential | null = null
  try {
    credential = await navigator.credentials.get({ publicKey: toRequestOptions(publicKey) })
  } catch (error) {
    throw new PasskeyCeremonyError(assertionMessage(error))
  }

  if (!credential || credential.type !== 'public-key') {
    throw new PasskeyCeremonyError('浏览器未返回通行密钥，登录已取消。')
  }

  return await passkeyLoginFinish(toLoginPayload(credential as PublicKeyCredential))
}

/**
 * Worded message for either half of the ceremony. The shared 401 wording
 * ("登录已过期") belongs to a signed-in session, so a rejected assertion is
 * worded as a login failure instead.
 */
export function passkeyLoginErrorMessage(error: unknown): string {
  if (error instanceof PasskeyCeremonyError) return error.message
  if (isApiError(error) && error.status === 401) {
    return '通行密钥验证未通过，请确认使用的是本账户已注册的通行密钥。'
  }
  return messageForError(error)
}
