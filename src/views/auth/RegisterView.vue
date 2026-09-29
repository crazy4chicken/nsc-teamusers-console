<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NFormItem, NInput, NSpace } from 'naive-ui'

import { register } from '@/api/auth'
import { isApiError, messageForError } from '@/api/errors'
import type { UserStatus } from '@/api/types'
import AuthPage from './AuthPage.vue'
import { PASSWORD_HINT, confirmedPasswordProblem } from './form'

/**
 * Public self-registration (`POST /auth/register`).
 *
 * The service answers 201 with `{id,status}`: `pending` under
 * `TEAMUSERS_REGISTRATION_MODE=approval`, `active` under `open`. When
 * self-registration is disabled the handler rejects with `403
 * registration_closed`, which the shared error mapping already words.
 */

/** The service rejects a malformed address with `400 invalid_email`. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const router = useRouter()

const form = ref({ username: '', email: '', displayName: '', password: '', confirm: '' })
const submitting = ref(false)
const errorMessage = ref('')
const rateLimited = ref(false)
/** Set once the account exists; drives the success panel. */
const created = ref<UserStatus | null>(null)

const emailProblem = computed(() =>
  form.value.email.trim() && !EMAIL_PATTERN.test(form.value.email.trim())
    ? '请输入有效的邮箱地址'
    : ''
)

const passwordProblem = computed(() =>
  form.value.password ? (confirmedPasswordProblem(form.value.password, form.value.confirm) ?? '') : ''
)

const canSubmit = computed(
  () =>
    Boolean(form.value.username.trim() && form.value.email.trim() && form.value.password) &&
    !emailProblem.value &&
    !passwordProblem.value
)

async function submit(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  rateLimited.value = false
  const problem = form.value.username.trim() ? emailProblem.value || passwordProblem.value : '请输入用户名'
  if (problem) {
    errorMessage.value = problem
    return
  }
  submitting.value = true
  try {
    const username = form.value.username.trim()
    const response = await register({
      username,
      email: form.value.email.trim(),
      password: form.value.password,
      // The field is required on the wire; an empty display name falls back to the username.
      display_name: form.value.displayName.trim() || username
    })
    created.value = response.status
  } catch (error) {
    rateLimited.value = isApiError(error) && error.status === 429
    errorMessage.value = messageForError(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthPage title="注册">
    <template v-if="created !== null">
      <NAlert type="success" title="注册成功">
        {{
          created === 'pending'
            ? '账户已创建，正在等待管理员审批；审批通过后即可登录。'
            : '账户已创建，现在可以直接登录。'
        }}
      </NAlert>
      <NAlert type="info" :show-icon="false" class="auth-notice">
        如果需要验证邮箱，请查收验证邮件并打开其中的链接，也可以直接在“邮箱验证”页面粘贴邮件中的令牌。
      </NAlert>
      <NSpace>
        <NButton type="primary" @click="router.push('/login')">返回登录</NButton>
        <NButton quaternary @click="router.push('/verify-email')">前往邮箱验证</NButton>
      </NSpace>
    </template>

    <template v-else>
      <NAlert
        v-if="errorMessage"
        class="auth-notice"
        :type="rateLimited ? 'warning' : 'error'"
        :title="rateLimited ? '操作太频繁' : undefined"
      >
        {{ errorMessage }}
      </NAlert>

      <NForm @submit.prevent="submit">
        <NFormItem label="用户名">
          <NInput v-model:value="form.username" placeholder="登录时使用的用户名" autocomplete="username" />
        </NFormItem>
        <NFormItem label="邮箱" :feedback="emailProblem" :validation-status="emailProblem ? 'error' : undefined">
          <NInput v-model:value="form.email" placeholder="用于验证和找回密码" autocomplete="email" />
        </NFormItem>
        <NFormItem label="显示名">
          <NInput v-model:value="form.displayName" placeholder="留空则使用用户名" />
        </NFormItem>
        <NFormItem label="密码" :feedback="passwordProblem" :validation-status="passwordProblem ? 'error' : undefined">
          <NInput
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            :placeholder="PASSWORD_HINT"
            autocomplete="new-password"
          />
        </NFormItem>
        <NFormItem label="确认密码">
          <NInput
            v-model:value="form.confirm"
            type="password"
            show-password-on="click"
            placeholder="再次输入密码"
            autocomplete="new-password"
            @keyup.enter="submit"
          />
        </NFormItem>
        <NButton type="primary" block :loading="submitting" :disabled="!canSubmit" @click="submit">
          注册
        </NButton>
      </NForm>

      <NSpace justify="center" class="auth-footnote">
        <NButton text type="primary" @click="router.push('/login')">已有账户？去登录</NButton>
      </NSpace>
    </template>
  </AuthPage>
</template>

<style scoped>
.auth-notice {
  margin-bottom: 16px;
}

.auth-footnote {
  margin-top: 16px;
}
</style>
