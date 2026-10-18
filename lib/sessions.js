/**
 * DSH 会话访问层。
 *
 * 控制台只通过这组窄接口访问宿主：
 *   prompt() / cancel()       投递、引导、打断
 *   page()                    读取轮次、助手输出、模型/权限事件
 *   list()                    会话清单及 running 状态
 *   modelCatalog()            宿主当前真实可用模型
 *   permissionPresets         DSH 当前权限档位
 *
 * 所有宿主能力都做软探测：缺失时返回结构化失败，不把 DSH 启动链拖垮。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

export function archivedSessionIds(home) {
  try {
    const dir = home ?? process.env.DSH_HOME ?? `${process.env.USERPROFILE}/.dsh`
    const raw = readFileSync(`${dir}/storages/workspace.json`, 'utf8')
    const arr = JSON.parse(raw)?.global?.archivedSessionIds ?? []
    return new Set(arr.map(String))
  } catch {
    return new Set()
  }
}

export function isSubagent(row) {
  return String(row?.origin ?? '') === 'subagent'
}

/**
 * 空白会话：建了但从没发过消息（title 为空、turns=0）。
 * DSH 自己的侧栏不显示它们，但 sessionController.list() 会返回，
 * 于是 QQ 菜单里会出现一堆「同名/无标题」的幽灵对话。归档标记也
 * 盖不住它们，只能按宿主给的 blank / turns 判掉。
 */
export function isBlankRow(row) {
  const values = row?.projectionValues ?? row?.projections?.values ?? {}
  const meta = values?.sessionListMetadata
  const blank = meta?.val?.blank ?? meta?.blank
  if (blank === true) return true
  if (blank === false) return false
  const turns = values?.sessionStats?.val?.turns ?? values?.sessionStats?.turns
  const rawTitle = values?.title
  const title = typeof rawTitle === 'string' ? rawTitle : rawTitle?.val
  return Number(turns ?? 0) === 0 && !title && !row?.running
}

export class Sessions {
  constructor(ctx, logger, log) {
    this.ctx = ctx
    this.logger = logger
    this.log = log
  }

  controller() {
    try {
      return this.ctx.get?.('sessionController') ?? this.ctx.sessionController ?? null
    } catch {
      return null
    }
  }

  liveSession(sessionId) {
    try {
      return this.ctx.get?.('sessions')?.get?.(sessionId) ?? null
    } catch {
      return null
    }
  }

  /**
   * 取会话的 Session 对象；冷会话先让控制器恢复/加载。
   *
   * DSH 重启后，持久化会话不在运行栈里，`ctx.sessions.get()` 返回空，
   * 权限服务就无法 `set()`。控制器的 `resolveAgent()` 会按 ID 恢复普通
   * 会话，返回的 Agent 上带着权限服务需要的 Session。
   */
  async ensureLive(sessionId) {
    const attached = this.liveSession(sessionId)
    if (attached) return attached
    const c = this.controller()
    if (!c?.resolveAgent) return null
    try {
      const agent = await c.resolveAgent(sessionId)
      return agent?.session ?? this.liveSession(sessionId) ?? null
    } catch (err) {
      this.logger?.warn?.('[qq-console-v2] 恢复会话失败：%s', err?.message ?? err)
      return null
    }
  }

  permissionService() {
    try {
      return this.ctx.get?.('permissionPresets') ?? null
    } catch {
      return null
    }
  }

  get available() {
    return this.controller() !== null
  }

  async list() {
    const c = this.controller()
    if (!c?.list) return []
    try {
      const res = await c.list()
      const rows = Array.isArray(res) ? res : (res?.sessions ?? res?.items ?? [])
      return rows.map((row) => normalizeRow(row))
    } catch (err) {
      this.logger?.warn?.('[qq-console-v2] list 失败：%s', err?.message ?? err)
      return []
    }
  }

  async rowFor(sessionId) {
    const want = String(sessionId)
    return (await this.list()).find((row) => String(row.sessionId ?? row.id ?? '') === want) ?? null
  }

