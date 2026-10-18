/**
 * DSH QQ 控制台 2.0 · 状态落盘。
 *
 * 所有跨重启需要保留的数据都在这里。写 JSON 时使用同目录临时文件 + rename，
 * 并对 Windows 上瞬时共享冲突做短重试；卸载插件不会删除这个目录，方便重新
 * 安装后继续使用绑定、排队和设置。
 */

import fs from 'node:fs'
import path from 'node:path'

let tmpSeq = 0

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

export class Store {
  constructor(baseDir, logger) {
    this.dir = baseDir
    this.logger = logger
    this.cache = new Map()
  }

  ensure() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
    } catch (err) {
      this.logger?.warn?.('[qq-console-v2] 建状态目录失败 %s：%s', this.dir, err?.message ?? err)
    }
  }

  file(name) {
    return path.join(this.dir, name)
  }

  load(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name)
    let value = fallback
    try {
      value = JSON.parse(fs.readFileSync(this.file(name), 'utf8'))
    } catch {
      value = fallback
    }
    this.cache.set(name, value)
    return value
  }

  save(name, value) {
    this.cache.set(name, value)
    const target = this.file(name)
    const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`
    try {
      this.ensure()
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, target)
          return
        } catch (err) {
          if (i >= 7) throw err
          const until = Date.now() + 12 * (i + 1)
          while (Date.now() < until) { /* short synchronous backoff */ }
        }
      }
    } catch (err) {
      this.logger?.warn?.('[qq-console-v2] 写 %s 失败：%s', name, err?.message ?? err)
      try { fs.unlinkSync(tmp) } catch { /* best effort */ }
    }
  }

  mutate(name, fallback, mutator) {
    const current = clone(this.load(name, fallback))
    const next = mutator(current)
    this.save(name, next)
    return next
  }

  append(name, fallbackArray, row) {
    return this.mutate(name, fallbackArray, (arr) => [...(Array.isArray(arr) ? arr : []), row])
  }

  log(message) {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      this.ensure()
      fs.appendFileSync(this.file('bridge.log'), line, 'utf8')
    } catch { /* logging must never break the gateway */ }
    this.logger?.info?.('[qq-console-v2] %s', message)
  }

  ensureDir(name) {
    const dir = this.file(name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  // ---- 绑定 ----

  binds() {
    return this.load('binds.json', {})
  }

  binding(openid) {
    const row = this.binds()[openid]
    if (!row) return null
    if (typeof row === 'string') return { sessionId: row, boundAt: 0 }
    const sessionId = String(row.sessionId ?? row.id ?? '')
    return sessionId ? { ...row, sessionId } : null
  }

  boundSession(openid) {
    return this.binding(openid)?.sessionId ?? ''
  }

  bind(openid, sessionId, meta = {}) {
    const all = { ...this.binds() }
    if (sessionId) {
      all[openid] = {
        sessionId,
        name: meta.name ?? '',
        cwd: meta.cwd ?? '',
        boundAt: Date.now(),
      }
    } else {
      delete all[openid]
    }
    this.save('binds.json', all)
  }

  // ---- QQ 目标 ----

  targets() { return this.load('targets.json', {}) }

  recordTarget(openid, firstMessage = '') {
    if (!openid) return
    const all = { ...this.targets() }
    if (!all[openid]) {
      all[openid] = { openid, first: String(firstMessage).slice(0, 80), at: Date.now() }
      this.save('targets.json', all)
    }
  }

  lastMessages() { return this.load('lastmsg.json', {}) }

  recordLastMessage(openid, msgId) {
    if (!openid || !msgId) return
    const all = { ...this.lastMessages() }
    all[openid] = { msgId: String(msgId), ts: Date.now() }
    this.save('lastmsg.json', all)
  }

  freshMsgId(openid, maxAgeSeconds = 260) {
    const row = this.lastMessages()[openid]
    if (!row?.msgId) return ''
    if (Date.now() - Number(row.ts ?? 0) > maxAgeSeconds * 1000) return ''
    return row.msgId
  }

  // ---- 任务台账：键 = openid:sessionId ----

  jobs() {
    const value = this.load('jobs.json', {})
    return value && !Array.isArray(value) ? value : {}
  }

  jobKey(openid, sessionId) { return `${openid}:${sessionId}` }
  job(openid, sessionId) { return this.jobs()[this.jobKey(openid, sessionId)] ?? null }

  activeJob(openid, sessionId) {
    const job = this.job(openid, sessionId)
    return job && job.status === 'running' ? job : null
  }

  setJob(openid, sessionId, job) {
    const all = { ...this.jobs() }
    all[this.jobKey(openid, sessionId)] = job
    this.save('jobs.json', all)
    return job
  }

  updateJob(openid, sessionId, patchOrFn) {
    const all = { ...this.jobs() }
    const key = this.jobKey(openid, sessionId)
    const current = all[key]
    if (!current) return null
    const next = typeof patchOrFn === 'function'
      ? patchOrFn(clone(current))
      : { ...current, ...patchOrFn }
    all[key] = next
    this.save('jobs.json', all)
    return next
  }

  deleteJob(openid, sessionId) {
    const all = { ...this.jobs() }
    delete all[this.jobKey(openid, sessionId)]
    this.save('jobs.json', all)
  }

  mutateJobs(fn) {
    const next = fn(this.jobs())
    this.save('jobs.json', next)
    return next
  }

  // ---- 待选 / 排队 / 闲时 ----

  pending() { return this.load('pending.json', {}) }
  pendingFor(openid) { return this.pending()[openid] ?? null }

  setPending(openid, item) {
    const all = { ...this.pending() }
    if (item) all[openid] = item
    else delete all[openid]
    this.save('pending.json', all)
  }

  deferred() { return this.load('deferred.json', []) }

  setDeferred(rows) {
    this.save('deferred.json', Array.isArray(rows) ? rows : [])
  }

  switch() { return this.load('switch.json', {}) }

  setSwitch(openid, action) {
    const all = { ...this.switch() }
    if (action) all[openid] = { action, at: Date.now() }
    else delete all[openid]
    this.save('switch.json', all)
  }

  takeSwitch(openid, maxAgeMs = 15 * 60_000) {
    const row = this.switch()[openid]
    if (!row) return ''
    this.setSwitch(openid, null)
    if (Date.now() - Number(row.at ?? 0) > maxAgeMs) return ''
    return String(row.action ?? '')
  }

  // ---- 会话偏好 ----

  prefs() { return this.load('prefs.json', {}) }
  prefKey(openid, sessionId) { return `${openid}:${sessionId}` }

  pref(openid, sessionId) {
    return this.prefs()[this.prefKey(openid, sessionId)] ?? {}
  }

  setPref(openid, sessionId, patch) {
    const all = { ...this.prefs() }
    const key = this.prefKey(openid, sessionId)
    all[key] = { ...(all[key] ?? {}), ...patch }
    this.save('prefs.json', all)
    return all[key]
  }

  clearPref(openid, sessionId) {
    const all = { ...this.prefs() }
    delete all[this.prefKey(openid, sessionId)]
    this.save('prefs.json', all)
  }

  report(openid, sessionId) {
    return this.pref(openid, sessionId).report ?? 'min5'
  }

  setReport(openid, sessionId, mode) {
    return this.setPref(openid, sessionId, { report: mode })
  }

  // ---- 控制台会话 / 隐藏 ----

  console() { return this.load('console.json', {}) }

  consoleSession(openid) {
    const row = this.console()[openid]
    if (!row) return null
    const sessionId = String(row.sessionId ?? row.id ?? '')
    return sessionId ? { ...row, sessionId } : null
  }

  setConsole(openid, row) {
    const all = { ...this.console() }
    if (row) all[openid] = row
    else delete all[openid]
    this.save('console.json', all)
  }

  hidden() { return this.load('hidden.json', []) }

  hide(sessionId) {
    const set = new Set(this.hidden())
    set.add(String(sessionId))
    this.save('hidden.json', [...set])
  }

  unhide(sessionId) {
    const all = [...new Set(this.hidden())].filter((id) => id !== String(sessionId))
    this.save('hidden.json', all)
  }

  // ---- 模型选择中间态（兼容旧版） ----

  modelPick() { return this.load('model_pick.json', {}) }
  setModelPick(openid, value) {
    const all = { ...this.modelPick() }
    if (value) all[openid] = value
    else delete all[openid]
    this.save('model_pick.json', all)
  }
}

export default Store
