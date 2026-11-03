/**
 * 中国法定节假日日历 + 闲时判定。
 *
 * 数据来自 NateScarlet/holiday-cn（每年按国务院放假通知更新）：
 *   https://github.com/NateScarlet/holiday-cn
 *
 * 口径：
 *   - isOffDay=true  → 放假（含周末连休）
 *   - isOffDay=false → 调休上班（周末也要按工作日处理）
 *   - 没有记录的日期 → 周一至周五算工作日，周六周日算周末
 *
 * 缓存落在 `~/.dsh/qq-console-v2/holidays.json`，每天最多刷新一次；
 * 网络失败时继续使用上一次缓存，并在设置页明确标注。
 */

import https from 'node:https'

const DAY_MS = 86_400_000
const VERSION = '2.2.28'
const SOURCES = [
  // 国内网络直连 GitHub raw 时常被重置；优先走 jsDelivr 镜像。
  'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master',
  'https://ghproxy.net/https://raw.githubusercontent.com/NateScarlet/holiday-cn/master',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master',
]
const SOURCE = SOURCES[0]
const REFRESH_EVERY_MS = 6 * 3600_000
const STALE_AFTER_MS = 7 * DAY_MS

export function beijingParts(now = Date.now()) {
  const d = new Date(Number(now) + 8 * 3600_000)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return {
    year,
    month,
    day,
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`节假日数据不是合法 JSON：${err?.message ?? err}`)
  }
}

function getText(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: 20_000,
        headers: {
          accept: 'application/json',
          'user-agent': `dsh-qq-console-v2/${VERSION}`,
        },
      },
      (res) => {
        const status = Number(res.statusCode ?? 0)
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume()
          resolve(getText(new URL(res.headers.location, url).toString(), redirects - 1))
          return
        }
        if (status >= 400) {
          res.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve(text))
      },
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
  })
}

function normalizeYear(payload, expectedYear) {
  if (!payload || typeof payload !== 'object') throw new Error('节假日数据为空')
  const year = Number(payload.year)
  if (year !== expectedYear) throw new Error(`年份不匹配：期望 ${expectedYear}，收到 ${payload.year}`)
  const days = {}
  for (const row of Array.isArray(payload.days) ? payload.days : []) {
    const date = String(row?.date ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    days[date] = {
      name: String(row?.name ?? '').trim(),
      isOffDay: row?.isOffDay === true,
    }
  }
  return {
    year,
    days,
    papers: Array.isArray(payload.papers) ? payload.papers.map(String) : [],
    fetchedAt: new Date().toISOString(),
  }
}

export class HolidayCalendar {
  constructor({ store, logger } = {}) {
    this.store = store
    this.logger = logger
    const saved = store?.load?.('holidays.json', {}) ?? {}
    this.years = saved && typeof saved.years === 'object' && saved.years ? saved.years : {}
    this.updatedAt = String(saved?.updatedAt ?? '')
    this.lastError = String(saved?.lastError ?? '')
    this.timer = null
    this.retryTimer = null
    this.nextRetryAt = ''
    this.refreshing = null
  }

  log(message) {
    if (this.store?.log) this.store.log(`[节假日] ${message}`)
    else this.logger?.info?.('[qq-console-v2] [节假日] %s', message)
  }

  start() {
    if (this.timer) return
    const run = () => {
      this.refresh().catch((err) => this.log(`刷新失败：${err?.message ?? err}`))
    }
    const now = beijingParts()
    if (this.needsRefresh(now)) run()
    this.timer = setInterval(run, REFRESH_EVERY_MS)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 为什么需要「自己定闹钟」而不是只靠 setInterval：
   * 上一年的 12 月，国务院才发下一年的放假通知（通常是 11 月）。只按固定
   * 间隔轮询的话，跨年那一刻手上还没有新年数据，闲时判定会悄悄退回
   * 「周末才算假」，把元旦、春节全当工作日 —— 而闲时闸门的整个意义就是
   * 避开外派的高峰。这里给「下一年数据尚未到位」单独定闹钟，
   * 第二天北京时间 08:10 再试，直到拿到为止（最多补到下一年）。
   *
   * 08:10 是刻意的：闲时判定 08:30 开始启用尾段规则，必须在上班前把当
   * 天的节假日口径定好。
   */
  scheduleTomorrow(now = beijingParts()) {
    clearTimeout(this.retryTimer)
    const next = Date.now() + this.msUntilNextBeijing(8, 10, now)
    this.nextRetryAt = new Date(next).toISOString()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.nextRetryAt = ''
      this.refresh().catch((err) => this.log(`跨年刷新失败：${err?.message ?? err}`))
    }, Math.max(60_000, next - Date.now()))
    this.retryTimer.unref?.()
  }

  /** 从 now 起，到下一个北京时间 hh:mm 的毫秒数。 */
  msUntilNextBeijing(hour, minute, now = beijingParts()) {
    const minsNow = now.hour * 60 + now.minute
    const target = hour * 60 + minute
    const deltaMin = target > minsNow ? target - minsNow : 24 * 60 - minsNow + target
    return deltaMin * 60_000 - (Number(Date.now()) % 60_000)
  }

  stopRetry() {
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.nextRetryAt = ''
  }

  needsRefresh(now = beijingParts()) {
    const current = this.years?.[now.year]
    if (!current || !Object.keys(current.days ?? {}).length) return true
    const updated = Date.parse(this.updatedAt)
    if (!Number.isFinite(updated)) return true
    return Date.now() - updated > DAY_MS
  }

  lookup(date) {
    const key = String(date ?? '').slice(0, 4)
    return this.years?.[key]?.days?.[date] ?? null
  }

  async refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing
    const task = (async () => {
      const now = beijingParts()
      const wanted = [now.year, now.year + 1]
      const years = { ...this.years }
      const loaded = []
      const failed = []
      for (const year of wanted) {
        const existing = years[year]
        const fresh = existing && Date.parse(existing.fetchedAt ?? '') > Date.now() - DAY_MS
        if (!force && fresh) continue
        let lastError = null
        for (const source of SOURCES) {
          try {
            const text = await getText(`${source}/${year}.json`)
            years[year] = normalizeYear(parseJson(text), year)
            loaded.push(year)
            lastError = null
            break
          } catch (err) {
            lastError = err
          }
        }
        if (lastError) {
          // 很常见：下一年的通知还没发布（文件里 days 为空）。保留旧数据即可。
          failed.push({ year, error: String(lastError?.message ?? lastError) })
        }
      }
      // 清理三年前的旧数据，避免文件无限增长。
      for (const key of Object.keys(years)) {
        if (Number(key) < now.year - 2) delete years[key]
      }
      this.years = years
      if (loaded.length) this.updatedAt = new Date().toISOString()
      this.lastError = failed.length
        ? failed.map((x) => `${x.year}: ${x.error}`).join('；').slice(0, 600)
        : ''
      this.store?.save?.('holidays.json', {
        updatedAt: this.updatedAt,
        years: this.years,
        lastError: this.lastError,
      })
      if (loaded.length) this.log(`已更新 ${loaded.join('、')} 年数据（缓存 ${this.updatedAt}）`)
      // 跨年补抓：下一年还没发布就先挂着，第二天再试。
      // 一旦拿到就撤掉闹钟，不再无谓地打扰数据源。
      if (this.timer) {
        const nextYear = now.year + 1
        const haveNext = Object.keys(this.years?.[nextYear]?.days ?? {}).length > 0
        // 元旦前一个月起才值得每天试（11 月发通知）；太早只是白请求。
        if (haveNext || now.month < 11) this.stopRetry()
        else this.scheduleTomorrow(now)
      }
      return {
        ok: loaded.length > 0 || Boolean(this.years?.[now.year]?.days),
        loaded,
        failed,
        error: this.lastError,
        status: this.status(),
      }
    })()
    this.refreshing = task
    try {
      return await task
    } finally {
      if (this.refreshing === task) this.refreshing = null
    }
  }

  status(now = Date.now()) {
    const p = beijingParts(now)
    const info = this.lookup(p.date)
    const updated = Date.parse(this.updatedAt)
    const weekdayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][p.weekday]
    let todayKind = '工作日'
    if (info?.isOffDay === true) todayKind = info.name ? `${info.name}假期` : '法定假日'
    else if (info?.isOffDay === false) todayKind = info.name ? `${info.name}调休上班` : '调休上班'
    else if (p.weekday === 0 || p.weekday === 6) todayKind = '周末'
    return {
      updatedAt: this.updatedAt,
      stale: !Number.isFinite(updated) || Date.now() - updated > STALE_AFTER_MS,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      refreshEveryHours: REFRESH_EVERY_MS / 3600_000,
      years: Object.keys(this.years ?? {})
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b),
      currentYear: p.year,
      hasCurrentYear: Boolean(Object.keys(this.years?.[p.year]?.days ?? {}).length),
      hasNextYear: Boolean(Object.keys(this.years?.[p.year + 1]?.days ?? {}).length),
      retryPending: Boolean(this.retryTimer),
      today: {
        date: p.date,
        weekday: weekdayName,
        name: info?.name ?? '',
        isOffDay: info ? info.isOffDay === true : null,
        isWorkday: info ? info.isOffDay === false : (p.weekday >= 1 && p.weekday <= 5),
        label: todayKind,
      },
      source: SOURCE,
    }
  }
}

