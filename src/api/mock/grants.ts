/**
 * Permission fixtures for the development mock.
 *
 * `MOCK_GRANTS` is the single switch for what the primary mocked identity
 * (`admin`) may do. `/me/export.effective_permissions` and every server-side
 * check in the mock resolve through it, so editing this one array is enough to
 * demo a narrower console: replace `iam:teams:any` with `iam:teams:team` for a
 * team-scoped view, or drop entries to hide menu sections and watch the mock
 * answer `403 insufficient_permissions`.
 *
 * The other two sets are the ready-made narrower demos: log in as `viewer` for
 * a read-only-ish console and as `teamadmin` for a team-scoped one.
 */

/** The eight platform keys provisioned by `teamusers bootstrap-admin`. */
export const MOCK_GRANTS: readonly string[] = [
  'iam:users:any',
  'iam:sessions:any',
  'iam:teams:any',
  'iam:groups:any',
  'iam:roles:any',
  'iam:bindings:any',
  'iam:permissions:any',
  'iam:audit:any'
]

/** `viewer`: user directory and audit only; the sessions panel and the other areas are denied. */
export const MOCK_VIEWER_GRANTS: readonly string[] = ['iam:users:any', 'iam:audit:any']

/**
 * `teamadmin`: team-scoped administration of the two teams it belongs to, plus
 * the permission registry (needed to render the role editor). It deliberately
 * holds no `:any` grant for teams/groups/roles/bindings, so collection requests
 * such as `GET /teams` and `GET /bindings` answer `403 insufficient_permissions`.
 */
export const MOCK_TEAM_ADMIN_GRANTS: readonly string[] = [
  'iam:teams:team',
  'iam:groups:team',
  'iam:roles:team',
  'iam:bindings:team',
  'iam:permissions:any'
]

/** Scope breadth, so `:any` satisfies `:team` but not the reverse. */
const SCOPE_RANK: Record<string, number> = { own: 0, team: 1, any: 2, '*': 3 }

/** Whether a single grant satisfies `required`; `*` matches any segment. */
function grantMatches(grant: string, required: string): boolean {
  const granted = grant.replace(/^!/, '').split(':')
  const wanted = required.split(':')
  if (granted.length !== wanted.length) return false
  const scopeIndex = wanted.length - 1
  return granted.every((segment, index) => {
    if (segment === '*' || segment === wanted[index]) return true
    if (index !== scopeIndex) return false
    const grantedRank = SCOPE_RANK[segment]
    const requiredRank = SCOPE_RANK[wanted[index]]
    return grantedRank !== undefined && requiredRank !== undefined && grantedRank >= requiredRank
  })
}

/** Whether `grants` holds `required`; an explicit deny for it always wins. */
export function hasGrant(grants: readonly string[], required: string): boolean {
  const matches = grants.filter((grant) => grantMatches(grant, required))
  if (matches.some((grant) => grant.startsWith('!'))) return false
  return matches.length > 0
}
