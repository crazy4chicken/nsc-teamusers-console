<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from 'vue'
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
  NSelect,
  NSpace,
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
import type { Binding, BindingSubjectKind, Role } from '@/api/types'
import { shortId } from '../idDisplay'
import TeamSelect, { ensureTeamDirectory, teamLabel } from './TeamSelect.vue'

/**
 * Role bindings (`iam:bindings:any|:team`).
 *
 * `GET /bindings` requires `subject_kind` + `subject_id` because the page is
 * scoped to one subject, and the collection request has no target team, so the
 * service only serves it at platform scope. `POST`/`DELETE` accept `:team` for
 * the team of the role in the body or of the binding in the path. The service
 * exposes no update endpoint: a binding is created or deleted.
 */

const message = useMessage()
const dialog = useDialog()

const platformScope = computed(() => authStore.hasPermission('iam:bindings:any'))
const canListAllRoles = computed(() => authStore.hasPermission('iam:roles:any'))
const canListTeamRoles = computed(() => authStore.hasPermission('iam:roles:team'))

const ROLE_PAGE_CAP = 10

const subjectKindOptions = [
  { label: '用户', value: 'user' },
  { label: '用户组', value: 'group' }
]

const SUBJECT_KIND_LABELS: Record<string, string> = { user: '用户', group: '用户组' }

const query = reactive<{ subjectKind: BindingSubjectKind; subjectId: string }>({
  subjectKind: 'user',
  subjectId: ''
})
const queryError = ref('')
const queriedSubject = ref<{ subject_kind: BindingSubjectKind; subject_id: string } | null>(null)

const bindings = ref<Binding[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)

const roleById = ref<Record<string, Role>>({})
const roleOptions = computed(() =>
  Object.values(roleById.value).map((role) => ({
    label: roleLabel(role),
    value: role.id
  }))
)

const columns: DataTableColumns<Binding> = [
  {
    title: '主体',
    key: 'subject',
    render: (row) => `${SUBJECT_KIND_LABELS[row.subject_kind] ?? row.subject_kind} · ${shortId(row.subject_id)}`
  },
  { title: '角色', key: 'role_id', render: (row) => roleLabelById(row.role_id) },
  { title: '团队', key: 'team_id', render: (row) => teamLabel(row.team_id) },
  {
    title: '条件',
    key: 'condition',
    render: (row) => row.condition || '—'
  },
  { title: '有效期', key: 'expires_at', render: (row) => row.expires_at ?? '长期' },
  {
    title: '操作',
    key: 'actions',
    render: (row) =>
      h(
        NButton,
        { size: 'tiny', type: 'error', quaternary: true, onClick: () => confirmDelete(row) },
        { default: () => '删除' }
      )
  }
]

const showForm = ref(false)
const submitting = ref(false)
const formRef = ref<FormInst | null>(null)
const form = reactive<{
  roleId: string
  subjectKind: BindingSubjectKind
  subjectId: string
  teamId: string | null
  condition: string
  expiresAt: number | null
}>({
  roleId: '',
  subjectKind: 'user',
  subjectId: '',
  teamId: null,
  condition: '',
  expiresAt: null
})
const formError = ref('')

const rules: FormRules = {
  roleId: { required: true, message: '请选择或填写角色编号', trigger: ['change', 'input', 'blur'] },
  subjectId: [
    { required: true, message: '请填写主体编号', trigger: ['input', 'blur'] },
    {
      validator: (_rule, value: string) => {
        if (!value) return true
        return authzApi.isUlid(value) ? true : new Error('编号应为 26 位字母和数字')
      },
      trigger: ['input', 'blur']
    }
  ]
}

function roleLabel(role: Role): string {
  return role.team_id ? `${role.name}（${teamLabel(role.team_id)}）` : `${role.name}（平台）`
}

function roleLabelById(roleId: string): string {
  const role = roleById.value[roleId]
  return role ? roleLabel(role) : roleId
}

