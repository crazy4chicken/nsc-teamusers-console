import { http, newIdempotencyKey } from '../client'
import { pageQuery, type PageQuery } from '../pagination'
import type {
  BatchResult,
  Binding,
  BindingSubjectKind,
  CreateBindingRequest,
  CreateGroupRequest,
  CreateRoleRequest,
  CreateTeamRequest,
  CursorPage,
  Group,
  GroupMember,
  GroupMemberRequest,
  PermissionRecord,
  RegisterPermissionRequest,
  Role,
  RolePermissionsResponse,
  Team,
  UpdateGroupRequest,
  UpdateRoleRequest,
  UpdateTeamRequest
} from '../types'

/**
 * Teams, groups, roles, permissions and bindings.
 *
 * Endpoint rules that the published `openapi.yaml` does not declare:
 * `GET /groups` requires `team_id`, `GET /bindings` requires
 * `subject_kind` + `subject_id`, and `GET /roles` optionally filters by
 * `team_id`. Mutations carry an `Idempotency-Key`; the client reuses the same
 * key when it retries once after a 401 refresh, so a replayed submit is not
 * applied twice.
 */

/** The area grants; team-capable areas also accept their `:team` variant. */
export const TEAM_AREA_PERMISSIONS = {
  teams: ['iam:teams:any', 'iam:teams:team'],
  groups: ['iam:groups:any', 'iam:groups:team'],
  roles: ['iam:roles:any', 'iam:roles:team'],
  bindings: ['iam:bindings:any', 'iam:bindings:team'],
  permissions: ['iam:permissions:any']
} as const

function mutation(): { idempotencyKey: string } {
  return { idempotencyKey: newIdempotencyKey() }
}

function idPath(prefix: string, id: string): string {
  return `${prefix}/${encodeURIComponent(id)}`
}

/* ------------------------------------------------------------------ *
 * Teams — list/create need `iam:teams:any`; `{id}` routes also accept
 * `iam:teams:team` for the team in the path.
 * ------------------------------------------------------------------ */

export async function listTeams(page: PageQuery = {}): Promise<CursorPage<Team>> {
  return await http.get<CursorPage<Team>>('/teams', { query: pageQuery(page) })
}

export async function getTeam(id: string): Promise<Team> {
  return await http.get<Team>(idPath('/teams', id))
}

export async function createTeam(payload: CreateTeamRequest): Promise<Team> {
  return await http.post<Team>('/teams', payload, mutation())
}

export async function updateTeam(id: string, payload: UpdateTeamRequest): Promise<Team> {
  return await http.patch<Team>(idPath('/teams', id), payload, mutation())
}

export async function deleteTeam(id: string): Promise<void> {
  await http.delete<void>(idPath('/teams', id), undefined, { ...mutation(), responseType: 'none' })
}

/* ------------------------------------------------------------------ *
 * Groups — `iam:groups:any|:team`. Listing is scoped by a required
 * `team_id`; membership writes bump each affected user's permission version.
 * ------------------------------------------------------------------ */

export async function listGroups(teamId: string, page: PageQuery = {}): Promise<CursorPage<Group>> {
  return await http.get<CursorPage<Group>>('/groups', {
    query: { ...pageQuery(page), team_id: teamId }
  })
}

export async function getGroup(id: string): Promise<Group> {
  return await http.get<Group>(idPath('/groups', id))
}

export async function createGroup(payload: CreateGroupRequest): Promise<Group> {
  return await http.post<Group>('/groups', payload, mutation())
}

export async function updateGroup(id: string, payload: UpdateGroupRequest): Promise<Group> {
  return await http.patch<Group>(idPath('/groups', id), payload, mutation())
}

export async function deleteGroup(id: string): Promise<void> {
  await http.delete<void>(idPath('/groups', id), undefined, { ...mutation(), responseType: 'none' })
}

/** Idempotent: re-adding a member replaces the existing expiry. */
export async function addGroupMember(
  groupId: string,
  payload: GroupMemberRequest
): Promise<GroupMember> {
  return await http.put<GroupMember>(`${idPath('/groups', groupId)}/members`, payload, mutation())
}

export async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  await http.delete<void>(
    `${idPath('/groups', groupId)}/members/${encodeURIComponent(userId)}`,
    undefined,
    { ...mutation(), responseType: 'none' }
  )
}

/** Same `{results:[{id,ok,error?}]}` envelope as `POST /users/batch`; at most 500 user ids. */
export interface GroupMemberBatchResponse {
  results: BatchResult[]
}

export async function batchAddGroupMembers(
  groupId: string,
  userIds: string[]
): Promise<GroupMemberBatchResponse> {
  return await http.post<GroupMemberBatchResponse>(
    `${idPath('/groups', groupId)}/members/batch`,
    { user_ids: userIds },
    mutation()
  )
}

/* ------------------------------------------------------------------ *
 * Roles — `iam:roles:any|:team`. `team_id: null` is a platform role.
 * The service exposes no way to read a role's current permission set:
 * `PUT /roles/{id}/permissions` is a full replacement.
 * ------------------------------------------------------------------ */

