// 打包入口：注入 localStorage mock 后执行流转断言。
import { runCleaningAction, createCleaningPlan, listRecheckItems, segmentLength } from '../src/api/cleaning-flow'
import { listRows, resetRows } from '../src/data/local-store'
import { SEED_ROWS } from '../src/data/seed'

// ---- localStorage mock：带「写满」开关模拟部分写入失败 ----
const storeMap = new Map<string, string>()
let failNextWrite = false
;(globalThis as any).window = {
  localStorage: {
    getItem: (key: string) => (storeMap.has(key) ? storeMap.get(key)! : null),
    setItem: (key: string, value: string) => {
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('QuotaExceededError: 模拟落盘失败')
      }
      storeMap.set(key, value)
    },
  },
}

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`)
  }
}

function ok(name: string, result: { ok: boolean; message: string }, expectOk: boolean) {
  check(`${name}（${result.message}）`, result.ok === expectOk)
}

// 直接重置内存：清掉缓存最简单方式是重置全部模块键
function fullReset() {
  storeMap.clear()
  for (const key of Object.keys(SEED_ROWS)) {
    resetRows(key)
  }
}

console.log('\n[1] 正常流转：待清洗 → 清洗中 → 已完成 → 需复查，并生成复核事项')
fullReset()
const seg4 = segmentLength('DRAI-0004')
check('DRAI-0004 管段长度为 80 米', seg4 === 80, String(seg4))

// id=1 待清洗，计划 2026-10-10；用实际日期 2026-10-11 开始
ok('合法开始清洗', runCleaningAction(1, '开始清洗', { 实际日期: '2026-10-11' }), true)
check('开始后状态=清洗中', String(listRows('pipe_cleaning')[0].status) === '清洗中')
check('实际日期已写入', String(listRows('pipe_cleaning')[0]['实际日期']) === '2026-10-11')

// 用 80 米（=管段长度）确认完成
ok('合法确认完成（长度=80）', runCleaningAction(1, '确认完成', { 清洗长度: 80 }), true)
check('完成后状态=已完成', String(listRows('pipe_cleaning')[0].status) === '已完成')
check('清洗长度已写入', Number(listRows('pipe_cleaning')[0]['清洗长度']) === 80)

ok('合法提交复查', runCleaningAction(1, '提交复查'), true)
check('复查后状态=需复查', String(listRows('pipe_cleaning')[0].status) === '需复查')
check('pending 置为 false', listRows('pipe_cleaning')[0].pending === false)
const rechecks = listRecheckItems()
const mine = rechecks.filter((r) => Number(r['清洗记录ID']) === 1)
check('管道检测页生成 1 条复核事项', mine.length === 1, String(mine.length))
check('复核事项编号为 REV-CLEAN-0001', String(mine[0]?.['检测编号']) === 'REV-CLEAN-0001')
check('复核事项状态=待检测', String(mine[0]?.status) === '待检测')

console.log('\n[2] 重复操作只推进一次')
ok('再次开始清洗（重复）被拒', runCleaningAction(1, '开始清洗', { 实际日期: '2026-10-12' }), false)
ok('再次确认完成（重复）被拒', runCleaningAction(1, '确认完成', { 清洗长度: 50 }), false)
ok('再次提交复查（重复）被拒', runCleaningAction(1, '提交复查'), false)
check('复核事项仍只有 1 条', listRecheckItems().filter((r) => Number(r['清洗记录ID']) === 1).length === 1)

console.log('\n[3] 跳级被拒绝')
fullReset()
// id=1 待清洗，直接确认完成（跳过清洗中）
ok('待清洗直接确认完成=跳级拒绝', runCleaningAction(1, '确认完成', { 清洗长度: 50 }), false)
ok('待清洗直接提交复查=跳级拒绝', runCleaningAction(1, '提交复查'), false)
check('记录仍为待清洗', String(listRows('pipe_cleaning')[0].status) === '待清洗')

console.log('\n[4] 倒序 / 完成后回退被拒绝')
// id=3 已完成，执行开始清洗属于倒序
ok('已完成执行开始清洗=倒序拒绝', runCleaningAction(3, '开始清洗', { 实际日期: '2026-10-01' }), false)
// id=4 需复查（终态），任何动作拒绝
ok('需复查执行确认完成=终态拒绝', runCleaningAction(4, '确认完成', { 清洗长度: 10 }), false)
ok('需复查执行开始清洗=终态拒绝', runCleaningAction(4, '开始清洗', { 实际日期: '2026-10-01' }), false)
check('需复查记录状态未变', String(listRows('pipe_cleaning')[3].status) === '需复查')

console.log('\n[5] 实际日期早于计划日期，停止流转')
fullReset()
// id=1 计划 2026-10-10
ok('实际日期早于计划被拒', runCleaningAction(1, '开始清洗', { 实际日期: '2026-10-09' }), false)
check('停在待清洗', String(listRows('pipe_cleaning')[0].status) === '待清洗')
ok('实际日期非法被拒', runCleaningAction(1, '开始清洗', { 实际日期: '2026/10/11' }), false)
ok('实际日期为空被拒', runCleaningAction(1, '开始清洗', { 实际日期: '' }), false)
ok('实际日期与计划同日允许', runCleaningAction(1, '开始清洗', { 实际日期: '2026-10-10' }), true)

console.log('\n[6] 长度超出管段范围，停止流转')
fullReset()
// id=2 清洗中，管段 DRAI-0001 长度 120
ok('长度为负数被拒', runCleaningAction(2, '确认完成', { 清洗长度: -5 }), false)
ok('长度 121 > 120 被拒', runCleaningAction(2, '确认完成', { 清洗长度: 121 }), false)
check('停在清洗中', String(listRows('pipe_cleaning')[1].status) === '清洗中')
check('长度未写入', String(listRows('pipe_cleaning')[1]['清洗长度']) === '')
ok('长度 120 边界允许', runCleaningAction(2, '确认完成', { 清洗长度: 120 }), true)
// 换个待清洗记录做非数字校验
fullReset()
runCleaningAction(2, '开始清洗', { 实际日期: '2026-10-03' })
ok('长度非数字被拒', runCleaningAction(2, '确认完成', { 清洗长度: 'abc' }), false)
ok('长度为 0 被拒', runCleaningAction(2, '确认完成', { 清洗长度: 0 }), false)

console.log('\n[7] 部分写入失败：状态与复核事项一起回到上一步')
fullReset()
runCleaningAction(2, '开始清洗', { 实际日期: '2026-10-03' })
runCleaningAction(2, '确认完成', { 清洗长度: 100 })
const beforeStatus = String(listRows('pipe_cleaning')[1].status)
const beforeDetectCount = listRows('pipe_detect').length
check('前置条件：已完成', beforeStatus === '已完成', beforeStatus)
failNextWrite = true // 让下一次 localStorage.setItem 抛错
const rollbackResult = runCleaningAction(2, '提交复查')
ok('提交复查写入失败返回失败', rollbackResult, false)
check('清洗状态回到已完成', String(listRows('pipe_cleaning')[1].status) === '已完成')
check('检测页未留下半成品复核事项', listRows('pipe_detect').length === beforeDetectCount)
check('内存中也没有该记录的复核事项', listRecheckItems().filter((r) => Number(r['清洗记录ID']) === 2).length === 0)
// 之后可以正常重试
ok('回滚后重试成功', runCleaningAction(2, '提交复查'), true)
check('重试后复核事项生成', listRecheckItems().some((r) => Number(r['清洗记录ID']) === 2))

console.log('\n[8] 登记清洗计划校验')
fullReset()
ok('未知管段登记被拒', createCleaningPlan({ 清洗管段: 'DRAI-9999', 清洗方式: '高压水射流', 清洗设备: 'X', 计划日期: '2026-10-20' }), false)
ok('空管段登记被拒', createCleaningPlan({ 清洗管段: '  ', 清洗方式: 'x', 清洗设备: 'x', 计划日期: '2026-10-20' }), false)
ok('空清洗方式被拒', createCleaningPlan({ 清洗管段: 'DRAI-0001', 清洗方式: '', 清洗设备: 'x', 计划日期: '2026-10-20' }), false)
ok('非法计划日期被拒', createCleaningPlan({ 清洗管段: 'DRAI-0001', 清洗方式: '高压水射流', 清洗设备: 'x', 计划日期: '10/20' }), false)
const beforeCreate = listRows('pipe_cleaning').length
ok('合法计划登记成功', createCleaningPlan({ 清洗管段: 'DRAI-0005', 清洗方式: '机械清通', 清洗设备: 'JC-09', 计划日期: '2026-10-20' }), true)
const created = listRows('pipe_cleaning')[listRows('pipe_cleaning').length - 1]
check('新增 1 条记录', listRows('pipe_cleaning').length === beforeCreate + 1)
check('新计划状态=待清洗', String(created.status) === '待清洗')
check('新计划编号自增 CLEAN-0005', String(created['清洗编号']) === 'CLEAN-0005', String(created['清洗编号']))
check('新计划实际日期为空', String(created['实际日期']) === '')

console.log('\n[9] 未知动作 / 未知记录')
ok('未知动作被拒', runCleaningAction(1, '安排清洗', {}), false)
ok('未知记录被拒', runCleaningAction(99999, '开始清洗', {}), false)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  process.exit(1)
}
