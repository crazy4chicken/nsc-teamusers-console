<script setup lang="ts">
import { NCard } from 'naive-ui'

/**
 * Page chrome shared by the unauthenticated screens: a centered card on the
 * app's neutral background. Every auth route renders exactly one of these so
 * the login/registration/recovery pages cannot drift apart visually.
 */

defineProps<{ title: string }>()
</script>

<template>
  <div class="auth-page">
    <NCard class="auth-card" :title="title" :bordered="false">
      <slot />
    </NCard>
  </div>
</template>

<style scoped>
.auth-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px 16px;
  box-sizing: border-box;
  background: #f5f6f8;
}

.auth-card {
  width: 380px;
  max-width: 100%;
  box-shadow: 0 2px 12px rgb(0 0 0 / 8%);
}
</style>
