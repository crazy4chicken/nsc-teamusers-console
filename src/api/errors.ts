import type { ProblemDetails } from './types'

/** Extra, non-RFC-9457 information carried by an HTTP failure. */
export interface ApiErrorInit {
  status: number
  title: string
  /** Stable service value: a code such as `account_locked` or a plain sentence. */
  detail: string
  type?: string
  instance?: string
  fields?: Record<string, string>
  /** Present on `403 password_change_required`; used as bearer for `POST /me/password` only. */
  changeToken?: string
  /** True when the response carried `Idempotency-Replayed: true`. */
  replayed?: boolean
  /** True for transport failures that never produced an HTTP status. */
  transport?: boolean
}

/**
 * Every failure surfaced by `src/api/client.ts`, whether it came from a
 * problem+json body, a non-JSON error response, or the transport itself.
 */
export class ApiError extends Error {
  readonly status: number
  readonly title: string
  readonly detail: string
  readonly code: string
  readonly type: string
  readonly instance: string | undefined
  readonly fields: Record<string, string>
  readonly changeToken: string | undefined
  readonly replayed: boolean
  readonly transport: boolean

  constructor(init: ApiErrorInit) {
    super(init.detail || init.title)
    this.name = 'ApiError'
    this.status = init.status
    this.title = init.title
    this.detail = init.detail
    // The service reuses `detail` as the machine-readable identifier; keep it
    // verbatim so callers can compare against the codes below.
    this.code = init.detail
    this.type = init.type ?? 'about:blank'
    this.instance = init.instance
    this.fields = init.fields ?? {}
    this.changeToken = init.changeToken
    this.replayed = init.replayed ?? false
    this.transport = init.transport ?? false
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

/** Coerces an optional `fields`/`errors` extension member into a field → message map. */
function normalizeFields(body: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {}

  const rawFields = body['fields']
  if (rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)) {
    for (const [key, value] of Object.entries(rawFields as Record<string, unknown>)) {
      if (typeof value === 'string') fields[key] = value
    }
  }

  const rawErrors = body['errors']
  if (Array.isArray(rawErrors)) {
    for (const entry of rawErrors) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const field = typeof record['field'] === 'string' ? record['field'] : record['name']
      const message = typeof record['message'] === 'string' ? record['message'] : record['detail']
      if (typeof field === 'string' && typeof message === 'string') fields[field] = message
    }
  }

  return fields
}

/**
 * Builds an `ApiError` from a decoded problem+json body. `fallbackDetail` is
 * used when the body is missing or carries no `detail`.
 */
export function apiErrorFromProblem(
  status: number,
  body: unknown,
  options: { fallbackDetail?: string; title?: string; replayed?: boolean } = {}
): ApiError {
  const problem = (body && typeof body === 'object' ? body : {}) as Partial<ProblemDetails> &
    Record<string, unknown>

  const detail =
    typeof problem.detail === 'string' && problem.detail.length > 0
      ? problem.detail
      : (options.fallbackDetail ?? options.title ?? `HTTP ${status}`)

  return new ApiError({
    status,
    title: typeof problem.title === 'string' && problem.title.length > 0 ? problem.title : (options.title ?? 'Request failed'),
    detail,
    type: typeof problem.type === 'string' ? problem.type : undefined,
    instance: typeof problem.instance === 'string' ? problem.instance : undefined,
    fields: normalizeFields(problem),
    changeToken: typeof problem.change_token === 'string' ? problem.change_token : undefined,
    replayed: options.replayed
  })
}

/** Builds an `ApiError` for a failure that never reached the service. */
export function transportError(kind: 'network' | 'abort' | 'timeout' = 'network'): ApiError {
  const detail = kind === 'network' ? 'network_error' : kind === 'timeout' ? 'request_timeout' : 'request_aborted'
  const title = kind === 'network' ? 'Network Error' : kind === 'timeout' ? 'Request Timeout' : 'Request Aborted'
  return new ApiError({ status: 0, title, detail, transport: true })
}

/** Builds an `ApiError` for a client-side state failure (e.g. a lost MFA challenge). */
export function clientError(detail: string, title = 'Client State Error'): ApiError {
  return new ApiError({ status: 0, title, detail })
}

