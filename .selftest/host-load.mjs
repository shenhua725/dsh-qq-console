/**
 * 宿主半的真加载测试。
 *
 * `node --check` 只证明语法过得去，证明不了 apply() 能被真的调起来。
 * 这里搭一个最小的 cordis 上下文替身（服务、日志、effect、inject、on），
 * 把 lib/index.js 当真正的 ESM 模块 import 进来并跑 apply()，看：
 *   1. 配置 schema 能不能算出默认值
 *   2. 没配密钥时是否安静降级（不抛、不发网）
 *   3. 五个设置路由是否注册成功、方法保护是否生效
 *   4. AppID / DPAPI 加密 AppSecret 是否能跨重载恢复，明文是否绝不落盘
 *
 * 用真实凭据存储替身（内存实现），不碰用户磁盘。
 */

import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'

// 默认测源目录；但源目录**解析不了 @deepseek-ai peer**（见 deploy.ps1 顶注），
// 所以真正跑得起来的只有部署后的副本。优先用部署位置：
//   DSH_QQ_PLUGIN_DIR 显式指定 > profile\vendor 副本 > 源目录
const SOURCE_ROOT = resolve(import.meta.dirname, '..')

const DEPLOYED = join(
  process.env.USERPROFILE ?? homedir(),
  '.dsh',
  'profiles',
  process.env.DSH_QQ_PROFILE ?? 'desktop',
  'vendor',
  'dsh-qq-console-v2',
)

const ROOT = process.env.DSH_QQ_PLUGIN_DIR
  ? resolve(process.env.DSH_QQ_PLUGIN_DIR)
  : existsSync(join(DEPLOYED, 'package.json'))
    ? DEPLOYED
    : SOURCE_ROOT

const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-qq-console-test-'))
process.env.DSH_HOME = TEST_HOME
process.env.DSH_QQ_TEST_NO_CONNECT = '1'

