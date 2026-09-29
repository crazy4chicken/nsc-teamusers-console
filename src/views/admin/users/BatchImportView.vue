<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NSpace,
  NTag,
  NText,
  NUpload,
  useDialog,
  useMessage,
  type DataTableColumns,
  type UploadInst,
  type UploadOnChange,
  type UploadSettledFileInfo
} from 'naive-ui'

import * as batchApi from '@/api/admin/batch'
import { messageForError } from '@/api/errors'
import type { ImportResponse, ImportRowResult } from '@/api/types'
import { renderIdCell } from '../idDisplay'

/**
 * CSV import. The service implements a single synchronous write endpoint
 * (`POST /users/import`, `text/csv`, header
 * `username,email,display_name,password`, at most 500 rows) and documents no
 * dry-run parameter, so the dry run is a local preview: the file is parsed and
 * validated in the browser, and only "确认导入" submits the bytes to the service.
 * Requires `iam:users:any`.
 */

const MAX_IMPORT_ROWS = 500
const CSV_HEADER = ['username', 'email', 'display_name', 'password']

interface PreviewRow {
  /** 1-based line number in the uploaded file (the header is line 1). */
  line: number
  username: string
  email: string
  display_name: string
  password: string
  /** Local validation finding, `null` when the row looks usable. */
  problem: string | null
}

interface Preview {
  headerProblem: string | null
  rows: PreviewRow[]
}

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const uploadRef = ref<UploadInst | null>(null)

const fileName = ref('')
const csvText = ref('')
const parseError = ref('')
const preview = ref<Preview>({ headerProblem: null, rows: [] })
const submitting = ref(false)
const result = ref<ImportResponse | null>(null)

