import type {
  AdminUser,
  AdminUserSummary,
  Group,
  GroupMember,
  PasskeyInfo,
  PermissionRecord,
  Profile,
  Role,
  SessionInfo,
  Team,
  Binding,
  TokenPair,
  UserStatus
} from '../types'
import {
  MOCK_GRANTS,
  MOCK_TEAM_ADMIN_GRANTS,
  MOCK_VIEWER_GRANTS
} from './grants'

/**
 * In-memory state of the development mock.
 *
 * Everything lives in this process's memory; `snapshotMockState` /
 * `restoreMockState` let the installer keep it across a document load, because
 * the console resumes a session from `sessionStorage` and the mock has to still
 * know that session afterwards (the real service keeps refresh-token families
 * for 30 days).
 */

/** Extra columns the service keeps but never returns on the wire. */
export interface MockUser extends AdminUser {
  /** Plain text: this is a fixture, not a credential store. */
  password: string
  /** Effective grant keys, exactly what `/me/export.effective_permissions` reports. */
  grants: string[]
  /** Forces the `403 password_change_required` branch of `POST /auth/login`. */
  must_change_password: boolean
  /** Team memberships, feeding `/me/export.memberships` and team-scope checks. */
  team_ids: string[]
  totp: { enabled: boolean; pending_secret: string | null; backup_codes: string[] }
}

export interface MockSession extends SessionInfo {
  user_id: string
}

export interface MockRole extends Role {
  /** Current permission set; the service exposes no read endpoint for it. */
  permissions: string[]
}

/** Audit rows carry the integer primary key the service pages with. */
export interface MockAudit {
  id: number
  at: string
  actor_id: string
  target: string
  action: string
  team_id: string | null
  diff: unknown
  request_id: string
}

export interface MockState {
  seq: number
  auditSeq: number
  users: MockUser[]
  teams: Team[]
  groups: Group[]
  groupMembers: GroupMember[]
  roles: MockRole[]
  permissions: PermissionRecord[]
  bindings: Binding[]
  audit: MockAudit[]
  sessions: MockSession[]
  passkeys: Map<string, PasskeyInfo[]>
  /** Access token -> user; mirrors the service's 10 minute TTL. */
  accessTokens: Map<string, { user_id: string; expires_at: number }>
  /** One-time `change_token` from the forced-password-change 403. */
  changeTokens: Map<string, string>
  /** Refresh token -> the session it rotates within. */
  refreshTokens: Map<string, { user_id: string; session_id: string }>
  /** Short-lived MFA challenge token (5 minutes). */
  mfaTokens: Map<string, { user_id: string; expires_at: number }>
}

/** Entry array of a `Map`-valued `MockState` field, as stored in a snapshot. */
type MockMapEntries<Key extends keyof MockState> =
  MockState[Key] extends Map<infer K, infer V> ? [K, V][] : never

/** JSON-safe projection of `MockState`; every `Map` becomes an entry array. */
interface PersistedMockState
  extends Omit<MockState, 'passkeys' | 'accessTokens' | 'changeTokens' | 'refreshTokens' | 'mfaTokens'> {
  passkeys: MockMapEntries<'passkeys'>
  accessTokens: MockMapEntries<'accessTokens'>
  changeTokens: MockMapEntries<'changeTokens'>
  refreshTokens: MockMapEntries<'refreshTokens'>
  mfaTokens: MockMapEntries<'mfaTokens'>
}

export function snapshotMockState(state: MockState): string {
  const persisted: PersistedMockState = {
    ...state,
    passkeys: [...state.passkeys.entries()],
    accessTokens: [...state.accessTokens.entries()],
    changeTokens: [...state.changeTokens.entries()],
    refreshTokens: [...state.refreshTokens.entries()],
    mfaTokens: [...state.mfaTokens.entries()]
  }
  return JSON.stringify(persisted)
}

/** Rebuilds a state written by `snapshotMockState`; `null` when it is unusable. */
export function restoreMockState(snapshot: string | null): MockState | null {
  if (!snapshot) return null
  try {
    const persisted = JSON.parse(snapshot) as PersistedMockState
    if (!Array.isArray(persisted.users) || !Array.isArray(persisted.sessions)) return null
    return {
      ...persisted,
      passkeys: new Map(persisted.passkeys ?? []),
      accessTokens: new Map(persisted.accessTokens ?? []),
      changeTokens: new Map(persisted.changeTokens ?? []),
      refreshTokens: new Map(persisted.refreshTokens ?? []),
      mfaTokens: new Map(persisted.mfaTokens ?? [])
    }
  } catch {
    return null
  }
}

