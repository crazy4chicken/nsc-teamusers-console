<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NSpace, NText } from 'naive-ui'

import { authStore } from '@/stores/authStore'

const route = useRoute()
const router = useRouter()

const from = computed(() => (typeof route.query.from === 'string' ? route.query.from : ''))

async function backHome(): Promise<void> {
  await router.replace({ name: 'home' })
}

async function signOut(): Promise<void> {
  await authStore.logout()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <NCard title="无权访问" :bordered="false">
    <NAlert type="error" title="没有权限">
      当前账户没有访问该功能的权限，如需使用请联系管理员开通。
    </NAlert>
    <NText v-if="from" depth="3" class="target">请求的页面：{{ from }}</NText>
    <NSpace class="actions">
      <NButton @click="backHome">返回概览</NButton>
      <NButton quaternary @click="signOut">退出登录</NButton>
    </NSpace>
  </NCard>
</template>

<style scoped>
.target {
  display: block;
  margin-top: 12px;
  font-size: 12px;
}

.actions {
  margin-top: 20px;
}
</style>
