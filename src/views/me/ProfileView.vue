<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NForm,
  NFormItem,
  NInput,
  NSpace,
  NSpin,
  NTag,
  NText,
  useDialog,
  useMessage
} from 'naive-ui'

import { isApiError, messageForError } from '@/api/errors'
import {
  changePassword,
  confirmEmailChange,
  deleteAccount,
  getProfile,
  requestEmailChange,
  updateProfile
} from '@/api/me'
import type { Profile, UserStatus } from '@/api/types'
import { authStore } from '@/stores/authStore'
import { queryToken } from '@/views/auth/form'

/**
 * Read-only identity plus the self-service edits: profile fields, the password,
 * the e-mail address and account closure. Changing the password or closing the
 * account revokes every session server-side, so the screen signs the browser out
 * afterwards and states why.
 *
 * `/me/email` never echoes the requested address and `/me` has no pending-email
 * field, so the pending state is tracked in component state and the confirmation
 * token stays with the user (it arrives by mail): the screen offers both the
 * `?token=` link entry point and a manual token field.
 */

/** `TEAMUSERS_PASSWORD_MIN_LENGTH` defaults to 12; the service also demands a letter and a digit. */
const MIN_PASSWORD_LENGTH = 12

/** Shape check only; the service owns the real validation (`invalid_email`). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const STATUS_LABELS: Record<UserStatus, string> = {
  active: '正常',
  disabled: '已禁用',
  pending: '待审批',
  invited: '已邀请'
}

const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const profile = ref<Profile | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)

const editForm = reactive({ username: '', displayName: '' })
const savingProfile = ref(false)

const passwordForm = reactive({ current: '', next: '', confirm: '' })
const changingPassword = ref(false)

const emailForm = reactive({ newEmail: '', password: '' })
const requestingEmailChange = ref(false)
/** Address waiting for confirmation; `/me/email` returns no body, so the screen remembers it. */
const pendingEmail = ref<string | null>(null)
const emailToken = ref('')
const confirmingEmail = ref(false)

const deleteForm = reactive({ password: '', username: '' })
const deletingAccount = ref(false)

const route = useRoute()

/** Unlocks the destructive button only on an exact-username typed confirmation plus a password. */
const deleteConfirmationMatches = computed(
  () =>
    profile.value !== null &&
    deleteForm.username.trim() !== '' &&
    deleteForm.username.trim() === profile.value.username
)
const deleteConfirmed = computed(
  () => deleteConfirmationMatches.value && deleteForm.password.length > 0
)

const statusLabel = computed(() =>
  profile.value ? (STATUS_LABELS[profile.value.status] ?? profile.value.status) : ''
)

const profileDirty = computed(() => {
  const current = profile.value
  if (!current) return false
  return (
    editForm.username.trim() !== current.username ||
    editForm.displayName.trim() !== current.display_name
  )
})

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const loaded = await getProfile()
    profile.value = loaded
    editForm.username = loaded.username
    editForm.displayName = loaded.display_name
  } catch (error) {
    loadError.value = messageForError(error)
  } finally {
    loading.value = false
  }
}

/** Restores the form to the values the service last returned. */
function resetProfileForm(): void {
  editForm.username = profile.value?.username ?? ''
  editForm.displayName = profile.value?.display_name ?? ''
}

async function saveProfile(): Promise<void> {
  const current = profile.value
  if (!current) return

  const username = editForm.username.trim()
  const displayName = editForm.displayName.trim()
  if (!username && !displayName) {
    message.warning('用户名与显示名不能同时为空。')
    return
  }

  const payload: { username?: string; display_name?: string } = {}
  if (username !== current.username) {
    if (!username) {
      message.warning('用户名不能为空。')
      return
    }
    payload.username = username
  }
  if (displayName !== current.display_name) payload.display_name = displayName
  if (!payload.username && payload.display_name === undefined) {
    message.info('没有需要保存的修改。')
    return
  }

  savingProfile.value = true
  try {
    profile.value = await updateProfile(payload)
    editForm.username = profile.value.username
    editForm.displayName = profile.value.display_name
    message.success('资料已更新。')
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    savingProfile.value = false
  }
}

