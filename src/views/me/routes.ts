import type { RouteRecordRaw } from 'vue-router'

import ProfileView from './ProfileView.vue'
import SecurityView from './SecurityView.vue'
import SessionsView from './SessionsView.vue'

/**
 * Self-service routes. They need no grant beyond a user session: every entry is
 * about the caller's own account, so `meta.permission` is deliberately absent.
 */
export default [
  {
    path: '/me/profile',
    name: 'me-profile',
    component: ProfileView,
    meta: { title: '个人资料', section: 'me' }
  },
  {
    path: '/me/security',
    name: 'me-security',
    component: SecurityView,
    meta: { title: '安全设置', section: 'me' }
  },
  {
    path: '/me/sessions',
    name: 'me-sessions',
    component: SessionsView,
    meta: { title: '登录会话', section: 'me' }
  }
] as RouteRecordRaw[]