const DETAIL_MESSAGES: Record<string, string> = {
  'authentication failed': '用户名或密码错误。',
  'authentication temporarily busy': '操作太频繁，请稍后再试。',
  'authentication service unavailable': '服务暂时不可用，请稍后再试。',
  'authorization service unavailable': '服务暂时不可用，请稍后再试。',
  'idempotency store unavailable': '服务暂时不可用，请稍后再试。',
  internal_error: '服务暂时不可用，请稍后再试。',
  auth_unauthorized: '登录已过期，请重新登录。',
  forbidden: '没有权限执行此操作。',
  rate_limited: '操作太频繁，请稍后再试。',
  not_found: '没有找到这条记录。',
  account_locked: '账户已被锁定，请联系管理员或稍后再试。',
  account_pending: '账户尚未激活，请等待审批或完成邮箱验证。',
  password_change_required: '需要先修改密码。',
  registration_closed: '当前未开放注册。',
  email_not_verified: '邮箱尚未验证。',
  invalid_token: '链接无效或已过期，请重新获取。',
  invalid_credentials: '身份验证未通过，请检查后重试。',
  invalid_email: '邮箱格式不正确。',
  email_taken: '邮箱已被使用。',
  weak_password: '密码强度不足：至少 12 位，且需同时包含字母和数字。',
  mfa_not_enrolled: '尚未启用两步验证。',
  totp_already_enabled: '两步验证已启用。',
  idempotency_conflict: '提交内容与上一次不一致，请重新提交。',
  idempotency_in_progress: '上一次提交仍在处理中，请稍后重试。',
  insufficient_permissions: '没有权限执行此操作。',
  'the requested resource was not found': '没有找到这条记录。',
  'the requested user was not found': '没有找到这条记录。',
  'the requested passkey was not found': '没有找到该通行密钥。',
  'an authenticated subject is required': '请先登录。',
  'an authenticated user subject is required': '请先登录。',
  'administrative access requires a user subject': '请先登录。',
  'a service subject is required': '当前账户无法执行此操作。',
  'account is not invited': '该账户尚未被邀请。',
  'username or email already exists': '用户名或邮箱已被使用。',
  'request body must be valid JSON': '提交的内容格式有误。',
  'limit must be a positive integer': '请求参数有误。',
  'cursor must be a non-negative integer': '请求参数有误。',
  'subject is required': '请求参数有误。',
  'subject_kind and subject_id are required': '请求参数有误。',
  'team_id is required': '请先选择团队。',
  'at least one of username or display_name is required': '至少需要填写一个字段。',
  unsupported_field: '提交的内容包含不支持的字段。',
  'email change is not supported': '当前不支持修改邮箱。',
  'op must be disable or enable': '操作类型无效。',
  'a maximum of 500 ids is allowed': '一次最多操作 500 条记录。',
  'a maximum of 500 user_ids is allowed': '一次最多操作 500 个用户。',
  'CSV header must be username,email,display_name,password':
    '表格文件的首行必须是 username,email,display_name,password。',
  'Content-Type must be text/csv': '请上传表格（CSV）文件。',
  'invalid WebAuthn response': '通行密钥验证未通过，请重试。',
  'permission must use resource:action:scope grammar': '权限格式不正确。',
  'condition could not be compiled': '条件表达式无效。',
  not_ready: '服务尚未就绪，请稍后再试。',
  client_no_mfa_challenge: '两步验证已超时，请重新登录。',
  client_no_change_token: '修改密码的会话已超时，请重新登录。',
  client_session_expired: '登录已过期，请重新登录。',
  client_invalid_totp_code: '验证码格式不正确。',
  client_invalid_mfa_code: '验证码格式不正确。',
  client_missing_password: '请输入密码。'
}

const DETAIL_PREFIX_MESSAGES: Array<[prefix: string, message: string]> = [
  ['permission is not registered:', '该权限尚未注册。'],
  ['unsupported_field:', '提交的内容包含不支持的字段。']
]

const STATUS_MESSAGES: Record<number, string> = {
  400: '提交的内容有误，请检查后重试。',
  401: '登录已过期，请重新登录。',
  403: '没有权限执行此操作。',
  404: '没有找到这条记录。',
  405: '操作不被支持。',
  406: '操作不被支持。',
  408: '操作超时，请重试。',
  409: '操作冲突，请刷新后重试。',
  413: '提交的内容过大。',
  415: '提交的内容格式不受支持。',
  422: '提交的内容无效，请检查后重试。',
  423: '账户已被锁定，请联系管理员或稍后再试。',
  429: '操作太频繁，请稍后再试。',
  500: '服务暂时不可用，请稍后再试。',
  502: '服务暂时不可用，请稍后再试。',
  503: '服务暂时不可用，请稍后再试。',
  504: '服务暂时不可用，请稍后再试。'
}

/** Chinese user-facing message for a `detail` value; falls back to the caller's status mapping. */
function messageForDetail(detail: string): string | undefined {
  const exact = DETAIL_MESSAGES[detail]
  if (exact) return exact
  for (const [prefix, message] of DETAIL_PREFIX_MESSAGES) {
    // The suffix after the prefix is a raw identifier; it is never shown.
    if (detail.startsWith(prefix)) return message
  }
  return undefined
}

/**
 * Maps any thrown value to a Chinese message suitable for display.
 * Unknown `detail` values fall through to the HTTP-status wording; anything
 * still unmapped becomes a generic message, so a raw code or an English
 * server string can never reach the screen.
 */
export function messageForError(error: unknown): string {
  if (isApiError(error)) {
    if (error.transport) {
      if (error.detail === 'request_timeout') return '请求超时，请重试。'
      if (error.detail === 'request_aborted') return '请求已取消。'
      return '网络连接失败，请检查网络后重试。'
    }
    const byDetail = messageForDetail(error.code)
    if (byDetail) return byDetail
    const byStatus = STATUS_MESSAGES[error.status]
    if (byStatus) return byStatus
    if (error.status >= 500 || error.status === 0) return '服务暂时不可用，请稍后再试。'
    return '操作失败，请稍后重试。'
  }
  // Plain `Error`s reaching this point are client-side and already worded for
  // display (e.g. `PasskeyCeremonyError`); anything else gets a generic message.
  if (error instanceof Error && error.message && /[一-鿿]/.test(error.message)) {
    return error.message
  }
  return '操作失败，请稍后重试。'
}
