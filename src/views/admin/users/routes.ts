import type { RouteRecordRaw } from 'vue-router'

import BatchImportView from './BatchImportView.vue'
import UserDetailView from './UserDetailView.vue'
import UsersListView from './UsersListView.vue'

/** All three screens need `iam:users:any`; the session panel self-gates on `iam:sessions:any`. */
const routes = [
  {
    path: '/admin/users',
    name: 'admin-users',
    component: UsersListView,
    meta: { title: '用户管理', section: 'admin', permission: 'iam:users:any' }
  },
  {
    path: '/admin/users/import',
    name: 'admin-users-import',
    component: BatchImportView,
    meta: { title: '批量导入用户', section: 'admin', permission: 'iam:users:any' }
  },
  {
    path: '/admin/users/:id',
    name: 'admin-user-detail',
    component: UserDetailView,
    meta: { title: '用户详情', section: 'admin', permission: 'iam:users:any' }
  }
] as RouteRecordRaw[]

export default routes
