<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NFormItem, NInput, NSpace } from 'naive-ui'

import { verifyEmail } from '@/api/auth'
import { isApiError, messageForError } from '@/api/errors'
import AuthPage from './AuthPage.vue'
import { queryToken } from './form'

/**
 * Landing page for the e-mailed verification link (`POST /auth/verify-email`).
 *
 * The token is a single-use value the service only ever receives in the request
 * body, so the link carries it as `?token=…`; a token pasted by hand is accepted
 * as well, which keeps the page usable when the mail client mangles the link.
 * The mock answers 204 for any token; the real service answers `400
 * invalid_token` for an unknown or expired one.
 */

const route = useRoute()
const router = useRouter()

const linkToken = queryToken(route.query.token)
const token = ref(linkToken)
const submitting = ref(false)
const verified = ref(false)
const rateLimited = ref(false)
const errorMessage = ref(
  linkToken ? '' : '链接中缺少验证令牌，请在下方粘贴邮件里的验证令牌后重试。'
)

const errorTitle = computed(() => (token.value.trim() ? '邮箱验证失败' : '缺少验证令牌'))

async function verify(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  rateLimited.value = false
  const value = token.value.trim()
  if (!value) {
    errorMessage.value = '请输入邮件中的验证令牌。'
    return
  }
  submitting.value = true
  try {
    await verifyEmail(value)
    verified.value = true
  } catch (error) {
    rateLimited.value = isApiError(error) && error.status === 429
    errorMessage.value = messageForError(error)
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  if (linkToken) void verify()
})
</script>

<template>
  <AuthPage title="邮箱验证">
    <template v-if="verified">
      <NAlert type="success" title="邮箱验证成功">
        该邮箱已完成验证，现在可以使用对应账户登录。若账户仍处于待审批状态，管理员审批通过后即可登录。
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

      <NForm @submit.prevent="verify">
        <NFormItem label="验证令牌">
          <NInput
            v-model:value="token"
            placeholder="邮件中的验证令牌"
            @keyup.enter="verify"
          />
        </NFormItem>
        <NButton type="primary" block :loading="submitting" :disabled="!token.trim()" @click="verify">
          验证邮箱
        </NButton>
      </NForm>

      <NAlert type="info" :show-icon="false" class="auth-notice auth-notice--top">
        请直接打开验证邮件中的链接，链接已包含所需令牌。若令牌已过期或无效，请重新注册或联系管理员重新发送。
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
