import { commitGroups, listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 管道清洗：待清洗 → 清洗中 → 已完成 → 需复查，只能逐级向前。
// 本服务独立于通用 runAction：跳级、倒序、完成后回退一律拒绝；
// 开始清洗记实际日期（不得早于计划日期），确认完成写清洗长度（不得超出管段范围）；
// 进入需复查时在管道检测页生成复核事项；跨模块写入走 commitGroups，部分失败整体回滚。

const CLEANING_KEY = 'pipe_cleaning'
const DETECT_KEY = 'pipe_detect'
const DRAIN_KEY = 'drain_network'

const CLEANING_STATUSES = ['待清洗', '清洗中', '已完成', '需复查'] as const

// 动作与目标状态：不设「往回走」的动作，从元数据层面杜绝回退入口。
const NEXT_STATUS: Record<string, (typeof CLEANING_STATUSES)[number]> = {
  开始清洗: '清洗中',
  确认完成: '已完成',
  提交复查: '需复查',
}

export type CleaningActionInput = {
  实际日期?: string
  清洗长度?: number | string
}

export type CleaningPlanInput = {
  清洗管段: string
  清洗方式: string
  清洗设备: string
  计划日期: string
}

const fail = (message: string): ActionResult => ({ ok: false, message })
const succeed = (message: string): ActionResult => ({ ok: true, message })

function parseDate(value: unknown): Date | null {
  const text = String(value ?? '').trim()
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!matched) {
    return null
  }
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  return new Date(year, month - 1, day)
}

function dateText(value: unknown): string {
  return String(value ?? '').trim()
}

// 管段长度以排水管网登记为准，返回 null 表示查不到该管段。
export function segmentLength(segmentCode: string): number | null {
  const code = segmentCode.trim()
  const segment = listRows(DRAIN_KEY).find(
    (row) => String(row['管段编号'] ?? '').trim() === code,
  )
  if (!segment) {
    return null
  }
  const length = Number(segment['管段长度'])
  return Number.isFinite(length) ? length : null
}

export function knownSegmentCodes(): string[] {
  return listRows(DRAIN_KEY)
    .map((row) => String(row['管段编号'] ?? '').trim())
    .filter(Boolean)
}

// 当前状态下唯一允许的下一步动作；已是终态则返回 null。
export function nextCleaningAction(status: string): string | null {
  const index = CLEANING_STATUSES.indexOf(status as (typeof CLEANING_STATUSES)[number])
  if (index < 0 || index >= CLEANING_STATUSES.length - 1) {
    return null
  }
  return Object.keys(NEXT_STATUS)[index]
}

// 管道检测页的清洗复核事项，与普通检测记录通过「事项类型」区分。
export function listRecheckItems(): EntryRow[] {
  return listRows(DETECT_KEY).filter((row) => String(row['事项类型'] ?? '') === '清洗复核')
}

function nextCleaningCode(rows: EntryRow[]): string {
  const maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  return `CLEAN-${String(maxId + 1).padStart(4, '0')}`
}

function nextDetectId(rows: EntryRow[]): number {
  // 复核事项从 1001 起编号，避开普通检测记录的小编号。
  const floor = 1000
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), floor) + 1
}

function buildRecheckItem(row: EntryRow, detectRows: EntryRow[]): EntryRow {
  return {
    id: nextDetectId(detectRows),
    status: '待检测',
    pending: true,
    abnormal: false,
    检测编号: `REV-${String(row['清洗编号'])}`,
    检测管段: row['清洗管段'],
    检测方式: '清洗复核',
    检测设备: String(row['清洗设备'] ?? '—'),
    检测日期: '',
    检测长度: row['清洗长度'],
    检测结果: '待复核',
    检测状态: '待检测',
    事项类型: '清洗复核',
    来源清洗记录: String(row['清洗编号']),
    清洗记录ID: Number(row.id),
  }
}

export function createCleaningPlan(input: CleaningPlanInput): ActionResult {
  const segment = input.清洗管段.trim()
  const method = input.清洗方式.trim()
  const equipment = input.清洗设备.trim()
  const planDate = dateText(input.计划日期)

  if (!segment) {
    return fail('登记失败：清洗管段不能为空')
  }
  if (segmentLength(segment) === null) {
    return fail(`登记失败：排水管网中查不到管段「${segment}」，无法核定清洗长度范围`)
  }
  if (!method) {
    return fail('登记失败：清洗方式不能为空')
  }
  if (!parseDate(planDate)) {
    return fail('登记失败：计划日期需为合法日期，格式 YYYY-MM-DD')
  }

  const rows = listRows(CLEANING_KEY)
  const code = nextCleaningCode(rows)
  const row: EntryRow = {
    id: rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1,
    status: '待清洗',
    pending: true,
    abnormal: false,
    清洗编号: code,
    清洗管段: segment,
    清洗方式: method,
    清洗设备: equipment || '—',
    计划日期: planDate,
    实际日期: '',
    清洗长度: '',
    清洗状态: '待清洗',
  }

  try {
    commitGroups({ [CLEANING_KEY]: [...rows, row] })
  } catch {
    return fail('登记失败：数据写入失败，计划未保存（已回滚到上一步）')
  }
  return succeed(`清洗计划 ${code} 已登记，当前状态「待清洗」`)
}

