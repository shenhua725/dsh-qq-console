/**
 * DSH QQ 控制台 2.2 · 宿主半。
 *
 * 全部在 DSH 进程内运行：QQ 网关 WebSocket 客户端、会话投递、菜单注册、
 * 进度看门狗和设置页路由。AppID 会落盘，AppSecret 使用 Windows DPAPI
 * 加密后落盘；插件重启会自动恢复并立即尝试连接。其它状态落在
 * `~/.dsh/qq-console-v2`，卸载插件不会删用户数据。
 */

import Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import { QqGateway } from './gateway.js'
import { QqConsole } from './console.js'
import { Store } from './store.js'
import { MenuManager } from './menu.js'
import { Sessions } from './sessions.js'
import { HolidayCalendar } from './holidays.js'
import { VoiceTranscriber } from './voice.js'
import {
  splitModelName,
  flattenCatalog,
  mergeCatalogEntries,
  normalizeEffort,
  readWorkbuddyCatalog,
} from './catalog.js'
import { protectSecret, unprotectSecret } from './secure-store.js'

/** loader 项 id，必须与 cordis.patch.yml 里的 id 一致。 */
export const name = 'qq-console-v2'
export const VERSION = '2.2.33'

/**
 * 跨模块实例的单例槽。
 *
 * DSH 热重载/重建 profile 时，旧模块实例的 dispose 不一定会被调用；
 * 如果每个实例都自己连一条 QQ 网关，就会新旧两条同时收消息，同一条
 * 指令被回复两遍。这里在进程级只保留一个活动网关，新实例启动前
 * 先把旧实例停掉。
 */
const GATEWAY_SLOT = Symbol.for('dsh.qq-console-v2.active-gateway')

function claimGateway(gateway) {
  const previous = globalThis[GATEWAY_SLOT]
  if (previous && previous !== gateway) {
    try { previous.stop?.() } catch { /* 旧实例清理失败不阻塞新连接 */ }
  }
  globalThis[GATEWAY_SLOT] = gateway
}

function releaseGateway(gateway) {
  if (gateway && globalThis[GATEWAY_SLOT] === gateway) delete globalThis[GATEWAY_SLOT]
}

const DEFAULT_CONFIG = {
  enabled: true,
  models: [],
  progressEvery: 10,
  queueWarnAfter: 420,
  idleGate: true,
  idleGateAll: true,
  voiceTranscribe: true,
  mediaMaxMB: 200,
  requireConsolePrefix: true,
  menuAutoRefresh: true,
  menuRefreshEvery: 300,
}

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('启用 QQ 控制台。关掉后不再连接 QQ 网关。'),

  models: Schema.array(
    Schema.object({
      short: Schema.string().default(''),
      provider: Schema.string().required(),
      model: Schema.string().required(),
      full: Schema.string().default(''),
      effort: Schema.string().default(''),
      efforts: Schema.array(Schema.string()).default([]),
      origin: Schema.string().default(''),
      sourceLabel: Schema.string().default(''),
    }),
  )
    .default([])
    .description('可选模型（顺序即优先级，第一项为默认）。可在设置卡片里从 DSH 模型目录添加/删除。'),

  progressEvery: Schema.number()
    .default(10)
    .description('实时进度轮询间隔（秒）。'),

  queueWarnAfter: Schema.number()
    .default(420)
    .description('投递后多久仍无回复就提醒一次（秒）。'),

  idleGate: Schema.boolean()
    .default(true)
    .description('闲时闸门总开关（默认开）。它只是「允许用闲时规则」，某个模型是否真的被拦由下面的每模型开关决定，而每模型默认是关。'),

  idleGateAll: Schema.boolean()
    .default(true)
    .description('允许按模型设置闲时闸门。关掉则所有模型都不拦。'),

  voiceTranscribe: Schema.boolean()
    .default(true)
    .description('语音条先在本机离线转写成文字，再按普通消息路由（零 token）。'),

  mediaMaxMB: Schema.number()
    .default(200)
    .description('发送给手机的单文件上限（MB）。'),

  requireConsolePrefix: Schema.boolean()
    .default(true)
    .description('默认消息发绑定会话；只有「控制台 <文字>」才发控制台会话。'),

  menuAutoRefresh: Schema.boolean()
    .default(true)
    .description('自动比对会话清单并刷新 QQ 底部菜单。'),

  menuRefreshEvery: Schema.number()
    .default(300)
    .description('菜单比对间隔（秒），下限 60 秒（平台限 5 QPM）。'),
})

