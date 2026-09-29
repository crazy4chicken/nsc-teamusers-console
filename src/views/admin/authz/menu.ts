import type { AreaMenuItem } from '@/app/registry'

import { TEAM_AREA_PERMISSIONS } from '@/api/admin/authorization'

/** Sidebar entries for the authorization planes, ordered after the user areas. */
export default [
  {
    key: 'admin.authz.teams',
    label: '团队',
    path: '/admin/teams',
    group: 'admin',
    permission: [...TEAM_AREA_PERMISSIONS.teams],
    order: 30
  },
  {
    key: 'admin.authz.groups',
    label: '用户组',
    path: '/admin/groups',
    group: 'admin',
    permission: [...TEAM_AREA_PERMISSIONS.groups],
    order: 31
  },
  {
    key: 'admin.authz.roles',
    label: '角色',
    path: '/admin/roles',
    group: 'admin',
    permission: [...TEAM_AREA_PERMISSIONS.roles],
    order: 32
  },
  {
    key: 'admin.authz.bindings',
    label: '授权绑定',
    path: '/admin/bindings',
    group: 'admin',
    permission: [...TEAM_AREA_PERMISSIONS.bindings],
    order: 33
  },
  {
    key: 'admin.authz.permissions',
    label: '权限登记',
    path: '/admin/permissions',
    group: 'admin',
    permission: [...TEAM_AREA_PERMISSIONS.permissions],
    order: 34
  }
] as AreaMenuItem[]
