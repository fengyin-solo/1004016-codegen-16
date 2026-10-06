import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  payload: Record<string, string | number> = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const source = meta.actionSources?.[action]
  if (source && current !== source) {
    return { ok: false, message: orderViolation(meta, current, source, action) }
  }
  if (key === 'pipe_cleaning') {
    return runPipeCleaningAction(meta, rows, index, action, target, payload)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 逐级流转的拒绝说明：区分跳级、倒序与完成后回退，让人知道卡在哪一步。
function orderViolation(meta: ModuleMeta, current: string, source: string, action: string): string {
  const currentIndex = meta.statuses.indexOf(current)
  const sourceIndex = meta.statuses.indexOf(source)
  if (currentIndex > sourceIndex) {
    return `${meta.entity}已流转到「${current}」，不允许倒序或回退执行「${action}」`
  }
  return `${meta.entity}当前为「${current}」，不允许跳级执行「${action}」，请先推进到「${source}」`
}

// 管道清洗的完整流转：待清洗→清洗中→已完成→需复查。
// 开始清洗写实际日期、确认完成写清洗长度，校验不过就停止流转；提交复查时在管道检测生成复核事项，
// 两个模块的写入绑在一起，任何一步失败都回到上一步。
function runPipeCleaningAction(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
  payload: Record<string, string | number>,
): ActionResult {
  const row = rows[index]
  const extra: Record<string, string | number> = {}

  if (action === '开始清洗') {
    const actual = String(payload['实际日期'] ?? today()).trim()
    if (!DATE_PATTERN.test(actual)) {
      return { ok: false, message: `实际日期「${actual}」格式应为 YYYY-MM-DD，已停止流转` }
    }
    const plan = String(row['计划日期'] ?? '')
    if (DATE_PATTERN.test(plan) && actual < plan) {
      return { ok: false, message: `实际日期 ${actual} 早于计划日期 ${plan}，已停止流转` }
    }
    extra['实际日期'] = actual
  }

  if (action === '确认完成') {
    const length = Number(payload['清洗长度'])
    if (!Number.isFinite(length) || length <= 0) {
      return { ok: false, message: `清洗长度「${payload['清洗长度'] ?? ''}」不是有效正数，已停止流转` }
    }
    const segmentCode = String(row['清洗管段'] ?? '')
    const segment = listRows('drain_network').find((item) => String(item['管段编号']) === segmentCode)
    if (!segment) {
      return { ok: false, message: `清洗管段 ${segmentCode} 未在排水管网登记，无法核验长度范围，已停止流转` }
    }
    const limit = Number(segment['管段长度'])
    if (Number.isFinite(limit) && length > limit) {
      return { ok: false, message: `清洗长度 ${length} 米超出管段 ${segmentCode} 范围（${limit} 米），已停止流转` }
    }
    extra['清洗长度'] = length
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...row,
    ...extra,
    'status': target,
    '清洗状态': target,
    'pending': target !== lastStatus,
    'abnormal': false,
  }
  const nextRows = [...rows]
  nextRows[index] = updated

  if (action !== '提交复查') {
    try {
      saveRows(meta.key, nextRows)
    } catch (error) {
      return { ok: false, message: `写入失败，状态与记录已回到上一步：${errorMessage(error)}` }
    }
    return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
  }

  // 提交复查：先生成管道检测复核事项，再推进本记录；任一写入失败，两边一起回到上一步。
  const detectRows = listRows('pipe_detect')
  const recheckCode = `RE-${String(row['清洗编号'] ?? row.id)}`
  const alreadyCreated = detectRows.some((item) => String(item['检测编号']) === recheckCode)
  const recheck: EntryRow = {
    'id': nextId(detectRows),
    'status': '待检测',
    'pending': true,
    'abnormal': false,
    '检测编号': recheckCode,
    '检测管段': String(row['清洗管段'] ?? ''),
    '检测方式': '清洗复查',
    '检测设备': '待安排',
    '检测日期': today(),
    '检测长度': row['清洗长度'] ?? '',
    '检测结果': `管道清洗 ${String(row['清洗编号'] ?? '')} 复查`,
    '检测状态': '待检测',
  }
  try {
    if (!alreadyCreated) {
      saveRows('pipe_detect', [...detectRows, recheck])
    }
    saveRows(meta.key, nextRows)
  } catch (error) {
    saveRows('pipe_detect', detectRows)
    saveRows(meta.key, rows)
    return { ok: false, message: `部分写入失败，状态与记录已回到上一步：${errorMessage(error)}` }
  }
  const suffix = alreadyCreated ? '（复核事项已存在，不重复生成）' : '，管道检测已生成复核事项'
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
