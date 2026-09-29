<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
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
  NTag,
  NText,
  useDialog,
  useMessage,
  type DataTableColumns,
  type DataTableRowKey
} from 'naive-ui'

import * as batchApi from '@/api/admin/batch'
import * as usersApi from '@/api/admin/users'
import { messageForError } from '@/api/errors'
import { DEFAULT_PAGE_LIMIT, unwrapPage } from '@/api/pagination'
import type { AdminUserSummary, BatchUserOp, UserStatus } from '@/api/types'
import { renderIdCell } from '../idDisplay'

/**
 * User list. `/users` is cursor-paginated and takes no filter parameter at all,
 * so paging is a cursor stack and there is deliberately no search box.
 * Everything on this screen requires `iam:users:any`.
 */

/** The service rejects more than 500 ids per batch call. */
const MAX_BATCH_IDS = 500

interface StatusMeta {
  label: string
  type: 'default' | 'info' | 'success' | 'warning' | 'error'
}

const STATUS_META: Record<string, StatusMeta> = {
  active: { label: '正常', type: 'success' },
  disabled: { label: '已停用', type: 'error' },
  pending: { label: '待审批', type: 'warning' },
  invited: { label: '已邀请', type: 'info' }
}

const BATCH_ERROR_LABELS: Record<string, string> = {
  invalid_id: '用户编号无效',
  not_found: '用户不存在',
  operation_failed: '操作失败',
  already_member: '已在用户组内'
}

interface BatchFailure {
  id: string
  error: string
}

const router = useRouter()
const message = useMessage()
const dialog = useDialog()

const rows = ref<AdminUserSummary[]>([])
const loading = ref(false)
const loadError = ref('')
const pageIndex = ref(0)
const cursors = ref<(string | null)[]>([null])
const nextCursor = ref<string | null>(null)
const checkedKeys = ref<DataTableRowKey[]>([])

const showCreateModal = ref(false)
const createMode = ref<'create' | 'invite'>('create')
const createSubmitting = ref(false)
const createForm = reactive({ username: '', display_name: '', email: '', password: '' })

const batchRunning = ref(false)
const showBatchModal = ref(false)
const batchSummary = ref<{ ok: number; failures: BatchFailure[] } | null>(null)

function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? { label: status, type: 'default' }
}

function batchErrorLabel(code: string): string {
  return BATCH_ERROR_LABELS[code] ?? '操作失败'
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

const rowKey = (row: AdminUserSummary): string => row.id

async function loadPage(index: number): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const page = unwrapPage(
      await usersApi.listUsers({ cursor: cursors.value[index] ?? null, limit: DEFAULT_PAGE_LIMIT })
    )
    rows.value = page.items
    nextCursor.value = page.nextCursor
    checkedKeys.value = []
  } catch (error) {
    rows.value = []
    nextCursor.value = null
    loadError.value = messageForError(error)
  } finally {
    loading.value = false
  }
}

function gotoPage(index: number): void {
  pageIndex.value = index
  void loadPage(index)
}

function gotoNext(): void {
  if (!nextCursor.value) return
  cursors.value = [...cursors.value.slice(0, pageIndex.value + 1), nextCursor.value]
  gotoPage(pageIndex.value + 1)
}

function gotoPrev(): void {
  if (pageIndex.value === 0) return
  gotoPage(pageIndex.value - 1)
}

function reload(): void {
  cursors.value = [null]
  gotoPage(0)
}

function openDetail(row: AdminUserSummary): void {
  void router.push(`/admin/users/${encodeURIComponent(row.id)}`)
}

async function setStatus(row: AdminUserSummary, status: UserStatus): Promise<void> {
  try {
    await usersApi.updateUser(row.id, { status })
    message.success('用户状态已更新')
    await loadPage(pageIndex.value)
  } catch (error) {
    message.error(messageForError(error))
  }
}

function enableUser(row: AdminUserSummary): void {
  void setStatus(row, 'active')
}

