import type { AreaMenuItem } from '@/app/registry'

const menu = [
  {
    key: '/admin/audit',
    label: '审计日志',
    path: '/admin/audit',
    group: 'admin',
    permission: 'iam:audit:any',
    order: 90
  }
] as AreaMenuItem[]

export default menu
