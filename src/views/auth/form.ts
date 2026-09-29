import type { LocationQueryValue } from 'vue-router'

/**
 * Validation and URL-parameter helpers shared by the unauthenticated auth
 * screens.
 *
 * The password rules mirror the service (`TEAMUSERS_PASSWORD_MIN_LENGTH`
 * defaults to 12, plus at least one letter and one digit); the service
 * re-validates everything and answers `422 weak_password`, so these checks only
 * save a round trip.
 */

/** Matches the backend default `TEAMUSERS_PASSWORD_MIN_LENGTH`. */
export const PASSWORD_MIN_LENGTH = 12

/** Help text/placeholder for every password input on the auth screens. */
export const PASSWORD_HINT = `至少 ${PASSWORD_MIN_LENGTH} 位，且同时包含字母和数字`

/** The first password-policy violation, or `null` when the policy is met. */
export function passwordPolicyProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码需同时包含字母和数字'
  return null
}

/** The policy check plus the confirmation-field check every password form needs. */
export function confirmedPasswordProblem(password: string, confirmation: string): string | null {
  const problem = passwordPolicyProblem(password)
  if (problem) return problem
  return password === confirmation ? null : '两次输入的密码不一致'
}

/**
 * A one-time token carried by an e-mailed link (`/reset-password?token=…`).
 * Array-valued or non-string query entries are ignored rather than guessed at.
 */
export function queryToken(value: LocationQueryValue | LocationQueryValue[]): string {
  const single = Array.isArray(value) ? value[0] : value
  return typeof single === 'string' ? single.trim() : ''
}