/** ULID-shaped, lexicographically increasing id (26 Crockford base32 characters). */
export function nextId(state: MockState): string {
  state.seq += 1
  let value = state.seq
  let encoded = ''
  while (value > 0) {
    encoded = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[value % 32] + encoded
    value = Math.floor(value / 32)
  }
  return encoded.padStart(26, '0')
}

/** Random 32 hex characters; stands in for the service's base64url tokens. */
export function randomHex(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '')
}

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function findUser(state: MockState, id: string): MockUser | undefined {
  return state.users.find((user) => user.id === id)
}

export function findUserByName(state: MockState, username: string): MockUser | undefined {
  const wanted = username.trim().toLowerCase()
  return state.users.find((user) => user.username.toLowerCase() === wanted)
}

/**
 * Issues an access token and a refresh token bound to `sessionId`.
 *
 * The access token is a JWT-shaped string. The console never decodes it (the
 * service puts no permissions in the token), but the payload still carries the
 * identity's `permissions` so a developer inspecting devtools can see the
 * fixture's grant set.
 */
export function mintTokens(state: MockState, user: MockUser, sessionId: string): TokenPair {
  const issuedAt = Math.floor(Date.now() / 1000)
  const header = toBase64Url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'mock-key' }))
  const payload = toBase64Url(
    JSON.stringify({
      iss: 'teamusers',
      aud: 'teamusers',
      sub: user.id,
      ...(user.team_ids.length > 0 ? { team: user.team_ids[0] } : {}),
      kind: 'user',
      perm_ver: user.perm_ver,
      iat: issuedAt,
      exp: issuedAt + 600,
      jti: randomHex(),
      permissions: [...user.grants]
    })
  )
  const accessToken = `${header}.${payload}.${randomHex()}`
  state.accessTokens.set(accessToken, { user_id: user.id, expires_at: Date.now() + 600_000 })

  const refreshToken = randomHex()
  state.refreshTokens.set(refreshToken, { user_id: user.id, session_id: sessionId })

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: 600
  }
}

export function createSession(state: MockState, user: MockUser): MockSession {
  const session: MockSession = {
    id: nextId(state),
    user_id: user.id,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString()
  }
  state.sessions.push(session)
  return session
}

/** Drops every refresh session of a user, as the service does on password change or disable. */
export function revokeUserSessions(state: MockState, userId: string): void {
  for (let index = state.sessions.length - 1; index >= 0; index -= 1) {
    if (state.sessions[index].user_id === userId) state.sessions.splice(index, 1)
  }
  for (const [token, entry] of state.refreshTokens) {
    if (entry.user_id === userId) state.refreshTokens.delete(token)
  }
  for (const [token, entry] of state.accessTokens) {
    if (entry.user_id === userId) state.accessTokens.delete(token)
  }
}

export function sessionsOf(state: MockState, userId: string): MockSession[] {
  return state.sessions
    .filter((session) => session.user_id === userId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

export function recordAudit(
  state: MockState,
  entry: Omit<MockAudit, 'id' | 'at' | 'request_id'> & { request_id?: string }
): void {
  state.auditSeq += 1
  state.audit.push({
    id: state.auditSeq,
    at: nowIso(),
    request_id: entry.request_id ?? `req-${randomHex().slice(0, 12)}`,
    actor_id: entry.actor_id,
    target: entry.target,
    action: entry.action,
    team_id: entry.team_id,
    diff: entry.diff
  })
}

/* ------------------------------------------------------------------ *
 * Wire projections
 * ------------------------------------------------------------------ */

export function toProfile(user: MockUser): Profile {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    status: user.status,
    email: user.email,
    email_verified_at: user.email_verified_at,
    created_at: user.created_at
  }
}

export function toAdminUserSummary(user: MockUser): AdminUserSummary {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    status: user.status,
    perm_ver: user.perm_ver,
    failed_logins: user.failed_logins,
    email_verified_at: user.email_verified_at,
    created_at: user.created_at,
    updated_at: user.updated_at
  }
}