  async listActive() {
    const archived = archivedSessionIds()
    const rows = await this.list()
    return rows.filter((row) => {
      const id = String(row.sessionId ?? row.id ?? '')
      return id && !isSubagent(row) && !archived.has(id) && !isBlankRow(row)
    })
  }

  async page(sessionId, { throughSeq = -1, maxMessages } = {}) {
    const c = this.controller()
    if (!c?.page) return { records: [], hasMore: false }

    // 新版 DSH 把 throughSeq 当作“最后一条要包含的 seq”，`-1` 会被
    // 解释成“第 0 条之前”，于是永远返回空页。要取最新页，先 inspect
    // 拿到最后一条 seq，再用真实 seq 请求。
    let through = throughSeq
    if (through === -1) {
      try {
        const inspected = await c.inspect?.(sessionId)
        through = Number(inspected?.events?.at(-1)?.seq ?? 0)
      } catch {
        through = 0
      }
    }

    const build = (endSeq) => {
      const req = {
        address: { kind: 'session', sessionId },
        throughSeq: endSeq,
      }
      if (maxMessages !== undefined) req.maxMessages = maxMessages
      return req
    }

    try {
      const res = await c.page(build(through), new AbortController().signal)
      const normalized = normalizePage(res)
      return normalized
    } catch (err) {
      const m = /past cursor (\d+)/.exec(err?.message ?? '')
      if (!m) {
        this.log?.(`page 失败：${err?.message ?? err}`)
        this.logger?.warn?.('[qq-console-v2] page 失败：%s', err?.message ?? err)
        return { records: [], hasMore: false }
      }
      try {
        return normalizePage(await c.page(build(Number(m[1])), new AbortController().signal))
      } catch (err2) {
        this.log?.(`page 重试失败：${err2?.message ?? err2}`)
        this.logger?.warn?.('[qq-console-v2] page 重试失败：%s', err2?.message ?? err2)
        return { records: [], hasMore: false }
      }
    }
  }

  async cursor(sessionId) {
    const page = await this.page(sessionId, { throughSeq: -1 })
    return page.asOfSeq ?? Sessions.maxSeq(page.records)
  }

  static maxSeq(records) {
    let max = 0
    for (const record of records ?? []) {
      const seq = typeof record?.seq === 'number' ? record.seq : 0
      if (seq > max) max = seq
    }
    return max
  }

  static userRecordFor(records, requestId) {
    for (const record of records ?? []) {
      if (record?.type !== 'user/message') continue
      if (record?.data?.source?.rpcId === requestId) return record
    }
    return null
  }

  static turnFinished(records, afterSeq) {
    for (const record of records ?? []) {
      if (record?.type === 'turn/end' && (record?.seq ?? 0) > afterSeq) return true
    }
    return false
  }

  static endReason(records, afterSeq) {
    let found = null
    for (const record of records ?? []) {
      if (record?.type === 'turn/end' && (record?.seq ?? 0) > afterSeq) found = record?.data?.reason ?? null
    }
    return found
  }

  static assistantTexts(records, afterSeq) {
    const out = []
    for (const record of records ?? []) {
      if ((record?.seq ?? 0) <= afterSeq) continue
      if (record?.type !== 'assistant/message') continue
      const text = textOf(record)
      if (text) out.push(text)
    }
    return out
  }

  static activityLines(records, afterSeq) {
    const out = []
    for (const record of records ?? []) {
      if ((record?.seq ?? 0) <= afterSeq) continue
      if (record?.type === 'assistant/message') {
        const text = textOf(record)
        if (text) out.push(`🤖 ${text}`)
      } else if (record?.type === 'tool/call') {
        const name = String(record?.data?.name ?? '').trim()
        if (name) out.push(`⚙️ 正在执行：${name}`)
      } else if (record?.type === 'tool/result') {
        const error = record?.data?.error
        if (error) out.push(`⚠️ 工具失败：${error.code ?? error.name ?? 'unknown'}`)
      } else if (record?.type === 'approval/asked') {
        out.push(`🔐 等待批准：${record?.data?.toolName ?? '工具'}`)
      }
    }
    return out
  }

  static lastModelSelection(records) {
    let found = null
    for (const record of records ?? []) {
      if (record?.type === 'model/selection') found = record.data ?? null
    }
    return found
  }

