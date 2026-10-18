/**
 * DSH QQ 控制台 2.0 · 业务层。
 *
 * 口径与 Codex 版 QQ 控制台一致：
 *   1. 普通消息 → 绑定会话；只有「控制台 <文字>」→ 控制台会话
 *   2. 收到任务先回「任务确认」，之后按会话级汇报方式推进度，结束推结果
 *   3. 对话状态固定 8 行；排队最多显示 5 条，每条带「引导 n」「取消 n」
 *   4. 对话 = 对话状态 / 排队执行 / 打断重发 / 退回编辑 / 删除取消
 *   5. 设置 = 实时进度 / 当前进度 / 1分钟汇报 / 5分钟汇报 / 只要结果
 *   6. 更多 = 当前对话 / 全部对话 / 项目 / 会话操作 / 面板
 *   7. 非闲时（工作日高峰、闲时尾段）不外派，进闲时队列，到点自动放行
 */

import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

import {
  Sessions, sleep, baseName, archivedSessionIds, isSubagent,
} from './sessions.js'
import { fit, fitUniq } from './menu.js'

const EFFORT_LABEL = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
  off: '关闭',
  none: '关闭',
  '': '默认',
}

/** 从低到高的展示顺序；“关闭”和“默认（跟随模型）”是特殊档，排在标尺之后。 */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const REPORT_MODES = {
  live: { label: '实时进度', every: 10 },
  min1: { label: '1分钟汇报', every: 60 },
  min5: { label: '5分钟汇报', every: 300 },
  result: { label: '只要结果', every: null },
}

const PERMISSION_LABEL = {
  'read-only': '只读（最低）',
  'workspace-write': '可写工作区（中）',
  'danger-full-access': '完全访问（最高）',
  full: '完全访问（最高）',
  'allow-all': '完全访问（最高）',
  auto: '自动（由系统判断）',
  '': '默认',
}

const PERMISSION_ORDER = [
  'read-only', 'workspace-write', 'danger-full-access', 'full', 'allow-all', 'auto',
]

const IMAGE_EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}

/** DSH 会话附件只接受这四种 image/*，其余格式必须落盘交路径。 */
const SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

function valueText(value) {
  return String(value ?? '').trim()
}

function firstText(...values) {
  for (const value of values) {
    const text = valueText(value)
    if (text) return text
  }
  return ''
}

function modelLabel(model) {
  return valueText(model?.full) ||
    valueText(model?.name) ||
    valueText(model?.model) ||
    '未命名模型'
}

function modelMeta(model) {
  return [valueText(model?.provider), valueText(model?.model)].filter(Boolean).join(' · ')
}

function modelSelectLabel(model, list) {
  const base = modelLabel(model)
  const sameName = (Array.isArray(list) ? list : [])
    .filter((item) => modelLabel(item) === base)
  if (sameName.length <= 1) return base
  return `${base} · ${valueText(model?.model)}`
}

