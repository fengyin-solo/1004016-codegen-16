<template>
  <section class="page" data-module="pipe_detect">
    <header class="page-head">
      <div>
        <h2>管道检测管理</h2>
        <p class="page-desc">维护检测记录，围绕检测编号、检测管段、检测方式、检测设备做登记、筛选与状态流转；管道清洗进入「需复查」后会在此自动生成清洗复核事项。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检测记录</button>
        <button class="btn" type="button" @click="exportRows">导出管道检测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ 'stat-hot': item.hot }">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 清洗复核事项：由管道清洗「提交复查」自动生成，不允许在检测页手工补录 -->
    <section class="recheck-panel">
      <header class="recheck-head">
        <h3>清洗复核事项</h3>
        <span class="legend-item">待复核 {{ pendingRecheckCount }} 条</span>
      </header>
      <table v-if="recheckItems.length" class="data-table">
        <thead>
          <tr>
            <th>复核编号</th>
            <th>来源清洗记录</th>
            <th>检测管段</th>
            <th>检测方式</th>
            <th>清洗长度（米）</th>
            <th>复核状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in recheckItems" :key="String(item.id)" class="recheck-row">
            <td>{{ item['检测编号'] }}</td>
            <td>{{ item['来源清洗记录'] }}</td>
            <td>{{ item['检测管段'] }}</td>
            <td>{{ item['检测方式'] }}</td>
            <td>{{ item['检测长度'] }}</td>
            <td><span class="tag tag-recheck">待复核</span></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state recheck-empty">暂无清洗复核事项；清洗记录提交复查后会自动出现在这里。</p>
    </section>

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
          <th>事项来源</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'recheck-row': isRecheck(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span v-if="isRecheck(row)" class="tag tag-recheck">清洗复核 · {{ row['来源清洗记录'] }}</span>
            <span v-else class="muted-text">常规检测</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无管道检测数据，可先登记检测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管道检测记录（含 {{ recheckItems.length }} 条清洗复核事项）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listRecheckItems } from '@/api/cleaning-flow'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pipe_detect')
const columns = ["检测编号", "检测管段", "检测方式", "检测设备", "检测日期", "检测长度", "检测结果", "检测状态"]
const actions = ["安排检测", "记录结果", "标记复测"]
const statuses = ["待检测", "检测中", "已完成", "需复测"]

const rows = ref<EntryRow[]>([])
const recheckItems = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const isRecheck = (row: EntryRow): boolean => String(row['事项类型'] ?? '') === '清洗复核'

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const pendingRecheckCount = computed(
  () => recheckItems.value.filter((item) => String(item.status) !== '已完成').length,
)

const stats = computed(() => [
  { label: '待检测管段', value: rows.value.filter((row) => String(row.status) === '待检测').length, hot: false },
  { label: '已完成管段', value: rows.value.filter((row) => String(row.status) === '已完成').length, hot: false },
  { label: '需复测管段', value: rows.value.filter((row) => String(row.status) === '需复测').length, hot: false },
  { label: '清洗复核事项', value: recheckItems.value.length, hot: true },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '检测记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 复核事项独立取数：清洗页提交复查后，回到本页即可看到新事项。
    recheckItems.value = listRecheckItems()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管道检测列表读取失败'
  }
}

onMounted(reload)
</script>