console.log(`模块目录: ${ROOT}`)
if (ROOT === SOURCE_ROOT) {
  console.log('（源目录通常解析不了 peer，若报 ERR_MODULE_NOT_FOUND 请先跑 deploy.ps1）')
}
console.log('')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ✅ ${name}`)
  } else {
    failures++
    console.log(`  ❌ ${name}${detail ? `  — ${detail}` : ''}`)
  }
}

// ---------------- cordis 上下文替身 ----------------

function makeCtx({ withWebServer = true } = {}) {
  const routes = new Map()
  const effects = []
  const listeners = new Map()
  const logs = []

  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')]),
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
    on(event, fn) {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    get(name) {
      if (name === 'webServer') return withWebServer ? ctx.webServer : undefined
      if (name === 'homePaths') return { dataDir: ':memory:' }
      return undefined
    },
    inject(services, fn) {
      // 只声明 webServer 是可选的：有就注入，没有就跳过（与宿主行为一致）。
      if (services.includes('webServer') && withWebServer) fn(ctx)
    },
  }

  if (withWebServer) {
    ctx.webServer = {
      register(route) {
        if (routes.has(`${route.kind}:${route.path}`)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
        }
        routes.set(`${route.kind}:${route.path}`, route)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    }
  }

  return { ctx, routes, effects, listeners, logs }
}

/** 造一个假的 http req/res，用来打路由。 */
function callRoute(route, { method = 'GET', body } = {}) {
  return new Promise((resolvePromise) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
    let status = 200
    let payload = ''
    const req = {
      method,
      on(event, fn) {
        if (event === 'data') for (const c of chunks) queueMicrotask(() => fn(c))
        if (event === 'end') queueMicrotask(() => fn())
        return req
      },
      destroy() {},
    }
    const res = {
      writeHead(code) {
        status = code
        return res
      },
      end(text) {
        payload = text ?? ''
        resolvePromise({ status, json: payload ? JSON.parse(payload) : undefined })
      },
    }
    route.handler(req, res)
  })
}

// ---------------- 跑起来 ----------------

console.log('DSH QQ 控制台 2.2 · 宿主半加载测试\n')

const mod = await import(pathToFileURL(resolve(ROOT, 'lib/index.js')).href)

// schemastery 的解析入口是 `Schema.resolve(data, schema, options)`，返回
// **[值, 是否被改写过]** 的元组（lib/index.mjs:256）；schema 对象本身没有
// resolve() 方法。整份测试共用这一份解析出来的默认配置。
//
// 注意：必须按 ROOT 解析，不能用裸 specifier —— 测试脚本自己住在源目录
// （F:\...\技能插件\），那里同样解析不到 @deepseek-ai/*。
const { createRequire } = await import('node:module')
const requireFromRoot = createRequire(resolve(ROOT, 'package.json'))
const Schema = requireFromRoot('@deepseek-ai/schemastery').default ?? requireFromRoot('@deepseek-ai/schemastery')
const [resolvedConfig] = Schema.resolve({}, mod.Config, {})

console.log('[1] 模块导出契约')
check('导出 name', typeof mod.name === 'string' && mod.name.length > 0, `name=${mod.name}`)
check('导出 apply', typeof mod.apply === 'function')
check('导出 Config', mod.Config !== undefined)
{
  // 与 cordis.patch.yml 的 insert.name 必须一致
  const fs = await import('node:fs')
  const patch = fs.readFileSync(resolve(ROOT, 'cordis.patch.yml'), 'utf8')
  check('patch 里的 name 与导出 name 一致', patch.includes(`id: ${mod.name}`), patch.trim())
  const pkg = JSON.parse(fs.readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  check('package.json 声明了 bundle.patch', Boolean(pkg.dsh?.bundle?.patch))
  check('package.json 声明了 client.platform=web', pkg.dsh?.client?.platform === 'web')
}

console.log('\n[2] 配置默认值')
{
  const resolved = resolvedConfig
  check('Config 可解析默认值', resolved !== undefined, 'Schema.resolve 返回空')
  if (resolved) {
    const models = resolved.models ?? []
    check('默认模型清单为空（从 DSH 目录添加）', models.length === 0, `实际 ${models.length}`)
    check('progressEvery 默认 10', resolved.progressEvery === 10, String(resolved.progressEvery))
    check('queueWarnAfter 默认 420', resolved.queueWarnAfter === 420, String(resolved.queueWarnAfter))
    check('默认启用', resolved.enabled === true, String(resolved.enabled))
    check('默认要求「控制台」前缀', resolved.requireConsolePrefix === true)
  }
}

console.log('\n[3] 未配密钥时安静降级')
{
  const { ctx, routes, logs } = makeCtx()
  let threw = null
  try {
    mod.apply(ctx, resolvedConfig)
  } catch (err) {
    threw = err
  }
  check('apply 不抛异常', threw === null, threw?.stack ?? '')
  // boot 是异步的，等一拍让它走完
  await new Promise((r) => setTimeout(r, 60))
  check(
    '日志提示未配置',
    logs.some(([lvl, msg]) => lvl === 'info' && msg.includes('未配置')),
    logs.map((l) => l[1]).join(' | '),
  )
  // 5 条 = state / config / secret / menu / status。
  check('无密钥时只注册 5 条路由，不多做别的', routes.size === 5, `注册了 ${routes.size} 条`)
}

console.log('\n[4] 配置路由读写（凭据 DPAPI 持久化）')
{
  const { ctx, routes, listeners } = makeCtx()
  mod.apply(ctx, resolvedConfig)
  await new Promise((r) => setTimeout(r, 60))

  const stateRoute = routes.get('exact:/plugins/dsh-qq-console-v2/state')
  const configRoute = routes.get('exact:/plugins/dsh-qq-console-v2/config')
  const secretRoute = routes.get('exact:/plugins/dsh-qq-console-v2/secret')

  check('注册了 state 路由', Boolean(stateRoute))
  check('注册了 config 路由', Boolean(configRoute))
  check('注册了 secret 路由', Boolean(secretRoute))

  if (stateRoute && configRoute && secretRoute) {
    const s0 = await callRoute(stateRoute)
    check('初始 appId 为空', s0.json?.appId === '', JSON.stringify(s0.json?.appId))
    check('初始 secretConfigured=false', s0.json?.secretConfigured === false, JSON.stringify(s0.json))
    check('初始 models 0 个', s0.json?.models?.length === 0, String(s0.json?.models?.length))

    const saved = await callRoute(configRoute, {
      method: 'POST',
      body: { appId: '1905369728', secret: 'test-secret-value' },
    })
    check('保存返回 200', saved.status === 200, JSON.stringify(saved.json))
    check('保存后 secretConfigured=true', saved.json?.secretConfigured === true)

    const s1 = await callRoute(stateRoute)
    check('state 回读本次运行的 appId', s1.json?.appId === '1905369728', String(s1.json?.appId))
    check('state 不回显密钥值', !JSON.stringify(s1.json).includes('test-secret-value'))

    // AppID 明文保存；AppSecret 只允许以 DPAPI 密文保存。
    const settingsCandidates = [
      join(TEST_HOME, 'qq-console-v2', 'settings.json'),
      join(TEST_HOME, '.dsh', 'qq-console-v2', 'settings.json'),
    ]
    const settingsPath = settingsCandidates.find((p) => existsSync(p)) ?? settingsCandidates[0]
    let disk = ''
    try { disk = readFileSync(settingsPath, 'utf8') } catch { /* 没写就是空 */ }
    check('settings.json 已写入模型清单', disk.includes('"models"'), settingsPath)
    check('settings.json 已写入 appId', disk.includes('"appId": "1905369728"'), disk)
    check('settings.json 已写入 DPAPI 密文', disk.includes('"secretProtected": "dpapi:v1:'), disk)
    check('settings.json 不含明文 secret 字段', !/"secret"\s*:/.test(disk), disk)
    check('settings.json 不含密钥明文', !disk.includes('test-secret-value'))
    check('state 声明凭据已持久化', s1.json?.credentialsPersisted === true)

    // 重新 apply 相当于插件重启：同一 Windows 用户下应恢复凭据。
    const again = makeCtx()
    mod.apply(again.ctx, resolvedConfig)
    await new Promise((r) => setTimeout(r, 300))
    const againState = await callRoute(
      again.routes.get('exact:/plugins/dsh-qq-console-v2/state'),
    )
    check('重载后恢复 appId', againState.json?.appId === '1905369728',
      JSON.stringify(againState.json?.appId))
    check('重载后恢复 secretConfigured', againState.json?.secretConfigured === true)
    check('重载后 state 不回显密钥', !JSON.stringify(againState.json).includes('test-secret-value'))
    again.listeners.get('dispose')?.()

    // webServer.register() 纯按路径匹配、根本不看方法（源码
    // dsh-host-webserver/lib/index.js:177 只存 {kind,path,handler}），
    // 所以「哪个方法合法」必须 handler 自己判。不判的后果是真实的：
    // /secret 无条件删密钥 → 任何一次 GET 都会把 AppSecret 抹掉。
    const getSecret = await callRoute(secretRoute, { method: 'GET' })
    check('GET /secret 回 405（不许用 GET 抹密钥）', getSecret.status === 405, String(getSecret.status))
    const afterGet = await callRoute(stateRoute)
    check('GET /secret 没有真的清掉内存凭据', afterGet.json?.secretConfigured === true)

    const postSecret = await callRoute(secretRoute, { method: 'POST' })
    check('POST /secret 回 405', postSecret.status === 405, String(postSecret.status))
    const afterPost = await callRoute(stateRoute)
    check('POST /secret 没有真的清掉内存凭据', afterPost.json?.secretConfigured === true)

    const getConfig = await callRoute(configRoute)
    check('GET /config 回 405（只收 POST）', getConfig.status === 405, String(getConfig.status))

    const postState = await callRoute(stateRoute, { method: 'POST' })
    check('POST /state 回 405（只收 GET）', postState.status === 405, String(postState.status))

    const cleared = await callRoute(secretRoute, { method: 'DELETE' })
    check('清除密钥返回 200', cleared.status === 200, JSON.stringify(cleared.json))
    check('清除后 appId 为空', cleared.json?.appId === '', JSON.stringify(cleared.json?.appId))
    check('清除后 secretConfigured=false', cleared.json?.secretConfigured === false)
  }

  // 菜单路由：GET 回状态，POST 才重建。网关没连上时应明确报失败而不是假装成功。
  const menuRoute = routes.get('exact:/plugins/dsh-qq-console-v2/menu')
  check('注册了 menu 路由', Boolean(menuRoute))
  if (menuRoute) {
    const g = await callRoute(menuRoute)
    check('menu GET 返回 200', g.status === 200, JSON.stringify(g.json))
    // 网关没起来时 status 也必须是形状完整的对象（回 null 会让卡片误报
    // 「还没注册过」，把「密钥没配」说成「去点刷新」）。
    check('menu GET 回 status 对象', typeof g.json?.status === 'object' && g.json.status !== null,
      JSON.stringify(g.json))
    check('menu GET 的 status 形状完整', g.json?.status?.active === false
      && typeof g.json.status.everySeconds === 'number'
      && typeof g.json.status.note === 'string' && g.json.status.note.length > 0,
      JSON.stringify(g.json?.status))

    const bad = await callRoute(menuRoute, { method: 'DELETE' })
    check('menu 不接受 DELETE（回 405）', bad.status === 405, String(bad.status))

    const noFlag = await callRoute(menuRoute, { method: 'POST', body: {} })
    check('menu POST 缺 refresh 回 400', noFlag.status === 400, `${noFlag.status} ${JSON.stringify(noFlag.json)}`)

    const p = await callRoute(menuRoute, { method: 'POST', body: { refresh: true } })
    check('menu POST 未连网关时回 503', p.status === 503, `${p.status} ${JSON.stringify(p.json)}`)
    check('menu POST 失败时带 note', typeof p.json?.note === 'string' && p.json.note.length > 0,
      JSON.stringify(p.json))
  }

  listeners.get('dispose')?.()
}

console.log('\n[5] 缺 webServer / 禁用时的降级')
{
  const a = makeCtx({ withWebServer: false })
  let threw = null
  try {
    mod.apply(a.ctx, resolvedConfig)
  } catch (err) {
    threw = err
  }
  await new Promise((r) => setTimeout(r, 40))
  check('无 webServer 时不抛', threw === null, threw?.stack ?? '')
  check('无 webServer 时不注册路由', a.routes.size === 0)

  const b = makeCtx()
  threw = null
  try {
    mod.apply(b.ctx, { ...resolvedConfig, enabled: false })
  } catch (err) {
    threw = err
  }
  await new Promise((r) => setTimeout(r, 40))
  check('禁用时不抛', threw === null, threw?.stack ?? '')
  check('禁用时设置页仍可打开（5 条路由）', b.routes.size === 5, `注册了 ${b.routes.size} 条`)
  check('禁用时有明确日志', b.logs.some(([, msg]) => msg.includes('已禁用')),
    b.logs.map((l) => l[1]).join(' | '))
  b.listeners.get('dispose')?.()
}

console.log('\n[6] dispose 清理')
{
  const { ctx, routes, listeners, effects } = makeCtx()
  mod.apply(ctx, resolvedConfig)
  await new Promise((r) => setTimeout(r, 60))
  const dispose = listeners.get('dispose')
  check('注册了 dispose 监听', typeof dispose === 'function')
  if (typeof dispose === 'function') {
    let threw = null
    try {
      dispose()
    } catch (err) {
      threw = err
    }
    check('dispose 不抛', threw === null, threw?.stack ?? '')
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `失败 ${failures} 项`}`)
process.exit(failures === 0 ? 0 : 1)
