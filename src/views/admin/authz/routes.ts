import type { RouteRecordRaw } from 'vue-router'

import { TEAM_AREA_PERMISSIONS } from '@/api/admin/authorization'

/**
 * Administration routes for the authorization planes. Each entry lists the
 * acceptable grants; the router guard treats them as alternatives, so a
 * team-scoped administrator passes with `:team` alone.
 */
export default [
  {
    path: '/admin/teams',
    name: 'admin-authz-teams',
    component: () => import('./TeamsView.vue'),
    meta: {
      title: '团队',
      section: 'admin',
      permission: [...TEAM_AREA_PERMISSIONS.teams]
    }
  },
  {
    path: '/admin/groups',
    name: 'admin-authz-groups',
    component: () => import('./GroupsView.vue'),
    meta: {
      title: '用户组',
      section: 'admin',
      permission: [...TEAM_AREA_PERMISSIONS.groups]
    }
  },
  {
    path: '/admin/roles',
    name: 'admin-authz-roles',
    component: () => import('./RolesView.vue'),
    meta: {
      title: '角色',
      section: 'admin',
      permission: [...TEAM_AREA_PERMISSIONS.roles]
    }
  },
  {
    path: '/admin/bindings',
    name: 'admin-authz-bindings',
    component: () => import('./BindingsView.vue'),
    meta: {
      title: '授权绑定',
      section: 'admin',
      permission: [...TEAM_AREA_PERMISSIONS.bindings]
    }
  },
  {
    path: '/admin/permissions',
    name: 'admin-authz-permissions',
    component: () => import('./PermissionsView.vue'),
    meta: {
      title: '权限登记',
      section: 'admin',
      permission: [...TEAM_AREA_PERMISSIONS.permissions]
    }
  }
] as RouteRecordRaw[]
