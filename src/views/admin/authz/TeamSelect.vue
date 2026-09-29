<script lang="ts">
import { ref, type Ref } from 'vue'

import * as authzApi from '@/api/admin/authorization'
import { messageForError } from '@/api/errors'
import * as meApi from '@/api/me'
import { authStore } from '@/stores/authStore'

/**
 * Team directory backing the area's team selector.
 *
 * `GET /teams` is a collection without a target team, so the service only
 * serves it to `iam:teams:any` holders. Everyone else gets the teams the
 * claims expose: `GET /me/export` memberships, which is the only
 * browser-reachable list of the caller's own teams. Names are resolved through
 * `GET /teams/{id}` when the caller also holds `iam:teams:team`, and fall back
 * to the bare id otherwise.
 */

export type TeamScope = 'any' | 'team'

/** Type alias (not an interface) so it stays assignable to naive-ui's index-signature option type. */
export type TeamOption = {
  value: string
  label: string
}

export interface TeamDirectory {
  scope: TeamScope
  options: TeamOption[]
  /** Why the list is partial; rendered under the selector. */
  note: string
  error: string
}

/** Platform-wide team listing, the only grant that unlocks `GET /teams`. */
const PLATFORM_TEAM_PERMISSION = 'iam:teams:any'
/** Team-scoped `GET /teams/{id}` is what makes a name resolvable. */
const SINGLE_TEAM_PERMISSION = 'iam:teams:team'
/** Bounds: a huge membership list or team table must not fan out or spin. */
const TEAM_PAGE_LIMIT = 200
const TEAM_PAGE_CAP = 50
const MEMBERSHIP_CAP = 100

const directory = ref<TeamDirectory>({ scope: 'team', options: [], note: '', error: '' })
let pending: Promise<TeamDirectory> | null = null

export function teamDirectory(): Ref<TeamDirectory> {
  return directory
}

export function hasPlatformTeamAccess(): boolean {
  return authStore.hasPermission(PLATFORM_TEAM_PERMISSION)
}

/** Team name when known, the raw id when it is not, `平台` for a platform scope. */
export function teamLabel(teamId: string | null | undefined): string {
  if (!teamId) return '平台'
  return directory.value.options.find((option) => option.value === teamId)?.label ?? teamId
}

async function loadEveryTeam(): Promise<TeamOption[]> {
  const options: TeamOption[] = []
  let cursor: string | null = null
  for (let page = 0; page < TEAM_PAGE_CAP; page += 1) {
    const response = await authzApi.listTeams({ cursor, limit: TEAM_PAGE_LIMIT })
    for (const team of response.items) {
      options.push({ value: team.id, label: `${team.name}（${team.slug}）` })
    }
    cursor = response.next_cursor ? response.next_cursor : null
    if (!cursor) break
  }
  return options
}

async function loadMemberTeams(): Promise<TeamOption[]> {
  const exported = await meApi.exportAccount()
  const ids = Array.from(new Set((exported.memberships ?? []).map((row) => row.team_id))).slice(
    0,
    MEMBERSHIP_CAP
  )
  if (!authStore.hasPermission(SINGLE_TEAM_PERMISSION)) {
    return ids.map((id) => ({ value: id, label: id }))
  }
  const resolved = await Promise.allSettled(ids.map((id) => authzApi.getTeam(id)))
  return ids.map((id, index) => {
    const result = resolved[index]
    if (result.status !== 'fulfilled') return { value: id, label: id }
    return { value: id, label: `${result.value.name}（${result.value.slug}）` }
  })
}

function noteFor(scope: TeamScope, count: number): string {
  if (scope === 'any') {
    return count === 0 ? '系统中还没有任何团队。' : ''
  }
  if (count === 0) {
    return '当前账户不属于任何团队，也没有查看全部团队的权限。'
  }
  return '当前账户只能选择自己所属的团队。'
}

/** Loads once and memoizes; call `invalidateTeamDirectory` after team mutations. */
export async function ensureTeamDirectory(): Promise<TeamDirectory> {
  if (!pending) {
    pending = (async () => {
      const scope: TeamScope = hasPlatformTeamAccess() ? 'any' : 'team'
      try {
        const options = scope === 'any' ? await loadEveryTeam() : await loadMemberTeams()
        directory.value = { scope, options, note: noteFor(scope, options.length), error: '' }
      } catch (error) {
        directory.value = {
          scope,
          options: [],
          note: '',
          error: `团队列表加载失败：${messageForError(error)}`
        }
      }
      return directory.value
    })()
  }
  return await pending
}

export function invalidateTeamDirectory(): void {
  pending = null
  directory.value = { scope: 'team', options: [], note: '', error: '' }
}
</script>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { NAlert, NSelect, NText } from 'naive-ui'

const props = withDefaults(
  defineProps<{
    value: string | null
    /** Renders a mandatory-selection placeholder and drops the clear affordance. */
    required?: boolean
    disabled?: boolean
    placeholder?: string
    /** Ids that stay selectable even when the directory does not contain them. */
    ensureIds?: string[]
  }>(),
  { required: false, disabled: false, placeholder: '选择团队', ensureIds: () => [] }
)

const emit = defineEmits<{ 'update:value': [string | null] }>()

const state = teamDirectory()
const loading = ref(true)

const options = computed<TeamOption[]>(() => {
  const known = state.value.options
  const extra = props.ensureIds
    .filter((id) => id.length > 0 && !known.some((option) => option.value === id))
    .map((id) => ({ value: id, label: id }))
  return [...known, ...extra]
})

function onUpdate(next: string | number | null): void {
  emit('update:value', next === null ? null : String(next))
}

onMounted(async () => {
  loading.value = true
  await ensureTeamDirectory()
  loading.value = false
})
</script>

<template>
  <div class="team-select">
    <NSelect
      :value="value"
      :options="options"
      :loading="loading"
      :disabled="disabled"
      :placeholder="required ? '必须选择团队' : placeholder"
      :clearable="!required"
      filterable
      @update:value="onUpdate"
    />
    <NAlert v-if="state.error" class="team-select-note" type="warning" :show-icon="false">
      {{ state.error }}
    </NAlert>
    <NText v-else-if="state.note" class="team-select-note" depth="3">{{ state.note }}</NText>
  </div>
</template>

<style scoped>
.team-select {
  width: 100%;
}

.team-select-note {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
}
</style>