/** Minimal RFC 4180 field splitter: enough to preview a file the service re-parses itself. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char !== '"') {
        current += char
      } else if (line[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        quoted = false
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields.map((field) => field.trim())
}

function parsePreview(text: string): Preview {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { headerProblem: '文件为空', rows: [] }

  const header = parseCsvLine(lines[0])
  if (
    header.length !== CSV_HEADER.length ||
    header.some((value, index) => value !== CSV_HEADER[index])
  ) {
    return { headerProblem: `表头必须为 ${CSV_HEADER.join(',')}`, rows: [] }
  }

  const seen = new Set<string>()
  const rows = lines.slice(1).map((line, index) => {
    const [username = '', email = '', displayName = '', password = ''] = parseCsvLine(line)
    let problem: string | null = null
    if (!username) problem = '用户名为空'
    else if (!password) problem = '密码为空'
    else if (seen.has(username)) problem = '文件内用户名重复'
    if (username) seen.add(username)
    return {
      line: index + 2,
      username,
      email,
      display_name: displayName,
      password,
      problem
    }
  })
  return { headerProblem: null, rows }
}

const problemCount = computed(() => preview.value.rows.filter((row) => row.problem !== null).length)
const tooManyRows = computed(() => preview.value.rows.length > MAX_IMPORT_ROWS)
const canApply = computed(
  () => preview.value.headerProblem === null && preview.value.rows.length > 0 && !tooManyRows.value
)
const resultSummary = computed(() => {
  const current = result.value
  if (!current) return null
  const failed = current.results.filter((row) => !row.ok).length
  return { total: current.results.length, ok: current.results.length - failed, failed }
})

function maskSecret(value: string): string {
  return value ? '•'.repeat(Math.min(value.length, 12)) : ''
}

async function handleUpload(file: UploadSettledFileInfo): Promise<void> {
  const raw = file.file
  if (!raw) {
    parseError.value = '无法读取所选文件'
    return
  }
  try {
    csvText.value = await raw.text()
    fileName.value = raw.name || file.name
    result.value = null
    parseError.value = ''
    preview.value = parsePreview(csvText.value)
  } catch {
    parseError.value = '读取文件失败，请重试'
  }
}

const onFileChange: UploadOnChange = (data) => {
  void handleUpload(data.file)
}

function clearFile(): void {
  uploadRef.value?.clear()
  fileName.value = ''
  csvText.value = ''
  parseError.value = ''
  preview.value = { headerProblem: null, rows: [] }
  result.value = null
}

async function submitImport(): Promise<void> {
  if (!canApply.value) return
  submitting.value = true
  try {
    const response = await batchApi.importUsersCsv(csvText.value)
    result.value = response
    const failed = response.results.filter((row) => !row.ok).length
    message.success(`导入完成：成功 ${response.results.length - failed} 行，失败 ${failed} 行`)
  } catch (error) {
    message.error(messageForError(error))
  } finally {
    submitting.value = false
  }
}

function confirmImport(): void {
  dialog.warning({
    title: '确认导入',
    content: `确认导入文件「${fileName.value}」的 ${preview.value.rows.length} 行用户数据？导入后立即生效，无法撤销。`,
    positiveText: '确认导入',
    negativeText: '取消',
    onPositiveClick: async () => {
      await submitImport()
    }
  })
}

const previewColumns: DataTableColumns<PreviewRow> = [
  { title: '行号', key: 'line', width: 80 },
  { title: '用户名', key: 'username', minWidth: 140 },
  { title: '邮箱', key: 'email', minWidth: 180 },
  { title: '显示名', key: 'display_name', minWidth: 140 },
  { title: '密码', key: 'password', width: 140, render: (row) => maskSecret(row.password) },
  {
    title: '本地校验',
    key: 'problem',
    width: 140,
    render: (row) => {
      const problem = row.problem
      return problem === null
        ? h(NTag, { size: 'small', type: 'success' }, { default: () => '通过' })
        : h(NTag, { size: 'small', type: 'warning' }, { default: () => problem })
    }
  }
]

const resultColumns: DataTableColumns<ImportRowResult> = [
  { title: '行号', key: 'row', width: 80 },
  { title: '用户名', key: 'username', minWidth: 140 },
  {
    title: '结果',
    key: 'ok',
    width: 100,
    render: (row) =>
      h(
        NTag,
        { size: 'small', type: row.ok ? 'success' : 'error' },
        { default: () => (row.ok ? '成功' : '失败') }
      )
  },
  { title: '用户编号', key: 'id', minWidth: 240, render: (row) => renderIdCell(row.id, (ok) => (ok ? message.success('已复制完整编号') : message.error('复制失败'))) },
  { title: '失败原因', key: 'error', minWidth: 200, render: (row) => row.error ?? '—' }
]
</script>

<template>
  <NSpace vertical :size="16">
    <NCard title="批量导入用户" :bordered="false">
      <template #header-extra>
        <NButton size="small" @click="router.push('/admin/users')">返回用户列表</NButton>
      </template>

      <NAlert class="block-alert" type="info" :show-icon="false">
        CSV 表头必须为 <strong>{{ CSV_HEADER.join(',') }}</strong>，单次最多
        {{ MAX_IMPORT_ROWS }} 行。预览只在本地检查，不会写入，点击「确认导入」后才会保存。
      </NAlert>

      <NSpace :size="8" align="center">
        <NUpload
          ref="uploadRef"
          :default-upload="false"
          :show-file-list="false"
          accept=".csv,text/csv"
          @change="onFileChange"
        >
          <NButton>选择 CSV 文件</NButton>
        </NUpload>
        <NText v-if="fileName" depth="3">已选择：{{ fileName }}</NText>
        <NButton v-if="fileName" size="small" quaternary @click="clearFile">清空</NButton>
      </NSpace>

      <NAlert v-if="parseError" class="block-alert" type="error" :show-icon="false">
        {{ parseError }}
      </NAlert>
      <NAlert v-if="preview.headerProblem" class="block-alert" type="error" :show-icon="false">
        {{ preview.headerProblem }}
      </NAlert>
      <NAlert v-if="tooManyRows" class="block-alert" type="error" :show-icon="false">
        共 {{ preview.rows.length }} 行，一次最多导入 {{ MAX_IMPORT_ROWS }} 行，请拆分后再导入。
      </NAlert>
    </NCard>

    <NCard v-if="fileName && !preview.headerProblem" title="导入前检查" :bordered="false">
      <NText depth="3" class="summary">
        共 {{ preview.rows.length }} 行，疑似问题 {{ problemCount }} 行。导入时系统会逐行重新校验，本地检查仅作提示。
      </NText>
      <NDataTable
        :columns="previewColumns"
        :data="preview.rows"
        :pagination="false"
        size="small"
        :scroll-x="1000"
      />
      <NSpace justify="end" class="actions">
        <NButton type="primary" :disabled="!canApply" :loading="submitting" @click="confirmImport">
          确认导入
        </NButton>
      </NSpace>
    </NCard>

    <NCard v-if="resultSummary" title="导入结果" :bordered="false">
      <NAlert
        class="block-alert"
        :type="resultSummary.failed ? 'warning' : 'success'"
        :show-icon="false"
      >
        共 {{ resultSummary.total }} 行：成功 {{ resultSummary.ok }} 行，失败 {{ resultSummary.failed }} 行。
      </NAlert>
      <NDataTable
        :columns="resultColumns"
        :data="result?.results ?? []"
        :pagination="false"
        size="small"
        :scroll-x="1000"
      />
      <NSpace justify="end" class="actions">
        <NButton size="small" @click="router.push('/admin/users')">查看用户列表</NButton>
      </NSpace>
    </NCard>
  </NSpace>
</template>

<style scoped>
.block-alert {
  margin-bottom: 12px;
}

.summary {
  display: block;
  margin-bottom: 12px;
  font-size: 12px;
}

.actions {
  margin-top: 12px;
}
</style>
