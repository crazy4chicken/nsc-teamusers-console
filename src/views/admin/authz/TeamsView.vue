<script setup lang="ts">
import { computed, h, nextTick, onMounted, reactive, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NTag,
  NText,
  useDialog,
  useMessage,
  type DataTableColumns,
  type FormInst,
  type FormRules
} from 'naive-ui'

import * as authzApi from '@/api/admin/authorization'
import { messageForError } from '@/api/errors'
import { unwrapPage } from '@/api/pagination'
import { authStore } from '@/stores/authStore'
import type { Team } from '@/api/types'
import { renderIdCell } from '../idDisplay'
import { ensureTeamDirectory, invalidateTeamDirectory } from './TeamSelect.vue'

/**
 * Teams. `GET /teams` and `POST /teams` have no target team, so both require
 * `iam:teams:any`; the `{id}` routes also accept `iam:teams:team`.
 */

const message = useMessage()
const dialog = useDialog()

/** Listing teams is a collection request, which the service only grants at platform scope. */
const platformScope = computed(() => authStore.hasPermission('iam:teams:any'))

const teams = ref<Team[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)

/** The handler accepts exactly these two values. */
const statusOptions = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'disabled' }
]

const showForm = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const formRef = ref<FormInst | null>(null)
const form = reactive({ name: '', slug: '', status: 'active' })

const rules: FormRules = {
  name: { required: true, message: '请填写团队名称', trigger: ['input', 'blur'] },
  slug: { required: true, message: '请填写团队标识', trigger: ['input', 'blur'] },
  status: { required: true, message: '请选择状态', trigger: ['change'] }
}

const columns: DataTableColumns<Team> = [
  { title: '名称', key: 'name' },
  { title: '标识', key: 'slug' },
  {
    title: '状态',
    key: 'status',
    render: (row) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: row.status === 'active' ? 'success' : 'warning' },
        { default: () => (row.status === 'active' ? '正常' : '已停用') }
      )
  },
  { title: '创建时间', key: 'created_at' },
  {
    title: '编号',
    key: 'id',
    render: (row) =>
      renderIdCell(row.id, (ok) => (ok ? message.success('已复制完整编号') : message.error('复制失败')))
  },
  {
    title: '操作',
    key: 'actions',
    render: (row) =>
      h(NSpace, { size: 8 }, () => [
        h(NButton, { size: 'tiny', onClick: () => openEdit(row) }, { default: () => '编辑' }),
        h(
          NButton,
          { size: 'tiny', type: 'error', quaternary: true, onClick: () => confirmDelete(row) },
          { default: () => '删除' }
        )
      ])
  }
]

async function load(reset: boolean): Promise<void> {
  if (reset) loading.value = true
  else loadingMore.value = true
  try {
    const page = unwrapPage(
      await authzApi.listTeams({ cursor: reset ? null : nextCursor.value })
    )
    teams.value = reset ? page.items : [...teams.value, ...page.items]
    nextCursor.value = page.nextCursor
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.slug = ''
  form.status = 'active'
  showForm.value = true
  void nextTick(() => formRef.value?.restoreValidation())
}

function openEdit(team: Team): void {
  editingId.value = team.id
  form.name = team.name
  form.slug = team.slug
  form.status = team.status === 'disabled' ? 'disabled' : 'active'
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
    const payload = { name: form.name.trim(), slug: form.slug.trim(), status: form.status }
    if (editingId.value) {
      await authzApi.updateTeam(editingId.value, payload)
      message.success('团队已更新')
    } else {
      await authzApi.createTeam(payload)
      message.success('团队已创建')
    }
    showForm.value = false
    invalidateTeamDirectory()
    await Promise.all([load(true), ensureTeamDirectory()])
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    submitting.value = false
  }
}

async function removeTeam(team: Team): Promise<void> {
  try {
    await authzApi.deleteTeam(team.id)
    message.success('团队已删除')
    invalidateTeamDirectory()
    await Promise.all([load(true), ensureTeamDirectory()])
  } catch (error) {
    message.error(messageForError(error))
  }
}

function confirmDelete(team: Team): void {
  dialog.warning({
    title: '删除团队',
    content: `确认删除团队“${team.name}（${team.slug}）”？该操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => removeTeam(team)
  })
}

onMounted(async () => {
  await Promise.all([load(true), ensureTeamDirectory()])
})
</script>

<template>
  <NCard title="团队" :bordered="false">
    <template #header-extra>
      <NSpace :size="8">
        <NButton size="small" :loading="loading" @click="load(true)">刷新</NButton>
        <NButton size="small" type="primary" @click="openCreate">新建团队</NButton>
      </NSpace>
    </template>

    <NAlert v-if="!platformScope" class="table-notice" type="warning" :show-icon="false">
      当前账户仅能管理自己所属的团队，无法查看全部团队列表。
    </NAlert>

    <NDataTable
      :columns="columns"
      :data="teams"
      :loading="loading"
      :pagination="false"
      size="small"
      remote
    />

    <div class="table-footer">
      <NButton v-if="nextCursor" size="small" :loading="loadingMore" @click="load(false)">
        加载更多
      </NButton>
      <NText v-else depth="3">已加载全部 {{ teams.length }} 个团队</NText>
    </div>
  </NCard>

  <NModal
    v-model:show="showForm"
    preset="card"
    :title="editingId ? '编辑团队' : '新建团队'"
    style="width: 520px"
  >
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="top">
      <NFormItem label="团队名称" path="name">
        <NInput v-model:value="form.name" placeholder="例如 平台运维组" />
      </NFormItem>
      <NFormItem label="团队标识" path="slug">
        <NInput v-model:value="form.slug" placeholder="例如 platform-ops" />
      </NFormItem>
      <NFormItem label="状态" path="status">
        <NSelect v-model:value="form.status" :options="statusOptions" />
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
