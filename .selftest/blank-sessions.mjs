/**
 * 空白会话过滤：DSH 建了没发过消息的会话（blank=true / turns=0 且无标题）
 * 会被 sessionController.list() 返回，但侧栏不显示。QQ 菜单必须滤掉，
 * 否则会冒出一堆同名幽灵对话。
 */
import { isBlankRow } from '../lib/sessions.js'

let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}`)
  if (!ok) failures++
}

check('宿主标 blank=true → 过滤',
  isBlankRow({ sessionId: 's1', projectionValues: { sessionListMetadata: { blank: true } } }) === true)

check('投影是 {val:{blank}} 包装 → 过滤',
  isBlankRow({ sessionId: 's2', projectionValues: { sessionListMetadata: { val: { blank: true } } } }) === true)

check('turns=0 且无标题 → 过滤',
  isBlankRow({
    sessionId: 's3',
    projectionValues: { sessionStats: { val: { turns: 0 } }, title: { val: '' } },
  }) === true)

check('turns=0 但有标题 → 保留',
  isBlankRow({
    sessionId: 's4',
    projectionValues: { sessionStats: { val: { turns: 0 } }, title: '朝堂小吏' },
  }) === false)

check('turns>0 无标题 → 保留',
  isBlankRow({ sessionId: 's5', projectionValues: { sessionStats: { val: { turns: 3 } } } }) === false)

check('正在跑的会话 → 保留（哪怕 turns 还是 0）',
  isBlankRow({ sessionId: 's6', running: true, projectionValues: { sessionStats: { val: { turns: 0 } } } }) === false)

check('普通会话 → 保留',
  isBlankRow({ sessionId: 's7', projectionValues: { sessionListMetadata: { blank: false } } }) === false)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