/** Platform scope lists every role; a team-scoped grant needs the team first. */
async function loadRoleOptions(teamId: string | null): Promise<void> {
  if (!canListAllRoles.value && !(canListTeamRoles.value && teamId)) {
    roleById.value = {}
    return
  }
  const found: Record<string, Role> = {}
  try {
    let cursor: string | null = null
    for (let page = 0; page < ROLE_PAGE_CAP; page += 1) {
      const response = await authzApi.listRoles({
        teamId: canListAllRoles.value ? null : teamId,
        cursor,
        limit: 1000
      })
      for (const role of response.items) found[role.id] = role
      cursor = response.next_cursor ? response.next_cursor : null
      if (!cursor) break
    }
    roleById.value = found
  } catch (error) {
    message.error(`角色列表加载失败：${messageForError(error)}`)
  }
}

async function load(reset: boolean): Promise<void> {
  const subject = queriedSubject.value
  if (!subject) {
    bindings.value = []
    nextCursor.value = null
    loading.value = false
    loadingMore.value = false
    return
  }
  if (reset) loading.value = true
  else loadingMore.value = true
  try {
    const page = unwrapPage(
      await authzApi.listBindings(subject, { cursor: reset ? null : nextCursor.value })
    )
    bindings.value = reset ? page.items : [...bindings.value, ...page.items]
    nextCursor.value = page.nextCursor
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

function runQuery(): void {
  const subjectId = authzApi.normalizeUlid(query.subjectId)
  if (!subjectId) {
    queryError.value = '请先填写要查询的用户或用户组编号。'
    return
  }
  if (!authzApi.isUlid(subjectId)) {
    queryError.value = '编号应为 26 位字母和数字。'
    return
  }
  queryError.value = ''
  queriedSubject.value = { subject_kind: query.subjectKind, subject_id: subjectId }
  void load(true)
}

async function openCreate(): Promise<void> {
  form.roleId = ''
  form.subjectKind = queriedSubject.value?.subject_kind ?? 'user'
  form.subjectId = queriedSubject.value?.subject_id ?? ''
  form.teamId = null
  form.condition = ''
  form.expiresAt = null
  formError.value = ''
  showForm.value = true
  await Promise.all([ensureTeamDirectory(), loadRoleOptions(null)])
}

async function submitForm(): Promise<void> {
  try {
    await formRef.value?.validate()
  } catch {
    return
  }
  const roleId = form.roleId.trim()
  if (!authzApi.isUlid(roleId)) {
    formError.value = '角色编号应为 26 位字母和数字。'
    return
  }
  const role = roleById.value[roleId]
  if (form.teamId && role?.team_id && role.team_id !== form.teamId) {
    formError.value = '所选团队与角色所属团队不一致，无法创建绑定。'
    return
  }
  formError.value = ''
  submitting.value = true
  try {
    const condition = form.condition.trim()
    await authzApi.createBinding({
      role_id: roleId,
      subject_kind: form.subjectKind,
      subject_id: authzApi.normalizeUlid(form.subjectId),
      team_id: form.teamId,
      // An empty string is compiled too; omit the field to keep the binding unconditional.
      ...(condition ? { condition } : {}),
      expires_at: form.expiresAt ? new Date(form.expiresAt).toISOString() : null
    })
    message.success('绑定已创建')
    showForm.value = false
    await load(true)
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    submitting.value = false
  }
}

async function removeBinding(binding: Binding): Promise<void> {
  try {
    await authzApi.deleteBinding(binding.id)
    message.success('绑定已删除')
    await load(true)
  } catch (error) {
    message.error(messageForError(error))
  }
}

function confirmDelete(binding: Binding): void {
  dialog.warning({
    title: '删除绑定',
    content: `确认删除该${SUBJECT_KIND_LABELS[binding.subject_kind] ?? '主体'}（${shortId(binding.subject_id)}）的角色绑定？相关用户可使用的功能会立即更新。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => removeBinding(binding)
  })
}

watch(
  () => form.teamId,
  (teamId) => {
    if (!canListAllRoles.value) void loadRoleOptions(teamId)
  }
)

onMounted(async () => {
  await Promise.all([ensureTeamDirectory(), loadRoleOptions(null)])
})
</script>

<template>
  <NCard title="授权绑定" :bordered="false">
    <template #header-extra>
      <NSpace :size="8">
        <NButton size="small" :disabled="!queriedSubject" :loading="loading" @click="load(true)">
          刷新
        </NButton>
        <NButton size="small" type="primary" @click="openCreate">新建绑定</NButton>
      </NSpace>
    </template>

    <NAlert v-if="!platformScope" type="warning" :show-icon="false" class="table-notice">
      当前账户没有查询绑定列表的权限，只能为本团队的角色创建或删除绑定。
    </NAlert>

    <NForm inline label-placement="left" :show-feedback="false" class="query-row">
      <NFormItem label="主体类型">
        <NSelect v-model:value="query.subjectKind" :options="subjectKindOptions" class="query-select" />
      </NFormItem>
      <NFormItem label="主体编号">
        <NInput v-model:value="query.subjectId" placeholder="用户或用户组的 26 位编号" />
      </NFormItem>
      <NFormItem>
        <NButton type="primary" secondary @click="runQuery">查询绑定</NButton>
      </NFormItem>
    </NForm>

    <NAlert v-if="queryError" type="error" :show-icon="false" class="table-notice">{{ queryError }}</NAlert>

    <NAlert v-if="!queriedSubject" type="info" :show-icon="false" class="table-notice">
      绑定按用户或用户组查询：填写主体编号后，即可查看其全部角色绑定。
    </NAlert>

    <NDataTable
      v-else
      :columns="columns"
      :data="bindings"
      :loading="loading"
      :pagination="false"
      size="small"
      remote
    />

    <div v-if="queriedSubject" class="table-footer">
      <NButton v-if="nextCursor" size="small" :loading="loadingMore" @click="load(false)">
        加载更多
      </NButton>
      <NText v-else depth="3">已加载全部 {{ bindings.length }} 条绑定</NText>
    </div>
  </NCard>

  <NModal v-model:show="showForm" preset="card" title="新建绑定" style="width: 620px">
    <NAlert v-if="formError" type="error" :show-icon="false" class="form-notice">{{ formError }}</NAlert>
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="top">
      <NFormItem label="角色" path="roleId">
        <NSelect
          v-if="roleOptions.length > 0"
          v-model:value="form.roleId"
          :options="roleOptions"
          filterable
          placeholder="选择角色"
        />
        <NInput
          v-else
          v-model:value="form.roleId"
          placeholder="26 位角色编号"
        />
      </NFormItem>
      <NFormItem label="主体类型" path="subjectKind">
        <NSelect v-model:value="form.subjectKind" :options="subjectKindOptions" />
      </NFormItem>
      <NFormItem label="主体编号" path="subjectId">
        <NInput v-model:value="form.subjectId" placeholder="用户或用户组的 26 位编号" />
      </NFormItem>
      <NFormItem label="团队（可选）">
        <TeamSelect v-model:value="form.teamId" :ensure-ids="[form.teamId ?? '']" placeholder="留空按角色推导" />
      </NFormItem>
      <NFormItem label="条件（可选）">
        <NInput
          v-model:value="form.condition"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          placeholder="留空表示无条件绑定；填写时使用条件表达式"
        />
      </NFormItem>
      <NFormItem label="有效期（可选）">
        <NDatePicker v-model:value="form.expiresAt" type="datetime" clearable />
      </NFormItem>
    </NForm>
    <NText depth="3" class="form-hint">
      主体可以是用户或用户组，且必须已存在。条件表达式保存时会校验，无法识别的表达式不能保存。团队留空时跟随角色所属团队，填写时必须与角色所属团队一致。
    </NText>
    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton @click="showForm = false">取消</NButton>
        <NButton type="primary" :loading="submitting" @click="submitForm">保存</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.query-row {
  margin-bottom: 12px;
}

.query-select {
  width: 160px;
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
</style>