/** 北京时间闲时判定。法定假日按周末处理，调休上班日按工作日处理。 */
export function idleState(now = Date.now(), holidays = null) {
  const p = beijingParts(now)
  const mins = p.hour * 60 + p.minute
  const info = holidays?.lookup?.(p.date) ?? null
  const weekend = p.weekday === 0 || p.weekday === 6
  const isOff = info ? info.isOffDay === true : weekend
  const isMakeupWorkday = info ? info.isOffDay === false && weekend : false
  const base = {
    date: p.date,
    weekday: p.weekday,
    name: info?.name ?? '',
    isHoliday: isOff,
    isMakeupWorkday,
  }

  if (isOff) {
    return {
      ...base,
      ok: true,
      reason: info?.name ? `${info.name}假期` : '周末',
      next: '',
      kind: info?.name ? 'holiday' : 'weekend',
    }
  }

  const prefix = isMakeupWorkday ? '调休工作日' : '工作日'
  if (mins < 8 * 60 + 30) {
    return { ...base, ok: true, reason: '早间闲时', next: '', kind: 'offpeak' }
  }
  if (mins < 9 * 60) {
    return { ...base, ok: false, reason: '闲时尾段 8:30-9:00', next: '09:00', kind: 'tail' }
  }
  if (mins < 12 * 60) {
    return { ...base, ok: false, reason: `${prefix}高峰 9:00-12:00`, next: '12:00', kind: 'peak' }
  }
  if (mins < 13 * 60 + 30) {
    return { ...base, ok: true, reason: '午间闲时', next: '', kind: 'offpeak' }
  }
  if (mins < 14 * 60) {
    return { ...base, ok: false, reason: '闲时尾段 13:30-14:00', next: '14:00', kind: 'tail' }
  }
  if (mins < 18 * 60) {
    return { ...base, ok: false, reason: `${prefix}高峰 14:00-18:00`, next: '18:00', kind: 'peak' }
  }
  return { ...base, ok: true, reason: '晚间闲时', next: '', kind: 'offpeak' }
}