/** Mirrors the server rule so a weak password is not round-tripped: 12+ with a letter and a digit. */
function passwordPolicyError(value: string): string | null {
  if (value.length < MIN_PASSWORD_LENGTH) return `新密码至少需要 ${MIN_PASSWORD_LENGTH} 位。`
  if (!/[A-Za-z]/.test(value)) return '新密码需要包含字母。'
  if (!/\d/.test(value)) return '新密码需要包含数字。'
  return null
}

async function submitPasswordChange(): Promise<void> {
  const current = passwordForm.current
  const next = passwordForm.next
  if (!current) {
    message.warning('请输入当前密码。')
    return
  }
  const policy = passwordPolicyError(next)
  if (policy) {
    message.warning(policy)
    return
  }
  if (next !== passwordForm.confirm) {
    message.warning('两次输入的新密码不一致。')
    return
  }
  if (next === current) {
    message.warning('新密码不能与当前密码相同。')
    return
  }

  changingPassword.value = true
  try {
    await changePassword({ current_password: current, new_password: next })
    passwordForm.current = ''
    passwordForm.next = ''
    passwordForm.confirm = ''
    dialog.success({
      title: '密码已修改',
      content: '密码修改后，所有设备上的登录都已失效，请使用新密码重新登录。',
      positiveText: '重新登录',
      onPositiveClick: () => {
        authStore.clearSession()
        void router.replace({ name: 'login' })
      }
    })
  } catch (error) {
    message.error(
      isApiError(error) && error.status === 401 ? '当前密码不正确。' : messageForError(error)
    )
  } finally {
    changingPassword.value = false
  }
}

/** Starts the e-mail change; nothing takes effect before the mailed token is confirmed. */
async function submitEmailChange(): Promise<void> {
  const target = emailForm.newEmail.trim()
  if (!EMAIL_PATTERN.test(target)) {
    message.warning('请输入有效的邮箱地址。')
    return
  }
  if (profile.value?.email && profile.value.email.toLowerCase() === target.toLowerCase()) {
    message.warning('新邮箱与当前邮箱相同。')
    return
  }
  if (!emailForm.password) {
    message.warning('请输入当前密码。')
    return
  }

  requestingEmailChange.value = true
  try {
    await requestEmailChange({ new_email: target, password: emailForm.password })
    pendingEmail.value = target
    emailForm.newEmail = ''
    emailForm.password = ''
    message.success('修改请求已提交，请完成邮箱确认后新邮箱才会生效。')
  } catch (error) {
    message.error(
      isApiError(error) && error.status === 401 ? '当前密码不正确。' : messageForError(error)
    )
  } finally {
    requestingEmailChange.value = false
  }
}

/** Completes the change with the one-time token sent to the new address, then re-reads the profile. */
async function submitEmailConfirm(): Promise<void> {
  const token = emailToken.value.trim()
  if (!token) {
    message.warning('请输入邮箱确认令牌。')
    return
  }

  confirmingEmail.value = true
  try {
    await confirmEmailChange({ token })
    emailToken.value = ''
    pendingEmail.value = null
    message.success('邮箱已确认并更新。')
    await load()
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    confirmingEmail.value = false
  }
}

/**
 * Irreversible closure. `DELETE /me` anonymizes and disables the account and
 * destroys its credentials and sessions server-side, so the browser signs out
 * and returns to the login page.
 */
async function submitAccountDeletion(): Promise<void> {
  if (!deleteConfirmed.value) {
    message.warning('请先输入当前密码，并完整输入用户名以确认注销。')
    return
  }

  deletingAccount.value = true
  try {
    await deleteAccount({ password: deleteForm.password })
    deleteForm.password = ''
    deleteForm.username = ''
    // Every session is already revoked server-side; this also clears local state.
    await authStore.logout()
    message.success('账户已注销，全部登录会话与凭据均已销毁。')
    void router.replace({ name: 'login' })
  } catch (error) {
    message.error(
      isApiError(error) && error.status === 401 ? '当前密码不正确。' : messageForError(error)
    )
  } finally {
    deletingAccount.value = false
  }
}

