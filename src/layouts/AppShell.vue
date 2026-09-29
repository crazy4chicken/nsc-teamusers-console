<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import {
  NButton,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
  NPopover,
  NSpace,
  NTag,
  NText,
  type MenuOption
} from 'naive-ui'

import { hasPermission, menuGroups, type AreaMenuItem } from '@/app/registry'
import { authStore } from '@/stores/authStore'

/** Plain-Chinese names for the administrative areas, keyed by permission segment. */
const AREA_LABELS: Record<string, string> = {
  users: '用户',
  teams: '团队',
  groups: '用户组',
  roles: '角色',
  permissions: '权限登记',
  bindings: '授权绑定',
  audit: '审计日志',
  sessions: '登录会话',
  invitations: '邀请'
}

const SCOPE_LABELS: Record<string, string> = {
  any: '全部范围',
  team: '本团队',
  own: '仅本人'
}

const STATUS_LABELS: Record<string, string> = {
  active: '正常',
  disabled: '已停用',
  pending: '待审批',
  invited: '已邀请'
}

/** Translates a grant into a plain capability phrase; never shows the raw key. */
function capabilityLabel(rawKey: string): string {
  const denied = rawKey.startsWith('!')
  const segments = (denied ? rawKey.slice(1) : rawKey).split(':')
  let label = '其他应用功能'
  if (segments[0] === 'iam' && segments[1]) {
    const area = AREA_LABELS[segments[1]]
    if (area) {
      const scope = segments[2] ? (SCOPE_LABELS[segments[2]] ?? '') : ''
      const verb = segments[1] === 'audit' ? '查看' : '管理'
      label = `可${verb}${area}${scope ? `（${scope}）` : ''}`
    }
  }
  return denied ? `已禁止：${label}` : label
}

const route = useRoute()
const router = useRouter()

const user = authStore.currentUser
const permissions = authStore.permissions

/** The shell's own overview screen, shown unless an area already registers that path. */
const homeItem: AreaMenuItem = { key: 'home', label: '概览', path: '/', group: 'self', order: -1 }

const selfItems = computed<readonly AreaMenuItem[]>(() =>
  menuGroups.self.some((item) => item.path === homeItem.path)
    ? menuGroups.self
    : [homeItem, ...menuGroups.self]
)

function isVisible(item: AreaMenuItem): boolean {
  return hasPermission(item.permission, permissions.value)
}

const menuOptions = computed<MenuOption[]>(() =>
  [
    { label: '我的', key: 'section:self', items: selfItems.value.filter(isVisible) },
    { label: '管理中心', key: 'section:admin', items: menuGroups.admin.filter(isVisible) }
  ]
    .filter((section) => section.items.length > 0)
    .map((section) => ({
      label: section.label,
      key: section.key,
      children: section.items.map((item) => ({ label: item.label, key: item.path }))
    }))
)

/** Key of the entry owning the current route, so detail pages keep their section highlighted. */
const activeKey = computed<string | null>(() => {
  const path = route.path
  let best: string | null = null
  for (const item of [...selfItems.value, ...menuGroups.admin]) {
    if (item.path === path) return item.path
    if (path.startsWith(`${item.path}/`) && item.path.length > (best?.length ?? 0)) best = item.path
  }
  return best
})

function onSelect(key: string | number): void {
  const path = String(key)
  if (path.startsWith('/')) void router.push(path)
}

async function signOut(): Promise<void> {
  await authStore.logout()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <NLayout has-sider class="shell">
    <NLayoutSider :width="220" :native-scrollbar="false" bordered>
      <div class="brand">团队用户控制台</div>
      <NMenu
        :options="menuOptions"
        :value="activeKey"
        :default-expand-all="true"
        @update:value="onSelect"
      />
    </NLayoutSider>

    <NLayout>
      <NLayoutHeader bordered class="header">
        <div class="header-inner">
          <NText strong class="identity">{{ user?.display_name || user?.username || '身份未加载' }}</NText>
          <NSpace class="header-controls" :size="12" align="center">
            <NTag v-if="user" size="small" :type="user.status === 'active' ? 'success' : 'warning'">
              {{ STATUS_LABELS[user.status] ?? '未知' }}
            </NTag>
            <NPopover trigger="hover" placement="bottom-end">
              <template #trigger>
                <NTag size="small" class="permission-trigger">
                  可使用 {{ permissions.length }} 项功能
                </NTag>
              </template>
              <div class="permission-panel">
                <NTag
                  v-for="key in permissions"
                  :key="key"
                  size="small"
                  :type="key.startsWith('!') ? 'error' : 'default'"
                >
                  {{ capabilityLabel(key) }}
                </NTag>
                <NText v-if="permissions.length === 0" depth="3">当前账户暂无可用的功能</NText>
                <NText depth="3" class="permission-hint">
                  以上是你当前可以使用的功能，仅作导航提示，实际以系统判断为准。
                </NText>
              </div>
            </NPopover>
            <NText v-if="user" depth="3">{{ user.username }}</NText>
            <NButton size="small" quaternary @click="signOut">退出登录</NButton>
          </NSpace>
        </div>
      </NLayoutHeader>

      <NLayoutContent class="content" :native-scrollbar="false">
        <RouterView />
      </NLayoutContent>
    </NLayout>
  </NLayout>
</template>

<style scoped>
.shell {
  height: 100vh;
}

.brand {
  padding: 18px 20px;
  font-size: 15px;
  font-weight: 600;
}

.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
  /* Window-edge gutter; wider than the 20px content inset so the controls clear the edge. */
  padding: 0 24px;
}

/* Long display names must not push the account controls into the right edge. */
.identity {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.header-controls {
  flex-shrink: 0;
}

.permission-trigger {
  cursor: pointer;
}

.permission-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 360px;
}

.permission-hint {
  display: block;
  font-size: 12px;
}

.content {
  padding: 20px;
}
</style>
