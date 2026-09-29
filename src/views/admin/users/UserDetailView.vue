<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSpace,
  NTag,
  NText,
  useDialog,
  useMessage,
  type DataTableColumns
} from 'naive-ui'

import * as usersApi from '@/api/admin/users'
import { messageForError } from '@/api/errors'
import type {
  AdminUser,
  ProvisionCredentialsResponse,
  SessionInfo,
  UpdateUserRequest
} from '@/api/types'
import { authStore } from '@/stores/authStore'
import { renderIdCell, shortId } from '../idDisplay'

/**
 * User detail: profile edit, credential/invitation actions and the per-user
 * session list.
 *
 * Profile, credentials, invitations and deletion need `iam:users:any`; the
 * session panel needs `iam:sessions:any` and is not even requested without it.
 */

const SESSION_PERMISSION = 'iam:sessions:any'

interface StatusMeta {
  label: string
  type: 'default' | 'info' | 'success' | 'warning' | 'error'
}

const STATUS_META: Record<string, StatusMeta> = {
  active: { label: '正常', type: 'success' },
  disabled: { label: '已停用', type: 'error' },
  pending: { label: '待审批', type: 'warning' },
  invited: { label: '已邀请', type: 'info' }
}

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const userId = computed(() => String(route.params.id ?? ''))
/** Advisory only: the service remains authoritative and still answers 403. */
const canManageSessions = computed(() => authStore.hasPermission(SESSION_PERMISSION))

const user = ref<AdminUser | null>(null)
const loading = ref(false)
const loadError = ref('')

const profileForm = reactive({ username: '', display_name: '', email: '' })
const profileSaving = ref(false)

const sessions = ref<SessionInfo[]>([])
const sessionsLoading = ref(false)
const sessionsError = ref('')

const showPasswordModal = ref(false)
const newPassword = ref('')
const credentialSubmitting = ref(false)

const showServiceModal = ref(false)
const serviceCredential = ref<ProvisionCredentialsResponse | null>(null)

const showDeleteModal = ref(false)
const deleteConfirmText = ref('')
const deleteSubmitting = ref(false)

function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? { label: status, type: 'default' }
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

async function copyId(value: string | null | undefined): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    message.success('已复制完整编号')
  } catch {
    message.error('复制失败')
  }
}

async function loadSessions(): Promise<void> {
  sessionsLoading.value = true
  sessionsError.value = ''
  try {
    sessions.value = await usersApi.listUserSessions(userId.value)
  } catch (error) {
    sessions.value = []
    sessionsError.value = messageForError(error)
  } finally {
    sessionsLoading.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const loaded = await usersApi.getUser(userId.value)
    user.value = loaded
    profileForm.username = loaded.username
    profileForm.display_name = loaded.display_name
    profileForm.email = loaded.email ?? ''
    if (canManageSessions.value) await loadSessions()
  } catch (error) {
    user.value = null
    loadError.value = messageForError(error)
  } finally {
    loading.value = false
  }
}

async function saveProfile(): Promise<void> {
  const current = user.value
  if (!current) return
  const username = profileForm.username.trim()
  const displayName = profileForm.display_name.trim()
  const email = profileForm.email.trim()
  if (!username || !displayName) {
    message.warning('用户名与显示名不能为空')
    return
  }

  const payload: UpdateUserRequest = {}
  if (username !== current.username) payload.username = username
  if (displayName !== current.display_name) payload.display_name = displayName
  if (email && email !== (current.email ?? '')) payload.email = email
  if (Object.keys(payload).length === 0) {
    message.warning('没有需要保存的修改')
    return
  }

  profileSaving.value = true
  try {
    await usersApi.updateUser(current.id, payload)
    message.success('资料已保存')
    await load()
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    profileSaving.value = false
  }
}