  async deliver(sessionId, text, { mode = 'queue', images = [] } = {}) {
    if (archivedSessionIds().has(String(sessionId))) {
      return {
        ok: false,
        note: '这个会话已归档，DSH 不会执行它的任务。发「会话」换一个，或在 App 里取消归档。',
      }
    }

    const row = await this.rowFor(sessionId)
    if (row && isSubagent(row)) {
      return {
        ok: false,
        note: '这是子会话（某个任务的执行记录），不能直接投指令。发「会话」换一个。',
      }
    }

    const c = this.controller()
    if (!c?.prompt) return { ok: false, note: 'DSH 会话服务不可用' }

    const beforeSeq = await this.cursor(sessionId)
    const requestId = randomUUID()
    const content = []
    if (text && text.trim()) content.push({ type: 'text', text })
    for (const image of images ?? []) content.push(image)
    if (content.length === 0) return { ok: false, note: '空指令，未投递' }

    try {
      await c.prompt({
        sessionId,
        content,
        requestId,
        mode: mode === 'steer' ? 'steer' : 'queue',
        clientTimeZone: 'Asia/Shanghai',
      }, new AbortController().signal)
    } catch (err) {
      const msg = err?.message ?? String(err)
      this.logger?.warn?.('[qq-console-v2] prompt 失败：%s', msg)
      return { ok: false, note: `投递失败：${msg}` }
    }

    let records = []
    let userRecord = null
    const deadline = Date.now() + 3000
    for (;;) {
      const page = await this.page(sessionId, { throughSeq: -1 })
      records = page.records ?? []
      userRecord = Sessions.userRecordFor(records, requestId)
      if (userRecord || Date.now() >= deadline) break
      await sleep(250)
    }

    const userSeq = userRecord?.seq ?? beforeSeq
    const tail = (records ?? []).filter((record) => (record?.seq ?? 0) > userSeq)
    const doneEarly = Sessions.turnFinished(tail, 0)
    return {
      ok: true,
      requestId,
      userSeq,
      baselineSeq: beforeSeq,
      awaitingUserRecord: userRecord === null,
      doneEarly,
      note: doneEarly ? '已投递并完成' : '已投递',
    }
  }

  async cancel(sessionId) {
    const c = this.controller()
    if (!c?.cancel) return { ok: false, note: 'DSH 会话服务不支持中断' }
    try {
      await c.cancel({ sessionId })
      return { ok: true, note: '已请求中断当前轮' }
    } catch (err) {
      return { ok: false, note: `中断失败：${err?.message ?? err}` }
    }
  }

  async modelCatalog() {
    const c = this.controller()
    if (!c?.modelCatalog) return { default: null, groups: [], failures: [], routableProviders: [] }
    try {
      const catalog = await c.modelCatalog()
      return normalizeCatalog(catalog)
    } catch (err) {
      this.logger?.warn?.('[qq-console-v2] modelCatalog 失败：%s', err?.message ?? err)
      return { default: null, groups: [], failures: [{ id: 'catalog', name: 'catalog', message: String(err?.message ?? err) }], routableProviders: [] }
    }
  }

  /**
   * 宿主说的「真的能跑」的 provider 白名单。
   * 返回 `null` 表示未知（目录没给），调用方不应据此拦截任何模型。
   */
  async routableProviders() {
    const catalog = await this.modelCatalog()
    const list = Array.isArray(catalog?.routableProviders) ? catalog.routableProviders : []
    return list.length ? new Set(list.map((item) => String(item))) : null
  }

