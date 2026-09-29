<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NFormItem, NInput, NSpace } from 'naive-ui'

import { acceptInvitation } from '@/api/auth'
import { isApiError, messageForError } from '@/api/errors'
import AuthPage from './AuthPage.vue'
import { PASSWORD_HINT, confirmedPasswordProblem, queryToken } from './form'

/**
 * Accepts an invitation and sets the initial password
 * (`POST /auth/invite/accept`).
 *
 * Invitations are created by an administrator (`POST /invitations`) and carry a
 * one-time 7-day token; the invitee has no credentials yet, so the token comes
 * from the link (`?token=…`) and the password is chosen here. The account is
 * `invited` until this call succeeds, which is why a login attempt before it
 * answers `403 account_pending`.
 */

const route = useRoute()
const router = useRouter()

const linkToken = queryToken(route.query.token)
const token = ref(linkToken)
const displayName = ref('')
const password = ref('')
const confirm = ref('')
const submitting = ref(false)
const accepted = ref(false)
const rateLimited = ref(false)
const errorMessage = ref(
  linkToken ? '' : '链接中缺少邀请令牌，请在下方粘贴邀请邮件里的令牌后重试。'
)

const errorTitle = computed(() => (token.value.trim() ? '接受邀请失败' : '缺少邀请令牌'))

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
    errorMessage.value = '请输入邀请邮件中的邀请令牌。'
    return
  }
  if (passwordProblem.value) {
    errorMessage.value = passwordProblem.value
    return
  }
  submitting.value = true
  try {
    await acceptInvitation({
      token: token.value.trim(),
      password: password.value,
      // Optional on the wire; omitted when left blank so the server keeps the invited display name.
      ...(displayName.value.trim() ? { display_name: displayName.value.trim() } : {})
    })
    accepted.value = true
  } catch (error) {
    rateLimited.value = isApiError(error) && error.status === 429
    errorMessage.value = messageForError(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthPage title="接受邀请">
    <template v-if="accepted">
      <NAlert type="success" title="邀请已接受">
        初始密码已设置，账户可以登录了。若系统开启了邮箱验证，请同时完成邮箱验证。
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
        <NFormItem label="邀请令牌">
          <NInput v-model:value="token" placeholder="邀请邮件中的令牌" />
        </NFormItem>
        <NFormItem label="显示名">
          <NInput v-model:value="displayName" placeholder="留空则沿用管理员设置的名字" />
        </NFormItem>
        <NFormItem label="初始密码" :feedback="passwordProblem" :validation-status="passwordProblem ? 'error' : undefined">
          <NInput
            v-model:value="password"
            type="password"
            show-password-on="click"
            :placeholder="PASSWORD_HINT"
            autocomplete="new-password"
          />
        </NFormItem>
        <NFormItem label="确认初始密码">
          <NInput
            v-model:value="confirm"
            type="password"
            show-password-on="click"
            placeholder="再次输入初始密码"
            autocomplete="new-password"
            @keyup.enter="submit"
          />
        </NFormItem>
        <NButton type="primary" block :loading="submitting" :disabled="!canSubmit" @click="submit">
          接受邀请并设置密码
        </NButton>
      </NForm>

      <NAlert type="info" :show-icon="false" class="auth-notice auth-notice--top">
        请直接打开邀请邮件中的链接，链接已包含所需令牌。邀请令牌为一次性凭证，过期后需联系管理员重新发送。
      </NAlert>

      <NSpace justify="center" class="auth-footnote">
        <NButton text type="primary" @click="router.push('/login')">返回登录</NButton>
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
