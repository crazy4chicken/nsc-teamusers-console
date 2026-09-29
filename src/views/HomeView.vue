<script setup lang="ts">
import { computed } from 'vue'
import {
  NAlert,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NSpace,
  NTag,
  NText
} from 'naive-ui'

import { hasPermission, menuGroups } from '@/app/registry'
import type { UserStatus } from '@/api/types'
import { authStore } from '@/stores/authStore'

const user = authStore.currentUser
const permissions = authStore.permissions
const identityError = computed(() => authStore.state.identityError)

/** Admin sidebar entries this identity may actually open, for the access summary. */
const adminEntryCount = computed(
  () => menuGroups.admin.filter((item) => hasPermission(item.permission, permissions.value)).length
)

const STATUS_LABELS: Record<UserStatus, string> = {
  active: '正常',
  disabled: '已停用',
  pending: '待审批',
  invited: '已邀请'
}

const statusLabel = computed(() => (user.value ? STATUS_LABELS[user.value.status] : ''))

/**
 * Plain capability wording for the grants a signed-in account may hold. Raw
 * keys are never rendered; anything outside the known set folds into a
 * generic label.
 */
const PERMISSION_LABELS: Record<string, string> = {
  'iam:users:any': '可管理用户',
  'iam:sessions:any': '可管理用户会话',
  'iam:teams:any': '可管理全部团队',
  'iam:teams:team': '可管理所属团队',
  'iam:groups:any': '可管理全部用户组',
  'iam:groups:team': '可管理所属用户组',
  'iam:roles:any': '可管理全部角色',
  'iam:roles:team': '可管理所属团队的角色',
  'iam:bindings:any': '可管理全部授权绑定',
  'iam:bindings:team': '可管理所属团队的授权绑定',
  'iam:permissions:any': '可维护权限列表',
  'iam:audit:any': '可查看审计日志'
}

interface PermissionEntry {
  key: string
  label: string
  denied: boolean
}

const permissionEntries = computed<PermissionEntry[]>(() =>
  permissions.value.map((raw) => {
    const denied = raw.startsWith('!')
    const key = denied ? raw.slice(1) : raw
    return { key: raw, label: PERMISSION_LABELS[key] ?? '其他权限', denied }
  })
)

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}
</script>

<template>
  <NSpace vertical :size="16">
    <NAlert v-if="identityError" type="warning" title="账户信息加载失败">
      {{ identityError }}　请刷新页面重试，或重新登录。
    </NAlert>

    <NCard title="账户信息" :bordered="false">
      <NDescriptions v-if="user" :column="2" label-placement="left" bordered>
        <NDescriptionsItem label="用户名">{{ user.username }}</NDescriptionsItem>
        <NDescriptionsItem label="显示名">{{ user.display_name }}</NDescriptionsItem>
        <NDescriptionsItem label="状态">{{ statusLabel }}</NDescriptionsItem>
        <NDescriptionsItem label="邮箱">{{ user.email ?? '未设置' }}</NDescriptionsItem>
        <NDescriptionsItem label="邮箱验证">
          {{ user.email_verified_at ? '已验证' : '未验证' }}
        </NDescriptionsItem>
        <NDescriptionsItem label="注册时间">{{ formatTimestamp(user.created_at) }}</NDescriptionsItem>
      </NDescriptions>
      <NText v-else depth="3">尚未加载账户信息。</NText>
    </NCard>

    <NCard title="我的权限" :bordered="false">
      <NSpace v-if="permissionEntries.length">
        <NTag
          v-for="entry in permissionEntries"
          :key="entry.key"
          :type="entry.denied ? 'error' : 'default'"
        >
          {{ entry.denied ? `已禁用：${entry.label}` : entry.label }}
        </NTag>
      </NSpace>
      <NEmpty v-else size="small" description="当前账户没有任何权限" />
      <NText depth="3" class="hint">
        这里列出当前账户具备的权限，用于控制侧边栏和按钮的显示；实际能否操作以系统的判断为准。
      </NText>
    </NCard>

    <NAlert type="info" title="权限与可见范围">
      侧边栏条目与页面内的操作按钮会按当前账户的权限显示：当前账户拥有
      {{ permissionEntries.length }} 项权限，可使用 {{ adminEntryCount }} 个管理功能。
    </NAlert>
  </NSpace>
</template>

<style scoped>
.hint {
  display: block;
  margin-top: 12px;
  font-size: 12px;
}
</style>
