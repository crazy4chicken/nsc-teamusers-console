<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NSelect,
  NSpace,
  NTag,
  NText,
  useMessage,
  type DataTableColumns
} from 'naive-ui'

import { auditHasMore, listAudit, type AuditLogEntry } from '@/api/admin/audit'
import { messageForError } from '@/api/errors'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/api/pagination'
import { renderIdCell, shortId } from '../idDisplay'

const message = useMessage()

/**
 * The `/audit` cursor is the last row's `id`, so paging is strictly forward:
 * each visited page keeps the cursor that produced it, which makes "previous"
 * a re-read of a lower cursor (the log is append-only, so a re-read is exact).
 */
const cursorHistory = ref<number[]>([0])
const pageIndex = ref(0)
const currentCursor = computed(() => cursorHistory.value[pageIndex.value] ?? 0)
const pageNumber = computed(() => pageIndex.value + 1)

const items = ref<AuditLogEntry[]>([])
const nextCursor = ref<number | null>(null)
const hasNextPage = computed(() => nextCursor.value !== null)
const loading = ref(false)
const errorText = ref<string | null>(null)

const limit = ref(DEFAULT_PAGE_LIMIT)
const limitOptions = [50, DEFAULT_PAGE_LIMIT, 200, 500, MAX_PAGE_LIMIT].map((value) => ({
  label: `${value} 条`,
  value
}))

const teamIdInput = ref('')
const activeTeamId = ref<string | null>(null)
const emptyDescription = computed(() =>
  activeTeamId.value ? '该团队暂无审计记录' : '暂无审计记录'
)

const selected = ref<AuditLogEntry | null>(null)
const drawerOpen = ref(false)

async function copyId(value: string | null | undefined): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    message.success('已复制完整编号')
  } catch {
    message.error('复制失败')
  }
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  hour12: false
})

function formatTime(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : timeFormatter.format(parsed)
}

/** Long identifier-shaped values get the short form with copy; anything else stays as-is. */
function looksLikeId(value: string): boolean {
  return /^[0-9A-Za-z]{26}$/.test(value)
}

function onCopied(ok: boolean): void {
  if (ok) message.success('已复制完整编号')
  else message.error('复制失败')
}

const columns: DataTableColumns<AuditLogEntry> = [
  {
    title: '时间',
    key: 'at',
    width: 200,
    render: (row) => h('span', { title: row.at ?? '' }, formatTime(row.at))
  },
  { title: '动作', key: 'action', width: 190, render: (row) => row.action ?? '—' },
  {
    title: '目标',
    key: 'target',
    width: 200,
    render: (row) =>
      row.target && looksLikeId(row.target)
        ? renderIdCell(row.target, onCopied)
        : h('span', { title: row.target ?? '' }, row.target ?? '—')
  },
  {
    title: '操作人',
    key: 'actor_id',
    width: 200,
    render: (row) => renderIdCell(row.actor_id, onCopied)
  },
  {
    title: '团队',
    key: 'team_id',
    width: 170,
    render: (row) =>
      row.team_id
        ? renderIdCell(row.team_id, onCopied)
        : h(NTag, { size: 'small', bordered: false }, { default: () => '平台' })
  },
  {
    title: '操作',
    key: 'actions',
    width: 90,
    render: (row) =>
      h(
        NButton,
        {
          size: 'small',
          quaternary: true,
          onClick: () => {
            selected.value = row
            drawerOpen.value = true
          }
        },
        { default: () => '查看' }
      )
  }
]

/** A later response must never overwrite the pages a newer request produced. */
let requestSeq = 0

