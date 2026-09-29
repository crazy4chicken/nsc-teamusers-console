import type { AreaMenuItem } from '@/app/registry'

/** Self-service sidebar entries, in the order a user reads their own account. */
export default [
  { key: 'me-profile', label: '个人资料', path: '/me/profile', group: 'self', order: 10 },
  { key: 'me-security', label: '安全设置', path: '/me/security', group: 'self', order: 20 },
  { key: 'me-sessions', label: '登录会话', path: '/me/sessions', group: 'self', order: 30 }
] as AreaMenuItem[]
