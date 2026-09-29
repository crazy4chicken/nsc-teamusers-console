<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NPopconfirm,
  NSpace,
  NSpin,
  NTable,
  NTd,
  NText,
  NTh,
  NTr,
  useMessage
} from 'naive-ui'

import { isApiError, messageForError } from '@/api/errors'
import { passkeyErrorMessage, passkeySupportError, registerPasskey } from '@/api/mfa'
import { deletePasskey, listPasskeys } from '@/api/me'
import type { PasskeyInfo } from '@/api/types'

/**
 * Passkey management. The service stores no name or device metadata for a
 * credential — a listing carries the unpadded base64url credential id and one
 * shared `created_at` — so the table identifies entries by credential id and
 * offers no rename.
 */

const message = useMessage()

const passkeys = ref<PasskeyInfo[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const registering = ref(false)
const removingId = ref<string | null>(null)
const supportError = ref<string | null>(null)

function formatTimestamp(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    passkeys.value = await listPasskeys()
  } catch (error) {
    loadError.value = messageForError(error)
  } finally {
    loading.value = false
  }
}

async function register(): Promise<void> {
  registering.value = true
  try {
    await registerPasskey()
    message.success('通行密钥已注册，可立即用于登录。')
    await load()
  } catch (error) {
    message.error(passkeyErrorMessage(error))
  } finally {
    registering.value = false
  }
}

async function remove(passkey: PasskeyInfo): Promise<void> {
  removingId.value = passkey.id
  try {
    await deletePasskey(passkey.id)
    message.success('通行密钥已删除。')
    await load()
  } catch (error) {
    if (isApiError(error) && error.status === 404) {
      message.warning('该通行密钥已不存在，列表已刷新。')
      await load()
    } else {
      message.error(messageForError(error))
    }
  } finally {
    removingId.value = null
  }
}

onMounted(() => {
  supportError.value = passkeySupportError()
  void load()
})
</script>

<template>
  <NCard title="通行密钥（Passkey）" :bordered="false">
    <template #header-extra>
      <NButton
        type="primary"
        :loading="registering"
        :disabled="supportError !== null || loading"
        @click="register"
      >
        注册新通行密钥
      </NButton>
    </template>

    <NAlert v-if="supportError" type="warning" title="当前环境无法使用通行密钥">
      {{ supportError }}
    </NAlert>

    <NAlert v-else type="info" :show-icon="false" class="notice">
      通行密钥让你用这台设备的指纹、面容或安全密钥直接登录，无需输入密码。系统不会保存密钥名称，列表以编号区分。
    </NAlert>

    <NAlert v-if="loadError" type="error" title="通行密钥列表加载失败">
      <NSpace align="center" :size="12">
        <NText>{{ loadError }}</NText>
        <NButton size="small" @click="load">重试</NButton>
      </NSpace>
    </NAlert>

    <NSpin :show="loading">
      <NEmpty v-if="passkeys.length === 0" description="尚未注册通行密钥" />

      <NTable v-else :bordered="false" :single-line="false">
        <thead>
          <NTr>
            <NTh>编号</NTh>
            <NTh>添加时间</NTh>
            <NTh>操作</NTh>
          </NTr>
        </thead>
        <tbody>
          <NTr v-for="passkey in passkeys" :key="passkey.id">
            <NTd>
              <NText code class="credential">…{{ passkey.id.slice(-8) }}</NText>
            </NTd>
            <NTd>{{ formatTimestamp(passkey.created_at) }}</NTd>
            <NTd>
              <NPopconfirm
                positive-text="删除"
                negative-text="取消"
                @positive-click="() => remove(passkey)"
              >
                <template #trigger>
                  <NButton
                    size="small"
                    type="error"
                    quaternary
                    :loading="removingId === passkey.id"
                  >
                    删除
                  </NButton>
                </template>
                删除后该设备和密钥将无法再登录，此操作不可撤销。
              </NPopconfirm>
            </NTd>
          </NTr>
        </tbody>
      </NTable>
    </NSpin>
  </NCard>
</template>

<style scoped>
.notice {
  margin-bottom: 16px;
}

.credential {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