async function loadPage(cursor: number): Promise<void> {
  const seq = requestSeq + 1
  requestSeq = seq
  loading.value = true
  try {
    const page = await listAudit({ cursor, limit: limit.value, team_id: activeTeamId.value })
    if (seq !== requestSeq) return
    items.value = page.items
    nextCursor.value = auditHasMore(cursor, page.nextCursor) ? page.nextCursor : null
    errorText.value = null
  } catch (error) {
    if (seq !== requestSeq) return
    const text = messageForError(error)
    items.value = []
    nextCursor.value = null
    errorText.value = text
    message.error(text)
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

/** Returns to the first page, which is the only page with no predecessor. */
function resetPaging(): void {
  cursorHistory.value = [0]
  pageIndex.value = 0
  nextCursor.value = null
  void loadPage(0)
}

function reload(): void {
  void loadPage(currentCursor.value)
}

function goNext(): void {
  const target = nextCursor.value
  if (target === null) return
  cursorHistory.value = [...cursorHistory.value.slice(0, pageIndex.value + 1), target]
  pageIndex.value = cursorHistory.value.length - 1
  void loadPage(target)
}

function goPrev(): void {
  if (pageIndex.value === 0) return
  pageIndex.value -= 1
  void loadPage(currentCursor.value)
}

function onLimitChange(value: number): void {
  if (value === limit.value) return
  limit.value = value
  resetPaging()
}

function applyTeamFilter(): void {
  const trimmed = teamIdInput.value.trim()
  activeTeamId.value = trimmed.length > 0 ? trimmed : null
  resetPaging()
}

function resetTeamFilter(): void {
  teamIdInput.value = ''
  if (activeTeamId.value === null) return
  activeTeamId.value = null
  resetPaging()
}

onMounted(() => {
  void loadPage(0)
})
</script>

<template>
  <NCard title="审计日志" :bordered="false">
    <NSpace class="filters" align="center" :size="12" :wrap="false">
      <NInput
        v-model:value="teamIdInput"
        class="team-filter"
        placeholder="团队编号（可选，留空显示全部团队）"
        clearable
        @keyup.enter="applyTeamFilter"
      />
      <NButton type="primary" :disabled="loading" @click="applyTeamFilter">筛选</NButton>
      <NButton
        quaternary
        :disabled="loading || (!activeTeamId && !teamIdInput)"
        @click="resetTeamFilter"
      >
        重置
      </NButton>
      <NButton quaternary :loading="loading" @click="reload">刷新</NButton>
    </NSpace>

    <NAlert v-if="errorText" class="failure" type="error" :title="errorText">
      <NButton size="small" :loading="loading" @click="reload">重试</NButton>
    </NAlert>

    <NDataTable
      :columns="columns"
      :data="items"
      :loading="loading"
      :row-key="(row: AuditLogEntry) => row.key"
      :pagination="false"
      :bordered="false"
      :single-line="false"
      :scroll-x="1150"
      size="small"
    >
      <template #empty>
        <NEmpty :description="emptyDescription" />
      </template>
    </NDataTable>

    <NSpace class="pager" align="center" justify="space-between" :wrap="false">
      <NText depth="3">
        第 {{ pageNumber }} 页 · 本页 {{ items.length }} 条
        <template v-if="activeTeamId"> · 团队 {{ shortId(activeTeamId) }}</template>
      </NText>
      <NSpace align="center" :size="8" :wrap="false">
        <NSelect
          :value="limit"
          :options="limitOptions"
          :disabled="loading"
          size="small"
          class="limit-select"
          @update:value="onLimitChange"
        />
        <NButton size="small" :disabled="loading || pageIndex === 0" @click="goPrev">
          上一页
        </NButton>
        <NButton size="small" :disabled="loading || !hasNextPage" @click="goNext">
          下一页
        </NButton>
      </NSpace>
    </NSpace>
  </NCard>

  <NDrawer v-model:show="drawerOpen" :width="620" placement="right">
    <NDrawerContent title="审计条目" closable>
      <NDescriptions v-if="selected" :column="1" label-placement="left" bordered size="small">
        <NDescriptionsItem label="编号">{{ selected.id ?? '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="时间">{{ formatTime(selected.at) }}</NDescriptionsItem>
        <NDescriptionsItem label="动作">{{ selected.action ?? '—' }}</NDescriptionsItem>
        <NDescriptionsItem label="目标">
          <template v-if="selected.target && looksLikeId(selected.target)">
            <code>{{ shortId(selected.target) }}</code>
            <NButton size="tiny" quaternary @click="copyId(selected.target)">复制</NButton>
          </template>
          <template v-else>{{ selected.target ?? '—' }}</template>
        </NDescriptionsItem>
        <NDescriptionsItem label="操作人">
          <template v-if="selected.actor_id">
            <code>{{ shortId(selected.actor_id) }}</code>
            <NButton size="tiny" quaternary @click="copyId(selected.actor_id)">复制</NButton>
          </template>
          <template v-else>—</template>
        </NDescriptionsItem>
        <NDescriptionsItem label="团队">
          <template v-if="selected.team_id">
            <code>{{ shortId(selected.team_id) }}</code>
            <NButton size="tiny" quaternary @click="copyId(selected.team_id)">复制</NButton>
          </template>
          <template v-else>平台</template>
        </NDescriptionsItem>
      </NDescriptions>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.filters {
  margin-bottom: 16px;
}

.team-filter {
  width: 300px;
}

.failure {
  margin-bottom: 16px;
}

.limit-select {
  width: 110px;
}

.pager {
  margin-top: 16px;
}

</style>
