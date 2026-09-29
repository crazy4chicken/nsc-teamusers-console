<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NDivider,
  NForm,
  NFormItem,
  NInput,
  NSpace,
  NText
} from 'naive-ui'

import { isApiError, messageForError } from '@/api/errors'
import { passkeySupportError } from '@/api/mfa'
import { loginWithPasskey, passkeyLoginErrorMessage } from '@/api/passkeyLogin'
import { authStore, type LoginStep } from '@/stores/authStore'
import AuthPage from './auth/AuthPage.vue'
import { PASSWORD_HINT, confirmedPasswordProblem } from './auth/form'

type Step = 'credentials' | Exclude<LoginStep, 'authenticated'>

const route = useRoute()
const router = useRouter()

const step = ref<Step>('credentials')
const username = ref('')
const password = ref('')
const mfaCode = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const submitting = ref(false)
const passkeySubmitting = ref(false)
const errorMessage = ref('')
const rateLimited = ref(false)
const notice = ref('')

/** Non-null when this browser cannot run a WebAuthn assertion at all. */
const passkeyUnsupported = ref(passkeySupportError())

const cardTitle = computed(() => {
  if (step.value === 'mfa_required') return '两步验证'
  if (step.value === 'password_change_required') return '设置新密码'
  return '登录'
})

/** Never follow a protocol-relative or absolute redirect. */
const redirectTarget = computed(() => {
  const value = route.query.redirect
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value
  return '/'
})

const newPasswordProblem = computed(() =>
  newPassword.value ? (confirmedPasswordProblem(newPassword.value, confirmPassword.value) ?? '') : ''
)

/**
 * `map` defaults to the shared wording; the passkey button supplies its own,
 * because a rejected assertion is not a bad username/password.
 */
function applyError(error: unknown, map: (value: unknown) => string = messageForError): void {
  rateLimited.value = isApiError(error) && error.status === 429
  errorMessage.value = rateLimited.value ? '操作太频繁，请稍后再试。' : map(error)
}

async function gotoNextStep(next: LoginStep): Promise<void> {
  if (next === 'authenticated') {
    await router.replace(redirectTarget.value)
    return
  }
  step.value = next
}

async function submitCredentials(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  notice.value = ''
  submitting.value = true
  try {
    const next = await authStore.login(username.value.trim(), password.value)
    if (next === 'mfa_required') {
      notice.value = '请输入两步验证应用生成的动态码，或使用一枚备用恢复码。'
    } else if (next === 'password_change_required') {
      notice.value = '首次登录需要先设置新密码，设置后将使用新密码重新登录。'
    }
    await gotoNextStep(next)
  } catch (error) {
    applyError(error)
  } finally {
    submitting.value = false
  }
}

async function submitMfa(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  submitting.value = true
  try {
    await authStore.completeMfa(mfaCode.value.trim())
    await router.replace(redirectTarget.value)
  } catch (error) {
    applyError(error)
  } finally {
    submitting.value = false
  }
}

async function submitPasswordChange(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  if (newPasswordProblem.value) {
    errorMessage.value = newPasswordProblem.value
    return
  }
  submitting.value = true
  try {
    const next = await authStore.completeForcedPasswordChange(newPassword.value)
    if (next === 'mfa_required') {
      notice.value = '请输入两步验证应用生成的动态码，或使用一枚备用恢复码。'
    }
    await gotoNextStep(next)
  } catch (error) {
    applyError(error)
  } finally {
    submitting.value = false
  }
}

/**
 * Passkey assertion: an omitted username means a discoverable
 * (usernameless) login, in which case the authenticator itself picks the
 * credential. A filled username narrows the server-side `allowCredentials`.
 */
async function submitPasskey(): Promise<void> {
  if (passkeySubmitting.value || submitting.value) return
  errorMessage.value = ''
  notice.value = ''
  passkeySubmitting.value = true
  try {
    const tokens = await loginWithPasskey(username.value.trim() || undefined)
    await authStore.adoptTokens(tokens)
    await router.replace(redirectTarget.value)
  } catch (error) {
    applyError(error, passkeyLoginErrorMessage)
  } finally {
    passkeySubmitting.value = false
  }
}
</script>

<template>
  <AuthPage :title="cardTitle">
    <NAlert v-if="notice" class="login-alert" type="info" :show-icon="false">{{ notice }}</NAlert>
    <NAlert
      v-if="errorMessage"
      class="login-alert"
      :type="rateLimited ? 'warning' : 'error'"
      :title="rateLimited ? '操作太频繁' : undefined"
    >
      {{ errorMessage }}
    </NAlert>

    <NForm v-if="step === 'credentials'" @submit.prevent="submitCredentials">
      <NFormItem label="用户名">
        <NInput v-model:value="username" placeholder="用户名" autocomplete="username" />
      </NFormItem>
      <NFormItem label="密码">
        <NInput
          v-model:value="password"
          type="password"
          show-password-on="click"
          placeholder="密码"
          autocomplete="current-password"
          @keyup.enter="submitCredentials"
        />
      </NFormItem>
      <NButton
        type="primary"
        block
        :loading="submitting"
        :disabled="!username || !password"
        @click="submitCredentials"
      >
        登录
      </NButton>

      <NDivider>或</NDivider>

      <NButton
        block
        :loading="passkeySubmitting"
        :disabled="passkeyUnsupported !== null || submitting"
        @click="submitPasskey"
      >
        用通行密钥登录
      </NButton>
      <NText depth="3" class="login-hint">
        {{
          passkeyUnsupported ??
          '用户名可留空，留空时将使用这台设备上已保存的通行密钥登录。'
        }}
      </NText>

      <NSpace justify="space-between" class="login-links">
        <NButton text type="primary" @click="router.push('/register')">注册新账户</NButton>
        <NButton text @click="router.push('/forgot-password')">忘记密码</NButton>
      </NSpace>
    </NForm>

    <NForm v-else-if="step === 'mfa_required'" @submit.prevent="submitMfa">
      <NFormItem label="验证码">
        <NInput
          v-model:value="mfaCode"
          placeholder="6 位动态码或备用恢复码"
          autocomplete="one-time-code"
          @keyup.enter="submitMfa"
        />
      </NFormItem>
      <NButton type="primary" block :loading="submitting" :disabled="!mfaCode" @click="submitMfa">
        验证并登录
      </NButton>
    </NForm>

    <NForm v-else @submit.prevent="submitPasswordChange">
      <NFormItem
        label="新密码"
        :feedback="newPasswordProblem"
        :validation-status="newPasswordProblem ? 'error' : undefined"
      >
        <NInput
          v-model:value="newPassword"
          type="password"
          show-password-on="click"
          :placeholder="PASSWORD_HINT"
          autocomplete="new-password"
        />
      </NFormItem>
      <NFormItem label="确认新密码">
        <NInput
          v-model:value="confirmPassword"
          type="password"
          show-password-on="click"
          autocomplete="new-password"
          @keyup.enter="submitPasswordChange"
        />
      </NFormItem>
      <NButton
        type="primary"
        block
        :loading="submitting"
        :disabled="!newPassword || !confirmPassword || newPasswordProblem !== ''"
        @click="submitPasswordChange"
      >
        保存并重新登录
      </NButton>
    </NForm>
  </AuthPage>
</template>

<style scoped>
.login-alert {
  margin-bottom: 16px;
}

.login-hint {
  display: block;
  margin-top: 8px;
  font-size: 12px;
}

.login-links {
  margin-top: 16px;
}
</style>
