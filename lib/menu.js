/**
 * QQ 单聊底部自定义菜单（`PUT /v2/menu`）。
 *
 * 当前口径（2026-10-17 定稿）：
 *   一级 = 最多 7 个项目 +「对话」+「设置」+「更多」（合计 ≤10，平台硬上限）。
 *   项目 = 该项目最近的会话；超过 5 个时只放最近 4 个，第 5 项为「更多」
 *          → 发 `项目 <组号>`，由控制台列出该项目全部会话。
 *   对话 = 对话状态 / 排队执行 / 打断重发 / 退回编辑 / 删除取消
 *   设置 = 实时进度 / 当前进度 / 1分钟汇报 / 5分钟汇报 / 只要结果
 *   更多 = 当前对话 / 全部对话 / 项目 / 会话操作 / 面板
 *
 * 平台限制：一级 name ≤10 加权字符（汉字算 2）、子菜单 ≤5 项、子项 ≤14 加权字符。
 */

import { archivedSessionIds, isSubagent } from './sessions.js'

export const LIMITS = {
  maxProjects: 7,
  maxTop: 10,
  maxChildren: 5,
  nameLimit: 10,
  childLimit: 14,
}

export const UTILITY_NAMES = ['对话', '设置', '更多']

const DIALOG_ITEMS = [
  ['对话状态', '对话状态'],
  ['排队执行', '排队执行'],
  ['打断重发', '打断重发'],
  ['退回编辑', '退回编辑'],
  ['删除取消', '删除取消'],
]

const SETTINGS_ITEMS = [
  ['实时进度', '实时进度'],
  ['当前进度', '当前进度'],
  ['1分钟汇报', '1分钟汇报'],
  ['5分钟汇报', '5分钟汇报'],
  ['只要结果', '只要结果'],
]

const MORE_ITEMS = [
  ['当前对话', '当前'],
  ['全部对话', '会话'],
  ['项目', '项目'],
  ['会话操作', '会话操作'],
  ['面板', '面板'],
]

/** 加权长度：码点 >127 的字符算 2（平台按中文 2 计算）。 */
export function weight(text) {
  let n = 0
  for (const ch of String(text ?? '')) n += ch.codePointAt(0) > 127 ? 2 : 1
  return n
}

/** 按加权长度截断；空结果回落 `?`，平台拒收空 name。 */
export function fit(text, limit) {
  let out = ''
  let cost = 0
  for (const ch of String(text ?? '')) {
    const w = ch.codePointAt(0) > 127 ? 2 : 1
    if (cost + w > limit) break
    out += ch
    cost += w
  }
  return out || '?'
}

/** 截断并去重：先给「·N」后缀留位，避免后缀被截掉后死循环。 */
export function fitUniq(texts, limit) {
  const seen = new Map()
  const out = []
  for (const raw of texts) {
    let n = (seen.get(raw) ?? 0) + 1
    seen.set(raw, n)
    let suffix = n === 1 ? '' : `·${n}`
    let candidate = fit(raw, limit - weight(suffix)) + suffix
    while (out.includes(candidate)) {
      n += 1
      seen.set(raw, n)
      suffix = `·${n}`
      candidate = fit(raw, limit - weight(suffix)) + suffix
    }
    out.push(candidate)
  }
  return out
}

function stamp(row) {
  const v = row?.updatedAt ?? row?.updated ?? row?.at ?? 0
  if (typeof v === 'number') return v
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : 0
}

function newest(rows) {
  let max = 0
  for (const r of rows) max = Math.max(max, stamp(r))
  return max
}

