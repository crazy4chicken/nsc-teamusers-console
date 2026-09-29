import { http } from '../client'
import { auditPageQuery } from '../pagination'

/**
 * The audit plane: `GET /audit` (`iam:audit:any`).
 *
 * This is the only collection in the service whose cursor is an integer rather
 * than an opaque string. The server validates it as a signed 64-bit integer
 * (`strconv.ParseInt`, `cursor must be a non-negative integer`) and pages with
 * `WHERE id > cursor ORDER BY id LIMIT n`, so the cursor is the `audit_log.id`
 * of the last row already seen — never an offset and never a token to be
 * coerced through a string. `next_cursor` echoes that row id and is `0` exactly
 * when the log is exhausted (the store returns 0 whenever the page came back
 * with fewer than `limit` rows).
 *
 * Wire fields are `omitempty` pointers on nullable columns, so `team_id`,
 * `actor_id` and `request_id` may be absent from an entry. Every field is
 * normalised defensively here and the untouched object is kept as `raw` for the
 * detail drawer.
 */

/** One audit entry as rendered by the console. */
export interface AuditLogEntry {
  /** `audit_log.id`; also the cursor that reaches newer entries. */
  id: number | null
  /** Stable render key (`id` when available, positional otherwise). */
  key: string
  at: string | null
  action: string | null
  target: string | null
  actor_id: string | null
  team_id: string | null
  request_id: string | null
  /** Free-form `{before, after}` JSON; the shape is not fixed by the service. */
  diff: unknown
  /** The untouched wire object, pretty-printed by the detail drawer. */
  raw: Record<string, unknown>
}

export interface AuditPage {
  items: AuditLogEntry[]
  /** `next_cursor` when it advances the cursor; `null` when the log is exhausted. */
  nextCursor: number | null
}

export interface AuditListParams {
  /** Cursor of the page to fetch: the previous page's last id. `0` starts at the oldest entry. */
  cursor?: number | null
  /** Page size; clamped to 1..1000, defaulting to 100 like the service. */
  limit?: number | null
  /** Optional team filter; blank means every team, platform-scoped entries included. */
  team_id?: string | null
}

/** Reads a nullable wire column, treating `null`, `undefined` and `""` alike. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Accepts the numeric cursor the service sends, plus the digit-string form a
 * 64-bit integer would take if a serializer ever stringified it. Anything that
 * is not a positive safe integer (including the end-of-log `0`) yields `null`,
 * so a malformed cursor stops paging instead of producing a bad request.
 */
function normalizeCursor(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : undefined
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

function normalizeEntry(value: unknown, index: number): AuditLogEntry {
  const raw =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const id = normalizeCursor(raw['id'])
  return {
    id,
    key: id !== null ? `audit-${id}` : `audit-row-${index}`,
    at: optionalText(raw['at']),
    action: optionalText(raw['action']),
    target: optionalText(raw['target']),
    actor_id: optionalText(raw['actor_id']),
    team_id: optionalText(raw['team_id']),
    request_id: optionalText(raw['request_id']),
    diff: raw['diff'] ?? null,
    raw
  }
}

/**
 * True when `next` really moves past `current`. The server pages with
 * `id > cursor`, so a cursor that fails to advance would repeat the same page
 * forever; such a response is treated as the end of the log.
 */
export function auditHasMore(current: number, next: number | null): next is number {
  return next !== null && next > current
}

function normalizePage(value: unknown): AuditPage {
  const record =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const items = Array.isArray(record['items']) ? record['items'].map(normalizeEntry) : []
  return { items, nextCursor: normalizeCursor(record['next_cursor']) }
}

/** Lists audit entries, newest last: the service always orders by ascending id. */
export async function listAudit(params: AuditListParams = {}): Promise<AuditPage> {
  const teamId = params.team_id?.trim()
  const wire = await http.get<unknown>('/audit', {
    query: auditPageQuery({
      cursor: params.cursor ?? 0,
      limit: params.limit,
      team_id: teamId ? teamId : null
    })
  })
  return normalizePage(wire)
}
