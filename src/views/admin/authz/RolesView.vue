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
import type { Role } from '@/api/types'
import { renderIdCell } from '../idDisplay'
import TeamSelect, { ensureTeamDirectory, teamLabel } from './TeamSelect.vue'

/**
 * Roles (`iam:roles:any|:team`). A role with no team is platform-wide.
 *
 * Two service rules drive the UI:
 * - `GET /roles` without `team_id` has no target team, so a team-scoped
 *   administrator must filter by their team.
 * - `PUT /roles/{id}/permissions` replaces the whole set and the service
 *   exposes no endpoint to read a role's current permissions.
 */

const message = useMessage()
const dialog = useDialog()

/** Platform scope: unrestricted team filter, team changes, and any permission scope. */
const platformScope = computed(() => authStore.hasPermission('iam:roles:any'))
const canReadRegistry = computed(() => authStore.hasPermission('iam:permissions:any'))

const teamFilter = ref<string | null>(null)
const roles = ref<Role[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)

const REGISTRY_PAGE_CAP = 10
const registryOptions = ref<{ label: string; value: string }[]>([])

const columns: DataTableColumns<Role> = [
  { title: '名称', key: 'name' },
  {
    title: '范围',
    key: 'team_id',
    render: (row) =>
      row.team_id
        ? h(NTag, { size: 'small', bordered: false }, { default: () => teamLabel(row.team_id) })
        : h(NText, { depth: 3 }, { default: () => '平台' })
  },
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
        h(NButton, { size: 'tiny', onClick: () => openPermissions(row) }, { default: () => '权限' }),
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

const rules: FormRules = {
  name: { required: true, message: '请填写角色名称', trigger: ['input', 'blur'] }
}

const showPermissions = ref(false)
const permRole = ref<Role | null>(null)
const permKeys = ref<string[]>([])
const permError = ref('')
const permSaving = ref(false)

async function load(reset: boolean): Promise<void> {
  if (!platformScope.value && !teamFilter.value) {
    roles.value = []
    nextCursor.value = null
    loading.value = false
    loadingMore.value = false
    return
  }
  if (reset) loading.value = true
  else loadingMore.value = true
  try {
    const page = unwrapPage(
      await authzApi.listRoles({
        teamId: teamFilter.value,
        cursor: reset ? null : nextCursor.value
      })
    )
    roles.value = reset ? page.items : [...roles.value, ...page.items]
    nextCursor.value = page.nextCursor
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadRegistry(): Promise<void> {
  if (!canReadRegistry.value || registryOptions.value.length > 0) return
  const keys: string[] = []
  try {
    let cursor: string | null = null
    for (let page = 0; page < REGISTRY_PAGE_CAP; page += 1) {
      const response = await authzApi.listPermissions({ cursor, limit: 1000 })
      for (const record of response.items) keys.push(record.key)
      cursor = response.next_cursor ? response.next_cursor : null
      if (!cursor) break
    }
    registryOptions.value = keys.map((key) => ({ label: key, value: key }))
  } catch (error) {
    message.error(`权限登记列表加载失败：${messageForError(error)}`)
  }
}

function openCreate(): void {
  editingId.value = null
  form.name = ''
  form.teamId = teamFilter.value
  showForm.value = true
  void nextTick(() => formRef.value?.restoreValidation())
}

function openEdit(role: Role): void {
  editingId.value = role.id
  form.name = role.name
  form.teamId = role.team_id
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
    const name = form.name.trim()
    if (editingId.value) {
      // A team-scoped administrator cannot change a role's team.
      await authzApi.updateRole(
        editingId.value,
        platformScope.value ? { name, team_id: form.teamId } : { name }
      )
      message.success('角色已更新')
    } else {
      await authzApi.createRole({ name, team_id: platformScope.value ? form.teamId : teamFilter.value })
      message.success('角色已创建')
    }
    showForm.value = false
    await load(true)
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    submitting.value = false
  }
}

async function openPermissions(role: Role): Promise<void> {
  permRole.value = role
  permKeys.value = []
  permError.value = ''
  showPermissions.value = true
  await loadRegistry()
}

async function submitPermissions(): Promise<void> {
  const role = permRole.value
  if (!role) return

  const keys = Array.from(
    new Set(
      permKeys.value
        .map((key) => key.trim())
        .filter((key) => key.length > 0)
    )
  )
  const malformed = keys.filter((key) => !authzApi.isValidPermissionKey(key))
  if (malformed.length > 0) {
    permError.value = `权限标识格式不正确：${malformed.join('、')}`
    return
  }
  if (!platformScope.value) {
    const broad = keys.filter((key) => authzApi.permissionScope(key) !== 'team')
    if (broad.length > 0) {
      permError.value = `当前账户只能为角色附加团队范围内的权限，请移除：${broad.join('、')}`
      return
    }
  }

  permError.value = ''
  permSaving.value = true
  try {
    const result = await authzApi.replaceRolePermissions(role.id, keys)
    message.success(`已保存，共 ${result.permissions.length} 项权限`)
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    permSaving.value = false
  }
}

async function removeRole(role: Role): Promise<void> {
  try {
    await authzApi.deleteRole(role.id)
    message.success('角色已删除')
    await load(true)
  } catch (error) {
    message.error(messageForError(error))
  }
}

function confirmDelete(role: Role): void {
  dialog.warning({
    title: '删除角色',
    content: `确认删除角色“${role.name}”？该角色的全部授权绑定会一并删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => removeRole(role)
  })
}

onMounted(async () => {
  await Promise.all([load(true), ensureTeamDirectory()])
})
</script>

<template>
  <NCard title="角色" :bordered="false">
    <template #header-extra>
      <NSpace :size="8">
        <NButton size="small" :loading="loading" @click="load(true)">刷新</NButton>
        <NButton size="small" type="primary" @click="openCreate">新建角色</NButton>
      </NSpace>
    </template>

    <div class="filter-row">
      <div class="filter-team">
        <TeamSelect v-model:value="teamFilter" :required="!platformScope" placeholder="全部范围（平台与所有团队）" />
      </div>
      <NText depth="3">
        {{ platformScope ? '不选择团队时显示平台角色与所有团队的角色。' : '请先选择要管理的团队，再查看其中的角色。' }}
      </NText>
    </div>

    <NDataTable
      :columns="columns"
      :data="roles"
      :loading="loading"
      :pagination="false"
      size="small"
      remote
    />

    <div class="table-footer">
      <NButton v-if="nextCursor" size="small" :loading="loadingMore" @click="load(false)">
        加载更多
      </NButton>
      <NText v-else depth="3">已加载全部 {{ roles.length }} 个角色</NText>
    </div>
  </NCard>

  <NModal
    v-model:show="showForm"
    preset="card"
    :title="editingId ? '编辑角色' : '新建角色'"
    style="width: 520px"
  >
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="top">
      <NFormItem label="角色名称" path="name">
        <NInput v-model:value="form.name" placeholder="例如 operator" />
      </NFormItem>
      <NFormItem label="所属团队">
        <TeamSelect
          v-model:value="form.teamId"
          :disabled="Boolean(editingId) && !platformScope"
          :ensure-ids="form.teamId ? [form.teamId] : []"
          placeholder="留空为平台角色"
        />
      </NFormItem>
    </NForm>
    <NAlert v-if="editingId && !platformScope" type="warning" :show-icon="false" class="form-notice">
      当前账户不能调整角色的所属团队。
    </NAlert>
    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton @click="showForm = false">取消</NButton>
        <NButton type="primary" :loading="submitting" @click="submitForm">保存</NButton>
      </NSpace>
    </template>
  </NModal>

  <NModal
    v-model:show="showPermissions"
    preset="card"
    :title="permRole ? `角色权限 · ${permRole.name}` : '角色权限'"
    style="width: 640px"
  >
    <NAlert type="warning" :show-icon="false" class="form-notice">
      保存会整体替换该角色的全部权限，请一次提交完整清单；清空后保存将移除该角色的所有权限。
    </NAlert>
    <NForm label-placement="top">
      <NFormItem label="权限标识">
        <NSelect
          v-model:value="permKeys"
          :options="registryOptions"
          multiple
          filterable
          tag
          :placeholder="canReadRegistry ? '选择或输入权限标识' : '输入权限标识后回车'"
        />
      </NFormItem>
    </NForm>
    <NAlert v-if="permError" type="error" :show-icon="false" class="form-notice">{{ permError }}</NAlert>
    <NText depth="3" class="form-hint">
      格式为「资源:操作:范围」，范围取 own、team、any 或 *；开头加 ! 表示拒绝。
    </NText>
    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton @click="showPermissions = false">关闭</NButton>
        <NButton type="primary" :loading="permSaving" @click="submitPermissions">保存</NButton>
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