export function toAdminUser(user: MockUser): AdminUser {
  return {
    ...toAdminUserSummary(user),
    approved_at: user.approved_at,
    approved_by: user.approved_by,
    locked_until: user.locked_until
  }
}

/* ------------------------------------------------------------------ *
 * Seed
 * ------------------------------------------------------------------ */

interface SeedUser {
  username: string
  display_name: string
  email: string | null
  status: UserStatus
  password: string
  grants: readonly string[]
  teams?: 'all' | string[]
  verified?: boolean
  mustChange?: boolean
  lockedHours?: number
  totp?: boolean
}

const TEAM_SEED: Team[] = [
  { id: '01JTEAM0000000000000000001', slug: 'platform-ops', name: '平台运维', status: 'active', created_at: '' },
  { id: '01JTEAM0000000000000000002', slug: 'payments', name: '支付业务', status: 'active', created_at: '' },
  { id: '01JTEAM0000000000000000003', slug: 'growth', name: '增长实验', status: 'disabled', created_at: '' }
]

const GROUP_SEED: Array<[teamIndex: number, name: string]> = [
  [0, '运维值班'],
  [0, '运维备份'],
  [1, '支付核心'],
  [1, '支付复核'],
  [2, '增长实验组']
]

const ROLE_SEED: Array<[teamIndex: number | null, name: string, permissions: string[]]> = [
  [
    null,
    'iam-admin',
    [
      'iam:users:any',
      'iam:sessions:any',
      'iam:teams:any',
      'iam:groups:any',
      'iam:roles:any',
      'iam:bindings:any',
      'iam:permissions:any',
      'iam:audit:any'
    ]
  ],
  [0, 'team-operator', ['iam:roles:team', 'iam:groups:team']],
  [0, 'team-viewer', ['iam:teams:team']],
  [1, 'payments-support', ['iam:groups:team', 'iam:bindings:team']],
  [null, 'report-reader', ['reports:read:team']]
]

const PERMISSION_SEED: Array<[key: string, description: string]> = [
  ['iam:users:any', '管理用户、邀请与凭据'],
  ['iam:sessions:any', '查看与撤销任意用户的会话'],
  ['iam:teams:any', '管理全部团队'],
  ['iam:teams:team', '管理所属团队'],
  ['iam:groups:any', '管理全部用户组'],
  ['iam:groups:team', '管理所属用户组'],
  ['iam:roles:any', '管理全部角色'],
  ['iam:roles:team', '管理所属角色'],
  ['iam:bindings:any', '管理全部授权绑定'],
  ['iam:bindings:team', '管理所属团队的授权绑定'],
  ['iam:permissions:any', '登记权限标识'],
  ['iam:audit:any', '读取审计日志'],
  ['orders:read:any', '读取全部订单'],
  ['orders:write:team', '写入本团队订单'],
  ['reports:read:team', '读取本团队报表'],
  ['!orders:delete:any', '禁止删除订单（显式拒绝）']
]

const AUDIT_ACTIONS: Array<[action: string, target: string, teamIndex: number | null]> = [
  ['auth.login', 'user', null],
  ['auth.logout', 'user', null],
  ['user.create', 'user', null],
  ['user.patch', 'user', null],
  ['user.disable', 'user', null],
  ['admin.totp_reset', 'user', null],
  ['session.revoke', 'session', null],
  ['role.permissions.replace', 'role', 0],
  ['binding.create', 'binding', 1],
  ['group.member.add', 'group', 1],
  ['team.create', 'team', null]
]

const GENERATED_USERS: Array<[username: string, displayName: string, status: UserStatus, teamIndex: number]> = [
  ['zhao.min', '赵敏', 'active', 0],
  ['li.na', '李娜', 'active', 0],
  ['wang.lei', '王磊', 'active', 1],
  ['chen.jing', '陈静', 'active', 1],
  ['liu.yang', '刘洋', 'active', 1],
  ['sun.qian', '孙倩', 'disabled', 0],
  ['zhou.hao', '周浩', 'active', 2],
  ['wu.fang', '吴芳', 'pending', 2],
  ['zheng.kai', '郑凯', 'active', 2],
  ['feng.yan', '冯燕', 'active', 1],
  ['he.min', '何敏', 'disabled', 2],
  ['gao.peng', '高鹏', 'active', 0],
  ['lin.xin', '林欣', 'active', 1],
  ['ma.chao', '马超', 'pending', 0]
]

