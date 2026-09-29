import { http } from '@/api/client'
import type { BatchUsersRequest, BatchUsersResponse, ImportResponse } from '@/api/types'

/**
 * Bulk user operations and CSV import. Both need `iam:users:any`.
 *
 * The service exposes no batch job concept: each endpoint executes
 * synchronously and answers with one result per requested id or CSV row, so
 * there is no follow-up status or result endpoint to poll.
 */

/** `ids` is capped at 500 by the service (`a maximum of 500 ids is allowed`). */
export async function batchUsers(payload: BatchUsersRequest): Promise<BatchUsersResponse> {
  return await http.post<BatchUsersResponse>('/users/batch', payload)
}

/**
 * Imports users from CSV. The body is the file itself (`text/csv`, verbatim —
 * not JSON), the header must be exactly `username,email,display_name,password`
 * and the service accepts at most 500 rows. The response maps every row to
 * `{row, username, ok, id?, error?}`; there is no dry-run parameter and no
 * partial-write rollback.
 */
export async function importUsersCsv(csv: string): Promise<ImportResponse> {
  return await http.post<ImportResponse>('/users/import', csv, {
    json: false,
    contentType: 'text/csv'
  })
}