  /** 从实时目录里取某个模型支持的推理强度 id 列表。 */
  async effortsForModel(provider, model) {
    if (!model) return []
    const catalog = await this.modelCatalog()
    for (const group of catalog.groups ?? []) {
      const groupProvider = String(group?.provider ?? group?.id ?? '')
      if (provider && groupProvider && groupProvider !== String(provider)) continue
      for (const item of group?.models ?? []) {
        const id = String(item?.model ?? item?.id ?? item?.name ?? '')
        if (id !== String(model)) continue
        const raw = Array.isArray(item?.reasoning?.efforts)
          ? item.reasoning.efforts
          : Array.isArray(item?.efforts) ? item.efforts : []
        return raw.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean)
      }
    }
    return []
  }

  async selectModel(sessionId, selection) {
    const c = this.controller()
    if (!c?.selectModel) return { ok: false, note: 'DSH 会话服务不支持模型选择' }
    try {
      const result = await c.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.effort ? { reasoningEffort: selection.effort } : {}),
      })
      return { ok: true, selection: result?.selected ?? selection }
    } catch (err) {
      return { ok: false, note: err?.message ?? String(err) }
    }
  }

  async currentModel(sessionId) {
    const page = await this.page(sessionId, { throughSeq: -1 })
    const event = Sessions.lastModelSelection(page.records)
    if (event?.provider && event?.model) return event
    const row = await this.rowFor(sessionId)
    const values = row?.projections?.values ?? row?.projectionValues ?? {}
    const candidate = values.modelSelection ?? values.model ?? null
    if (candidate?.provider && candidate?.model) return candidate
    return null
  }

  async permissionCatalog() {
    const service = this.permissionService()
    if (!service?.catalog) return { supported: false, options: [], defaultPreset: '' }
    try {
      const catalog = service.catalog()
      return {
        supported: true,
        options: Array.isArray(catalog?.options) ? catalog.options : [],
        defaultPreset: String(catalog?.defaultPreset ?? ''),
      }
    } catch (err) {
      return {
        supported: false,
        options: [],
        defaultPreset: '',
        note: String(err?.message ?? err),
      }
    }
  }

  async currentPermission(sessionId) {
    const service = this.permissionService()
    const live = this.liveSession(sessionId)
    if (!service || !live) return ''
    try {
      return String(service.current?.(live) ?? '')
    } catch {
      return ''
    }
  }

  async setPermission(sessionId, preset) {
    const service = this.permissionService()
    const live = await this.ensureLive(sessionId)
    if (!service?.set || !live) {
      return { ok: false, note: 'DSH 权限服务不可用，或会话当前不在运行栈中' }
    }
    try {
      service.set(live, String(preset))
      return { ok: true, preset: String(preset) }
    } catch (err) {
      return { ok: false, note: `切换权限失败：${err?.message ?? err}` }
    }
  }
}

export function normalizeRow(row) {
  if (!row || typeof row !== 'object') return row
  const values = row.projections?.values ?? row.projectionValues ?? {}
  const rawTitle = values?.title
  const title = typeof rawTitle === 'string' && rawTitle !== '' ? rawTitle : undefined
  const id = row.sessionId ?? row.id
  const displayTitle = title ?? row.displayTitle ?? baseName(row.cwd) ?? (id ? String(id) : undefined)
  return {
    ...row,
    ...(id === undefined ? {} : { id }),
    ...(title === undefined ? {} : { title }),
    ...(displayTitle === undefined ? {} : { displayTitle }),
    projectionValues: values,
  }
}

export function baseName(p) {
  if (typeof p !== 'string' || p === '') return undefined
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : undefined
}

function normalizePage(res) {
  /** 新版 DSH 历史页把每条事件包成 `{ type: 'event', event }`；旧版是裸事件。 */
  const unwrap = (record) => (
    record?.type === 'event' && record.event && typeof record.event === 'object'
      ? record.event
      : record
  )
  const rows = Array.isArray(res)
    ? res
    : (res?.records ?? res?.events ?? res?.items ?? [])
  return {
    records: rows.map(unwrap),
    hasMore: Boolean(res?.hasMore),
    asOfSeq: typeof res?.asOfSeq === 'number' ? res.asOfSeq : undefined,
    cursor: typeof res?.cursor === 'number' ? res.cursor : undefined,
  }
}

function normalizeCatalog(value) {
  return {
    default: value?.default ?? null,
    routableProviders: Array.isArray(value?.routableProviders) ? value.routableProviders : [],
    groups: Array.isArray(value?.groups) ? value.groups : [],
    failures: Array.isArray(value?.failures) ? value.failures : [],
  }
}

export function textOf(event) {
  const parts = event?.data?.message?.content ?? event?.data?.content ?? []
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