/** Builds the whole fixture set. Called once per page load. */
export function createMockState(): MockState {
  const state: MockState = {
    seq: 0,
    auditSeq: 0,
    users: [],
    teams: [],
    groups: [],
    groupMembers: [],
    roles: [],
    permissions: [],
    bindings: [],
    audit: [],
    sessions: [],
    passkeys: new Map(),
    accessTokens: new Map(),
    changeTokens: new Map(),
    refreshTokens: new Map(),
    mfaTokens: new Map()
  }

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

  state.teams = TEAM_SEED.map((team, index) => ({ ...team, created_at: hoursAgo(700 - index * 12) }))

  const addUser = (seed: SeedUser, order: number): MockUser => {
    const id = nextId(state)
    const user: MockUser = {
      id,
      username: seed.username,
      email: seed.email,
      display_name: seed.display_name,
      status: seed.status,
      perm_ver: 1,
      failed_logins: 0,
      email_verified_at: seed.verified === false ? null : hoursAgo(600 - order * 3),
      created_at: hoursAgo(600 - order * 3),
      updated_at: hoursAgo(24),
      approved_at: seed.status === 'active' ? hoursAgo(500 - order) : null,
      approved_by: null,
      locked_until: seed.lockedHours ? new Date(Date.now() + seed.lockedHours * 3_600_000).toISOString() : null,
      password: seed.password,
      grants: [...seed.grants],
      must_change_password: seed.mustChange === true,
      team_ids: seed.teams === 'all' ? state.teams.map((team) => team.id) : [...(seed.teams ?? [])],
      totp: {
        enabled: seed.totp === true,
        pending_secret: null,
        backup_codes: seed.totp === true ? ['aaaa-bbbb-cccc-dddd', 'eeee-ffff-0000-1111'] : []
      }
    }
    state.users.push(user)
    return user
  }

  // Fully privileged demo identity; its grants are the single override point.
  const admin = addUser(
    {
      username: 'admin',
      display_name: '平台管理员',
      email: 'admin@example.com',
      status: 'active',
      password: 'Admin-pass-1234',
      grants: MOCK_GRANTS,
      teams: 'all'
    },
    0
  )

  // MFA-required fixture: login answers `{mfa_required:true}`; the demo code is 123456.
  addUser(
    {
      username: 'mfa',
      display_name: '两步验证用户',
      email: 'mfa@example.com',
      status: 'active',
      password: 'Mfa-pass-1234',
      grants: MOCK_VIEWER_GRANTS,
      teams: [],
      totp: true
    },
    1
  )

  // Forced-password-change fixture: login answers 403 with a `change_token`.
  addUser(
    {
      username: 'firstlogin',
      display_name: '首次登录用户',
      email: 'firstlogin@example.com',
      status: 'active',
      password: 'First-pass-1234',
      grants: MOCK_VIEWER_GRANTS,
      teams: [],
      mustChange: true
    },
    2
  )

  // Read-only-ish fixture: user directory + audit only.
  addUser(
    {
      username: 'viewer',
      display_name: '只读审计员',
      email: 'viewer@example.com',
      status: 'active',
      password: 'Viewer-pass-1234',
      grants: MOCK_VIEWER_GRANTS,
      teams: [TEAM_SEED[0].id]
    },
    3
  )

  const teamAdmin = addUser(
    {
      username: 'teamadmin',
      display_name: '团队管理员',
      email: 'teamadmin@example.com',
      status: 'active',
      password: 'Team-pass-1234',
      grants: MOCK_TEAM_ADMIN_GRANTS,
      teams: []
    },
    4
  )
  teamAdmin.team_ids = [TEAM_SEED[0].id, TEAM_SEED[1].id]

  // Login-state fixtures.
  addUser(
    {
      username: 'pendinguser',
      display_name: '待审批用户',
      email: 'pending@example.com',
      status: 'pending',
      password: 'Pending-pass-1234',
      grants: [],
      teams: [],
      verified: false
    },
    5
  )
  addUser(
    {
      username: 'lockeduser',
      display_name: '锁定用户',
      email: 'locked@example.com',
      status: 'active',
      password: 'Locked-pass-1234',
      grants: [],
      teams: [],
      lockedHours: 2
    },
    6
  )
  addUser(
    {
      username: 'invited.user',
      display_name: '待接受邀请',
      email: 'invited@example.com',
      status: 'invited',
      password: '',
      grants: [],
      teams: [],
      verified: false
    },
    7
  )

  GENERATED_USERS.forEach(([username, displayName, status, teamIndex], index) => {
    addUser(
      {
        username,
        display_name: displayName,
        email: `${username}@example.com`,
        status,
        password: `${username.split('.')[0]}-pass-1234`,
        grants: status === 'active' ? ['reports:read:team'] : [],
        teams: [TEAM_SEED[teamIndex].id]
      },
      index + 8
    )
  })
  const usersByTeam = (teamId: string) => state.users.filter((user) => user.team_ids.includes(teamId))

  GROUP_SEED.forEach(([teamIndex, name], index) => {
    const team = state.teams[teamIndex]
    state.groups.push({ id: nextId(state), team_id: team.id, name })
    // Two members per group so member batch operations have something to act on.
    for (const member of usersByTeam(team.id).slice(index, index + 2)) {
      state.groupMembers.push({
        team_id: team.id,
        group_id: state.groups[state.groups.length - 1].id,
        user_id: member.id,
        expires_at: null
      })
    }
  })

  ROLE_SEED.forEach(([teamIndex, name, permissions]) => {
    state.roles.push({
      id: nextId(state),
      team_id: teamIndex === null ? null : state.teams[teamIndex].id,
      name,
      permissions: [...permissions]
    })
  })

  PERMISSION_SEED.forEach(([key, description], index) => {
    state.permissions.push({
      key,
      description,
      registered_by: 'bootstrap-admin',
      created_at: hoursAgo(500 - index)
    })
  })

  const roleByName = (name: string) => state.roles.find((role) => role.name === name)
  const bindings: Array<[role: string, kind: 'user' | 'group', subject: string]> = [
    ['iam-admin', 'user', admin.id],
    ['team-viewer', 'user', state.users[3].id],
    ['team-operator', 'group', state.groups[0].id],
    ['team-viewer', 'group', state.groups[1].id],
    ['payments-support', 'group', state.groups[2].id],
    ['report-reader', 'user', state.users[8].id]
  ]
  for (const [roleName, kind, subject] of bindings) {
    const role = roleByName(roleName)
    if (!role) continue
    state.bindings.push({
      id: nextId(state),
      team_id: role.team_id,
      role_id: role.id,
      subject_kind: kind,
      subject_id: subject,
      condition: kind === 'group' ? 'request.time.weekday < 6' : '',
      expires_at: null
    })
  }

  // Ascending `created_at`: the sessions screen treats the newest row as the current one.
  state.users.forEach((user, index) => {
    if (user.status !== 'active') return
    const count = user.id === admin.id ? 3 : 1 + (index % 2)
    for (let i = 0; i < count; i += 1) {
      state.sessions.push({
        id: nextId(state),
        user_id: user.id,
        created_at: hoursAgo(60 - index - i),
        expires_at: new Date(Date.now() + (30 - i) * 24 * 3_600_000).toISOString()
      })
    }
  })

  state.passkeys.set(admin.id, [
    { id: 'bW9jay1wYXNza2V5LW9uZQ', created_at: hoursAgo(300) },
    { id: 'bW9jay1wYXNza2V5LXR3bw', created_at: hoursAgo(120) }
  ])

  for (let index = 0; index < 130; index += 1) {
    const [action, target, teamIndex] = AUDIT_ACTIONS[index % AUDIT_ACTIONS.length]
    const actor = state.users[index % state.users.length]
    state.auditSeq += 1
    state.audit.push({
      id: state.auditSeq,
      at: hoursAgo(200 - index * 1.5),
      actor_id: index % 7 === 0 ? admin.id : actor.id,
      target: target === 'user' ? actor.id : state.teams[(teamIndex ?? 0) % state.teams.length].id,
      action,
      team_id: teamIndex === null ? null : state.teams[teamIndex].id,
      diff: { before: { status: 'active' }, after: { status: action.endsWith('disable') ? 'disabled' : 'active' } },
      request_id: `req-${(index + 1).toString(16).padStart(12, '0')}`
    })
  }

  return state
}
