import type { RouteRecordRaw } from 'vue-router'

import AuditView from './AuditView.vue'

const routes = [
  {
    path: '/admin/audit',
    name: 'admin-audit',
    component: AuditView,
    meta: { title: '审计日志', permission: 'iam:audit:any' }
  }
] as RouteRecordRaw[]

export default routes