export function basename(cwd) {
  const parts = String(cwd ?? '').split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

export { archivedSessionIds }

function idOf(row) {
  return String(row?.sessionId ?? row?.id ?? '')
}

function titleOf(row) {
  return String(row?.title ?? row?.displayTitle ?? row?.name ?? idOf(row).slice(0, 12) ?? '会话')
}

function shortIdOf(row) {
  const id = idOf(row)
  const m = /^session-([0-9a-f-]{6,})$/i.exec(id)
  if (m) return m[1].split('-')[0].slice(0, 8)
  return id.length > 8 ? id.slice(0, 8) : id
}

/** 菜单入口只写对话名；同名会话附 8 位短 ID 消歧。 */
function enterCommand(row, rows) {
  const title = titleOf(row)
  const same = (rows ?? []).filter((r) => titleOf(r) === title)
  return same.length > 1 ? `进入 ${title} · ${shortIdOf(row)}` : `进入 ${title}`
}

function sendMessage(name, command) {
  return { name, type: 'send_message', send_message: command }
}

/**
 * 纯函数：会话行 → 平台菜单 items。
 * `send_message` 用「进入 + 标题」，同名会话才附 8 位短 ID 消歧。
 */
export function buildMenuItems(rows, options = {}) {
  const limits = { ...LIMITS, ...(options.limits ?? {}) }
  const hidden = options.hidden ?? new Set()
  const archived = options.archived ?? new Set()

  const live = (rows ?? []).filter((r) => {
    const id = idOf(r)
    return Boolean(id) && !hidden.has(id) && !archived.has(id) && !isSubagent(r)
  })

  const buckets = new Map()
  for (const r of live) {
    const key = r?.projectId ?? r?.cwd ?? r?.project ?? '(未知项目)'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(r)
  }

  const groups = [...buckets.entries()].sort((a, b) => newest(b[1]) - newest(a[1]))
  const top = groups.slice(0, limits.maxProjects)
  const names = top.map(([key, list]) =>
    String(list[0]?.projectName ?? list[0]?.project ?? basename(key) ?? key) || '项目')
  const topNames = fitUniq(names, limits.nameLimit)

  const items = []
  top.forEach(([, list], i) => {
    const sorted = [...list].sort((a, b) => stamp(b) - stamp(a))
    const overflow = sorted.length > limits.maxChildren
    const show = overflow ? sorted.slice(0, limits.maxChildren - 1) : sorted
    const labels = show.map((r) => titleOf(r))
    if (overflow) labels.push('更多')
    const children = fitUniq(labels, limits.childLimit)
    const sub = children.map((name, pos) => {
      const isMore = overflow && pos === children.length - 1
      return sendMessage(name, isMore ? `项目 ${i + 1}` : enterCommand(show[pos], live))
    })
    items.push({ name: topNames[i], type: 'menu', sub_menu_items: sub })
  })

  const block = (label, pairs) => ({
    name: label,
    type: 'menu',
    sub_menu_items: pairs.map(([name, command]) =>
      sendMessage(fit(name, limits.childLimit), command)),
  })

  items.push(block('对话', DIALOG_ITEMS))
  items.push(block('设置', SETTINGS_ITEMS))
  items.push(block('更多', MORE_ITEMS))
  return items.slice(0, limits.maxTop)
}

/** 清单指纹：只判断要不要重注册，不要求密码学强度。 */
export function fingerprint(items) {
  const text = JSON.stringify(items)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

export class MenuManager {
  constructor({ sessions, store, logger, config, gateway }) {
    this.sessions = sessions
    this.store = store
    this.logger = logger
    this.config = config
    this.getGateway = typeof gateway === 'function' ? gateway : () => gateway
    this.timer = null
    this.lastError = ''
  }

  get intervalMs() {
    const seconds = Number(this.config?.menuRefreshEvery ?? 300)
    return Math.max(60_000, (Number.isFinite(seconds) ? seconds : 300) * 1000)
  }

  async apply({ force = false } = {}) {
    const gw = this.getGateway()
    if (!gw) return { ok: false, note: '网关未连接' }

    let items
    try {
      // listActive 会滤掉归档、子会话和空白会话（建了没发过消息的幽灵对话）。
      const rows = await this.sessions.listActive()
      items = buildMenuItems(rows, {
        hidden: new Set(this.store?.hidden?.() ?? []),
        archived: archivedSessionIds(),
      })
    } catch (err) {
      this.lastError = String(err?.message ?? err)
      return { ok: false, note: `构建菜单失败：${this.lastError}` }
    }

    const digest = fingerprint(items)
    const state = this.store?.load?.('menu.json', {}) ?? {}
    if (!force && state.hash === digest) {
      return { ok: true, skipped: true, digest, items }
    }

    try {
      const res = await gw.api('/v2/menu', 'PUT', { menu: { items } })
      if (res.status >= 400) {
        this.lastError = `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`
        this.logger?.warn?.('[qq-console-v2] 注册菜单失败：%s', this.lastError)
        return { ok: false, note: this.lastError, digest, items }
      }
      this.lastError = ''
      this.store?.save?.('menu.json', {
        hash: digest,
        at: new Date().toISOString(),
        version: res.body?.version,
        items,
      })
      return { ok: true, digest, items, version: res.body?.version }
    } catch (err) {
      this.lastError = String(err?.message ?? err)
      this.logger?.warn?.('[qq-console-v2] 注册菜单异常：%s', this.lastError)
      return { ok: false, note: this.lastError, digest, items }
    }
  }

  start({ delayMs = 15_000 } = {}) {
    this.stop()
    if (this.config?.menuAutoRefresh === false) {
      this.logger?.info?.('[qq-console-v2] 菜单自动刷新已关闭。')
      return
    }
    const run = () => {
      this.apply().catch((err) =>
        this.logger?.warn?.('[qq-console-v2] 菜单刷新异常：%s', err?.message ?? err))
    }
    const first = setTimeout(run, delayMs)
    first.unref?.()
    this.timer = setInterval(run, this.intervalMs)
    this.timer.unref?.()
    this.logger?.info?.('[qq-console-v2] 菜单自动刷新：每 %d 秒比对一次，有变化才重注册。',
      Math.round(this.intervalMs / 1000))
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status() {
    const state = this.store?.load?.('menu.json', {}) ?? {}
    return {
      active: true,
      auto: this.config?.menuAutoRefresh !== false,
      everySeconds: Math.round(this.intervalMs / 1000),
      registeredAt: state.at ?? '',
      version: state.version ?? null,
      groups: Array.isArray(state.items) ? state.items.length : 0,
      lastError: this.lastError,
      note: '',
    }
  }
}