onMounted(() => {
  void load()

  // Link entry point: `/me/profile?token=<email-change token>`.
  const linkedToken = queryToken(route.query.token ?? null)
  if (linkedToken) {
    emailToken.value = linkedToken
    void submitEmailConfirm().finally(() => {
      // Keep the one-time token out of the address bar and out of a reload.
      void router.replace({
        query: Object.fromEntries(
          Object.entries(route.query).filter(([key]) => key !== 'token')
        )
      })
    })
  }
})
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="16">
      <NAlert v-if="loadError" type="error" title="资料加载失败">
        <NSpace align="center" :size="12">
          <NText>{{ loadError }}</NText>
          <NButton size="small" @click="load">重试</NButton>
        </NSpace>
      </NAlert>

      <NCard title="账户资料" :bordered="false">
        <NDescriptions v-if="profile" :column="2" label-placement="left" bordered>
          <NDescriptionsItem label="用户名">{{ profile.username }}</NDescriptionsItem>
          <NDescriptionsItem label="显示名">{{ profile.display_name }}</NDescriptionsItem>
          <NDescriptionsItem label="状态">
            <NTag size="small" :type="profile.status === 'active' ? 'success' : 'warning'">
              {{ statusLabel }}
            </NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="邮箱">
            {{ profile.email ?? '未设置' }}
          </NDescriptionsItem>
          <NDescriptionsItem label="邮箱验证时间">
            {{ formatTimestamp(profile.email_verified_at) }}
          </NDescriptionsItem>
          <NDescriptionsItem label="创建时间">
            {{ formatTimestamp(profile.created_at) }}
          </NDescriptionsItem>
        </NDescriptions>

        <NDivider />

        <NForm label-placement="left" :label-width="96" @submit.prevent="saveProfile">
          <NFormItem label="用户名">
            <NInput v-model:value="editForm.username" placeholder="登录用户名" />
          </NFormItem>
          <NFormItem label="显示名">
            <NInput v-model:value="editForm.displayName" placeholder="界面上展示的名字" />
          </NFormItem>
          <NFormItem label=" ">
            <NSpace align="center">
              <NButton
                type="primary"
                attr-type="submit"
                :loading="savingProfile"
                :disabled="!profileDirty"
              >
                保存修改
              </NButton>
              <NButton :disabled="!profileDirty || savingProfile" @click="resetProfileForm">
                重置
              </NButton>
              <NText depth="3" class="hint">导航栏中的显示名在下次刷新页面后同步。</NText>
            </NSpace>
          </NFormItem>
        </NForm>
      </NCard>

      <NCard title="修改密码" :bordered="false">
        <NAlert type="info" :show-icon="false" class="policy">
          新密码至少 {{ MIN_PASSWORD_LENGTH }} 位，且需同时包含字母与数字。修改成功后该账户的全部登录会话都会被撤销。
        </NAlert>

        <NForm label-placement="left" :label-width="96" @submit.prevent="submitPasswordChange">
          <NFormItem label="当前密码">
            <NInput
              v-model:value="passwordForm.current"
              type="password"
              show-password-on="click"
              placeholder="当前登录密码"
              autocomplete="current-password"
            />
          </NFormItem>
          <NFormItem label="新密码">
            <NInput
              v-model:value="passwordForm.next"
              type="password"
              show-password-on="click"
              placeholder="至少 12 位，含字母与数字"
              autocomplete="new-password"
            />
          </NFormItem>
          <NFormItem label="确认新密码">
            <NInput
              v-model:value="passwordForm.confirm"
              type="password"
              show-password-on="click"
              placeholder="再次输入新密码"
              autocomplete="new-password"
            />
          </NFormItem>
          <NFormItem label=" ">
            <NButton type="primary" attr-type="submit" :loading="changingPassword">
              修改密码
            </NButton>
          </NFormItem>
        </NForm>
      </NCard>

      <NCard title="修改邮箱" :bordered="false">
        <template #header-extra>
          <NTag v-if="pendingEmail" type="warning" size="small">待确认</NTag>
        </template>

        <NAlert type="info" :show-icon="false" class="notice">
          提交后，确认令牌会发送到新邮箱。只有完成确认，新邮箱才会真正生效；在此之前账户邮箱保持不变。
        </NAlert>

        <NText depth="3" class="current-email">当前邮箱：{{ profile?.email ?? '未设置' }}</NText>

        <NForm label-placement="left" :label-width="96" @submit.prevent="submitEmailChange">
          <NFormItem label="新邮箱">
            <NInput v-model:value="emailForm.newEmail" placeholder="new@example.com" />
          </NFormItem>
          <NFormItem label="当前密码">
            <NInput
              v-model:value="emailForm.password"
              type="password"
              show-password-on="click"
              placeholder="用于确认身份"
              autocomplete="current-password"
            />
          </NFormItem>
          <NFormItem label=" ">
            <NButton type="primary" attr-type="submit" :loading="requestingEmailChange">
              提交修改请求
            </NButton>
          </NFormItem>
        </NForm>

        <NDivider />

        <NAlert v-if="pendingEmail" type="warning" :show-icon="false" class="pending">
          <NSpace vertical :size="4">
            <NText strong>待确认的新邮箱：{{ pendingEmail }}</NText>
            <NText>请查收该邮箱收到的确认令牌并在下方完成确认，确认前新邮箱不会生效。</NText>
          </NSpace>
        </NAlert>

        <NForm label-placement="left" :label-width="96" @submit.prevent="submitEmailConfirm">
          <NFormItem label="确认令牌">
            <NInput v-model:value="emailToken" placeholder="邮件中的确认令牌" />
          </NFormItem>
          <NFormItem label=" ">
            <NSpace align="center">
              <NButton
                type="primary"
                attr-type="submit"
                :loading="confirmingEmail"
                :disabled="!emailToken.trim()"
              >
                完成邮箱确认
              </NButton>
              <NText depth="3" class="hint">
                也可以直接打开邮件中的确认链接完成确认。
              </NText>
            </NSpace>
          </NFormItem>
        </NForm>
      </NCard>

      <NCard title="注销账户" :bordered="false">
        <NAlert type="error" title="此操作不可撤销" :show-icon="false" class="notice">
          <NSpace vertical :size="4">
            <NText>
              注销后账户将被匿名化并停用：当前密码、两步验证、备用码与通行密钥全部销毁，所有登录会话立即失效，且无法恢复。
            </NText>
            <NText>注销后本浏览器会清除登录状态并返回登录页。</NText>
          </NSpace>
        </NAlert>

        <NForm label-placement="left" :label-width="96" @submit.prevent="submitAccountDeletion">
          <NFormItem label="当前密码">
            <NInput
              v-model:value="deleteForm.password"
              type="password"
              show-password-on="click"
              placeholder="用于确认身份"
              autocomplete="current-password"
            />
          </NFormItem>
          <NFormItem label="输入用户名">
            <NInput
              v-model:value="deleteForm.username"
              :placeholder="`请输入 ${profile?.username ?? '用户名'} 以确认`"
            />
          </NFormItem>
          <NFormItem label=" ">
            <NSpace align="center">
              <NButton type="error" attr-type="submit" :loading="deletingAccount" :disabled="!deleteConfirmed">
                永久注销账户
              </NButton>
              <NText v-if="deleteForm.username && !deleteConfirmationMatches" type="error" class="hint">
                用户名与当前账户不一致。
              </NText>
              <NText v-else depth="3" class="hint">
                按钮仅在用户名完全一致且已填写当前密码时可用。
              </NText>
            </NSpace>
          </NFormItem>
        </NForm>
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.hint {
  font-size: 12px;
}

.policy {
  margin-bottom: 16px;
}

.notice,
.pending {
  margin-bottom: 16px;
}

.current-email {
  display: block;
  margin-bottom: 16px;
}
</style>