export interface RoleListQuery extends PageQuery {
  /** Omit for every scope (needs `iam:roles:any`); pass a team for `:team` grants. */
  teamId?: string | null
}

export async function listRoles(query: RoleListQuery = {}): Promise<CursorPage<Role>> {
  return await http.get<CursorPage<Role>>('/roles', {
    query: { ...pageQuery(query), team_id: query.teamId ?? undefined }
  })
}

export async function getRole(id: string): Promise<Role> {
  return await http.get<Role>(idPath('/roles', id))
}

export async function createRole(payload: CreateRoleRequest): Promise<Role> {
  return await http.post<Role>('/roles', payload, mutation())
}

export async function updateRole(id: string, payload: UpdateRoleRequest): Promise<Role> {
  return await http.patch<Role>(idPath('/roles', id), payload, mutation())
}

export async function deleteRole(id: string): Promise<void> {
  await http.delete<void>(idPath('/roles', id), undefined, { ...mutation(), responseType: 'none' })
}

/** Replaces the complete permission set; an empty array clears the role. */
export async function replaceRolePermissions(
  id: string,
  permissionKeys: string[]
): Promise<RolePermissionsResponse> {
  return await http.put<RolePermissionsResponse>(
    `${idPath('/roles', id)}/permissions`,
    { permission_keys: permissionKeys },
    mutation()
  )
}

/* ------------------------------------------------------------------ *
 * Permission registry — `iam:permissions:any` (platform area only).
 * Registration is an upsert; there is no delete.
 * ------------------------------------------------------------------ */

export async function listPermissions(page: PageQuery = {}): Promise<CursorPage<PermissionRecord>> {
  return await http.get<CursorPage<PermissionRecord>>('/permissions', { query: pageQuery(page) })
}

export async function registerPermission(
  payload: RegisterPermissionRequest
): Promise<PermissionRecord> {
  return await http.post<PermissionRecord>('/permissions', payload, mutation())
}

/* ------------------------------------------------------------------ *
 * Bindings — `iam:bindings:any`; `POST` and `DELETE /{id}` also accept
 * `iam:bindings:team` for the team of the role/binding. The collection
 * `GET` has no resolvable target team, so listing needs `:any`.
 * ------------------------------------------------------------------ */

export interface BindingSubjectQuery {
  subject_kind: BindingSubjectKind
  subject_id: string
}

export async function listBindings(
  subject: BindingSubjectQuery,
  page: PageQuery = {}
): Promise<CursorPage<Binding>> {
  return await http.get<CursorPage<Binding>>('/bindings', {
    query: {
      ...pageQuery(page),
      subject_kind: subject.subject_kind,
      subject_id: subject.subject_id
    }
  })
}

/**
 * `team_id` is optional: the service falls back to the role's team, or to the
 * group's team for a group subject, and rejects a mismatch.
 */
export async function createBinding(payload: CreateBindingRequest): Promise<Binding> {
  return await http.post<Binding>('/bindings', payload, mutation())
}

export async function deleteBinding(id: string): Promise<void> {
  await http.delete<void>(idPath('/bindings', id), undefined, {
    ...mutation(),
    responseType: 'none'
  })
}

/* ------------------------------------------------------------------ *
 * Shared write-time validation (mirrors the service's domain rules)
 * ------------------------------------------------------------------ */

/** Bare ULID: 26 Crockford base32 characters. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function normalizeUlid(value: string): string {
  return value.trim().toUpperCase()
}

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(normalizeUlid(value))
}

const RESOURCE_PATTERN = /^[a-z][a-z0-9_.-]*$/
const ACTION_PATTERN = /^(?:[a-z][a-z0-9_-]*|\*)$/
const SCOPES = ['own', 'team', 'any', '*'] as const

/** Team-scoped administration exists for exactly these `iam` areas. */
const TEAM_CAPABLE_AREAS = ['teams', 'groups', 'roles', 'bindings']

export interface PermissionKeyParts {
  deny: boolean
  resource: string
  action: string
  scope: string
}

/**
 * Parses `[!]resource:action:scope`, including the `iam` area rule that only
 * `:any` is accepted platform-wide and `:team` only for team-capable areas.
 * Returns `null` when the key violates the grammar.
 */
export function parsePermissionKey(key: string): PermissionKeyParts | null {
  const trimmed = key.trim()
  const deny = trimmed.startsWith('!')
  const body = deny ? trimmed.slice(1) : trimmed
  const parts = body.split(':')
  if (parts.length !== 3) return null

  const [resource, action, scope] = parts
  if (!RESOURCE_PATTERN.test(resource)) return null
  if (!ACTION_PATTERN.test(action)) return null
  if (!(SCOPES as readonly string[]).includes(scope)) return null
  if (resource === 'iam' && scope !== 'any' && !(scope === 'team' && TEAM_CAPABLE_AREAS.includes(action))) {
    return null
  }
  return { deny, resource, action, scope }
}

export function isValidPermissionKey(key: string): boolean {
  return parsePermissionKey(key) !== null
}

/** The `scope` segment of a valid key, or `null` when the key is malformed. */
export function permissionScope(key: string): string | null {
  return parsePermissionKey(key)?.scope ?? null
}
