import type { QueryParams } from './client'
import type { CursorPage } from './types'

/** Service default when no `limit` is supplied. */
export const DEFAULT_PAGE_LIMIT = 100
/** Hard cap enforced by the store; larger values are accepted but never exceed this page size. */
export const MAX_PAGE_LIMIT = 1000

/** The service rejects a non-positive or malformed `limit` outright. */
export function clampLimit(limit?: number | null): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_PAGE_LIMIT
  }
  return Math.min(Math.floor(limit), MAX_PAGE_LIMIT)
}

export interface PageQuery {
  /** Opaque cursor from the previous page; omit for the first page. */
  cursor?: string | null
  limit?: number | null
}

/** Builds the `cursor`/`limit` params shared by every opaque-cursor collection. */
export function pageQuery(params: PageQuery = {}): QueryParams {
  const query: QueryParams = { limit: clampLimit(params.limit) }
  if (params.cursor) query.cursor = params.cursor
  return query
}

export interface AuditPageQuery {
  /** Integer cursor: `0` starts at the beginning. */
  cursor?: number | null
  limit?: number | null
  team_id?: string | null
}

/** `/audit` is the only collection using an integer cursor; it is always sent explicitly. */
export function auditPageQuery(params: AuditPageQuery = {}): QueryParams {
  const query: QueryParams = { limit: clampLimit(params.limit), cursor: params.cursor ?? 0 }
  if (params.team_id) query.team_id = params.team_id
  return query
}

export interface UnwrappedPage<T> {
  items: T[]
  /** `null` when the service reported no further page. */
  nextCursor: string | null
}

/** Unwraps `{items, next_cursor}`; an empty cursor string means "end of list". */
export function unwrapPage<T>(page: CursorPage<T> | null | undefined): UnwrappedPage<T> {
  return {
    items: page?.items ?? [],
    nextCursor: page?.next_cursor ? page.next_cursor : null
  }
}
