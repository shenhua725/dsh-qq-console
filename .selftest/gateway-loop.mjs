/**
 * 连接循环回归测试。
 *
 * 旧版 connectOnce() 在「握手成功」时就返回，外层 while 立刻再取一次
 * /gateway 并叠开新连接；被平台限流（100017）后每次成功又把退避重置回
 * 1 秒，于是永远恢复不了。这里用假的 connectOnce 验证：
 *   1. 连接结束后才进入下一轮（不会空转）
 *   2. 100017 至少退避 60 秒（带 0.85~1.15 抖动）
 */
import { QqGateway } from '../lib/gateway.js'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeGateway() {
  const logs = []
  const gw = new QqGateway({
    appId: 'test-app',
    secret: 'test-secret',
    logger: { info() {}, warn() {}, error() {} },
    store: { log: (m) => logs.push(m) },
  })
  return { gw, logs }
}

// [1] 快速断线不应该空转
{
  const { gw } = makeGateway()
  let calls = 0
  gw.connectOnce = async () => {
    calls++
    await sleep(5)
  }
  gw.start()
  await sleep(2600)
  gw.stop()
  check('2.6 秒内只重连 2-3 次（修复前是几百次）', calls >= 2 && calls <= 4, `calls=${calls}`)
}

// [2] 100017 至少退避 60 秒
{
  const { gw, logs } = makeGateway()
  gw.connectOnce = async () => {
    throw new Error('取网关地址失败：HTTP 400 {"code":100017,"message":"接口调用超过频率限制"}')
  }
  gw.start()
  await sleep(300)
  gw.stop()
  const line = logs.find((m) => m.includes('100017')) ?? ''
  const seconds = Number((/；([\d.]+) 秒后重试/.exec(line) ?? [])[1] ?? 0)
  check('100017 首次退避 ≥ 51 秒', seconds >= 51, `wait=${seconds}s`)
}

// [3] 正常断开后仍能重连
{
  const { gw } = makeGateway()
  let calls = 0
  gw.connectOnce = async () => {
    calls++
    await sleep(5)
  }
  gw.start()
  gw.start() // 重复 start 不应叠加循环
  await sleep(1200)
  gw.stop()
  check('重复 start() 不会叠加连接循环', calls <= 3, `calls=${calls}`)
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
