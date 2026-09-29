<script setup lang="ts">
import { h, nextTick, onMounted, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDatePicker,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
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
import type { BatchResult, Group } from '@/api/types'
import { renderIdCell, shortId } from '../idDisplay'
import TeamSelect, { ensureTeamDirectory, teamLabel } from './TeamSelect.vue'

/**
 * Groups (`iam:groups:any|:team`). `GET /groups` and `POST /groups` carry the
 * team as a required parameter, so the screen is always scoped to one team.
 * Memberships have no list endpoint: they are added and removed by user id.
 */

const message = useMessage()
const dialog = useDialog()

const teamFilter = ref<string | null>(null)
const groups = ref<Group[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)

const BATCH_LIMIT = 500

const columns: DataTableColumns<Group> = [
  { title: '名称', key: 'name' },
  { title: '团队', key: 'team_id', render: (row) => teamLabel(row.team_id) },
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
        h(NButton, { size: 'tiny', onClick: () => openMembers(row) }, { default: () => '成员' }),
        h(
          NButton,
          { size: 'tiny', type: 'error', quaternary: true, onClick: () => confirmDelete(row) },
          { default: () => '删除' }
        )
      ])
  }
]

const showForm = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const formRef = ref<FormInst | null>(null)
const form = reactive<{ name: string; teamId: string | null }>({ name: '', teamId: null })
const formError = ref('')

const rules: FormRules = {
  name: { required: true, message: '请填写用户组名称', trigger: ['input', 'blur'] }
}

const showMembers = ref(false)
const memberGroup = ref<Group | null>(null)
const memberMode = ref('single')
const memberUserId = ref('')
const memberExpiresAt = ref<number | null>(null)
const memberBatchText = ref('')
const memberError = ref('')
const memberSaving = ref(false)
const batchResults = ref<BatchResult[]>([])

async function load(reset: boolean): Promise<void> {
  if (!teamFilter.value) {
    groups.value = []
    nextCursor.value = null
    loading.value = false
    loadingMore.value = false
    return
  }
  if (reset) loading.value = true
  else loadingMore.value = true
  try {
    const page = unwrapPage(
      await authzApi.listGroups(teamFilter.value, {
        cursor: reset ? null : nextCursor.value
      })
    )
    groups.value = reset ? page.items : [...groups.value, ...page.items]
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
  form.teamId = teamFilter.value
  formError.value = ''
  showForm.value = true
  void nextTick(() => formRef.value?.restoreValidation())
}

function openEdit(group: Group): void {
  editingId.value = group.id
  form.name = group.name
  form.teamId = group.team_id
  formError.value = ''
  showForm.value = true
  void nextTick(() => formRef.value?.restoreValidation())
}

async function submitForm(): Promise<void> {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }
  const name = form.name.trim()
  if (!editingId.value && !form.teamId) {
    formError.value = '新建用户组需要先选择所属团队。'
    return
  }
  formError.value = ''
  submitting.value = true
  try {
    if (editingId.value) {
      await authzApi.updateGroup(editingId.value, {
        name,
        ...(form.teamId ? { team_id: form.teamId } : {})
      })
      message.success('用户组已更新')
    } else {
      await authzApi.createGroup({ name, team_id: form.teamId ?? '' })
      message.success('用户组已创建')
    }
    showForm.value = false
    await load(true)
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    submitting.value = false
  }
}

function openMembers(group: Group): void {
  memberGroup.value = group
  memberMode.value = 'single'
  memberUserId.value = ''
  memberExpiresAt.value = null
  memberBatchText.value = ''
  memberError.value = ''
  batchResults.value = []
  showMembers.value = true
}

function parseBatchIds(): string[] {
  return Array.from(
    new Set(
      memberBatchText.value
        .split(/[\s,;]+/)
        .map((value) => authzApi.normalizeUlid(value))
        .filter((value) => value.length > 0)
    )
  )
}

async function submitMember(): Promise<void> {
  const group = memberGroup.value
  if (!group) return

  const userId = authzApi.normalizeUlid(memberUserId.value)
  if (memberMode.value === 'batch') {
    const ids = parseBatchIds()
    if (ids.length === 0) {
      memberError.value = '请填写至少一个用户编号（每行一个，或以空格、逗号分隔）。'
      return
    }
    if (ids.length > BATCH_LIMIT) {
      memberError.value = `一次最多 ${BATCH_LIMIT} 个用户，当前 ${ids.length} 个。`
      return
    }
    const invalid = ids.filter((id) => !authzApi.isUlid(id))
    if (invalid.length > 0) {
      memberError.value = `用户编号应为 26 位字母和数字：${invalid.slice(0, 5).map(shortId).join('、')}`
      return
    }
    memberError.value = ''
    memberSaving.value = true
    try {
      const result = await authzApi.batchAddGroupMembers(group.id, ids)
      batchResults.value = result.results
      const failed = batchResults.value.filter((row) => !row.ok).length
      if (failed > 0) message.warning(`批量添加完成，${failed} 个用户失败`)
      else message.success(`已添加 ${batchResults.value.length} 个成员`)
    } catch (error) {
      message.error(messageForError(error))
    } finally {
      memberSaving.value = false
    }
    return
  }

  if (!userId) {
    memberError.value = '请填写用户编号。'
    return
  }
  if (!authzApi.isUlid(userId)) {
    memberError.value = '用户编号应为 26 位字母和数字。'
    return
  }
  memberError.value = ''
  memberSaving.value = true
  try {
    if (memberMode.value === 'remove') {
      await authzApi.removeGroupMember(group.id, userId)
      message.success('成员已移除')
    } else {
      await authzApi.addGroupMember(group.id, {
        user_id: userId,
        expires_at: memberExpiresAt.value ? new Date(memberExpiresAt.value).toISOString() : null
      })
      message.success('成员已添加')
    }
    memberUserId.value = ''
    memberExpiresAt.value = null
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    memberSaving.value = false
  }
}

