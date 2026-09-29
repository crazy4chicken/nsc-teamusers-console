<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NFormItem, NInput, NSpace } from 'naive-ui'

import { requestPasswordReset } from '@/api/auth'
import { isApiError, messageForError } from '@/api/errors'
import AuthPage from './AuthPage.vue'

/**
 * Requests a password-reset link (`POST /auth/password-reset/request`).
 *
 * The service never enumerates accounts: it answers 204 for an unknown login and
 * even when throttled, so the screen only ever shows the generic outcome and
 * must not claim that a mail was sent.
 */

const router = useRouter()

const login = ref('')
const submitting = ref(false)
const sent = ref(false)
const errorMessage = ref('')
const rateLimited = ref(false)

const canSubmit = computed(() => login.value.trim().length > 0)

async function submit(): Promise<void> {
  if (submitting.value) return
  errorMessage.value = ''
  rateLimited.value = false
  if (!login.value.trim()) {
    errorMessage.value = '请输入用户名或邮箱。'
    return
  }
  submitting.value = true
  try {
    await requestPasswordReset({ login: login.value.trim() })
    sent.value = true
  } catch (error) {
    rateLimited.value = isApiError(error) && error.status === 429
    errorMessage.value = messageForError(error)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthPage title="忘记密码">
    <template v-if="sent">
      <NAlert type="success" title="请求已提交">
        如果该账户存在，重置密码的链接已发送到对应的邮箱。请查收邮件，也请检查垃圾邮件文件夹，并在链接有效期内完成重置。
      </NAlert>
      <NAlert type="info" :show-icon="false" class="auth-notice auth-notice--top">
        为保护账户安全，无论账户是否存在，这里都会显示相同的提示；页面不会确认账户是否已注册，也不会显示邮箱地址。
      </NAlert>
      <NSpace class="auth-actions">
        <NButton type="primary" @click="router.push('/login')">返回登录</NButton>
        <NButton quaternary @click="sent = false">重新填写</NButton>
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
        <NFormItem label="用户名或邮箱">
          <NInput
            v-model:value="login"
            placeholder="注册时使用的用户名或邮箱"
            autocomplete="username"
            @keyup.enter="submit"
          />
        </NFormItem>
        <NButton type="primary" block :loading="submitting" :disabled="!canSubmit" @click="submit">
          发送重置链接
        </NButton>
      </NForm>

      <NAlert type="info" :show-icon="false" class="auth-notice auth-notice--top">
        收到邮件后，请点击其中的链接打开重置页面；也可以复制邮件中的令牌，在“重置密码”页面手动粘贴。
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
