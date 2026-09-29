import type { AreaMenuItem } from '@/app/registry'

/** Invitations have no list screen: they are filtered out of the user list by `status: "invited"`. */
const menu = [
  {
    key: 'admin-users',
    label: '用户管理',
    path: '/admin/users',
    group: 'admin',
    permission: 'iam:users:any',
    order: 10
  },
  {
    key: 'admin-users-import',
    label: '批量导入用户',
    path: '/admin/users/import',
    group: 'admin',
    permission: 'iam:users:any',
    order: 11
  }
] as AreaMenuItem[]

export default menu
