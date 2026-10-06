<template>
  <section class="page" data-module="pipe_cleaning">
    <header class="page-head">
      <div>
        <h2>管道清洗管理</h2>
        <p class="page-desc">清洗计划严格按 待清洗 → 清洗中 → 已完成 → 需复查 逐级流转；开始清洗记录实际日期，确认完成登记清洗长度，进入需复查后自动推送复核事项到管道检测页。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记清洗计划</button>
        <button class="btn" type="button" @click="exportRows">导出管道清洗清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>
            <span :class="['status-badge', `status-${statusIndex(row.status)}`]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-if="nextCleaningAction(String(row.status))"
              class="link"
              type="button"
              @click="openAction(row)"
            >
              {{ nextCleaningAction(String(row.status)) }}
            </button>
            <span v-else class="muted-text">已到复查终态</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无管道清洗数据，可先登记清洗计划</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管道清洗记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <!-- 流转动作弹窗：开始清洗填实际日期，确认完成填清洗长度，提交复查做确认 -->
    <div v-if="actionDialog.open" class="modal-mask" @click.self="closeAction">
      <div class="modal">
        <h3 class="modal-title">{{ actionDialog.action }} · {{ actionDialog.code }}</h3>
        <p class="modal-hint">
          当前状态「{{ actionDialog.status }}」，操作后进入「{{ targetStatus(actionDialog.action) }}」。
        </p>

        <label v-if="actionDialog.action === '开始清洗'" class="modal-field">
          <span>实际开工日期 <em>*</em></span>
          <input v-model="actionDialog.actualDate" type="date" />
          <small>不得早于计划日期 {{ actionDialog.planDate }}</small>
        </label>

        <label v-if="actionDialog.action === '确认完成'" class="modal-field">
          <span>清洗长度（米） <em>*</em></span>
          <input v-model="actionDialog.length" type="number" min="0" step="0.1" placeholder="请输入实际清洗长度" />
          <small>管段 {{ actionDialog.segment }} 登记长度 {{ actionDialog.segmentLimit }} 米，超出范围将被拒绝</small>
        </label>

        <p v-if="actionDialog.action === '提交复查'" class="modal-tip">
          提交后管道检测页将为管段 {{ actionDialog.segment }} 生成一条「清洗复核」事项。
        </p>

        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeAction">取消</button>
          <button class="btn primary" type="button" @click="confirmAction">确认{{ actionDialog.action }}</button>
        </div>
      </div>
    </div>

    <!-- 登记清洗计划弹窗 -->
    <div v-if="createDialog.open" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3 class="modal-title">登记清洗计划</h3>
        <p class="modal-hint">计划登记后状态为「待清洗」，清洗编号由系统自动生成。</p>

        <label class="modal-field">
          <span>清洗管段 <em>*</em></span>
          <input v-model="createDialog.segment" list="segment-codes" placeholder="如 DRAI-0001" />
          <datalist id="segment-codes">
            <option v-for="code in segmentCodes" :key="code" :value="code" />
          </datalist>
          <small>只能选择排水管网中已登记的管段</small>
        </label>

        <label class="modal-field">
          <span>清洗方式 <em>*</em></span>
          <input v-model="createDialog.method" placeholder="如 高压水射流 / 机械清通" />
        </label>

        <label class="modal-field">
          <span>清洗设备</span>
          <input v-model="createDialog.equipment" placeholder="如 高压清洗车 HC-12" />
        </label>

        <label class="modal-field">
          <span>计划日期 <em>*</em></span>
          <input v-model="createDialog.planDate" type="date" />
        </label>

        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" @click="confirmCreate">登记计划</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  createCleaningPlan,
  knownSegmentCodes,
  nextCleaningAction,
  runCleaningAction,
  segmentLength,
} from '@/api/cleaning-flow'
import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pipe_cleaning')
const columns = meta.fields
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const segmentCodes = knownSegmentCodes()

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待清洗管段', value: countByStatus('待清洗') },
  { label: '清洗中管段', value: countByStatus('清洗中') },
  { label: '已完成管段', value: countByStatus('已完成') },
  { label: '需复查管段', value: countByStatus('需复查') },
])

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function statusIndex(status: string): number {
  const index = statuses.indexOf(status)
  return index < 0 ? 0 : index
}

function displayValue(row: EntryRow, column: string): string | number {
  const value = row[column]
  if (value === '' || value === undefined || value === null) {
    return '—'
  }
  return typeof value === 'boolean' ? String(value) : value
}

function targetStatus(action: string): string {
  return meta.actionTargets[action] ?? ''
}

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const actionDialog = reactive({
  open: false,
  id: 0,
  code: '',
  action: '',
  status: '',
  segment: '',
  planDate: '',
  segmentLimit: 0,
  actualDate: todayText(),
  length: '',
})

const createDialog = reactive({
  open: false,
  segment: '',
  method: '',
  equipment: '',
  planDate: '',
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function flash(message: string, ok: boolean) {
  successMessage.value = ok ? message : ''
  errorMessage.value = ok ? '' : message
}

function openCreate() {
  Object.assign(createDialog, {
    open: true,
    segment: '',
    method: '',
    equipment: '',
    planDate: todayText(),
  })
}

function closeCreate() {
  createDialog.open = false
}

function confirmCreate() {
  const result = createCleaningPlan({
    清洗管段: createDialog.segment,
    清洗方式: createDialog.method,
    清洗设备: createDialog.equipment,
    计划日期: createDialog.planDate,
  })
  if (!result.ok) {
    flash(result.message, false)
    return
  }
  closeCreate()
  flash(result.message, true)
  reload()
}

function openAction(row: EntryRow) {
  const action = nextCleaningAction(String(row.status))
  if (!action) {
    return
  }
  const segment = String(row['清洗管段'] ?? '')
  Object.assign(actionDialog, {
    open: true,
    id: Number(row.id),
    code: String(row['清洗编号'] ?? ''),
    action,
    status: String(row.status),
    segment,
    planDate: String(row['计划日期'] ?? ''),
    segmentLimit: segmentLength(segment) ?? 0,
    actualDate: todayText(),
    length: '',
  })
  errorMessage.value = ''
}

function closeAction() {
  actionDialog.open = false
}

function confirmAction() {
  const result = runCleaningAction(
    actionDialog.id,
    actionDialog.action,
    {
      实际日期: actionDialog.actualDate,
      清洗长度: actionDialog.length,
    },
  )
  if (!result.ok) {
    flash(result.message, false)
    return
  }
  closeAction()
  flash(result.message, true)
  reload()
}

function reload() {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    flash(error instanceof Error ? error.message : '管道清洗列表读取失败', false)
  }
}

onMounted(reload)
</script>