function approveAccount(): void {
  const target = user.value
  if (!target) return
  dialog.success({
    title: '审批通过',
    content: `确认通过用户「${target.username}」的注册审批？审批通过后该账户即可登录。`,
    positiveText: '通过',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.approveUser(target.id)
        message.success('审批已通过')
        await load()
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function disableAccount(): void {
  const target = user.value
  if (!target) return
  dialog.warning({
    title: '停用账户',
    content: `确认停用用户「${target.username}」？停用后，该用户的登录会话会全部失效，需要重新登录。`,
    positiveText: '停用',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.disableUser(target.id)
        message.success('用户已停用')
        await load()
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

async function enableAccount(): Promise<void> {
  const target = user.value
  if (!target) return
  try {
    await usersApi.updateUser(target.id, { status: 'active' })
    message.success('用户已启用')
    await load()
  } catch (error) {
    message.error(messageForError(error))
  }
}

function openPasswordModal(): void {
  newPassword.value = ''
  showPasswordModal.value = true
}

async function submitPasswordReset(): Promise<void> {
  const target = user.value
  if (!target) return
  if (!newPassword.value) {
    message.warning('请输入新密码')
    return
  }
  credentialSubmitting.value = true
  try {
    await usersApi.provisionCredentials(target.id, { kind: 'password', password: newPassword.value })
    showPasswordModal.value = false
    newPassword.value = ''
    message.success('密码已重置')
    await load()
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    credentialSubmitting.value = false
  }
}

function issueServiceCredential(): void {
  const target = user.value
  if (!target) return
  dialog.warning({
    title: '签发服务凭据',
    content: `确认为用户「${target.username}」签发服务凭据？凭据密钥仅在签发时返回一次，请立即保存。`,
    positiveText: '签发',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        serviceCredential.value = await usersApi.provisionCredentials(target.id, { kind: 'service' })
        showServiceModal.value = true
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function resetTotp(): void {
  const target = user.value
  if (!target) return
  dialog.error({
    title: '重置两步验证',
    content: `确认重置用户「${target.username}」的两步验证？该用户已绑定的动态口令与备用恢复码将全部失效。`,
    positiveText: '重置',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.resetUserTotp(target.id)
        message.success('两步验证已重置')
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function resendInvitation(): void {
  const target = user.value
  if (!target) return
  dialog.info({
    title: '重发邀请',
    content: `确认为用户「${target.username}」重新发送邀请？原邀请链接将失效。`,
    positiveText: '重发',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.resendInvitation(target.id)
        message.success('邀请已重新签发')
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function cancelInvitation(): void {
  const target = user.value
  if (!target) return
  dialog.error({
    title: '撤销邀请',
    content: `确认撤销用户「${target.username}」的邀请？撤销会删除该受邀账户，且不可撤销。`,
    positiveText: '撤销邀请',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.cancelInvitation(target.id)
        message.success('邀请已撤销')
        await router.push('/admin/users')
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function revokeSessionConfirm(session: SessionInfo): void {
  const target = user.value
  if (!target) return
  dialog.warning({
    title: '撤销会话',
    content: `确认撤销用户「${target.username}」的会话（${shortId(session.id)}）？该设备需要重新登录。`,
    positiveText: '撤销',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.revokeUserSession(target.id, session.id)
        message.success('会话已撤销')
        await loadSessions()
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function revokeAllSessionsConfirm(): void {
  const target = user.value
  if (!target) return
  dialog.error({
    title: '撤销全部会话',
    content: `确认撤销用户「${target.username}」的全部登录会话？该用户的所有设备都需要重新登录。`,
    positiveText: '全部撤销',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.revokeAllUserSessions(target.id)
        message.success('全部会话已撤销')
        await loadSessions()
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function openDeleteModal(): void {
  deleteConfirmText.value = ''
  showDeleteModal.value = true
}

async function confirmDelete(): Promise<void> {
  const target = user.value
  if (!target) return
  if (deleteConfirmText.value !== target.username) {
    message.warning('请输入完整的用户名以确认删除')
    return
  }
  deleteSubmitting.value = true
  try {
    await usersApi.deleteUser(target.id)
    message.success('用户已删除')
    await router.push('/admin/users')
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    deleteSubmitting.value = false
  }
}

const sessionColumns: DataTableColumns<SessionInfo> = [
  {
    title: '编号',
    key: 'id',
    minWidth: 260,
    render: (row) =>
      renderIdCell(row.id, (ok) => (ok ? message.success('已复制完整编号') : message.error('复制失败')))
  },
  { title: '创建时间', key: 'created_at', minWidth: 180, render: (row) => formatTime(row.created_at) },
  { title: '过期时间', key: 'expires_at', minWidth: 180, render: (row) => formatTime(row.expires_at) },
  {
    title: '操作',
    key: 'actions',
    width: 100,
    render: (row) =>
      h(
        NButton,
        { size: 'small', quaternary: true, type: 'error', onClick: () => revokeSessionConfirm(row) },
        { default: () => '撤销' }
      )
  }
]

onMounted(() => {
  void load()
})
</script>

<template>
  <NSpace vertical :size="16">
    <NCard title="用户详情" :bordered="false">
      <template #header-extra>
        <NSpace :size="8">
          <NButton size="small" :disabled="loading" @click="load">刷新</NButton>
          <NButton size="small" @click="router.push('/admin/users')">返回列表</NButton>
        </NSpace>
      </template>

      <NAlert v-if="loadError" class="block-alert" type="error" :show-icon="false">
        {{ loadError }}
      </NAlert>

      <template v-if="user">
        <NDescriptions :column="2" label-placement="left" bordered>
          <NDescriptionsItem label="编号">
            <code>{{ shortId(user.id) }}</code>
            <NButton size="tiny" quaternary @click="copyId(user.id)">复制</NButton>
          </NDescriptionsItem>
          <NDescriptionsItem label="用户名">{{ user.username }}</NDescriptionsItem>
          <NDescriptionsItem label="显示名">{{ user.display_name }}</NDescriptionsItem>
          <NDescriptionsItem label="状态">
            <NTag size="small" :type="statusMeta(user.status).type">
              {{ statusMeta(user.status).label }}
            </NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="邮箱">{{ user.email ?? '未设置' }}</NDescriptionsItem>
          <NDescriptionsItem label="邮箱验证时间">
            {{ formatTime(user.email_verified_at) }}
          </NDescriptionsItem>
          <NDescriptionsItem label="锁定至">{{ formatTime(user.locked_until) }}</NDescriptionsItem>
          <NDescriptionsItem label="审批时间">{{ formatTime(user.approved_at) }}</NDescriptionsItem>
          <NDescriptionsItem label="审批人">{{ user.approved_by ?? '—' }}</NDescriptionsItem>
          <NDescriptionsItem label="创建时间">{{ formatTime(user.created_at) }}</NDescriptionsItem>
          <NDescriptionsItem label="更新时间">{{ formatTime(user.updated_at) }}</NDescriptionsItem>
        </NDescriptions>
      </template>
    </NCard>

    <NCard v-if="user" title="资料编辑" :bordered="false">
      <NForm label-placement="top" class="form">
        <NFormItem label="用户名">
          <NInput v-model:value="profileForm.username" placeholder="登录用户名" />
        </NFormItem>
        <NFormItem label="显示名">
          <NInput v-model:value="profileForm.display_name" placeholder="展示名称" />
        </NFormItem>
        <NFormItem label="邮箱">
          <NInput v-model:value="profileForm.email" placeholder="留空表示不修改邮箱" />
        </NFormItem>
      </NForm>
      <NButton type="primary" :loading="profileSaving" @click="saveProfile">保存资料</NButton>
      <NText depth="3" class="hint">
        账户状态通过下方「停用账户 / 启用账户」切换；停用会同时退出该用户的全部登录会话。
      </NText>
    </NCard>

    <NCard v-if="user" title="凭据与邀请" :bordered="false">
      <NSpace :size="8">
        <NButton v-if="user.status === 'pending'" size="small" type="primary" @click="approveAccount">
          审批通过
        </NButton>
        <NButton v-if="user.status === 'active'" size="small" @click="disableAccount">停用账户</NButton>
        <NButton v-if="user.status === 'disabled'" size="small" @click="enableAccount">启用账户</NButton>
        <NButton size="small" @click="openPasswordModal">重置密码</NButton>
        <NButton size="small" @click="issueServiceCredential">签发服务凭据</NButton>
        <NButton size="small" @click="resetTotp">重置两步验证</NButton>
        <NButton v-if="user.status === 'invited'" size="small" @click="resendInvitation">
          重发邀请
        </NButton>
        <NButton v-if="user.status === 'invited'" size="small" type="error" @click="cancelInvitation">
          撤销邀请
        </NButton>
      </NSpace>
    </NCard>

    <NCard title="登录会话" :bordered="false">
      <NAlert v-if="!canManageSessions" type="warning" :show-icon="false">
        当前账户没有管理登录会话的权限，无法查看或撤销该用户的会话。
      </NAlert>
      <template v-else>
        <NAlert v-if="sessionsError" class="block-alert" type="error" :show-icon="false">
          {{ sessionsError }}
        </NAlert>
        <NSpace class="block-alert" justify="space-between" align="center">
          <NText depth="3">共 {{ sessions.length }} 个活动会话</NText>
          <NButton
            size="small"
            type="error"
            :disabled="sessions.length === 0"
            :loading="sessionsLoading"
            @click="revokeAllSessionsConfirm"
          >
            撤销全部会话
          </NButton>
        </NSpace>
        <NDataTable
          :columns="sessionColumns"
          :data="sessions"
          :loading="sessionsLoading"
          :pagination="false"
          size="small"
        />
      </template>
    </NCard>

    <NCard title="危险操作" :bordered="false">
      <NText depth="3" class="hint">
        删除用户会级联删除其会话、授权绑定与用户组关系，且不可恢复。
      </NText>
      <NButton v-if="user" type="error" @click="openDeleteModal">删除用户</NButton>
    </NCard>

    <NModal
      v-model:show="showPasswordModal"
      preset="card"
      :title="user ? `重置密码 · ${user.username}` : '重置密码'"
      style="width: 480px"
    >
      <NForm label-placement="top">
        <NFormItem label="新密码">
          <NInput
            v-model:value="newPassword"
            type="password"
            show-password-on="click"
            placeholder="至少 12 位，需同时包含字母和数字"
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end" :size="8">
          <NButton @click="showPasswordModal = false">取消</NButton>
          <NButton type="primary" :loading="credentialSubmitting" @click="submitPasswordReset">
            重置密码
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal
      v-model:show="showServiceModal"
      preset="card"
      :title="user ? `服务凭据 · ${user.username}` : '服务凭据'"
      style="width: 560px"
    >
      <template v-if="serviceCredential">
        <NAlert class="block-alert" type="warning" :show-icon="false">
          密钥仅在本次响应中返回一次，关闭后无法再次查看。
        </NAlert>
        <NDescriptions :column="1" label-placement="left" bordered>
          <NDescriptionsItem label="凭据类型">
            {{ serviceCredential.kind === 'service' ? '服务凭据' : '密码' }}
          </NDescriptionsItem>
          <NDescriptionsItem label="用户名">{{ serviceCredential.username }}</NDescriptionsItem>
          <NDescriptionsItem label="客户端编号">
            {{ serviceCredential.client_id ?? '未返回' }}
          </NDescriptionsItem>
          <NDescriptionsItem label="客户端密钥">
            {{ serviceCredential.client_secret ?? '未返回' }}
          </NDescriptionsItem>
        </NDescriptions>
      </template>
    </NModal>

    <NModal
      v-model:show="showDeleteModal"
      preset="card"
      :title="user ? `删除用户 · ${user.username}` : '删除用户'"
      style="width: 520px"
    >
      <NAlert class="block-alert" type="error" :show-icon="false">
        该操作不可撤销，将一并删除用户「{{ user?.username }}」的会话、授权绑定与用户组关系。
      </NAlert>
      <NText depth="3">请输入用户名 <strong>{{ user?.username }}</strong> 以确认删除：</NText>
      <NInput
        v-model:value="deleteConfirmText"
        class="confirm-input"
        :placeholder="user?.username"
      />
      <template #footer>
        <NSpace justify="end" :size="8">
          <NButton @click="showDeleteModal = false">取消</NButton>
          <NButton
            type="error"
            :disabled="!user || deleteConfirmText !== user.username"
            :loading="deleteSubmitting"
            @click="confirmDelete"
          >
            永久删除
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </NSpace>
</template>

<style scoped>
.block-alert {
  margin-bottom: 12px;
}

.hint {
  display: block;
  margin: 12px 0;
  font-size: 12px;
}

.form {
  max-width: 480px;
}

.confirm-input {
  margin-top: 8px;
}
</style>