export function runCleaningAction(
  id: number,
  action: string,
  payload: CleaningActionInput = {},
): ActionResult {
  const target = NEXT_STATUS[action]
  if (!target) {
    return fail(`管道清洗记录没有登记「${action}」这个动作`)
  }

  const rows = listRows(CLEANING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的管道清洗记录`)
  }
  const current = String(rows[index].status)
  const currentIndex = CLEANING_STATUSES.indexOf(current as (typeof CLEANING_STATUSES)[number])
  const targetIndex = CLEANING_STATUSES.indexOf(target)

  // 同一记录重复操作只推进一次：已在目标态直接拒绝。
  if (current === target) {
    return fail(`该记录已经是「${target}」，${action}只推进一次，请勿重复操作`)
  }
  if (currentIndex < 0) {
    return fail(`该记录当前状态「${current}」不在清洗流转链上，禁止执行${action}`)
  }
  // 终态（需复查）不允许任何继续推进。
  if (currentIndex >= CLEANING_STATUSES.length - 1) {
    return fail(`该记录已到「${current}」终态，不能再执行${action}`)
  }
  // 只能从紧邻的上一级进入目标态：跳级与倒序都在这里被挡住。
  if (currentIndex < targetIndex - 1) {
    return fail(
      `禁止跳级流转：「${current}」不能直接${action}到「${target}」，请先执行「${nextCleaningAction(current) ?? ''}」`,
    )
  }
  if (currentIndex > targetIndex) {
    return fail(`禁止倒序流转：清洗记录只能逐级向前，不能从「${current}」回退到「${target}」`)
  }

  const source = rows[index]
  const updated: EntryRow = { ...source, status: target, abnormal: false }

  // 业务校验全部在落盘之前完成，不通过就停在原状态。
  if (action === '开始清洗') {
    const actualDate = dateText(payload.实际日期)
    if (!actualDate) {
      return fail('开始清洗被拒绝：必须记录实际开工日期')
    }
    const actual = parseDate(actualDate)
    if (!actual) {
      return fail(`开始清洗被拒绝：实际日期「${actualDate}」不是合法日期（YYYY-MM-DD）`)
    }
    const planned = parseDate(String(source['计划日期']))
    if (planned && actual.getTime() < planned.getTime()) {
      return fail(
        `开始清洗被拒绝：实际日期 ${actualDate} 早于计划日期 ${dateText(source['计划日期'])}，记录保持「${current}」`,
      )
    }
    updated['实际日期'] = actualDate
  }

  if (action === '确认完成') {
    const raw = payload.清洗长度
    const length = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
    if (!Number.isFinite(length) || String(raw ?? '').trim() === '') {
      return fail(`确认完成被拒绝：清洗长度「${String(raw ?? '')}」不是有效数字`)
    }
    if (length <= 0) {
      return fail(`确认完成被拒绝：清洗长度必须大于 0（输入：${length}）`)
    }
    const segmentCode = String(source['清洗管段'] ?? '').trim()
    const limit = segmentLength(segmentCode)
    if (limit === null) {
      return fail(
        `确认完成被拒绝：排水管网中查不到管段「${segmentCode}」，无法核定长度范围，记录保持「${current}」`,
      )
    }
    if (length > limit) {
      return fail(
        `确认完成被拒绝：清洗长度 ${length} 米超出管段 ${segmentCode} 的长度范围（${limit} 米），记录保持「${current}」`,
      )
    }
    updated['清洗长度'] = length
  }

  // 需复查不是待办终点之前的挂起态：终态 pending 置 false。
  updated.pending = target !== '需复查'
  updated['清洗状态'] = target

  const nextRows = [...rows]
  nextRows[index] = updated

  try {
    if (target === '需复查') {
      // 进入需复查：在管道检测页生成复核事项。
      // 同一清洗记录只生成一条（状态机已挡住重复提交，这里再按来源 ID 去重兜底）。
      const detectRows = listRows(DETECT_KEY)
      const already = detectRows.some(
        (row) =>
          String(row['事项类型'] ?? '') === '清洗复核' &&
          Number(row['清洗记录ID']) === Number(source.id),
      )
      if (already) {
        // 复核事项已存在时，只推进清洗状态，不重复生成事项。
        commitGroups({ [CLEANING_KEY]: nextRows })
      } else {
        const recheck = buildRecheckItem(updated, detectRows)
        // 两组记录一次提交：复核事项写入失败时，清洗状态也回到「已完成」。
        commitGroups({ [CLEANING_KEY]: nextRows, [DETECT_KEY]: [...detectRows, recheck] })
      }
    } else {
      commitGroups({ [CLEANING_KEY]: nextRows })
    }
  } catch {
    // 任何部分写入失败：状态与记录一起回到上一步（commitGroups 已恢复存储快照）。
    return fail(
      `${action}失败：复核事项或状态写入时出错，已整体回滚，记录保持「${current}」`,
    )
  }

  const extra =
    action === '开始清洗'
      ? `，实际日期已记录为 ${updated['实际日期']}`
      : action === '确认完成'
        ? `，清洗长度已登记为 ${updated['清洗长度']} 米`
        : '，管道检测页已生成对应复核事项'
  return succeed(`管道清洗记录 ${String(source['清洗编号'])} 已${action}，当前状态「${target}」${extra}`)
}
