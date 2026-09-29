<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NFormItem, NInput, NSpace } from 'naive-ui'

import { confirmPasswordReset } from '@/api/auth'
import { isApiError, messageForError } from '@/api/errors'
import AuthPage from './AuthPage.vue'
import { PASSWORD_HINT, confirmedPasswordProblem, queryToken } from './form'

/**
 * Consumes the reset token (`POST /auth/password-reset/confirm`).
 *
 * The token arrives as `?token=…` on the link the mail carries and may also be
 * pasted by hand. The service answers 204 and never signs the browser in: the
 * reset revokes the account's sessions, so the user returns to the login page.
 * An unknown or expired token is `400 invalid_token`.
 */

const route = useRoute()
const router = useRouter()

const linkToken = queryToken(route.query.token)
const token = ref(linkToken)
const password = ref('')
const confirm = ref('')
const submitting = ref(false)
const reset = ref(false)
const rateLimited = ref(false)
const errorMessage = ref(
  linkToken ? '' : '链接中缺少重置令牌，请在下方粘贴邮件里的重置令牌后重试。'
)

const errorTitle = computed(() => (token.value.trim() ? '重置失败' : '缺少重置令牌'))

const passwordProblem = computed(() =>
  password.value ? (confirmedPasswordProblem(password.value, confirm.value) ?? '') : ''
)

const canSubmit = computed(
  () => Boolean(token.value.trim() && password.value && confirm.value) && !passwordProblem.value
)

async function submit(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  rateLimited.value = false
  if (!token.value.trim()) {
    errorMessage.value = '请输入邮件中的重置令牌。'
    return
  }
  if (passwordProblem.value) {
    errorMessage.value = passwordProblem.value
    return
  }
  submitting.value = true
  try {
    await confirmPasswordReset({ token: token.value.trim(), new_password: password.value })
    reset.value = true
  } catch (error) {
    rateLimited.value = isApiError(error) && error.status === 429
    errorMessage.value = messageForError(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthPage title="重置密码">
    <template v-if="reset">
      <NAlert type="success" title="密码已重置">
        密码已更新，所有旧会话都已失效，请使用新密码重新登录。
      </NAlert>
      <NSpace class="auth-actions">
        <NButton type="primary" @click="router.push('/login')">前往登录</NButton>
      </NSpace>
    </template>

    <template v-else>
      <NAlert
        v-if="errorMessage"
        class="auth-notice"
        :type="rateLimited ? 'warning' : 'error'"
        :title="rateLimited ? '操作太频繁' : errorTitle"
      >
        {{ errorMessage }}
      </NAlert>

      <NForm @submit.prevent="submit">
        <NFormItem label="重置令牌">
          <NInput v-model:value="token" placeholder="重置邮件中的令牌" />
        </NFormItem>
        <NFormItem label="新密码" :feedback="passwordProblem" :validation-status="passwordProblem ? 'error' : undefined">
          <NInput
            v-model:value="password"
            type="password"
            show-password-on="click"
            :placeholder="PASSWORD_HINT"
            autocomplete="new-password"
          />
        </NFormItem>
        <NFormItem label="确认新密码">
          <NInput
            v-model:value="confirm"
            type="password"
            show-password-on="click"
            placeholder="再次输入新密码"
            autocomplete="new-password"
            @keyup.enter="submit"
          />
        </NFormItem>
        <NButton type="primary" block :loading="submitting" :disabled="!canSubmit" @click="submit">
          重置密码
        </NButton>
      </NForm>

      <NAlert type="info" :show-icon="false" class="auth-notice auth-notice--top">
        请直接打开重置邮件中的链接，链接已包含所需令牌。若令牌已过期，请重新发起“忘记密码”。
      </NAlert>

      <NSpace justify="center" class="auth-footnote">
        <NButton text type="primary" @click="router.push('/forgot-password')">重新发起找回</NButton>
      </NSpace>
    </template>
  </AuthPage>
</template>

<style scoped>
.auth-notice {
  margin-bottom: 16px;
}

.auth-notice--top {
  margin-top: 16px;
}

.auth-actions {
  margin-top: 16px;
}

.auth-footnote {
  margin-top: 16px;
}
</style>