function pick(config, key) {
  const v = config?.[key]
  return v === undefined || v === null ? DEFAULT_CONFIG[key] : v
}

function cleanModels(models) {
  if (!Array.isArray(models)) return []
  const out = []
  for (const m of models) {
    const provider = String(m?.provider ?? '').trim()
    const model = String(m?.model ?? '').trim()
    if (!provider || !model) continue
    const efforts = Array.isArray(m?.efforts)
      ? m.efforts
        .map((e) => normalizeEffort(e)?.id ?? '')
        .filter((e, i, a) => e && a.indexOf(e) === i)
      : []
    const named = splitModelName(String(m?.full ?? '').trim() || model)
    out.push({
      short: String(m?.short ?? '').trim() || model.slice(0, 10),
      provider,
      model,
      full: named.name || model,
      billing: String(m?.billing ?? '').trim() || named.billing,
      effort: String(m?.effort ?? efforts[0] ?? ''),
      efforts,
      origin: String(m?.origin ?? '').trim(),
      sourceLabel: String(m?.sourceLabel ?? '').trim(),
    })
  }
  return out
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const resolved = {
    enabled: pick(config, 'enabled'),
    models: cleanModels(pick(config, 'models')),
    progressEvery: Number(pick(config, 'progressEvery')) || 10,
    queueWarnAfter: Number(pick(config, 'queueWarnAfter')) || 420,
    idleGate: pick(config, 'idleGate') !== false,
    idleGateAll: pick(config, 'idleGateAll') !== false,
    voiceTranscribe: pick(config, 'voiceTranscribe') !== false,
    mediaMaxMB: Math.max(1, Number(pick(config, 'mediaMaxMB')) || 200),
    requireConsolePrefix: pick(config, 'requireConsolePrefix') !== false,
    menuAutoRefresh: pick(config, 'menuAutoRefresh') !== false,
    menuRefreshEvery: Number(pick(config, 'menuRefreshEvery')) || 300,
  }

  let dshHome
  let baseDir
  try {
    dshHome = resolveDshHome()
    baseDir = `${dshHome}/qq-console-v2`
  } catch {
    dshHome = process.env.DSH_HOME ?? `${process.env.USERPROFILE}/.dsh`
    baseDir = `${dshHome}/qq-console-v2`
  }

  const store = new Store(baseDir, logger)
  store.ensure()
  const holidays = new HolidayCalendar({ store, logger })
  if (process.env.DSH_QQ_TEST_NO_CONNECT !== '1') holidays.start()
  const voice = new VoiceTranscriber({ logger })

  let appId = ''
  let appSecret = ''
  let secretProtected = ''
  let credentialLoadError = ''

  // 运行期设置（设置页保存到这里；Cordis 配置只是首次启动的默认值）。
  const saved = store.load('settings.json', {})
  if (Array.isArray(saved.models)) resolved.models = cleanModels(saved.models)
  if (typeof saved.idleGate === 'boolean') resolved.idleGate = saved.idleGate
  if (typeof saved.idleGateAll === 'boolean') resolved.idleGateAll = saved.idleGateAll
  if (typeof saved.voiceTranscribe === 'boolean') resolved.voiceTranscribe = saved.voiceTranscribe
  if (Number(saved.mediaMaxMB) > 0) resolved.mediaMaxMB = Number(saved.mediaMaxMB)
  if (typeof saved.appId === 'string') appId = saved.appId.trim()
  if (typeof saved.secretProtected === 'string' && saved.secretProtected) {
    secretProtected = saved.secretProtected
    try {
      appSecret = unprotectSecret(secretProtected)
    } catch (err) {
      credentialLoadError = `保存的 AppSecret 解密失败：${err?.message ?? err}`
      logger.warn?.('[qq-console-v2] %s', credentialLoadError)
    }
  } else if (typeof saved.secret === 'string' && saved.secret) {
    // 从旧版本或手工配置迁移：立即改成 DPAPI 密文，不再保留明文。
    appSecret = saved.secret
    try {
      secretProtected = protectSecret(appSecret)
    } catch (err) {
      credentialLoadError = `AppSecret 安全保存失败：${err?.message ?? err}`
    }
  }

  const persistSettings = () => {
    const payload = {
      models: resolved.models,
      appId,
      secretProtected,
      idleGate: resolved.idleGate,
      idleGateAll: resolved.idleGateAll,
      voiceTranscribe: resolved.voiceTranscribe,
      mediaMaxMB: resolved.mediaMaxMB,
    }
    store.save('settings.json', payload)
    return payload
  }
  if (Object.hasOwn(saved, 'secret') || (appSecret && !saved.secretProtected)) persistSettings()

  const sessions = new Sessions(ctx, logger, (msg) => store.log(msg))

  let connected = false
  let connecting = false
  let lastConnectError = ''
  let gateway = null
  let console_ = null
  let menu_ = null
  let booting = false

  const menuStatus = () => {
    if (menu_) return menu_.status()
    return {
      active: false,
      auto: resolved.menuAutoRefresh,
      everySeconds: Math.max(60, Number(resolved.menuRefreshEvery) || 300),
      registeredAt: '',
      version: null,
      groups: 0,
      lastError: '',
      note: connected
        ? '菜单管理器尚未就绪（网关刚连上，稍后自动注册）'
        : '网关未连接：请在设置页填写 AppID / AppSecret 并保存。',
    }
  }

  const statePayload = async () => {
    let catalog = { groups: [], default: null, failures: [] }
    try { catalog = await sessions.modelCatalog() } catch { /* 降级为空目录 */ }
    let permissions = { supported: false, options: [], defaultPreset: '' }
    try { permissions = await sessions.permissionCatalog() } catch { /* 降级 */ }
    const liveCatalog = flattenCatalog(catalog, {
      routable: Array.isArray(catalog.routableProviders) && catalog.routableProviders.length
        ? catalog.routableProviders
        : null,
    })
    const cachedCatalog = readWorkbuddyCatalog(dshHome)
    return {
      appId,
      secretConfigured: Boolean(appSecret),
      credentialsPersisted: Boolean(appId && secretProtected),
      credentialLoadError,
      connected,
      connecting,
      connectError: lastConnectError,
      gatewayState: connected
        ? 'connected'
        : lastConnectError
          ? 'error'
          : connecting ? 'connecting' : 'disconnected',
      models: resolved.models,
      defaultModel: resolved.models[0] ?? null,
      idleGate: resolved.idleGate !== false,
      idleGateAll: resolved.idleGateAll !== false,
      idleModels: console_
        ? console_.modelIdleList()
        : resolved.models.map((m) => ({
          provider: m.provider,
          model: m.model,
          key: `${m.provider}/${m.model}`,
          name: m.full || m.model,
          idle: false,
        })),
      voiceTranscribe: resolved.voiceTranscribe !== false,
      voiceTools: voice.describe(),
      mediaMaxMB: resolved.mediaMaxMB,
      holidays: holidays.status(),
      catalog: mergeCatalogEntries(liveCatalog, cachedCatalog),
      catalogStats: {
        live: liveCatalog.length,
        cached: cachedCatalog.length,
      },
      routableProviders: Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [],
      permissionPresets: permissions.options ?? [],
      permissionDefault: permissions.defaultPreset ?? '',
      menu: menuStatus(),
    }
  }

  const boot = async () => {
    if (booting) return
    booting = true
    lastConnectError = ''
    try {
      if (!resolved.enabled) {
        connecting = false
        logger.info?.('[qq-console-v2] 已禁用，不启动网关。')
        return
      }
      if (!appId || !appSecret) {
        connecting = false
        logger.info?.('[qq-console-v2] 未配置凭据，网关未启动。到插件设置卡片填写。')
        return
      }
      if (process.env.DSH_QQ_TEST_NO_CONNECT === '1') {
        connecting = false
        logger.info?.('[qq-console-v2] 测试模式：跳过 QQ 网关连接。')
        return
      }

      console_ = new QqConsole({
        ctx,
        store,
        logger,
        config: resolved,
        sessions,
        holidays,
        voice,
      })
      store.log(`QQ 控制台 v${VERSION} 启动`)
      menu_ = new MenuManager({
        sessions,
        store,
        logger,
        config: resolved,
        gateway: () => gateway,
      })
      console_.attachMenu(menu_)

      gateway = new QqGateway({
        appId,
        secret: appSecret,
        logger,
        store,
        onReady: (info) => {
          logger.info?.('[qq-console-v2] 网关就绪：%s', info?.user?.username ?? appId)
          connected = true
          connecting = false
          lastConnectError = ''
          console_.attach(gateway)
          console_.startWatchdog()
          menu_.start()
        },
        onError: (message) => {
          connected = false
          connecting = true
          lastConnectError = String(message ?? '')
        },
        onClose: (reason) => {
          connected = false
          if (gateway && !gateway.stopped) {
            connecting = true
            if (reason) lastConnectError = String(reason)
          }
        },
        onMessage: (msg) => console_.onMessage(msg),
        onInteraction: (payload, id) => console_.onInteraction(payload, id),
      })
      claimGateway(gateway)
      connecting = true
      gateway.start()
    } catch (err) {
      connected = false
      connecting = false
      lastConnectError = String(err?.message ?? err)
      throw err
    } finally {
      booting = false
    }
  }

  const stopGateway = () => {
    const oldGateway = gateway
    try { console_?.stopWatchdog() } catch { /* ignore */ }
    try { menu_?.stop() } catch { /* ignore */ }
    try { oldGateway?.stop() } catch { /* ignore */ }
    releaseGateway(oldGateway)
    gateway = null
    menu_ = null
    console_ = null
    connected = false
    connecting = false
    lastConnectError = ''
  }

  const waitForConnection = async (timeoutMs = 12_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (connected) return { ok: true, connected: true, error: '' }
      if (lastConnectError) return { ok: false, connected: false, error: lastConnectError }
      if (!connecting) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return {
      ok: connected,
      connected,
      error: connected ? '' : (lastConnectError || '连接超时：12 秒内未收到 QQ 网关 READY'),
    }
  }

  const restartGateway = async (timeoutMs = 12_000) => {
    stopGateway()
    await boot()
    return waitForConnection(timeoutMs)
  }

  void boot().catch((err) => {
    logger.error?.('[qq-console-v2] 启动失败：%s', err?.stack ?? err)
  })

  // ---------------- 设置页路由 ----------------

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 1 << 20) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text.trim()) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch (err) {
          reject(new Error(`请求体不是合法 JSON：${err?.message ?? err}`))
        }
      })
      req.on('error', reject)
    })

  ctx.inject?.(['webServer'], (webCtx) => {
    const methodNotAllowed = (res, allowed) => {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: allowed })
      res.end(JSON.stringify({ error: `method not allowed; use ${allowed}` }))
      return true
    }

    const routes = [
      {
        path: '/plugins/dsh-qq-console-v2/state',
        handler: async (req, res) => {
          if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
          json(res, 200, await statePayload())
        },
      },
      {
        path: '/plugins/dsh-qq-console-v2/config',
        handler: async (req, res) => {
          if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
          try {
            const body = await readBody(req)
            let credentialChanged = false
            let nextAppId = appId
            let nextSecret = appSecret
            let nextSecretProtected = secretProtected
            let nextModels = resolved.models
            if (typeof body.appId === 'string') {
              const value = body.appId.trim()
              if (value !== nextAppId) credentialChanged = true
              nextAppId = value
            }
            if (typeof body.secret === 'string' && body.secret.trim()) {
              nextSecret = body.secret.trim()
              nextSecretProtected = protectSecret(nextSecret)
              credentialChanged = true
            }
            if (Array.isArray(body.models)) {
              nextModels = cleanModels(body.models)
            }
            const nextIdleGate = typeof body.idleGate === 'boolean'
              ? body.idleGate
              : resolved.idleGate !== false
            const nextIdleGateAll = typeof body.idleGateAll === 'boolean'
              ? body.idleGateAll
              : resolved.idleGateAll !== false
            const nextVoice = typeof body.voiceTranscribe === 'boolean'
              ? body.voiceTranscribe
              : resolved.voiceTranscribe !== false
            const nextMediaMax = Number(body.mediaMaxMB) > 0
              ? Math.max(1, Number(body.mediaMaxMB))
              : (Number(resolved.mediaMaxMB) || 200)

            appId = nextAppId
            appSecret = nextSecret
            secretProtected = nextSecretProtected
            resolved.models = nextModels
            resolved.idleGate = nextIdleGate
            resolved.idleGateAll = nextIdleGateAll
            resolved.voiceTranscribe = nextVoice
            resolved.mediaMaxMB = nextMediaMax
            credentialLoadError = ''
            persistSettings()

            // 每模型闲时开关：{ idleModels: [{provider, model, idle}] }
            // 或单发 { idleModel: {provider, model}, idle: true }。
            let idleChanged = false
            if (Array.isArray(body.idleModels) || Array.isArray(body.idleGateModels)) {
              const rows = Array.isArray(body.idleModels) ? body.idleModels : body.idleGateModels
              const map = {}
              for (const row of rows) {
                if (!row?.provider || !row?.model) continue
                if (row.idle === true) map[`${row.provider}/${row.model}`] = true
              }
              store.save('idle_by_model.json', map)
              idleChanged = true
            } else if (body.idleModel?.provider && body.idleModel?.model
              && typeof body.idle === 'boolean') {
              const map = { ...(store.load('idle_by_model.json', {}) ?? {}) }
              const key = `${body.idleModel.provider}/${body.idleModel.model}`
              if (body.idle) map[key] = true
              else delete map[key]
              store.save('idle_by_model.json', map)
              idleChanged = true
            }

            // 删掉的模型要连闲时记录一起清，否则 idle_by_model.json 会不停
            // 攒下已经不存在的 key（换模型换得勤的人尤其明显）。
            if (Array.isArray(body.models) && !Array.isArray(body.idleModels)
              && !Array.isArray(body.idleGateModels) && !body.idleModel) {
              const alive = new Set(
                nextModels.map((m) => `${m.provider}/${m.model}`).filter((k) => k !== '/'),
              )
              const map = store.load('idle_by_model.json', {}) ?? {}
              const kept = {}
              let dropped = 0
              for (const [key, value] of Object.entries(map)) {
                if (alive.has(key)) kept[key] = value
                else dropped += 1
              }
              if (dropped) {
                store.save('idle_by_model.json', kept)
                logger.info?.('[qq-console-v2] 模型删除后清掉 %d 条闲时记录', dropped)
              }
            }

            // 刚关掉闸门时，把已经排在闲时队列里的任务立刻放行一次，
            // 不必等看门狗下一个轮询周期。
            const idleLoosened = (resolved.idleGate === false || nextIdleGateAll === false)
              || (idleChanged && nextIdleGate !== false)
            if (idleLoosened && console_) {
              void console_.tick().catch((err) => {
                logger.warn?.('[qq-console-v2] 关闭闲时闸门后放行队列失败：%s', err?.message ?? err)
              })
            }

            let connection = { ok: Boolean(connected), connected, error: lastConnectError }
            // “保存并连接”是显式连接动作：凭据变化、当前断线或仍在重试时都
            // 立即重建网关；只有已连接且只改模型顺序时才不打断现有连接。
            // 设置页改模型时会带 connect:false —— 那只是存清单，不该顺手
            // 重启网关（尤其是断线状态下，否则每点一次就重连一次）。
            const shouldConnect = body.connect !== false && (credentialChanged || !connected)
            if (shouldConnect) {
              if (appId && appSecret) {
                connection = await restartGateway()
              } else {
                stopGateway()
                connection = {
                  ok: false,
                  connected: false,
                  error: 'AppID 或 AppSecret 不完整，网关未启动',
                }
              }
            }
            json(res, 200, {
              ok: true,
              restartRequired: false,
              connection,
              ...(await statePayload()),
            })
          } catch (err) {
            json(res, 400, { error: String(err?.message ?? err) })
          }
        },
      },
      {
        path: '/plugins/dsh-qq-console-v2/secret',
        handler: async (req, res) => {
          if (req.method !== 'DELETE') return methodNotAllowed(res, 'DELETE')
          try {
            appId = ''
            appSecret = ''
            secretProtected = ''
            credentialLoadError = ''
            persistSettings()
            stopGateway()
            json(res, 200, {
              ok: true,
              ...(await statePayload()),
            })
          } catch (err) {
            json(res, 400, { error: String(err?.message ?? err) })
          }
        },
      },
      {
        path: '/plugins/dsh-qq-console-v2/holidays',
        handler: async (req, res) => {
          if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
          try {
            const body = await readBody(req)
            if (!body.refresh) {
              return json(res, 200, { ok: true, status: holidays.status() })
            }
            const result = await holidays.refresh({ force: Boolean(body.force) })
            json(res, result.ok ? 200 : 503, { ...result, status: holidays.status() })
          } catch (err) {
            json(res, 400, { error: String(err?.message ?? err), status: holidays.status() })
          }
        },
      },
      {
        path: '/plugins/dsh-qq-console-v2/menu',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')
          try {
            if (req.method === 'POST') {
              const body = await readBody(req)
              if (!body.refresh) return json(res, 400, { error: 'POST 需要 {refresh: true}；只读状态请用 GET。' })
              const result = menu_
                ? await menu_.apply({ force: Boolean(body.force) })
                : { ok: false, note: '菜单管理器未启动（网关未连接或未配置密钥）' }
              return json(res, result.ok ? 200 : 503, { ...result, status: menuStatus() })
            }
            json(res, 200, { ok: true, status: menuStatus() })
          } catch (err) {
            json(res, 400, { error: String(err?.message ?? err) })
          }
        },
      },
      {
        path: '/plugins/dsh-qq-console-v2/status',
        handler: async (req, res) => {
          if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
          json(res, 200, await statePayload())
        },
      },
    ]

    const disposers = []
    for (const route of routes) {
      try {
        const dispose = webCtx.webServer.register({
          kind: 'exact',
          path: route.path,
          handler: (req, res) => {
            Promise.resolve(route.handler(req, res)).catch((err) => {
              logger.warn?.('[qq-console-v2] 路由 %s 失败：%s', route.path, err?.message ?? err)
              try { json(res, 500, { error: String(err?.message ?? err) }) } catch { /* 响应已发出 */ }
            })
          },
        })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (err) {
        logger.warn?.('[qq-console-v2] 注册路由 %s 失败：%s', route.path, err?.message ?? err)
      }
    }

    ctx.effect?.(
      () => () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* 卸载清理失败不再抛 */ }
        }
      },
      'dsh-qq-console-v2: web routes',
    )
  })

  ctx.on?.('dispose', () => {
    try { holidays.stop() } catch { /* ignore */ }
    try { holidays.stopRetry() } catch { /* ignore */ }
    stopGateway()
    appId = ''
    appSecret = ''
    logger.info?.('[qq-console-v2] 已停止。')
  })
}

export {
  QqGateway, QqConsole, Store, MenuManager, Sessions,
  HolidayCalendar, VoiceTranscriber,
}
