<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSpace,
  NText,
  useMessage,
  type DataTableColumns,
  type FormInst,
  type FormRules
} from 'naive-ui'

import * as authzApi from '@/api/admin/authorization'
import { messageForError } from '@/api/errors'
import { unwrapPage } from '@/api/pagination'
import type { PermissionRecord } from '@/api/types'

/**
 * Permission registry (`iam:permissions:any`, platform scope only).
 * Registration is an upsert of key + description + registrar; a key must be
 * registered before a role can attach it.
 */

const message = useMessage()

const permissions = ref<PermissionRecord[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)

const showForm = ref(false)
const submitting = ref(false)
const formRef = ref<FormInst | null>(null)
const form = reactive({ key: '', registered_by: '', description: '' })

const rules: FormRules = {
  key: [
    { required: true, message: '请填写权限标识', trigger: ['input', 'blur'] },
    {
      validator: (_rule, value: string) => {
        if (!value) return true
        if (authzApi.isValidPermissionKey(value)) return true
        return new Error('格式应为「资源:操作:范围」，例如 orders:read:team；开头加 ! 表示拒绝')
      },
      trigger: ['input', 'blur']
    }
  ],
  registered_by: { required: true, message: '请填写登记来源（服务或模块名）', trigger: ['input', 'blur'] }
}

const columns: DataTableColumns<PermissionRecord> = [
  { title: '权限标识', key: 'key' },
  { title: '说明', key: 'description' },
  { title: '登记来源', key: 'registered_by' },
  { title: '登记时间', key: 'created_at' }
]

async function load(reset: boolean): Promise<void> {
  if (reset) loading.value = true
  else loadingMore.value = true
  try {
    const page = unwrapPage(
      await authzApi.listPermissions({ cursor: reset ? null : nextCursor.value })
    )
    permissions.value = reset ? page.items : [...permissions.value, ...page.items]
    nextCursor.value = page.nextCursor
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function openCreate(): void {
  form.key = ''
  form.registered_by = ''
  form.description = ''
  showForm.value = true
  void nextTick(() => formRef.value?.restoreValidation())
}

async function submitForm(): Promise<void> {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }
  submitting.value = true
  try {
    await authzApi.registerPermission({
      key: form.key.trim(),
      registered_by: form.registered_by.trim(),
      description: form.description.trim()
    })
    message.success('权限已登记')
    showForm.value = false
    await load(true)
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await load(true)
})
</script>

<template>
  <NCard title="权限登记" :bordered="false">
    <template #header-extra>
      <NSpace :size="8">
        <NButton size="small" :loading="loading" @click="load(true)">刷新</NButton>
        <NButton size="small" type="primary" @click="openCreate">登记权限</NButton>
      </NSpace>
    </template>

    <NAlert class="table-notice" type="info" :show-icon="false">
      权限标识登记后才能分配给角色；重复登记同一标识会更新其说明与来源，登记后无法删除。
    </NAlert>

    <NDataTable
      :columns="columns"
      :data="permissions"
      :loading="loading"
      :pagination="false"
      size="small"
      remote
    />

    <div class="table-footer">
      <NButton v-if="nextCursor" size="small" :loading="loadingMore" @click="load(false)">
        加载更多
      </NButton>
      <NText v-else depth="3">已加载全部 {{ permissions.length }} 条权限</NText>
    </div>
  </NCard>

  <NModal v-model:show="showForm" preset="card" title="登记权限" style="width: 560px">
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="top">
      <NFormItem label="权限标识" path="key">
        <NInput v-model:value="form.key" placeholder="例如 orders:read:team，或以 ! 前缀表示拒绝" />
      </NFormItem>
      <NFormItem label="登记来源" path="registered_by">
        <NInput v-model:value="form.registered_by" placeholder="例如 orders-service" />
      </NFormItem>
      <NFormItem label="说明" path="description">
        <NInput
          v-model:value="form.description"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          placeholder="该权限的用途"
        />
      </NFormItem>
    </NForm>
    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton @click="showForm = false">取消</NButton>
        <NButton type="primary" :loading="submitting" @click="submitForm">保存</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.table-notice {
  margin-bottom: 12px;
}

.table-footer {
  margin-top: 12px;
  text-align: center;
}
</style>