function disableConfirm(row: AdminUserSummary): void {
  dialog.warning({
    title: '停用用户',
    content: `确认停用用户「${row.username}」？停用后，该用户的登录会话会全部失效，需要重新登录。`,
    positiveText: '停用',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.disableUser(row.id)
        message.success('用户已停用')
        await loadPage(pageIndex.value)
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function deleteConfirm(row: AdminUserSummary): void {
  dialog.error({
    title: '删除用户',
    content: `确认永久删除用户「${row.username}」？该操作会一并删除其会话、授权绑定与用户组关系，且不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await usersApi.deleteUser(row.id)
        message.success('用户已删除')
        await loadPage(pageIndex.value)
      } catch (error) {
        message.error(messageForError(error))
      }
    }
  })
}

function renderActions(row: AdminUserSummary) {
  return h(NSpace, { size: 4 }, {
    default: () => [
      h(
        NButton,
        { size: 'small', quaternary: true, type: 'primary', onClick: () => openDetail(row) },
        { default: () => '查看' }
      ),
      row.status === 'disabled'
        ? h(
            NButton,
            { size: 'small', quaternary: true, onClick: () => enableUser(row) },
            { default: () => '启用' }
          )
        : h(
            NButton,
            { size: 'small', quaternary: true, onClick: () => disableConfirm(row) },
            { default: () => '停用' }
          ),
      h(
        NButton,
        { size: 'small', quaternary: true, type: 'error', onClick: () => deleteConfirm(row) },
        { default: () => '删除' }
      )
    ]
  })
}

const columns = computed<DataTableColumns<AdminUserSummary>>(() => [
  { type: 'selection' },
  { title: '用户名', key: 'username', minWidth: 140 },
  { title: '显示名', key: 'display_name', minWidth: 140 },
  { title: '邮箱', key: 'email', minWidth: 200, render: (row) => row.email ?? '—' },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: (row) => {
      const meta = statusMeta(row.status)
      return h(NTag, { size: 'small', type: meta.type }, { default: () => meta.label })
    }
  },
  {
    title: '创建时间',
    key: 'created_at',
    minWidth: 180,
    render: (row) => formatTime(row.created_at)
  },
  { title: '操作', key: 'actions', width: 190, render: (row) => renderActions(row) }
])

const batchFailureColumns: DataTableColumns<BatchFailure> = [
  { title: '用户编号', key: 'id', minWidth: 240, render: (row) => renderIdCell(row.id, (ok) => (ok ? message.success('已复制完整编号') : message.error('复制失败'))) },
  { title: '失败原因', key: 'error', render: (row) => batchErrorLabel(row.error) }
]

function onCheckedRowKeys(keys: DataTableRowKey[]): void {
  checkedKeys.value = keys
}

function openCreate(mode: 'create' | 'invite'): void {
  createMode.value = mode
  createForm.username = ''
  createForm.display_name = ''
  createForm.email = ''
  createForm.password = ''
  showCreateModal.value = true
}

async function submitCreate(): Promise<void> {
  const username = createForm.username.trim()
  const displayName = createForm.display_name.trim()
  const email = createForm.email.trim()
  if (!username || !displayName) {
    message.warning('用户名与显示名不能为空')
    return
  }
  if (createMode.value === 'create' && !createForm.password) {
    message.warning('请填写初始密码')
    return
  }

  createSubmitting.value = true
  try {
    if (createMode.value === 'create') {
      await usersApi.createUser({
        username,
        display_name: displayName,
        email: email || null,
        password: createForm.password
      })
      message.success('用户已创建')
    } else {
      await usersApi.createInvitation({
        username,
        display_name: displayName,
        email: email || null
      })
      message.success('邀请已创建')
    }
    showCreateModal.value = false
    await loadPage(pageIndex.value)
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    createSubmitting.value = false
  }
}

function runBatch(op: BatchUserOp): void {
  const ids = checkedKeys.value.map((key) => String(key))
  if (ids.length === 0) {
    message.warning('请先选择用户')
    return
  }
  if (ids.length > MAX_BATCH_IDS) {
    message.warning(`一次最多操作 ${MAX_BATCH_IDS} 个用户`)
    return
  }
  const verb = op === 'disable' ? '停用' : '启用'
  dialog.warning({
    title: `批量${verb}用户`,
    content: `确认对选中的 ${ids.length} 个用户执行${verb}操作？`,
    positiveText: '确认',
    negativeText: '取消',
    onPositiveClick: async () => {
      batchRunning.value = true
      try {
        const result = await batchApi.batchUsers({ ids, op })
        const failures = result.results
          .filter((entry) => !entry.ok)
          .map((entry) => ({ id: entry.id, error: entry.error ?? 'operation_failed' }))
        batchSummary.value = { ok: result.results.length - failures.length, failures }
        showBatchModal.value = true
        await loadPage(pageIndex.value)
      } catch (error) {
        message.error(messageForError(error))
      } finally {
        batchRunning.value = false
      }
    }
  })
}

onMounted(() => {
  void loadPage(0)
})
</script>

<template>
  <NSpace vertical :size="16">
    <NCard title="用户管理" :bordered="false">
      <template #header-extra>
        <NSpace :size="8">
          <NButton size="small" :disabled="loading" @click="reload">刷新</NButton>
          <NButton size="small" @click="openCreate('invite')">邀请用户</NButton>
          <NButton size="small" type="primary" @click="openCreate('create')">新建用户</NButton>
        </NSpace>
      </template>

      <NAlert v-if="loadError" class="block-alert" type="error" :show-icon="false">
        {{ loadError }}
      </NAlert>

      <NSpace v-if="checkedKeys.length" class="bulk-bar" :size="8" align="center">
        <NText depth="3">已选择 {{ checkedKeys.length }} 个用户</NText>
        <NButton size="small" :loading="batchRunning" @click="runBatch('enable')">批量启用</NButton>
        <NButton size="small" :loading="batchRunning" @click="runBatch('disable')">批量停用</NButton>
      </NSpace>

      <NDataTable
        :columns="columns"
        :data="rows"
        :loading="loading"
        :row-key="rowKey"
        :checked-row-keys="checkedKeys"
        :pagination="false"
        remote
        size="small"
        :scroll-x="1200"
        @update:checked-row-keys="onCheckedRowKeys"
      />

      <NSpace class="pager" justify="space-between" align="center">
        <NText depth="3">第 {{ pageIndex + 1 }} 页 · 本页 {{ rows.length }} 条</NText>
        <NSpace :size="8">
          <NButton size="small" :disabled="pageIndex === 0 || loading" @click="gotoPrev">上一页</NButton>
          <NButton size="small" :disabled="!nextCursor || loading" @click="gotoNext">下一页</NButton>
        </NSpace>
      </NSpace>
    </NCard>

    <NModal
      v-model:show="showCreateModal"
      preset="card"
      :title="createMode === 'create' ? '新建用户' : '邀请用户'"
      style="width: 520px"
    >
      <NForm label-placement="top">
        <NFormItem label="用户名">
          <NInput v-model:value="createForm.username" placeholder="登录用户名" />
        </NFormItem>
        <NFormItem label="显示名">
          <NInput v-model:value="createForm.display_name" placeholder="展示名称" />
        </NFormItem>
        <NFormItem label="邮箱">
          <NInput v-model:value="createForm.email" placeholder="可选，用于邮箱验证与密码找回" />
        </NFormItem>
        <NFormItem v-if="createMode === 'create'" label="初始密码">
          <NInput
            v-model:value="createForm.password"
            type="password"
            show-password-on="click"
            placeholder="至少 12 位，需同时包含字母和数字"
          />
        </NFormItem>
        <NText v-else depth="3">
          受邀账户会显示为「已邀请」，对方通过邀请链接设置初始密码后才能登录。
        </NText>
      </NForm>
      <template #footer>
        <NSpace justify="end" :size="8">
          <NButton @click="showCreateModal = false">取消</NButton>
          <NButton type="primary" :loading="createSubmitting" @click="submitCreate">
            {{ createMode === 'create' ? '创建' : '发送邀请' }}
          </NButton>
        </NSpace>
      </template>
    </NModal>

    <NModal v-model:show="showBatchModal" preset="card" title="批量操作结果" style="width: 640px">
      <template v-if="batchSummary">
        <NAlert
          class="block-alert"
          :type="batchSummary.failures.length ? 'warning' : 'success'"
          :show-icon="false"
        >
          成功 {{ batchSummary.ok }} 条，失败 {{ batchSummary.failures.length }} 条。
        </NAlert>
        <NDataTable
          v-if="batchSummary.failures.length"
          :columns="batchFailureColumns"
          :data="batchSummary.failures"
          :pagination="false"
          size="small"
        />
      </template>
    </NModal>
  </NSpace>
</template>

<style scoped>
.block-alert {
  margin-bottom: 12px;
}

.bulk-bar {
  margin-bottom: 12px;
}

.pager {
  margin-top: 12px;
}
</style>
