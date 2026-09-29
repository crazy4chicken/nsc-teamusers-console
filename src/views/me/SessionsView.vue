<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NPopconfirm,
  NSpace,
  NSpin,
  NTable,
  NTag,
  NTd,
  NText,
  NTh,
  NTr,
  useDialog,
  useMessage
} from 'naive-ui'

import { isApiError, messageForError } from '@/api/errors'
import { listSessions, revokeAllSessions, revokeSession } from '@/api/me'
import type { SessionInfo } from '@/api/types'
import { authStore } from '@/stores/authStore'

/**
 * Refresh sessions of the signed-in user. The service lists only unrevoked,
 * unexpired sessions and never marks which one the caller is using: every
 * rotation creates a fresh row (the previous one is revoked as `rotated`), so
 * the newest row is the session this browser is on right after a page load.
 * That inference is labelled as such in the UI and drives nothing by itself.
 */

const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const sessions = ref<SessionInfo[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const revokingId = ref<string | null>(null)
const revokingAll = ref(false)

/** Newest `created_at` wins; the service returns the list oldest first. */
const inferredCurrentId = computed(() => {
  let newest: SessionInfo | null = null
  for (const session of sessions.value) {
    if (!newest) {
      newest = session
      continue
    }
    if (new Date(session.created_at).getTime() >= new Date(newest.created_at).getTime()) {
      newest = session
    }
  }
  return newest?.id ?? null
})

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function formatRemaining(expiresAt: string | null): string {
  if (!expiresAt) return '—'
  const expires = new Date(expiresAt).getTime()
  if (Number.isNaN(expires)) return '—'
  const remaining = expires - Date.now()
  if (remaining <= 0) return '已过期'
  const days = Math.floor(remaining / 86_400_000)
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000)
  if (days > 0) return `${days} 天 ${hours} 小时`
  const minutes = Math.max(1, Math.floor((remaining % 3_600_000) / 60_000))
  return `${hours} 小时 ${minutes} 分钟`
}

/** A surfaced 401 means the refresh token is gone: the local session is over. */
function handleFailure(error: unknown): void {
  if (isApiError(error) && error.status === 401) {
    authStore.clearSession()
    void router.replace({ name: 'login' })
    return
  }
  message.error(messageForError(error))
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    sessions.value = await listSessions()
  } catch (error) {
    if (isApiError(error) && error.status === 401) handleFailure(error)
    else loadError.value = messageForError(error)
  } finally {
    loading.value = false
  }
}

async function revoke(session: SessionInfo): Promise<void> {
  revokingId.value = session.id
  try {
    await revokeSession(session.id)
    message.success('该会话已撤销。')
    await load()
  } catch (error) {
    if (isApiError(error) && error.status === 404) {
      message.warning('该会话已不存在，列表已刷新。')
      await load()
    } else {
      handleFailure(error)
    }
  } finally {
    revokingId.value = null
  }
}

async function revokeAll(): Promise<void> {
  revokingAll.value = true
  try {
    const result = await revokeAllSessions()
    if (result.failed.length > 0) {
      message.warning(
        `已撤销 ${result.revoked.length} 个会话，${result.failed.length} 个未能撤销，正在重新加载列表。`
      )
      await load()
      return
    }
    authStore.clearSession()
    await router.replace({ name: 'login' })
    message.success(`已撤销全部 ${result.revoked.length} 个会话，请重新登录。`)
  } catch (error) {
    handleFailure(error)
  } finally {
    revokingAll.value = false
  }
}

function confirmRevokeAll(): void {
  const count = sessions.value.length
  dialog.warning({
    title: '撤销全部会话',
    content: `将撤销全部 ${count} 个会话，其中包括当前浏览器正在使用的会话；完成后需要使用密码重新登录。`,
    positiveText: '全部撤销',
    negativeText: '取消',
    onPositiveClick: () => {
      void revokeAll()
    }
  })
}

onMounted(() => {
  void load()
})
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="16">
      <NCard title="登录会话" :bordered="false">
        <template #header-extra>
          <NSpace>
            <NButton size="small" :disabled="loading" @click="load">刷新</NButton>
            <NButton
              size="small"
              type="error"
              secondary
              :disabled="sessions.length === 0 || revokingAll"
              :loading="revokingAll"
              @click="confirmRevokeAll"
            >
              撤销全部会话
            </NButton>
          </NSpace>
        </template>

        <NAlert type="info" :show-icon="false" class="notice">
          这里列出仍在有效期内的登录会话。最近登录的一条通常就是本浏览器正在使用的会话，撤销它会同时退出本浏览器的登录。
        </NAlert>

        <NAlert v-if="loadError" type="error" title="会话列表加载失败">
          <NSpace align="center" :size="12">
            <NText>{{ loadError }}</NText>
            <NButton size="small" @click="load">重试</NButton>
          </NSpace>
        </NAlert>

        <NEmpty v-else-if="sessions.length === 0" description="没有有效的登录会话" />

        <NTable v-else :bordered="false" :single-line="false">
          <thead>
            <NTr>
              <NTh>登录时间</NTh>
              <NTh>失效时间</NTh>
              <NTh>剩余有效期</NTh>
              <NTh>操作</NTh>
            </NTr>
          </thead>
          <tbody>
            <NTr v-for="session in sessions" :key="session.id">
              <NTd>
                <NSpace align="center" :size="8">
                  <NText>{{ formatTimestamp(session.created_at) }}</NText>
                  <NTag v-if="session.id === inferredCurrentId" size="small" type="success">
                    当前会话
                  </NTag>
                </NSpace>
              </NTd>
              <NTd>{{ formatTimestamp(session.expires_at) }}</NTd>
              <NTd>{{ formatRemaining(session.expires_at) }}</NTd>
              <NTd>
                <NPopconfirm
                  positive-text="撤销"
                  negative-text="取消"
                  @positive-click="() => revoke(session)"
                >
                  <template #trigger>
                    <NButton
                      size="small"
                      type="error"
                      quaternary
                      :loading="revokingId === session.id"
                      :disabled="revokingAll"
                    >
                      撤销
                    </NButton>
                  </template>
                  撤销后，使用该会话的设备需要重新登录。
                </NPopconfirm>
              </NTd>
            </NTr>
          </tbody>
        </NTable>
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.notice {
  margin-bottom: 16px;
}
</style>