function choiceText(value) {
  return String(value ?? '').trim()
    .replace(/^[「『“"']+/, '')
    .replace(/[」』”"']+$/, '')
    .trim()
}

function sameModel(a, b) {
  const ap = valueText(a?.provider)
  const bp = valueText(b?.provider)
  const am = valueText(a?.model)
  const bm = valueText(b?.model)
  if (!am || am !== bm) return false
  return !ap || !bp || ap === bp
}

function effortText(effort, { forChoice = false } = {}) {
  const id = valueText(effort)
  if (!id) return forChoice ? '默认（跟随模型）' : '默认'
  if (id === 'off' || id === 'none') return '强度0（关闭）'
  return EFFORT_LABEL[id] ?? id
}

function effortChoiceText(effort) {
  return effortText(effort, { forChoice: true })
}

function effortAliases(effort) {
  const id = valueText(effort)
  const out = new Set([id])
  if (!id) {
    out.add('默认')
    out.add('默认（跟随模型）')
    out.add('跟随模型')
    return out
  }
  if (id === 'off' || id === 'none') {
    for (const alias of ['强度0', '强度0（关闭）', '关闭', 'off', 'none']) out.add(alias)
    return out
  }
  const label = EFFORT_LABEL[id]
  if (label) {
    out.add(label)
    out.add(`强度${label}`)
    out.add(`强度 ${label}`)
  }
  return out
}

function effortChoiceMatches(effort, text) {
  return effortAliases(effort).has(choiceText(text))
}

/**
 * 会话偏好里显式的 `effort`（包括空串＝默认）优先；没有这个字段时，
 * 才回退会话事件或模型自带的预设强度。避免「当前：默认」和列表里
 * 「强度 关闭」同时出现。
 */
function selectedEffort(pref, model, configured = null) {
  if (pref && Object.hasOwn(pref, 'effort')) return valueText(pref.effort)
  return firstText(
    model?.reasoningEffort,
    model?.effort,
    configured?.effort,
    configured?.efforts?.[0],
  )
}

function sortEfforts(list, { descending = false } = {}) {
  const rank = (value) => {
    const id = valueText(value)
    const index = EFFORT_ORDER.indexOf(id)
    if (index >= 0) return descending ? EFFORT_ORDER.length - 1 - index : index
    if (id === 'off' || id === 'none') return EFFORT_ORDER.length
    if (!id) return EFFORT_ORDER.length + 2
    return EFFORT_ORDER.length + 1
  }
  const unique = [...new Set((Array.isArray(list) ? list : []).map(valueText))]
  return unique
    .map((value, index) => ({ value, index }))
    .sort((a, b) => rank(a.value) - rank(b.value) || a.index - b.index)
    .map((row) => row.value)
}

function permissionId(option) {
  return valueText(option?.preset ?? option?.id ?? option?.value)
}

function permissionText(id, fallback = '') {
  const key = valueText(id)
  if (!key) return fallback || '默认'
  return PERMISSION_LABEL[key] ?? (fallback || key)
}

function sortPermissions(options) {
  const rank = (id) => {
    const index = PERMISSION_ORDER.indexOf(id)
    return index >= 0 ? index : PERMISSION_ORDER.length
  }
  return (Array.isArray(options) ? options : [])
    .map((option, index) => ({ option, index, id: permissionId(option) }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.index - b.index)
    .map((row) => row.option)
}

function declaredImageMime(value) {
  const clean = String(value ?? '').split(';')[0].trim().toLowerCase()
  return /^image\/[a-z0-9.+-]+$/.test(clean) ? clean : ''
}

/** 按文件魔数识别图片格式；识别不了返回空串。 */
export function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf)) return ''
  const b = buf

  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'image/png'
  if (b.length >= 6) {
    const head = b.subarray(0, 6).toString('latin1')
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (b.length >= 12) {
    const riff = b.subarray(0, 4).toString('latin1')
    const webp = b.subarray(8, 12).toString('latin1')
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
    if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
      const brand = b.subarray(8, 12).toString('latin1').toLowerCase()
      if (brand === 'avif' || brand === 'avis') return 'image/avif'
      if (['heic', 'heix', 'heif', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
    }
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
  ) return 'image/tiff'
  return ''
}

/**
 * 图片 MIME 判定：魔数 > 声明类型 > 扩展名。
 * QQ 回调经常不带 content_type，不能默认当 PNG——JPEG 冒充 PNG 会让
 * 下游解码/预览失败，所以宁可多读一次魔数。
 */
export function imageMimeFor(buf, declared, name = '') {
  const magic = sniffImageMime(buf)
  if (magic) return magic
  const fromDeclared = declaredImageMime(declared)
  if (fromDeclared) return fromDeclared
  return IMAGE_EXT_MIME[path.extname(String(name ?? '')).toLowerCase()] ?? ''
}

const WORKFLOW =
  '\n\n——流程要求（来自 QQ 控制台）：先回一句「任务确认」再做；' +
  '执行期间每完成一个阶段性进展就用一句话简述；全部做完后给出结果摘要。'

const HELP = `DSH QQ 控制台 2.0 · 指令

导航
  菜单 / 项目 / 会话 / 当前 / 对话状态 / 进度 / 排队
  进入 <序号|标题|会话ID>    绑定会话
  改名 <文字>                给当前会话改名
  归档                       查看已归档（不能执行）

投递
  <任意文字>        投到绑定会话
  控制台 <文字>     投到控制台会话（也可以用「. <文字>」）
  引导 <文字>       运行中插入这一条，按它改向

对话
  对话状态 / 排队执行 / 打断重发 / 退回编辑 / 删除取消
  引导 n / 取消 n   针对排队第 n 条

设置
  实时进度 / 当前进度 / 1分钟汇报 / 5分钟汇报 / 只要结果

模型与权限
  模型 / 选择 / 强度 / 权限

其它
  刷新菜单 / 面板 / 隐藏列表 / 退出`

function nowText(ts = Date.now()) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function duration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}秒`
  if (sec < 3600) return `${Math.floor(sec / 60)}分`
  return `${Math.floor(sec / 3600)}小时${Math.floor((sec % 3600) / 60)}分`
}

function short(text, n = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 会话入口显示 8 位短 ID，避免整条 UUID 占满手机屏幕；enter() 支持短 ID 匹配。 */
function shortSessionId(id) {
  const s = String(id ?? '')
  const m = /^session-([0-9a-f-]{6,})$/i.exec(s)
  if (m) return m[1].split('-')[0].slice(0, 8)
  return s.length > 8 ? s.slice(0, 8) : s
}

/** 北京时间（UTC+8）闲时判定。周末全天可跑；法定节假日由用户在配置里视为周末。 */
function idleState(now = Date.now()) {
  const d = new Date(now + 8 * 3600_000)
  const day = d.getUTCDay()
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes()
  if (day === 0 || day === 6) return { ok: true, reason: '周末', next: '' }
  if (mins < 8 * 60 + 30) return { ok: true, reason: '早间闲时', next: '' }
  if (mins < 9 * 60) return { ok: false, reason: '闲时尾段 8:30-9:00', next: '09:00' }
  if (mins < 12 * 60) return { ok: false, reason: '工作日高峰 9:00-12:00', next: '12:00' }
  if (mins < 13 * 60 + 30) return { ok: true, reason: '午间闲时', next: '' }
  if (mins < 14 * 60) return { ok: false, reason: '闲时尾段 13:30-14:00', next: '14:00' }
  if (mins < 18 * 60) return { ok: false, reason: '工作日高峰 14:00-18:00', next: '18:00' }
  return { ok: true, reason: '晚间闲时', next: '' }
}

let deferredSeq = 0

export class QqConsole {
  constructor({ ctx, store, logger, config, sessions }) {
    this.ctx = ctx
    this.store = store
    this.logger = logger
    this.config = config
    this.sessions = sessions ?? new Sessions(ctx, logger)
    this.gateway = null
    this.menu = null
    this.watchTimer = null
    this.seqMap = new Map()
    this.ticking = false
  }

  attach(gateway) { this.gateway = gateway }
  attachMenu(menu) { this.menu = menu }

  startWatchdog() {
    this.stopWatchdog()
    const every = Math.max(5_000, Math.min(Number(this.config.progressEvery) || 10, 60) * 1000)
    this.watchTimer = setInterval(() => {
      this.tick().catch((err) => this.logger?.warn?.('[qq-console-v2] tick 异常：%s', err?.message ?? err))
    }, every)
    this.watchTimer.unref?.()
  }

  stopWatchdog() {
    clearInterval(this.watchTimer)
    this.watchTimer = null
  }

  log(msg) {
    this.store?.log?.(msg)
    this.logger?.info?.('[qq-console-v2] %s', msg)
  }

  // ---------------- 发送 ----------------

  nextSeq(openid, msgId) {
    const key = `${openid}:${msgId}`
    const n = (this.seqMap.get(key) ?? 0) + 1
    this.seqMap.set(key, n)
    // msg_id 只在 5 分钟被动窗口内有意义，顺手清掉旧键，避免无限增长。
    if (this.seqMap.size > 80) {
      const oldest = this.seqMap.keys().next().value
      this.seqMap.delete(oldest)
    }
    return n
  }

  async send(openid, text, opts = {}) {
    if (!this.gateway) return false
    const rows = opts.rows ?? []
    // 控制命令（项目/进入/模型…）以前不带 msg_id，QQ 会把回执当成主动消息，
    // 过了被动窗口就稳定回 40011000「请求数据异常」。这里统一回退到最近
    // 260 秒内的 msg_id，让所有回执都走被动回复；没有新鲜 msg_id 时才主动发。
    const msgId = opts.msgId || this.store?.freshMsgId?.(openid) || ''
    const useMd = opts.md === true || rows.length > 0 || /<qqbot-/.test(String(text))
    const base = useMd
      ? { msg_type: 2, markdown: { content: String(text) } }
      : { msg_type: 0, content: String(text) }
    if (rows.length) base.keyboard = { content: { rows } }
    if (msgId) {
      base.msg_id = msgId
      base.msg_seq = this.nextSeq(openid, msgId)
    }
    const target = `/v2/users/${encodeURIComponent(openid)}/messages`
    try {
      let res = await this.gateway.api(target, 'POST', base)
      if (res.status >= 400 && useMd) {
        this.log(`Markdown 首发被拒 HTTP ${res.status}（rows=${rows.length}，len=${String(text).length}），尝试纯文本兜底`)
        // Markdown 被拒 → 纯文本兜底（去掉行内交互标签）。
        const plain = String(text).replace(/<qqbot-[^>]*\/>/g, '').trim()
        const body = { msg_type: 0, content: plain }
        if (rows.length) body.keyboard = { content: { rows } }
        if (msgId) { body.msg_id = msgId; body.msg_seq = base.msg_seq }
        res = await this.gateway.api(target, 'POST', body)
      }
      if (res.status >= 400 && (useMd || msgId || rows.length)) {
        // 最后兜底：纯文本、不带键盘、不带 msg_id，保证至少能回一句话。
        this.log(`仍被拒 HTTP ${res.status}，最后尝试纯文本主动发送`)
        const plain = String(text).replace(/<qqbot-[^>]*\/>/g, '').trim()
        res = await this.gateway.api(target, 'POST', { msg_type: 0, content: plain })
      }
      if (res.status >= 400) {
        this.log(`发送失败 HTTP ${res.status}：${JSON.stringify(res.body).slice(0, 240)}`)
        return false
      }
      return true
    } catch (err) {
      this.log(`发送异常：${err?.message ?? err}`)
      return false
    }
  }

  async streamSend(openid, content, { index = 0, state = 1, streamId = '', msgId = '' } = {}) {
    if (!this.gateway) return null
    const body = {
      input_mode: 'replace',
      input_state: state,
      index,
      content_type: 'markdown',
      content_raw: String(content),
      msg_seq: msgId ? this.nextSeq(openid, msgId) : 1,
    }
    if (streamId) body.stream_msg_id = streamId
    if (msgId) body.msg_id = msgId
    try {
      const res = await this.gateway.api(`/v2/users/${encodeURIComponent(openid)}/stream_messages`, 'POST', body)
      if (res.status >= 400) return null
      return { id: res.body?.id ?? '', body: res.body }
    } catch {
      return null
    }
  }

  btn(label, text) {
    return {
      buttons: [{
        id: 'b1',
        render_data: { label: String(label).slice(0, 10), style: 1, visited_label: String(label).slice(0, 10) },
        // type=2 的 data 会被客户端**原样当消息发出**，不能带内部前缀。
        action: { type: 2, data: String(text), permission: { type: 2 }, enter: true },
      }],
    }
  }

  cmdEnter(text) {
    return `<qqbot-cmd-enter text="${encodeURIComponent(String(text))}" />`
  }

  cmdInput(text) {
    return `<qqbot-cmd-input text="${encodeURIComponent(String(text))}" show="${encodeURIComponent('编辑并发送')}" reference="false" />`
  }

  // ---------------- 收消息 ----------------

  async onMessage(msg) {
    if (!msg?.openid) return
    this.store.recordTarget(msg.openid, msg.content)
    if (msg.msgId) this.store.recordLastMessage(msg.openid, msg.msgId)
    try {
      await this.handle(msg.openid, msg.content, msg.msgId, msg)
    } catch (err) {
      this.log(`处理失败：${err?.message ?? err}`)
      await this.send(msg.openid, `处理出错：${err?.message ?? err}`)
    }
  }

  async onInteraction(payload, eventId) {
    const openid = payload?.user_openid ?? payload?.data?.resolved?.user_id ?? ''
    const data = String(payload?.data?.button_data ?? '')
    if (eventId && this.gateway) {
      // 平台要求 3 秒内回执，否则手机端一直转圈。
      try { await this.gateway.api(`/interactions/${encodeURIComponent(eventId)}`, 'PUT', { code: 0 }) } catch { /* best effort */ }
    }
    if (!openid || !data) return
    try {
      await this.handleButton(openid, data)
    } catch (err) {
      this.log(`按钮处理失败：${err?.message ?? err}`)
    }
  }

  async handleButton(openid, data) {
    if (data.startsWith('cmd:')) return this.handle(openid, data.slice(4), '')
    if (data.startsWith('bind:')) return this.bindTo(openid, data.slice(5))
    if (data.startsWith('model:')) return this.applyModel(openid, Number(data.slice(6)))
    if (data.startsWith('effort:')) return this.applyEffort(openid, Number(data.slice(7)))
    if (data.startsWith('perm:')) return this.applyPermission(openid, decodeURIComponent(data.slice(5)))
    // type=2 指令按钮的 data 就是用户消息本身。
    return this.handle(openid, data, '')
  }

  // ---------------- 指令路由 ----------------

  async handle(openid, raw, msgId = '', msg = null) {
    const text = String(raw ?? '').trim()
    if (!text) return

    const isConsole = /^(控制台|\.)\s*/i.test(text)
    const body = isConsole ? text.replace(/^(控制台|\.)\s*/i, '') : text
    const simple = body.trim()

    if (!isConsole) {
      const exact = {
        帮助: () => this.send(openid, HELP),
        help: () => this.send(openid, HELP),
        菜单: () => this.viewMenu(openid),
        项目: () => this.viewProjects(openid),
        会话: () => this.viewSessions(openid),
        对话: () => this.viewSessions(openid),
        归档: () => this.viewArchived(openid),
        当前: () => this.viewCurrent(openid),
        对话状态: () => this.viewState(openid),
        状态: () => this.viewState(openid),
        进度: () => this.viewProgress(openid),
        当前进度: () => this.viewProgress(openid),
        排队: () => this.viewQueue(openid),
        模型: () => this.viewModel(openid),
        选择: () => this.pickModelCard(openid),
        强度: () => this.pickEffortCard(openid),
        权限: () => this.pickPermissionCard(openid),
        刷新菜单: () => this.refreshMenu(openid),
        面板: () => this.send(openid, HELP),
        会话操作: () => this.sessionOps(openid),
        汇报: () => this.settingsCard(openid),
        实时进度: () => this.setReport(openid, 'live'),
        '1分钟汇报': () => this.setReport(openid, 'min1'),
        '5分钟汇报': () => this.setReport(openid, 'min5'),
        只要结果: () => this.setReport(openid, 'result'),
        排队执行: () => this.queuePending(openid),
        引导改向: () => this.guidePending(openid),
        打断重发: () => this.breakAndResend(openid),
        打断: () => this.interruptCurrent(openid),
        退回编辑: () => this.returnToEdit(openid),
        删除取消: () => this.cancelAll(openid),
        取消本条: () => this.cancelPendingOnly(openid),
        取消: () => this.cancelAll(openid),
        设为控制台: () => this.setConsoleSession(openid),
        隐藏当前: () => this.hideCurrent(openid),
        隐藏列表: () => this.hiddenList(openid),
        退出: () => this.unbind(openid),
      }
      if (exact[simple]) return exact[simple]()

      // 手机端点「模型全称」或「最高/低/强度0」时，消息正文就是这些词；
      // 只在刚发出选择卡的有效期内拦截，避免把普通任务文本误当选择。
      const picked = await this.trySelectionText(openid, simple)
      if (picked) return

      let m = /^引导\s+(\d{1,2})$/.exec(simple)
      if (m) return this.guideQueued(openid, Number(m[1]))
      m = /^取消\s+(\d{1,2})$/.exec(simple)
      if (m) return this.cancelQueued(openid, Number(m[1]))
      m = /^项目\s+(\d{1,2})(?:\s|[·:：-]|$)/.exec(simple)
      if (m) return this.viewProjects(openid, Number(m[1]))
      m = /^进入\s+(.+)$/.exec(simple)
      if (m) return this.enter(openid, m[1].trim())
      m = /^改名\s+(.+)$/.exec(simple)
      if (m) return this.rename(openid, m[1].trim())
      m = /^模型\s+(\d{1,2})$/.exec(simple)
      if (m) return this.applyModel(openid, Number(m[1]) - 1)
      m = /^强度\s+(\d{1,2}|默认)$/.exec(simple)
      if (m) return this.applyEffortByName(openid, m[1])
      m = /^权限\s+(.+)$/.exec(simple)
      if (m) return this.applyPermission(openid, m[1].trim())
      m = /^取消隐藏\s+([0-9a-zA-Z-]{4,64})$/i.exec(simple)
      if (m) return this.unhide(openid, m[1])
      m = /^引导\s*[:：]?\s*(\S[\s\S]*)$/.exec(simple)
      if (m) return this.steer(openid, m[1].trim())
    }

    return this.submit(openid, body, { consoleRoute: isConsole, msgId, msg })
  }

  // ---------------- 投递 ----------------

  boundId(openid) {
    return this.store.boundSession(openid) || ''
  }

  consoleId(openid) {
    return this.store.consoleSession(openid)?.sessionId ?? ''
  }

  async isBusy(openid, sessionId) {
    if (!sessionId) return null
    const job = this.store.activeJob(openid, sessionId)
    if (job) return { kind: 'job', job }
    const row = await this.sessions.rowFor(sessionId)
    if (row?.running) return { kind: 'row', row }
    return null
  }

  async prepareIncoming(msg) {
    const images = []
    const notes = []
    for (const att of msg?.attachments ?? []) {
      const url = String(att?.url ?? '')
      const declared = String(att?.content_type ?? '')
      const name = String(att?.filename ?? '')
      if (!url) continue
      const looksImage = /^image\//i.test(declared) ||
        Boolean(IMAGE_EXT_MIME[path.extname(name).toLowerCase()])
      try {
        const buf = await this.download(url)
        // 无论是声明成图片还是普通文件，都先用魔数认一遍：
        // QQ 有时把图片当 application/octet-stream 发过来。
        const mime = imageMimeFor(buf, declared, name)
        if (looksImage || mime) {
          if (!mime) {
            notes.push(`（附件 ${name || ''} 看起来是图片，但无法识别格式，未上传）`)
            continue
          }
          if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
            const file = this.saveInbox(name, buf)
            notes.push(`（图片格式 ${mime} 暂不支持直接投递，已存到本机：${file}）`)
            continue
          }
          if (buf.length > 8 * 1024 * 1024) {
            notes.push(`（图片 ${name || ''} 超过 8MB，未上传）`)
            continue
          }
          images.push({
            type: 'image',
            mediaType: mime,
            data: buf.toString('base64'),
            name: name || 'qq-image',
          })
        } else {
          const file = this.saveInbox(name, buf)
          notes.push(`（附件已保存：${file}）`)
        }
      } catch (err) {
        notes.push(`（${looksImage ? '图片' : '附件'}下载失败：${err?.message ?? err}）`)
      }
    }
    return { images, note: notes.length ? `\n\n${notes.join('\n')}` : '' }
  }

  saveInbox(name, buf) {
    const dir = this.store.ensureDir('inbox')
    const safe = String(name || `qq-file-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_')
    const file = path.join(dir, `${Date.now()}-${safe}`)
    fs.writeFileSync(file, buf)
    return file
  }

  download(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 20_000 }, (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > 30 * 1024 * 1024) {
            req.destroy(new Error('附件超过 30MB'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.on('timeout', () => req.destroy(new Error('下载超时')))
      req.on('error', reject)
    })
  }

  async submit(openid, text, { consoleRoute = false, msgId = '', msg = null } = {}) {
    const sessionId = consoleRoute
      ? (this.consoleId(openid) || this.boundId(openid))
      : (this.boundId(openid) || this.consoleId(openid))
    if (!sessionId) {
      return this.send(openid, '还没绑定会话。发「项目」看项目，或发「会话」直接挑一个。')
    }

    const { images, note } = await this.prepareIncoming(msg)
    const fullText = text + note

    const sw = this.store.takeSwitch(openid)
    const busy = await this.isBusy(openid, sessionId)
    if (busy && !sw) {
      this.store.setPending(openid, {
        text: fullText, images, sessionId, at: Date.now(), msgId,
      })
      return this.send(openid, await this.busyCard(openid, sessionId, busy), { msgId, md: true })
    }
    if (sw === 'q' && busy) {
      if (busy.kind === 'job') this.addFollowup(openid, sessionId, fullText, images)
      else this.addDeferred(openid, sessionId, fullText, images)
      return this.send(openid, '⏸ 已排队：等当前任务干完，立刻执行这条。')
    }
    if (sw === 'b' && busy) {
      await this.cancelCurrent(openid, sessionId)
    }
    if (sw === 's' && busy) {
      return this.steerWith(openid, sessionId, fullText, images)
    }

    const idle = idleState()
    if (this.config.idleGate !== false && !idle.ok) {
      this.addDeferred(openid, sessionId, fullText, images)
      const n = this.deferredFor(openid, sessionId).length
      return this.send(openid,
        `⏸ 现在是${idle.reason}，按规则不直接外派。\n这条已进闲时队列（第 ${n} 个），到 ${idle.next} 自动开跑。`)
    }

    return this.deliver(openid, sessionId, fullText, { images, msgId })
  }

  async deliver(openid, sessionId, text, { images = [], msgId = '', mode = 'queue' } = {}) {
    const row = await this.sessions.rowFor(sessionId)
    const name = row ? String(row.title ?? row.displayTitle ?? sessionId.slice(0, 12)) : sessionId.slice(0, 12)
    if (archivedSessionIds().has(String(sessionId))) {
      return this.send(openid, `「${name}」已归档，DSH 不会执行。发「会话」换一个，或在 App 里取消归档。`, { msgId })
    }
    if (row && isSubagent(row)) {
      return this.send(openid, `「${name}」是子会话（执行记录），不能直接投指令。发「会话」换一个。`, { msgId })
    }

    // 默认模型：手机端在「模型」里显式选过的优先，其次是设置页第一项。
    // 以前只有“会话从没选过模型”才落到默认，结果会话一旦有历史就一直用
    // 它自己的模型，QQ 里的回复和设置页写的默认对不上。
    try {
      const pref = this.store.pref(openid, sessionId).model
      const target = pref ?? this.defaultSelection()
      if (target?.provider && target?.model) {
        const existing = await this.sessions.currentModel(sessionId)
        const targetEffort = target.effort ?? target.reasoningEffort ?? ''
        const sameModel = existing
          && String(existing.provider ?? '') === String(target.provider)
          && String(existing.model ?? '') === String(target.model)
        const existingEffort = existing?.reasoningEffort ?? existing?.effort ?? ''
        const same = sameModel && (!targetEffort || String(existingEffort) === String(targetEffort))
        if (!same) {
          const picked = await this.sessions.selectModel(sessionId, {
            provider: target.provider,
            model: target.model,
            effort: targetEffort,
          })
          if (picked?.ok) {
            this.log(`模型已切到默认：${target.model}${targetEffort ? ` / ${targetEffort}` : ''}`)
          }
        }
      }
    } catch { /* 模型选择失败不阻断投递，DSH 会用会话默认 */ }

    const result = await this.sessions.deliver(sessionId, `【QQ 指令】${text}${WORKFLOW}`, { mode, images })
    if (!result.ok) return this.send(openid, result.note, { msgId })

    const report = this.store.report(openid, sessionId)
    const job = {
      id: result.requestId,
      openid,
      sessionId,
      text: short(text, 500),
      at: Date.now(),
      lastReport: Date.now(),
      baselineSeq: result.baselineSeq,
      userSeq: result.userSeq,
      lastSeq: result.userSeq,
      confirmed: false,
      warned: false,
      status: 'running',
      awaitingUserRecord: result.awaitingUserRecord,
      report,
      streamId: '',
      streamIndex: 0,
      liveTail: '',
      followups: [],
    }
    this.store.setJob(openid, sessionId, job)
    this.log(`投递：${name}｜${short(text, 50)}｜${result.requestId.slice(0, 8)}`)

    if (result.doneEarly) {
      this.store.updateJob(openid, sessionId, { status: 'done' })
      return this.send(openid, `✅ 已完成 · ${name}\n\n「${this.cmdEnter('汇报')}」`, { msgId })
    }
    return this.send(openid,
      `📨 已投递到「${name}」。\n任务确认会马上转给你；之后按「${REPORT_MODES[report]?.label ?? '5分钟汇报'}」推进度。\n\n` +
      `「${this.cmdEnter('对话状态')}」\n「${this.cmdEnter('当前进度')}」`,
      { msgId, md: true })
  }

  async steer(openid, text) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const busy = await this.isBusy(openid, sid)
    if (!busy) return this.send(openid, '这个会话现在没在跑任务；直接发文字就是下达指令，不用加「引导」。')
    return this.steerWith(openid, sid, text, [])
  }

  async steerWith(openid, sessionId, text, images) {
    const result = await this.sessions.deliver(sessionId,
      `【运行中插话·立刻改向】${text}\n（说明：用户在你上一轮执行途中插话，请以这条新要求为准，接着往下干。）`,
      { mode: 'steer', images })
    if (!result.ok) return this.send(openid, result.note)
    const job = this.store.job(openid, sessionId)
    if (job && job.status === 'running') {
      this.store.updateJob(openid, sessionId, { lastSeq: result.userSeq, steers: (job.steers ?? 0) + 1 })
    }
    return this.send(openid, '🎯 已插入当前轮，按这条改向。')
  }

  async cancelCurrent(openid, sessionId) {
    const result = await this.sessions.cancel(sessionId)
    const job = this.store.job(openid, sessionId)
    if (job && job.status === 'running') {
      this.store.updateJob(openid, sessionId, { status: 'cancelled', endedAt: Date.now() })
    }
    return result
  }

  async interruptCurrent(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const busy = await this.isBusy(openid, sid)
    if (!busy) return this.send(openid, '当前没有在跑的任务（空闲）。')
    const result = await this.cancelCurrent(openid, sid)
    return this.send(openid, result.ok ? '🛑 已请求中断当前轮。' : result.note)
  }

  // ---------------- 排队 ----------------

  addFollowup(openid, sessionId, text, images = []) {
    const job = this.store.job(openid, sessionId)
    if (!job || job.status !== 'running') return false
    const next = [...(job.followups ?? []), { text, images, at: Date.now(), kind: 'followup' }]
    this.store.updateJob(openid, sessionId, { followups: next })
    return true
  }

  addDeferred(openid, sessionId, text, images = []) {
    const rows = this.store.deferred()
    rows.push({
      id: `${Date.now()}-${++deferredSeq}`,
      openid, sessionId, text, images, at: Date.now(),
    })
    this.store.setDeferred(rows)
  }

  deferredFor(openid, sessionId) {
    return this.store.deferred().filter((r) => r.openid === openid && (!sessionId || r.sessionId === sessionId))
  }

  async queueEntries(openid, sessionId) {
    const out = []
    const pending = this.store.pendingFor(openid)
    if (pending) {
      out.push({ source: 'pending', label: '待选·未排队', text: pending.text, images: pending.images ?? [] })
    }
    const job = this.store.job(openid, sessionId)
    for (const [i, f] of (job?.followups ?? []).entries()) {
      out.push({ source: 'followup', index: i, label: '任务后', text: f.text, images: f.images ?? [] })
    }
    for (const row of this.deferredFor(openid, sessionId)) {
      out.push({ source: 'deferred', id: row.id, label: '闲时', text: row.text, images: row.images ?? [] })
    }
    return out
  }

  removeEntry(openid, sessionId, entry) {
    if (entry.source === 'pending') {
      this.store.setPending(openid, null)
      return
    }
    if (entry.source === 'followup') {
      const job = this.store.job(openid, sessionId)
      if (!job) return
      const next = [...(job.followups ?? [])]
      next.splice(entry.index, 1)
      this.store.updateJob(openid, sessionId, { followups: next })
      return
    }
    if (entry.source === 'deferred') {
      this.store.setDeferred(this.store.deferred().filter((r) => r.id !== entry.id))
    }
  }

  async viewQueue(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const entries = await this.queueEntries(openid, sid)
    if (!entries.length) return this.send(openid, '当前没有排队中的指令。')
    const lines = [`🧾 排队中 · ${entries.length} 条`, '']
    entries.slice(0, 5).forEach((e, i) => {
      lines.push(`${i + 1}. ${short(e.text, 46)}（${e.label}） ${this.cmdEnter(`引导 ${i + 1}`)} ${this.cmdEnter(`取消 ${i + 1}`)}`)
    })
    if (entries.length > 5) lines.push(`…还有 ${entries.length - 5} 条未显示`)
    return this.send(openid, lines.join('\n'), { md: true })
  }

  async queuePending(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const pending = this.store.pendingFor(openid)
    if (!pending) {
      const entries = await this.queueEntries(openid, sid)
      return this.send(openid, entries.length
        ? `已经有 ${entries.length} 条在排队；没有新的「待选」指令。`
        : '没有待发送的指令。先发文字，再选发送方式。')
    }
    const busy = await this.isBusy(openid, sid)
    this.store.setPending(openid, null)
    if (busy) {
      if (busy.kind === 'job') this.addFollowup(openid, sid, pending.text, pending.images ?? [])
      else this.addDeferred(openid, sid, pending.text, pending.images ?? [])
      return this.send(openid, '⏸ 已排队：等当前任务干完，立刻执行这条。')
    }
    const idle = idleState()
    if (this.config.idleGate !== false && !idle.ok) {
      this.addDeferred(openid, sid, pending.text, pending.images ?? [])
      return this.send(openid, `⏸ 现在是${idle.reason}，已进闲时队列，到 ${idle.next} 自动开跑。`)
    }
    return this.deliver(openid, sid, pending.text, { images: pending.images ?? [] })
  }

  async breakAndResend(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const pending = this.store.pendingFor(openid)
    if (!pending) {
      this.store.setSwitch(openid, 'b')
      return this.send(openid, '🛑 已就位：下一条指令会先停掉当前任务，再当作新任务发。')
    }
    this.store.setPending(openid, null)
    await this.cancelCurrent(openid, sid)
    return this.deliver(openid, sid, pending.text, { images: pending.images ?? [] })
  }

  async returnToEdit(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const entries = await this.queueEntries(openid, sid)
    const last = entries[entries.length - 1]
    if (!last) return this.send(openid, '没有可退回的指令（待选、排队、闲时队列都是空的）。')
    this.removeEntry(openid, sid, last)
    const text = String(last.text ?? '')
    const tail = text.length <= 100
      ? `\n\n${this.cmdInput(text)}`
      : '\n\n（内容较长，已放到下面，复制修改后重发。）'
    return this.send(openid, `↩ 已把这条退回编辑：\n\n${text}${tail}`, { md: true })
  }

  async cancelAll(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const before = await this.queueEntries(openid, sid)
    this.store.setPending(openid, null)
    const job = this.store.job(openid, sid)
    if (job) this.store.updateJob(openid, sid, { followups: [] })
    this.store.setDeferred(this.store.deferred().filter((r) => !(r.openid === openid && r.sessionId === sid)))
    return this.send(openid, before.length
      ? `🗑 已取消 ${before.length} 条等待中的指令；正在跑的任务没动。`
      : '没有等待中的指令。')
  }

  async guidePending(openid) {
    const p = this.store.pendingFor(openid)
    if (!p) return this.send(openid, '没有待选指令。先发文字，收到选择卡后再点「引导改向」。')
    this.store.setPending(openid, null)
    const target = p.sessionId || this.boundId(openid)
    if (!target) return this.send(openid, '还没绑定会话。')
    const busy = await this.isBusy(openid, target)
    if (!busy) return this.deliver(openid, target, p.text, { images: p.images ?? [] })
    return this.steerWith(openid, target, p.text, p.images ?? [])
  }

  async cancelPendingOnly(openid) {
    const had = Boolean(this.store.pendingFor(openid))
    this.store.setPending(openid, null)
    return this.send(openid, had ? '✖ 已取消，这条指令没有发出去。' : '没有待选指令。')
  }

  async settingsCard(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const current = REPORT_MODES[this.store.report(openid, sid)]?.label ?? '5分钟汇报'
    const lines = [
      `⚙️ 汇报设置 · ${await this.nameOf(sid)}`,
      `当前方式：${current}`,
      '',
      '点一下执行：',
      `「${this.cmdEnter('实时进度')}」`,
      `「${this.cmdEnter('当前进度')}」`,
      `「${this.cmdEnter('1分钟汇报')}」`,
      `「${this.cmdEnter('5分钟汇报')}」`,
      `「${this.cmdEnter('只要结果')}」`,
    ]
    return this.send(openid, lines.join('\n'), { md: true })
  }

  async setConsoleSession(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    this.store.setConsole(openid, {
      sessionId: sid,
      name: await this.nameOf(sid),
      at: Date.now(),
    })
    return this.send(openid, `✅ 已把「${await this.nameOf(sid)}」设为控制台会话。`)
  }

  async hideCurrent(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    this.store.hide(sid)
    return this.send(openid, `🙈 已从菜单隐藏「${await this.nameOf(sid)}」。发「隐藏列表」可查看或恢复。`)
  }

  async unhide(openid, prefix) {
    const hits = this.store.hidden().filter((id) => id.startsWith(prefix))
    if (!hits.length) return this.send(openid, '没找到这个隐藏会话。发「隐藏列表」看完整 ID。')
    for (const id of hits) this.store.unhide(id)
    return this.send(openid, `已恢复 ${hits.length} 个会话。`)
  }

  async guideQueued(openid, n) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const entries = await this.queueEntries(openid, sid)
    const pick = entries[n - 1]
    if (!pick) return this.send(openid, `没有第 ${n} 条排队指令。发「排队」看看。`)
    this.removeEntry(openid, sid, pick)
    await this.cancelCurrent(openid, sid)
    await sleep(300)
    return this.deliver(openid, sid, pick.text, { images: pick.images ?? [] })
  }

  async cancelQueued(openid, n) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const entries = await this.queueEntries(openid, sid)
    const pick = entries[n - 1]
    if (!pick) return this.send(openid, `没有第 ${n} 条排队指令。`)
    this.removeEntry(openid, sid, pick)
    return this.send(openid, `🗑 已取消第 ${n} 条：${short(pick.text, 40)}`)
  }

  async busyCard(openid, sessionId, busy) {
    const row = await this.sessions.rowFor(sessionId)
    const name = row ? String(row.title ?? row.displayTitle ?? sessionId.slice(0, 12)) : sessionId.slice(0, 12)
    const lines = [`⏸「${name}」正在跑任务 —— 这条新指令怎么发？`, '']
    if (busy.kind === 'job') {
      const j = busy.job
      lines.push(`· 状态：QQ 派发 · 已 ${duration(Date.now() - j.at)}`)
      lines.push(`· 最近进度：${j.confirmed ? '已确认，正在执行' : '等待任务确认'}`)
      if (j.text) lines.push(`· 最近输出：${short(j.text, 80)}`)
    } else {
      lines.push('· 状态：电脑端界面发起（DSH 侧运行中）')
    }
    lines.push('', '· ⏸ 排队执行 = 等当前任务干完，立刻执行这条')
    lines.push('· 🎯 引导改向 = 插入当前轮，按这条改向')
    lines.push('· 🛑 打断重发 = 停掉当前任务，把这条当新任务发')
    lines.push('· ✖ 取消 = 这条不发了')
    lines.push('', '点一下选择：')
    lines.push(`「${this.cmdEnter('排队执行')}」`)
    lines.push(`「${this.cmdEnter('引导改向')}」`)
    lines.push(`「${this.cmdEnter('打断重发')}」`)
    lines.push(`「${this.cmdEnter('取消本条')}」`)
    return lines.join('\n')
  }

  // ---------------- 视图 ----------------

  async activeRows() {
    return this.sessions.listActive()
  }

  projectGroups(rows) {
    const stamp = (r) => {
      const v = r?.updatedAt ?? r?.updated ?? 0
      if (typeof v === 'number') return v
      const t = Date.parse(v)
      return Number.isFinite(t) ? t : 0
    }
    const by = new Map()
    for (const r of rows) {
      const p = r.projectId ?? r.cwd ?? r.project ?? '(未知项目)'
      if (!by.has(p)) by.set(p, [])
      by.get(p).push(r)
    }
    return [...by.entries()].sort((a, b) => Math.max(...b[1].map(stamp)) - Math.max(...a[1].map(stamp)))
  }

  projectName(row, key) {
    return String(row?.projectName ?? row?.project ?? baseName(key) ?? key ?? '项目')
  }

  titleOf(row) {
    return String(row?.title ?? row?.displayTitle ?? row?.name ?? String(row?.sessionId ?? row?.id ?? '').slice(0, 12))
  }

  /**
   * 会话入口只写对话名；同名时才附 8 位短 ID 消歧。
   * 例：「进入 AI助手身份询问」/「进入 测试 · 58e9da59」。
   */
  enterCommand(row, rows = []) {
    const title = this.titleOf(row)
    const same = (Array.isArray(rows) ? rows : []).filter((r) => this.titleOf(r) === title)
    if (same.length <= 1) return `进入 ${title}`
    return `进入 ${title} · ${shortSessionId(row?.sessionId ?? row?.id)}`
  }

  async viewMenu(openid) {
    const rows = await this.activeRows()
    const groups = this.projectGroups(rows)
    const lines = [`📱 DSH QQ 控制台 · ${groups.length} 个项目 / ${rows.length} 个会话`, '']
    groups.slice(0, 7).forEach(([cwd, list], i) => {
      lines.push(`${i + 1}. ${this.projectName(list[0], cwd)}（${list.length}）`)
    })
    lines.push('', '底部菜单：项目 / 对话 / 设置 / 更多；也可以发「会话」直接挑。')
    await this.send(openid, lines.join('\n'))
  }

  async viewProjects(openid, only = 0) {
    const rows = await this.activeRows()
    const groups = this.projectGroups(rows)
    if (!groups.length) return this.send(openid, '没有找到项目。')

    if (only >= 1) {
      const entry = groups[only - 1]
      if (!entry) return this.send(openid, `没有第 ${only} 个项目。发「项目」看全部。`)
      const [cwd, list] = entry
      const lines = [`📁 ${this.projectName(list[0], cwd)}（${list.length} 个会话）`, '']
      list.forEach((r, i) => {
        lines.push(`${i + 1}. ${this.titleOf(r)}`)
        lines.push(`　 ${this.cmdEnter(this.enterCommand(r, rows))}`)
      })
      return this.send(openid, lines.join('\n'), { md: true })
    }

    const lines = ['📁 项目', '']
    groups.forEach(([cwd, list], i) => lines.push(`${i + 1}. ${this.projectName(list[0], cwd)}　${list.length} 个`))
    lines.push('', '点一下进入项目：')
    groups.forEach(([cwd, list], i) => {
      lines.push(`「${this.cmdEnter(`项目 ${i + 1} · ${this.projectName(list[0], cwd)}`)}」`)
    })
    return this.send(openid, lines.join('\n'), { md: true })
  }

  async viewSessions(openid) {
    const rows = await this.activeRows()
    if (!rows.length) return this.send(openid, '没有活跃会话。')
    const sorted = [...rows].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    const lines = [`🕘 全部对话 · ${sorted.length} 个`, '']
    sorted.slice(0, 20).forEach((r, i) => {
      lines.push(`${i + 1}. ${this.titleOf(r)}`)
      lines.push(`　 ${this.cmdEnter(this.enterCommand(r, rows))}`)
    })
    if (sorted.length > 20) lines.push(`…还有 ${sorted.length - 20} 个，发「项目」按项目看。`)
    return this.send(openid, lines.join('\n'), { md: true })
  }

  async viewArchived(openid) {
    const archived = archivedSessionIds()
    if (!archived.size) return this.send(openid, '没有已归档会话。')
    const rows = await this.sessions.list()
    const lines = [`🗄 已归档 · ${archived.size} 个（不能执行任务）`, '']
    let n = 0
    for (const r of rows) {
      const id = String(r.sessionId ?? r.id ?? '')
      if (!archived.has(id)) continue
      n += 1
      lines.push(`${n}. ${this.titleOf(r)}　${id.slice(0, 12)}`)
    }
    if (!n) lines.push('（归档会话不在当前清单里；可在 DSH App 里查看。）')
    lines.push('', '要恢复执行，请在 DSH App 里取消归档。')
    return this.send(openid, lines.join('\n'))
  }

  async viewCurrent(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。发「项目」或「会话」挑一个。')
    const row = await this.sessions.rowFor(sid)
    const name = row ? this.titleOf(row) : sid.slice(0, 12)
    const busy = await this.isBusy(openid, sid)
    const state = busy ? (busy.kind === 'job' ? '⏳ 正在跑（QQ 派发）' : '⏳ 正在跑（界面发起）') : '🟢 当前空闲'
    return this.send(openid,
      `📌 当前对话：${name}\n项目：${row?.cwd ?? '?'}\n${state}\n\n` +
      `「${this.cmdEnter('对话状态')}」\n「${this.cmdEnter('当前进度')}」`,
      { md: true })
  }

  async viewState(openid) {
    const sid = this.boundId(openid)
    if (!sid) {
      return this.send(openid, '当前未绑定对话。发「项目」→ 选一个。')
    }
    const rows = await this.sessions.list()
    const row = rows.find((r) => String(r.sessionId ?? r.id) === sid)
    const name = row ? this.titleOf(row) : sid.slice(0, 12)
    const proj = row?.cwd ? (baseName(row.cwd) ?? row.cwd) : '（未知项目）'
    const job = this.store.activeJob(openid, sid)
    const busy = job ? { kind: 'job', job } : (row?.running ? { kind: 'row', row } : null)

    let task = '无（空闲）'
    if (job) {
      task = `正在跑（QQ 派发）｜已 ${duration(Date.now() - job.at)}｜${job.confirmed ? '已确认' : '等待确认'}`
    } else if (row?.running) {
      task = '正在跑（界面·电脑端发起）'
    }

    const entries = await this.queueEntries(openid, sid)
    const pref = this.store.pref(openid, sid)
    const model = await this.sessions.currentModel(sid)
    const sel = pref.model ?? model ?? this.defaultSelection()
    const configured = sel
      ? this.modelChoices().find((item) => sameModel(item, sel))
      : null
    const effort = selectedEffort(pref, sel, configured)
    const perm = await this.sessions.currentPermission(sid)
    const archived = archivedSessionIds().has(sid)
    const sub = row ? isSubagent(row) : false
    const report = this.store.report(openid, sid)

    const md = ['📊 **【对话状态】**']
    md.push(`当前项目：${proj} ${this.cmdEnter('项目')}`)
    md.push(`当前对话：${name}${archived ? '（已归档）' : sub ? '（子会话）' : ''} ${this.cmdEnter('对话')}`)
    md.push(`当前任务：${task} ${busy ? this.cmdEnter('打断') : ''}`)
    md.push(`排队任务：${entries.length ? `${entries.length} 条` : '无'}`)
    entries.slice(0, 5).forEach((e, i) => {
      md.push(`${i + 1}. ${short(e.text, 34)}（${e.label}） ${this.cmdEnter(`引导 ${i + 1}`)} ${this.cmdEnter(`取消 ${i + 1}`)}`)
    })
    if (entries.length > 5) md.push(`…还有 ${entries.length - 5} 条未显示`)
    md.push(`汇报方式：${REPORT_MODES[report]?.label ?? '5分钟汇报'} ${this.cmdEnter('汇报')}`)
    md.push(`当前模型：${sel ? modelLabel(sel) : '默认'} ${this.cmdEnter('模型')}`)
    md.push(`推理强度：${effortText(effort)} ${this.cmdEnter('强度')}`)
    md.push(`当前权限：${permissionText(perm)} ${this.cmdEnter('权限')}`)
    return this.send(openid, md.join('\n'), { md: true })
  }

  async viewProgress(openid) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const job = this.store.activeJob(openid, sid)
    if (!job) {
      const row = await this.sessions.rowFor(sid)
      if (row?.running) {
        return this.send(openid, `⏳ ${this.titleOf(row)} 正在电脑端界面里跑（不是 QQ 发起的）；QQ 可以看，也可以在「打断重发」里停掉。`)
      }
      return this.send(openid, '当前没有在跑的任务（空闲）。')
    }
    const page = await this.sessions.page(sid, { throughSeq: -1 })
    const acts = Sessions.activityLines(page.records ?? [], job.userSeq).slice(-6)
    const lines = [
      `⏳ ${await this.nameOf(sid)} · 已 ${duration(Date.now() - job.at)}`,
      `状态：${job.confirmed ? '已确认' : '等待任务确认'}｜汇报：${REPORT_MODES[this.store.report(openid, sid)]?.label ?? '5分钟汇报'}`,
      '',
      ...(acts.length ? acts : ['（还没有新的文字输出）']),
      '',
      `「${this.cmdEnter('汇报')}」`,
    ]
    return this.send(openid, lines.join('\n'))
  }

  async nameOf(sid) {
    const row = await this.sessions.rowFor(sid)
    return row ? this.titleOf(row) : String(sid).slice(0, 12)
  }

  async setReport(openid, mode) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    this.store.setReport(openid, sid, mode)
    const job = this.store.activeJob(openid, sid)
    if (job) this.store.updateJob(openid, sid, { report: mode })
    const label = REPORT_MODES[mode]?.label ?? mode
    const extra = mode === 'live'
      ? '（用流式消息持续追加；没有新鲜 msg_id 时自动退化为普通增量消息）'
      : mode === 'result' ? '（保留任务确认，不推中间进度）' : ''
    return this.send(openid, `✅ 汇报方式已设为「${label}」${extra}${job ? '，当前任务立即生效。' : '。'}`)
  }

  async refreshMenu(openid) {
    if (!this.menu) return this.send(openid, '菜单管理器没启动（网关未连接）。')
    await this.send(openid, '⏳ 正在按当前会话清单重建底部菜单…')
    const result = await this.menu.apply({ force: true })
    if (!result.ok) return this.send(openid, `❌ 菜单没更新成功：${result.note ?? '未知原因'}`)
    return this.send(openid,
      `✅ 底部菜单已更新 · 项目/对话/设置/更多 · 平台版本 ${result.version ?? '?'}\n` +
      '（手机 QQ 里可能需要退出会话再进来才会刷新显示。）')
  }

  async sessionOps(openid) {
    const sid = this.boundId(openid)
    const cid = this.consoleId(openid)
    const lines = [
      '🛠 会话操作',
      `· 当前绑定：${sid ? await this.nameOf(sid) : '（无）'}`,
      `· 控制台会话：${cid ? await this.nameOf(cid) : '（无）'}`,
      '',
      `「${this.cmdEnter('当前')}」`,
      `「${this.cmdEnter('设为控制台')}」`,
      `「${this.cmdEnter('隐藏当前')}」`,
      `「${this.cmdEnter('隐藏列表')}」`,
      `「${this.cmdEnter('退出')}」`,
    ]
    return this.send(openid, lines.join('\n'), { md: true })
  }

  async hiddenList(openid) {
    const ids = this.store.hidden()
    if (!ids.length) return this.send(openid, '目前没有隐藏任何会话。')
    return this.send(openid, `已隐藏 ${ids.length} 个会话：\n${ids.map((x) => `· ${x}`).join('\n')}\n恢复：发「取消隐藏 <ID 前几位>」`)
  }

  async bindTo(openid, sessionId) {
    const rows = await this.sessions.list()
    const row = rows.find((r) => String(r.sessionId ?? r.id) === String(sessionId))
    if (!row) return this.send(openid, '这个会话不存在或已失效。发「会话」刷新。')
    if (archivedSessionIds().has(String(sessionId))) return this.send(openid, '这个会话已归档，不能绑定执行。')
    if (isSubagent(row)) return this.send(openid, '这是子会话（执行记录），不能绑定。')
    const sid = String(sessionId)
    this.store.bind(openid, sid, { name: this.titleOf(row), cwd: row.cwd ?? '' })

    // 和 Codex 控制台的绑定卡对齐：项目 / 模型 / 强度 / 权限 各挂一个
    // 行内标签，点一下就能改；末尾「状态」打开 8 行对话状态卡。
    const pref = this.store.pref(openid, sid)
    const model = await this.sessions.currentModel(sid)
    const sel = pref.model ?? model ?? this.defaultSelection()
    const perm = await this.sessions.currentPermission(sid)
    const configured = sel
      ? this.modelChoices().find((item) => sameModel(item, sel))
      : null
    const effort = selectedEffort(pref, sel, configured)
    const lines = [
      `✅ 已绑定：${this.titleOf(row)} ${this.cmdEnter('状态')}`,
      `项目：${row.cwd ?? '?'}`,
      `模型：${sel ? modelLabel(sel) : '默认'} ${this.cmdEnter('模型')}`,
      `强度：${effortText(effort)} ${this.cmdEnter('强度')}`,
      `权限：${permissionText(perm)} ${this.cmdEnter('权限')}`,
    ]
    return this.send(openid, lines.join('\n'), { md: true })
  }

  async enter(openid, target) {
    const rows = await this.activeRows()
    const ordered = [...rows].sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
    const query = String(target ?? '').trim()
    if (!query) return this.send(openid, '用法：「进入 <序号|标题|会话ID>」。')
    const idOf = (r) => String(r.sessionId ?? r.id ?? '')
    const idx = Number(query)
    if (Number.isInteger(idx) && idx >= 1 && idx <= ordered.length) {
      const row = ordered[idx - 1]
      return this.bindTo(openid, idOf(row))
    }
    // 「进入 标题 · 短ID」：同名会话消歧。
    const hinted = /^(.*?)\s+·\s+([0-9a-f]{6,8})$/i.exec(query)
    const titleQuery = hinted ? hinted[1].trim() : query
    const idHint = hinted ? hinted[2].toLowerCase() : ''
    const pool = idHint
      ? rows.filter((r) => this.titleOf(r) === titleQuery && idOf(r).toLowerCase().includes(idHint))
      : rows
    const exact = pool.filter((r) => this.titleOf(r) === titleQuery)
    if (exact.length === 1) return this.bindTo(openid, idOf(exact[0]))
    const byId = pool.filter((r) => {
      const id = idOf(r)
      return id.startsWith(query) || (query.length >= 6 && id.includes(query))
    })
    if (byId.length === 1) return this.bindTo(openid, idOf(byId[0]))
    const byTitle = pool.filter((r) => this.titleOf(r).includes(titleQuery))
    if (byTitle.length === 1) return this.bindTo(openid, idOf(byTitle[0]))
    const inWs = pool.filter((r) => baseName(r.cwd) === titleQuery)
    if (inWs.length === 1) return this.bindTo(openid, idOf(inWs[0]))
    const many = [...new Set([...exact, ...byId, ...byTitle, ...inWs])]
    if (many.length > 1) {
      const lines = [`「${titleQuery}」匹配到 ${many.length} 个，点下面任意一条：`, '']
      many.slice(0, 10).forEach((r, i) => {
        lines.push(`${i + 1}. ${this.titleOf(r)}`)
        lines.push(`　 ${this.cmdEnter(this.enterCommand(r, rows))}`)
      })
      return this.send(openid, lines.join('\n'), { md: true })
    }
    return this.send(openid, `没找到「${query}」。发「会话」看清单。`)
  }

  async rename(openid, name) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const c = this.sessions.controller()
    if (!c?.rename) return this.send(openid, 'DSH 不支持改名。')
    try {
      await c.rename({ sessionId: sid, title: name })
      this.store.bind(openid, sid, { name, cwd: (await this.sessions.rowFor(sid))?.cwd ?? '' })
      return this.send(openid, `已改名：${name}`)
    } catch (err) {
      return this.send(openid, `改名失败：${err?.message ?? err}`)
    }
  }

  async unbind(openid) {
    this.store.bind(openid, '')
    return this.send(openid, '已解除绑定。')
  }

  // ---------------- 模型 / 强度 / 权限 ----------------

  async trySelectionText(openid, text) {
    const pick = this.store.modelPick()[openid]
    if (!pick?.stage || pick.stage === 'done') return false
    const at = Number(pick.at ?? 0)
    if (at && Date.now() - at > 15 * 60_000) {
      this.store.setModelPick(openid, null)
      return false
    }
    const clean = choiceText(text)
    if (!clean) return false

    if (pick.stage === 'model') {
      const list = this.modelChoices()
      const hits = list.filter((m) => (
        clean === modelSelectLabel(m, list) ||
        clean === valueText(m.model) ||
        clean === valueText(m.full)
      ))
      if (hits.length === 1) {
        await this.applyModel(openid, list.indexOf(hits[0]))
        return true
      }
      if (hits.length > 1) {
        await this.send(openid, '这个模型名对应多个模型，请发「模型 序号」选择。')
        return true
      }
    }

    if (pick.stage === 'effort' && pick.model) {
      const efforts = sortEfforts(await this.effortsFor(pick.model), { descending: true })
      const index = efforts.findIndex((effort) => effortChoiceMatches(effort, clean))
      if (index >= 0) {
        await this.applyEffort(openid, index, pick.model)
        return true
      }
    }
    return false
  }

  modelChoices() {
    const list = Array.isArray(this.config.models) ? this.config.models : []
    return list.filter((m) => m?.provider && m?.model)
  }

  defaultSelection() {
    const first = this.modelChoices()[0]
    if (!first) return null
    return {
      provider: first.provider,
      model: first.model,
      reasoningEffort: first.effort ?? first.efforts?.[0] ?? '',
      name: valueText(first.full) || first.model,
    }
  }

  /**
   * 手机端的模型卡：既显示当前模型，也把设置页保存的候选模型全部列出来。
   * 之前「模型」只回一行当前模型，用户保存了 6 个模型却在手机上看不到，
   * 误以为选择器是空的。这里统一走同一张卡。
   */
  async modelCard(openid, { title = '选模型' } = {}) {
    const list = this.modelChoices()
    const sid = this.boundId(openid)
    const pref = sid ? this.store.pref(openid, sid) : {}
    let live = null
    if (sid) {
      try {
        live = await this.sessions.currentModel(sid)
      } catch {
        live = null
      }
    }
    const current = pref.model ?? live ?? this.defaultSelection()
    const configured = current
      ? this.modelChoices().find((item) => sameModel(item, current))
      : null
    const currentEffort = selectedEffort(pref, current, configured)

    if (!list.length) {
      const now = current
        ? `当前模型：${modelLabel(current)}${modelMeta(current) ? `（${modelMeta(current)}）` : ''}\n强度：${effortText(currentEffort)}`
        : '当前模型：未设置'
      return this.send(openid,
        `🔧 ${title}\n${now}\n\n还没有配置可选模型。到 DSH → 插件 → QQ 控制台最下方「模型」里添加。`)
    }

    const previous = this.store.modelPick()[openid]
    this.store.setModelPick(openid, { ...(previous ?? {}), stage: 'model', at: Date.now() })

    const lines = [`模型选择：默认 ${list.length} 个`]
    if (current) {
      lines.push(
        '',
        `当前：${modelLabel(current)} · 强度：${effortText(currentEffort)}`,
      )
    }
    lines.push('')
    list.forEach((m, i) => {
      const tags = []
      if (i === 0) tags.push('默认')
      if (sameModel(current, m)) tags.push('当前')
      const suffix = tags.length ? `　${tags.join(' · ')}` : ''
      lines.push(`${i + 1}. 「${this.cmdEnter(modelSelectLabel(m, list))}」${suffix}`)
    })
    lines.push('', '点模型全称即可切换；选完再选推理强度。数字命令「模型 序号」仍可用。')
    return this.send(openid, lines.join('\n'), { md: true })
  }

  async pickModelCard(openid) {
    return this.modelCard(openid, { title: '选模型' })
  }

  async applyModel(openid, index) {
    const m = this.modelChoices()[index]
    if (!m) return this.send(openid, '这个序号没有模型。')
    this.store.setModelPick(openid, { model: m, stage: 'effort' })
    return this.pickEffortCard(openid)
  }

  async pickEffortCard(openid) {
    const sid = this.boundId(openid)
    const pick = this.store.modelPick()[openid]
    const model = pick?.model ?? (sid ? await this.sessions.currentModel(sid) : null) ?? this.defaultSelection()
    if (!model) return this.pickModelCard(openid)
    // 「强度 N」要作用在卡片上展示的这只模型，而不是悄悄落回设置页第一项。
    this.store.setModelPick(openid, {
      ...(pick ?? {}),
      model,
      stage: 'effort',
      at: Date.now(),
    })
    const efforts = sortEfforts(await this.effortsFor(model), { descending: true })
    const current = pick && Object.hasOwn(pick, 'effort')
      ? valueText(pick.effort)
      : firstText(model.reasoningEffort, model.effort, model.efforts?.[0])
    const lines = [
      `推理强度：${modelLabel(model)}`,
      '',
      '从高到低，点一下直接生效：',
    ]
    efforts.forEach((e) => {
      const mark = e === current ? '　（当前）' : ''
      lines.push(`「${this.cmdEnter(effortChoiceText(e))}」${mark}`)
    })
    return this.send(openid, lines.join('\n'), { md: true })
  }

  /**
   * 模型支持哪些推理强度：会话里存的是 `{provider, model, reasoningEffort}`，
   * 本身不带档位清单；旧代码于是硬编码成 `['', 'high', 'low']`，手机端
   * 只会看到三档、还显示英文。这里改成按 provider+model 去实时目录里
   * 取 `reasoning.efforts`，拿不到才退回低/中/高三档。
   */
  async effortsFor(model) {
    const direct = Array.isArray(model?.efforts) && model.efforts.length
      ? model.efforts
      : Array.isArray(model?.reasoning?.efforts) && model.reasoning.efforts.length
        ? model.reasoning.efforts
        : []
    const ids = direct.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean)
    if (ids.length) return sortEfforts(['', ...ids], { descending: true })
    const fromCatalog = await this.sessions.effortsForModel(model?.provider, model?.model)
    if (fromCatalog.length) return sortEfforts(['', ...fromCatalog], { descending: true })
    return sortEfforts(['', 'low', 'medium', 'high'], { descending: true })
  }

  async applyEffortByName(openid, token) {
    const pick = this.store.modelPick()[openid]
    if (token === '默认') return this.applyEffortValue(openid, '')
    const idx = Number(token)
    if (!Number.isInteger(idx) || idx < 1) return this.send(openid, '用法：「强度 1」或「强度 默认」。')
    return this.applyEffort(openid, idx - 1, pick?.model)
  }

  async applyEffort(openid, index, chosen = null) {
    const sid = this.boundId(openid)
    const pick = this.store.modelPick()[openid]
    const model = chosen ?? pick?.model ?? this.defaultSelection()
    if (!model) return this.pickModelCard(openid)
    const efforts = await this.effortsFor(model)
    const effort = efforts[index]
    if (effort === undefined) return this.send(openid, '这个强度档位不存在。')
    return this.applyEffortValue(openid, effort, model)
  }

  async applyEffortValue(openid, effort, model = null) {
    const sid = this.boundId(openid)
    const pick = this.store.modelPick()[openid]
    const target = model ?? pick?.model ?? this.defaultSelection()
    if (!target) return this.pickModelCard(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    const result = await this.sessions.selectModel(sid, {
      provider: target.provider,
      model: target.model,
      effort,
    })
    if (!result.ok) return this.send(openid, `❌ 设置失败：${result.note}`)
    this.store.setModelPick(openid, { model: target, effort, stage: 'done' })
    this.store.setPref(openid, sid, { model: target, effort })
    return this.send(openid, `✅ 已设为 ${modelLabel(target)} · ${effortChoiceText(effort)}`)
  }

  async viewModel(openid) {
    return this.modelCard(openid, { title: '模型' })
  }

  async pickPermissionCard(openid) {
    const cat = await this.sessions.permissionCatalog()
    if (!cat.supported || !cat.options.length) return this.send(openid, 'DSH 权限服务不可用。')
    const options = sortPermissions(cat.options)
    const lines = ['🔐 权限档位', '', '从低到高；「自动」是特殊档：']
    options.forEach((p, i) => {
      const id = permissionId(p)
      const label = permissionText(id, String(p.name ?? p.label ?? ''))
      lines.push(`${i + 1}. ${label}${id === cat.defaultPreset ? ' · 默认' : ''}　${this.cmdEnter(`权限 ${i + 1}`)}`)
    })
    lines.push('', '点按钮或发「权限 序号」切换。')
    return this.send(openid, lines.join('\n'), { md: true })
  }

  async applyPermission(openid, preset) {
    const sid = this.boundId(openid)
    if (!sid) return this.send(openid, '还没绑定会话。')
    // 卡片上的行内标签发的是「权限 2」这种序号；这里还原成档位 id，
    // 也兼容直接发「权限 workspace-write」。
    let target = String(preset ?? '').trim()
    if (/^\d{1,2}$/.test(target)) {
      const cat = await this.sessions.permissionCatalog()
      const option = sortPermissions(cat.options)[Number(target) - 1]
      if (!option) return this.send(openid, '这个权限档位不存在。发「权限」看清单。')
      target = permissionId(option)
    }
    if (!target) return this.send(openid, '用法：「权限 1」或「权限 <档位名>」。')
    const result = await this.sessions.setPermission(sid, target)
    if (!result.ok) return this.send(openid, result.note)
    return this.send(openid, `✅ 权限已切换为 ${permissionText(target)}`)
  }

  // ---------------- 看门狗 ----------------

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tickJobs()
      await this.tickDeferred()
    } finally {
      this.ticking = false
    }
  }

  async tickJobs() {
    const jobs = this.store.jobs()
    let changed = false
    for (const [key, job] of Object.entries(jobs)) {
      if (job.status !== 'running') continue
      const page = await this.sessions.page(job.sessionId, { throughSeq: -1 })
      const records = page.records ?? []
      const maxSeq = page.asOfSeq ?? Sessions.maxSeq(records)

      if (job.awaitingUserRecord) {
        const ue = Sessions.userRecordFor(records, job.id)
        if (ue) {
          job.userSeq = ue.seq
          job.lastSeq = ue.seq
          job.awaitingUserRecord = false
          changed = true
        }
      }

      const texts = Sessions.assistantTexts(records, job.userSeq)
      if (!job.confirmed && texts.length) {
        job.confirmed = true
        job.lastSeq = maxSeq
        changed = true
        await this.send(job.openid, `🟢 任务确认\n${short(texts[0], 200)}\n\n「${this.cmdEnter('汇报')}」`)
      }

      const report = job.report ?? this.store.report(job.openid, job.sessionId)
      const acts = Sessions.activityLines(records, job.lastSeq)
      if (report === 'live' && acts.length) {
        job.liveTail = `${job.liveTail ? `${job.liveTail}\n` : ''}${acts.join('\n')}`.slice(-1800)
        await this.pushLive(job)
        job.lastSeq = maxSeq
        changed = true
      }

      const finished = Sessions.turnFinished(records, job.userSeq)
      if (finished) {
        const reason = Sessions.endReason(records, job.userSeq)
        const kind = reason?.kind ?? 'completed'
        const body = texts.join('\n\n').slice(0, 1500) || '（这一轮没有文字输出）'
        if (job.streamId) {
          const msgId = this.store.freshMsgId(job.openid)
          await this.streamSend(job.openid, job.liveTail || body, {
            index: job.streamIndex, state: 10, streamId: job.streamId, msgId,
          })
        }
        await this.send(job.openid, `${kind === 'completed' ? '✅' : '⚠️'} 任务结束（${kind}）\n\n${body}`)
        job.status = kind === 'completed' ? 'done' : 'ended'
        job.endedAt = Date.now()
        changed = true
        await this.runNextFollowup(job)
        continue
      }

      const mode = REPORT_MODES[report] ?? REPORT_MODES.min5
      if (mode.every && Date.now() - job.lastReport >= mode.every * 1000) {
        job.lastReport = Date.now()
        changed = true
        const tail = acts.length ? acts.slice(-4).join('\n') : '还在跑，暂无新输出。'
        await this.send(job.openid,
          `⏳ 进度 · ${await this.nameOf(job.sessionId)} · 已 ${duration(Date.now() - job.at)}\n${short(tail, 320)}\n\n「${this.cmdEnter('汇报')}」`)
      }

      if (!job.warned && Date.now() - job.at >= (Number(this.config.queueWarnAfter) || 420) * 1000 && !texts.length) {
        job.warned = true
        changed = true
        await this.send(job.openid,
          '⚠️ 投递后一直没有新回复。可能：会话被归档、模型不可用、或那一轮被打断。\n发「对话状态」看看到底怎么回事。')
      }
    }
    if (changed) {
      // tick 过程中可能已经投递了下一条 followup（同一个 key、不同 id）：
      // 只回写本轮真正处理过、且 id 未变的记录，避免覆盖新任务。
      const current = this.store.jobs()
      for (const [key, job] of Object.entries(jobs)) {
        if (current[key] && current[key].id === job.id) current[key] = job
      }
      this.store.save('jobs.json', current)
    }
  }

  async pushLive(job) {
    const msgId = this.store.freshMsgId(job.openid)
    const text = `⏳ 实时进度 · ${await this.nameOf(job.sessionId)}\n${job.liveTail}\n\n「${this.cmdEnter('汇报')}」`
    if (msgId) {
      const res = await this.streamSend(job.openid, text, {
        index: job.streamIndex, state: 1, streamId: job.streamId, msgId,
      })
      if (res) {
        job.streamId = res.id || job.streamId
        job.streamIndex += 1
        return
      }
    }
    // 没有新鲜 msg_id（或流式被拒）→ 普通增量消息，只发新内容，避免重复开头。
    const delta = String(job.liveTail).split('\n').slice(-6).join('\n')
    await this.send(job.openid, `⏳ ${short(delta, 600)}`)
  }

  async runNextFollowup(job) {
    const next = (job.followups ?? []).shift()
    if (!next) return
    this.store.updateJob(job.openid, job.sessionId, { followups: job.followups ?? [] })
    await sleep(500)
    await this.deliver(job.openid, job.sessionId, next.text, { images: next.images ?? [] })
  }

  async tickDeferred() {
    const idle = idleState()
    if (!idle.ok) return
    const rows = this.store.deferred()
    if (!rows.length) return
    const row = rows[0]
    const busy = await this.isBusy(row.openid, row.sessionId)
    if (busy) return
    this.store.setDeferred(rows.slice(1))
    await this.deliver(row.openid, row.sessionId, row.text, { images: row.images ?? [] })
  }
}