async function removeGroup(group: Group): Promise<void> {
  try {
    await authzApi.deleteGroup(group.id)
    message.success('用户组已删除')
    await load(true)
  } catch (error) {
    message.error(messageForError(error))
  }
}

function confirmDelete(group: Group): void {
  dialog.warning({
    title: '删除用户组',
    content: `确认删除用户组“${group.name}”？其成员关系会一并删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => removeGroup(group)
  })
}

watch(teamFilter, () => {
  void load(true)
})

onMounted(async () => {
  await ensureTeamDirectory()
})
</script>

<template>
  <NCard title="用户组" :bordered="false">
    <template #header-extra>
      <NSpace :size="8">
        <NButton size="small" :disabled="!teamFilter" :loading="loading" @click="load(true)">
          刷新
        </NButton>
        <NButton size="small" type="primary" @click="openCreate">新建用户组</NButton>
      </NSpace>
    </template>

    <div class="filter-row">
      <div class="filter-team">
        <TeamSelect v-model:value="teamFilter" required placeholder="必须选择团队" />
      </div>
      <NText depth="3">用户组按团队查看和管理，请先选择团队。</NText>
    </div>

    <NAlert v-if="!teamFilter" type="info" :show-icon="false" class="table-notice">
      尚未选择团队：请先选择一个团队，再查看和管理其中的用户组。
    </NAlert>

    <NDataTable
      v-else
      :columns="columns"
      :data="groups"
      :loading="loading"
      :pagination="false"
      size="small"
      remote
    />

    <div v-if="teamFilter" class="table-footer">
      <NButton v-if="nextCursor" size="small" :loading="loadingMore" @click="load(false)">
        加载更多
      </NButton>
      <NText v-else depth="3">已加载全部 {{ groups.length }} 个用户组</NText>
    </div>
  </NCard>

  <NModal
    v-model:show="showForm"
    preset="card"
    :title="editingId ? '编辑用户组' : '新建用户组'"
    style="width: 520px"
  >
    <NAlert v-if="formError" type="error" :show-icon="false" class="form-notice">{{ formError }}</NAlert>
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="top">
      <NFormItem label="所属团队" :required="!editingId">
        <TeamSelect v-model:value="form.teamId" required :ensure-ids="form.teamId ? [form.teamId] : []" />
      </NFormItem>
      <NFormItem label="用户组名称" path="name">
        <NInput v-model:value="form.name" placeholder="例如 operators" />
      </NFormItem>
    </NForm>
    <NText depth="3" class="form-hint">
      新建用户组必须选择所属团队；编辑时留空表示保持原团队不变。
    </NText>
    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton @click="showForm = false">取消</NButton>
        <NButton type="primary" :loading="submitting" @click="submitForm">保存</NButton>
      </NSpace>
    </template>
  </NModal>

  <NModal
    v-model:show="showMembers"
    preset="card"
    :title="memberGroup ? `成员管理 · ${memberGroup.name}` : '成员管理'"
    style="width: 620px"
  >
    <NAlert type="info" :show-icon="false" class="form-notice">
      此处按用户编号直接添加或移除成员；保存后相关用户可使用的功能会立即更新。
    </NAlert>
    <NForm label-placement="top">
      <NFormItem label="操作">
        <NRadioGroup v-model:value="memberMode">
          <NRadioButton value="single">添加成员</NRadioButton>
          <NRadioButton value="batch">批量添加</NRadioButton>
          <NRadioButton value="remove">移除成员</NRadioButton>
        </NRadioGroup>
      </NFormItem>

      <NFormItem v-if="memberMode === 'batch'" label="用户编号列表">
        <NInput
          v-model:value="memberBatchText"
          type="textarea"
          :autosize="{ minRows: 4, maxRows: 10 }"
          placeholder="每行一个用户编号，也可用空格或逗号分隔，最多 500 个"
        />
      </NFormItem>

      <template v-else>
        <NFormItem label="用户编号">
          <NInput v-model:value="memberUserId" placeholder="26 位用户编号" />
        </NFormItem>
        <NFormItem v-if="memberMode === 'single'" label="有效期（可选）">
          <NDatePicker v-model:value="memberExpiresAt" type="datetime" clearable />
        </NFormItem>
      </template>
    </NForm>

    <NAlert v-if="memberError" type="error" :show-icon="false" class="form-notice">{{ memberError }}</NAlert>

    <div v-if="batchResults.length > 0" class="batch-results">
      <NTag
        v-for="row in batchResults"
        :key="`${row.id}-${row.error ?? 'ok'}`"
        size="small"
        class="batch-result"
        :bordered="false"
        :type="row.ok ? 'success' : 'error'"
      >
        {{ shortId(row.id) }}：{{ row.ok ? '成功' : (row.error ?? '失败') }}
      </NTag>
    </div>

    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton @click="showMembers = false">关闭</NButton>
        <NButton type="primary" :loading="memberSaving" @click="submitMember">
          {{ memberMode === 'remove' ? '移除' : '添加' }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.filter-team {
  width: 320px;
}

.table-notice {
  margin-bottom: 12px;
}

.table-footer {
  margin-top: 12px;
  text-align: center;
}

.form-notice {
  margin-bottom: 12px;
}

.form-hint {
  display: block;
  font-size: 12px;
}

.batch-results {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.batch-result {
  font-family: ui-monospace, monospace;
}
</style>
