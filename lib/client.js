/**
 * DSH QQ 控制台 2.2 · 浏览器半（插件设置卡片）。
 *
 * 契约：
 *  - 工厂 id 必须等于包名；`require("react")` 从宿主模块表取。
 *  - 注册到 `plugins.bundle.config`，key = 包名。
 *  - 每个 contribution 都要 guard，单个失败不拖垮整个插件页。
 *  - 与宿主通信走本插件自有同源路由；AppSecret 永不回显。
 */

window.__ModuleLoader__.load({
  id: 'dsh-qq-console-v2',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const BUNDLE_NAME = 'dsh-qq-console-v2'
    const NAME = 'qq-console-v2'

    const CONFIG_PATH = '/plugins/dsh-qq-console-v2/config'
    const STATE_PATH = '/plugins/dsh-qq-console-v2/state'
    const SECRET_PATH = '/plugins/dsh-qq-console-v2/secret'
    const MENU_PATH = '/plugins/dsh-qq-console-v2/menu'
    const HOLIDAYS_PATH = '/plugins/dsh-qq-console-v2/holidays'

    const CLIENT_FAILED = '[dsh-qq-console-v2] 客户端贡献加载失败（宿主半不受影响）：'
    const NOOP_DISPOSER = () => {}

    function guard(label, fn) {
      try {
        return fn()
      } catch (error) {
        console.error(`${CLIENT_FAILED} ${label}`, error)
        return undefined
      }
    }

    const zh = {
      title: 'DSH QQ 控制台 2.2',
      intro: '把手机 QQ 变成 DSH 的遥控器。AppID 与 DPAPI 加密后的 AppSecret 会保存在本机，重启后自动恢复并连接。',
      appIdLabel: 'AppID',
      appIdHint: 'QQ 开放平台 → 开发设置里的机器人 AppID。',
      secretLabel: 'AppSecret',
      secretSet: '✅ 已用 Windows DPAPI 加密保存；永不回显，重启 DSH 后自动恢复。',
      secretUnset: '尚未设置；保存后会用 Windows DPAPI 加密保存在本机。',
      secretKeep: '••••••••（已保存，重新输入可替换）',
      secretNew: '粘贴 AppSecret',
      secretTip: 'AppSecret 在 QQ 开放平台 →「开发设置」里复制；同一页的 Token 不是 AppSecret。',
      invalidCred: '平台拒绝这组凭据（100016）：请到 QQ 开放平台「开发设置」重新复制 AppSecret，必要时点重置；不要复制成 Token，也不要带空格或省略号。',
      save: '保存并连接',
      saving: '保存并连接中…',
      clear: '清除已保存凭据',
      saved: '已保存。',
      savedSecret: '已安全保存，正在立即连接…',
      savedConnected: '✅ 已保存并连接成功。',
      savedConnectFailed: '已保存，但连接失败：{message}',
      savedConnecting: '已保存，正在连接 QQ 网关…',
      cleared: '已保存的凭据已清除，网关已停止。',
      failed: '保存失败：{message}',
      models: '可选模型（{count} 个，第一项为默认）',
      modelsHint: '从实时目录或 WorkBuddy 缓存目录添加；顺序即手机「选择」里的顺序。',
      autoSaved: '✅ 模型与强度已自动保存',
      autoSaveFailed: '模型自动保存失败：{message}',
      catalog: '模型目录（实时 + 插件缓存）',
      catalogEmpty: '模型目录暂时为空（DSH 尚未返回目录）；已保存的 {count} 个模型仍会保留，手机端可以继续选择。',
      catalogCachedHint: '带「缓存·需登录」的模型来自 WorkBuddy；先登录 WorkBuddy 才能真正调用。',
      add: '添加',
      remove: '删除',
      up: '上移',
      down: '下移',
      default: '默认',
      emptyModels: '还没有添加模型。手机端会使用 DSH 会话当前模型。',
      effort: '强度',
      status: '运行状态',
      connected: '🟢 QQ 网关已连接',
      connecting: '🟡 正在连接 QQ 网关…',
      connectFailed: '🔴 连接失败：{message}',
      disconnected: '⚪ QQ 网关未连接',
      notConfigured: '未配置：填好 AppID 与 AppSecret，点「保存并连接」。',
      persisted: '凭据已保存，重启 DSH 后会自动恢复并连接。',
      runtime: '运行设置',
      idleGate: '闲时闸门总开关',
      idleGateHint: '只是允许按模型设闲时。真正拦不拦由模型列表里每一行的「闲时」勾选决定，新加的模型默认关闭。勾上的模型在工作日 9-12 / 14-18 与 8:30-9、13:30-14 不直接外派，进队列等到闲时；法定节假日与调休按官方日历自动判断。',
      idleModels: '每模型的闲时开关（默认关）',
      idleModelsHint: '开关就在下面模型列表里，紧挨着推理强度。手机端发「闲时」也能单独开关。',
      idleModelsEmpty: '还没有模型，先在上面添加。',
      idleRow: '闲时',
      idleRowHint: '勾上＝这只模型在工作时段排队等闲时；不勾＝随时跑。默认不勾。',
      idleSummaryOff: '总开关已关闭，所有模型都随时可用。',
      idleSummaryNone: '当前没有模型开启闲时，全部随时可用。',
      idleSummarySome: '{count} 只模型开启了闲时：{names}',
      idleOn: '开',
      idleOff: '关',
      voiceTranscribe: '语音条本地转写',
      voiceTranscribeHint: '开启：手机语音条先在本机离线转成文字（零 token），再按普通消息路由；音频原件不投给模型。',
      voiceToolsOk: '✅ 本地转写工具就绪（silk / ffmpeg / whisper）。',
      voiceToolsMissing: '⚠️ 本地转写工具不完整，缺：{items}',
      holidays: '法定节假日',
      holidayAuto: '每 {hours} 小时自动比对一次；离开前一年 11 月起每天 08:10 补抓来年安排。',
      holidayLoaded: '已加载 {years} 年数据 · 更新于 {at}',
      holidayMissing: '尚未加载当年数据，当前只按周六/周日判断。',
      holidayToday: '今日：{date} {weekday} · {label}',
      holidayStale: '⚠️ 数据已超过 7 天未刷新，建议点右侧刷新。',
      holidayError: '最近错误：{message}',
      refreshHolidays: '刷新节假日',
      holidayRefreshing: '刷新中…',
      holidayOk: '✅ 节假日数据已刷新。',
      holidayFail: '刷新失败：{message}',
      media: '附件发送',
      mediaHint: '支持图片、视频、语音、文件；任务结果里出现本地文件路径会自动发回手机，也可以发「发送文件 <绝对路径>」。单文件上限 {max}MB。',
      runtimeSaved: '✅ 运行设置已保存',
      runtimeSaveFailed: '运行设置保存失败：{message}',
      menu: '底部菜单栏',
      menuAuto: '自动刷新：每 {seconds} 秒比对一次，有变化才重注册。',
      menuOff: '自动刷新已关闭。',
      menuNever: '还没注册过。点「立即刷新」按当前会话重建。',
      menuAt: '上次注册：{at}（版本 {version}，{groups} 项）',
      refresh: '立即刷新菜单',
      refreshing: '刷新中…',
      menuOk: '✅ 菜单已更新（版本 {version}）。手机上可能需要退出会话再进。',
      menuSkip: '✅ 菜单没变化，无需重注册。',
      menuFail: '刷新失败：{message}',
      help: '手机上发「帮助」看全部指令；底部菜单＝项目 / 对话 / 设置 / 更多。',
    }

    const en = {
      title: 'DSH QQ Console 2.2',
      intro: 'Turn mobile QQ into a remote control for DSH. AppID and a DPAPI-protected AppSecret are stored locally and restored after restart.',
      appIdLabel: 'AppID',
      appIdHint: 'Bot AppID from QQ Open Platform → Development settings.',
      secretLabel: 'AppSecret',
      secretSet: '✅ Saved with Windows DPAPI; never shown. Restored automatically after restart.',
      secretUnset: 'Not set. Saving stores it with Windows DPAPI.',
      secretKeep: '•••••••• (saved; type to replace)',
      secretNew: 'Paste the AppSecret',
      secretTip: 'Copy the AppSecret from QQ Open Platform → Development settings; the Token on the same page is not the AppSecret.',
      invalidCred: 'The platform rejected these credentials (100016). Re-copy the AppSecret from QQ Open Platform → Development settings (reset it if needed); do not paste the Token, spaces or an ellipsis.',
      save: 'Save & connect',
      saving: 'Saving & connecting…',
      clear: 'Clear saved credentials',
      saved: 'Saved.',
      savedSecret: 'Saved securely; connecting now…',
      savedConnected: '✅ Saved and connected.',
      savedConnectFailed: 'Saved, but connection failed: {message}',
      savedConnecting: 'Saved; connecting to the QQ gateway…',
      cleared: 'Saved credentials cleared; gateway stopped.',
      failed: 'Save failed: {message}',
      models: 'Selectable models ({count}; first is default)',
      modelsHint: 'Add from the live catalog or WorkBuddy cache; order is what the phone shows.',
      autoSaved: '✅ Models and effort saved automatically',
      autoSaveFailed: 'Auto-save failed: {message}',
      catalog: 'Model catalog (live + plugin cache)',
      catalogEmpty: 'The model catalog is empty right now (DSH returned no entries); your {count} saved models are kept and still selectable on the phone.',
      catalogCachedHint: 'Rows marked “cache · sign-in required” come from WorkBuddy and need a WorkBuddy sign-in before use.',
      add: 'Add',
      remove: 'Remove',
      up: 'Up',
      down: 'Down',
      default: 'default',
      emptyModels: 'No models added; the phone will use the session’s current model.',
      effort: 'Effort',
      status: 'Status',
      connected: '🟢 QQ gateway connected',
      connecting: '🟡 Connecting to the QQ gateway…',
      connectFailed: '🔴 Connection failed: {message}',
      disconnected: '⚪ QQ gateway not connected',
      notConfigured: 'Not configured: enter AppID and AppSecret, then Save & connect.',
      persisted: 'Credentials are stored and will be restored automatically after a DSH restart.',
      runtime: 'Runtime settings',
      idleGate: 'Idle gate master switch',
      idleGateHint: 'Only permits per-model idle rules. Whether a message is actually held is decided by the "闲时" checkbox on each row of the model list below; newly added models default to off. When a model is checked, workday peaks 9-12 / 14-18 and 8:30-9 / 13:30-14 are queued until idle; official holidays and makeup workdays are applied automatically.',
      idleModels: 'Per-model idle gate (off by default)',
      idleModelsHint: 'The toggle lives on each row of the model list below, right next to the reasoning effort. Sending “闲时” on the phone toggles them too.',
      idleModelsEmpty: 'No models yet — add one above.',
      idleRow: 'Idle',
      idleRowHint: 'Checked = this model queues during working hours; unchecked = always runs. Off by default.',
      idleSummaryOff: 'Master switch is off — every model runs at any time.',
      idleSummaryNone: 'No model has the idle gate on; all run at any time.',
      idleSummarySome: '{count} model(s) idle-gated: {names}',
      idleOn: 'On',
      idleOff: 'Off',
      voiceTranscribe: 'Local voice transcription',
      voiceTranscribeHint: 'On: voice notes are transcribed locally first (zero tokens), then routed as normal text; the audio itself is never sent to the model.',
      voiceToolsOk: '✅ Local ASR tools ready (silk / ffmpeg / whisper).',
      voiceToolsMissing: '⚠️ Local ASR tools incomplete; missing: {items}',
      holidays: 'Public holidays',
      holidayAuto: 'Auto-checks every {hours} hour(s); from November of the previous year it retries daily at 08:10 for the next year.',
      holidayLoaded: 'Loaded {years} year(s) · updated {at}',
      holidayMissing: 'Current-year data is not loaded; only weekends are recognised.',
      holidayToday: 'Today: {date} {weekday} · {label}',
      holidayStale: '⚠️ Data is over 7 days old; refresh recommended.',
      holidayError: 'Last error: {message}',
      refreshHolidays: 'Refresh holidays',
      holidayRefreshing: 'Refreshing…',
      holidayOk: '✅ Holiday data refreshed.',
      holidayFail: 'Refresh failed: {message}',
      media: 'File delivery',
      mediaHint: 'Images, videos, voice and files are supported. Local file paths in a task result are sent automatically; you can also send “发送文件 <absolute path>”. Limit {max} MB per file.',
      runtimeSaved: '✅ Runtime settings saved',
      runtimeSaveFailed: 'Failed to save runtime settings: {message}',
      menu: 'Bottom menu',
      menuAuto: 'Auto-refresh every {seconds}s; re-registers only on change.',
      menuOff: 'Auto-refresh is off.',
      menuNever: 'Never registered. Hit refresh to rebuild.',
      menuAt: 'Last registered: {at} (version {version}, {groups} items)',
      refresh: 'Refresh now',
      refreshing: 'Refreshing…',
      menuOk: '✅ Menu updated (version {version}).',
      menuSkip: '✅ Menu unchanged.',
      menuFail: 'Refresh failed: {message}',
      help: 'Send "help" from the phone; bottom menu = projects / dialog / settings / more.',
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid rgba(128,128,128,0.4)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }

    // 原生 <select> 的展开层由操作系统绘制：深色主题里 color 是浅色，
    // 弹层背景却仍是白色，选项就成了“白底浅字”。显式声明深色配色并把
    // 每个 option 的底色/字色写死，弹层在任何主题下都能看清。
    const selectStyle = { ...inputStyle, colorScheme: 'dark' }
    const optionStyle = { background: '#1f1f1f', color: '#f2f2f2' }
    const groupStyle = { background: '#1f1f1f', color: '#9aa0a6', fontWeight: 600 }

    const buttonStyle = {
      padding: '5px 12px',
      borderRadius: 6,
      cursor: 'pointer',
      border: '1px solid rgba(128,128,128,0.4)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }

    const smallButton = { ...buttonStyle, padding: '2px 8px', fontSize: 12 }

    function Field(props) {
      return React.createElement(
        'label',
        { style: { display: 'block', marginBottom: 12 } },
        React.createElement('div', { style: { fontSize: 13, marginBottom: 4, opacity: 0.85 } }, props.label),
        props.children,
        props.hint
          ? React.createElement('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 4 } }, props.hint)
          : null,
      )
    }

    function QqConsoleConfigPage({ view, t }) {
      const tt = typeof t === 'function' ? t : (key) => key

      if (view === 'summary') return tt('intro')

      // 100016 是 QQ 平台对「AppID / AppSecret 不匹配」的统一回执；原样
      // 展示只会让人以为是插件坏了，这里补一句可执行的去处。
      const explainError = (message) => {
        const text = String(message ?? '')
        if (!/100016|invalid appid or secret/i.test(text)) return text
        return `${text} · ${tt('invalidCred')}`
      }

      const [appId, setAppId] = React.useState('')
      const [secret, setSecret] = React.useState('')
      const [secretSet, setSecretSet] = React.useState(false)
      const [models, setModels] = React.useState([])
      const [catalog, setCatalog] = React.useState([])
      const [connected, setConnected] = React.useState(false)
      const [connecting, setConnecting] = React.useState(false)
      const [connectError, setConnectError] = React.useState('')
      const [credentialsPersisted, setCredentialsPersisted] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [loaded, setLoaded] = React.useState(false)
      const [pick, setPick] = React.useState(0)
      const [pickEffort, setPickEffort] = React.useState('')
      const [menu, setMenu] = React.useState(null)
      const [menuBusy, setMenuBusy] = React.useState(false)
      const [menuNote, setMenuNote] = React.useState('')
      const [idleGate, setIdleGate] = React.useState(true)
      const [idleModels, setIdleModels] = React.useState([])
      const [voiceTranscribe, setVoiceTranscribe] = React.useState(true)
      const [voiceTools, setVoiceTools] = React.useState(null)
      const [holidays, setHolidays] = React.useState(null)
      const [mediaMaxMB, setMediaMaxMB] = React.useState(200)
      const [holidayBusy, setHolidayBusy] = React.useState(false)
      const [holidayNote, setHolidayNote] = React.useState('')

      const applyState = (body, { syncAppId = true, syncModels = true, syncSettings = true } = {}) => {
        if (syncAppId) setAppId(body.appId ?? '')
        setSecretSet(Boolean(body.secretConfigured))
        if (syncModels) setModels(Array.isArray(body.models) ? body.models : [])
        setCatalog(Array.isArray(body.catalog) ? body.catalog : [])
        setConnected(Boolean(body.connected))
        setConnecting(Boolean(body.connecting))
        setConnectError(explainError(body.connectError ?? body.connection?.error ?? ''))
        setCredentialsPersisted(Boolean(body.credentialsPersisted))
        if (syncSettings) {
          setIdleGate(body.idleGate !== false)
          setVoiceTranscribe(body.voiceTranscribe !== false)
        }
        setVoiceTools(body.voiceTools ?? null)
        if (Array.isArray(body.idleModels)) setIdleModels(body.idleModels)
        setHolidays(body.holidays ?? null)
        if (Number(body.mediaMaxMB) > 0) setMediaMaxMB(Number(body.mediaMaxMB))
        if (body.menu) setMenu(body.menu)
      }

      React.useEffect(() => {
        let alive = true
        const loadState = async (syncAppId, syncModels, quiet = false) => {
          try {
            const res = await fetch(STATE_PATH, { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = await res.json()
            if (alive) applyState(body, { syncAppId, syncModels, syncSettings: !quiet })
          } catch (error) {
            // 后台轮询失败（最常见的是插件被停用时路由暂时 404）只说明
            // 这一刻读不到状态，不代表保存失败；把它写成“保存失败”会留下
            // 一条误导性的红字，停用再启用后也不会自己消失。
            if (alive && !quiet) setNote(tt('failed', { message: String(error?.message ?? error) }))
          } finally {
            if (alive) setLoaded(true)
          }
        }
        ;(async () => {
          await loadState(true, true)
          try {
            const res = await fetch(MENU_PATH, { headers: { accept: 'application/json' } })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const body = await res.json()
            if (alive && body.status) setMenu(body.status)
          } catch (error) {
            if (alive) setMenu({ error: String(error?.message ?? error) })
          }
        })()
        const timer = setInterval(() => {
          // 轮询只刷新连接/菜单状态；用户尚未保存的 AppID、模型顺序与强度
          // 不能被后台 state 覆盖。
          if (alive) void loadState(false, false, true)
        }, 2000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const save = async () => {
        setBusy(true)
        setNote('')
        try {
          const res = await fetch(CONFIG_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              appId,
              secret: secret || undefined,
              models,
              idleGate,
              voiceTranscribe,
            }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
          applyState(body)
          if (body.connected) {
            setNote(tt('savedConnected'))
          } else if (body.connectError || body.connection?.error) {
            setNote(tt('savedConnectFailed', {
              message: explainError(body.connectError ?? body.connection?.error),
            }))
          } else if (secret) {
            setSecret('')
            setNote(tt('savedSecret'))
          } else {
            setNote(tt('savedConnecting'))
          }
          if (secret) setSecret('')
        } catch (error) {
          setNote(tt('failed', { message: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }

      const clearSecret = async () => {
        setBusy(true)
        setNote('')
        try {
          const res = await fetch(SECRET_PATH, { method: 'DELETE' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const body = await res.json().catch(() => ({}))
          applyState(body)
          setSecret('')
          setNote(tt('cleared'))
        } catch (error) {
          setNote(tt('failed', { message: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }

      const refreshMenu = async () => {
        setMenuBusy(true)
        setMenuNote('')
        try {
          const res = await fetch(MENU_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refresh: true, force: true }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.ok === false) throw new Error(body.note ?? body.error ?? `HTTP ${res.status}`)
          if (body.status) setMenu(body.status)
          setMenuNote(body.skipped
            ? tt('menuSkip')
            : tt('menuOk', { version: body.version ?? body.status?.version ?? '?' }))
        } catch (error) {
          setMenuNote(tt('menuFail', { message: String(error?.message ?? error) }))
        } finally {
          setMenuBusy(false)
        }
      }

      const saveRuntime = async (patch) => {
        const nextIdle = typeof patch.idleGate === 'boolean' ? patch.idleGate : idleGate
        const nextVoice = typeof patch.voiceTranscribe === 'boolean' ? patch.voiceTranscribe : voiceTranscribe
        const nextIdleModels = Array.isArray(patch.idleModels) ? patch.idleModels : idleModels
        setIdleGate(nextIdle)
        setVoiceTranscribe(nextVoice)
        setIdleModels(nextIdleModels)
        try {
          const res = await fetch(CONFIG_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              idleGate: nextIdle,
              voiceTranscribe: nextVoice,
              idleModels: nextIdleModels.map((m) => ({
                provider: m.provider,
                model: m.model,
                idle: m.idle === true,
              })),
              connect: false,
            }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
          applyState(body)
          setNote(tt('runtimeSaved'))
          setTimeout(() => setNote((prev) => (prev === tt('runtimeSaved') ? '' : prev)), 1800)
        } catch (error) {
          setNote(tt('runtimeSaveFailed', { message: String(error?.message ?? error) }))
        }
      }

      const refreshHolidays = async () => {
        setHolidayBusy(true)
        setHolidayNote('')
        try {
          const res = await fetch(HOLIDAYS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refresh: true, force: true }),
          })
          const body = await res.json().catch(() => ({}))
          if (body.status) setHolidays(body.status)
          if (!res.ok) throw new Error(body.error ?? body.lastError ?? `HTTP ${res.status}`)
          setHolidayNote(tt('holidayOk'))
        } catch (error) {
          setHolidayNote(tt('holidayFail', { message: String(error?.message ?? error) }))
        } finally {
          setHolidayBusy(false)
        }
      }

      const effortOrder = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'off', 'none', '']
      const sortEfforts = (list) => [...new Set(
        (Array.isArray(list) ? list : ['']).map((value) => String(value ?? '')),
      )].sort((a, b) => {
        const ai = effortOrder.indexOf(a)
        const bi = effortOrder.indexOf(b)
        return (ai < 0 ? effortOrder.length : ai) - (bi < 0 ? effortOrder.length : bi)
      })
      const effortLabel = (value) => ({
        minimal: '最低',
        low: '低',
        medium: '中',
        high: '高',
        xhigh: '很高',
        max: '最高',
        off: '强度0（关闭）',
        none: '强度0（关闭）',
        '': '跟随模型',
      }[value] ?? value ?? '跟随模型')
      const current = catalog[pick] ?? null
      const effortOptions = sortEfforts(current?.efforts?.length ? current.efforts : [''])
      const effectivePickEffort = pickEffort || current?.defaultEffort || current?.efforts?.[0] || ''
      const hasCachedCatalog = catalog.some((m) => m.origin === 'cache')
      const formatWhen = (iso) => {
        if (!iso) return '—'
        const date = new Date(iso)
        if (Number.isNaN(date.getTime())) return String(iso)
        return date.toLocaleString('zh-CN', { hour12: false })
      }
      const missingVoiceTools = (voiceTools?.missing ?? []).map((x) => x.name)
      const holidayLine = holidays?.hasCurrentYear
        ? tt('holidayLoaded', {
          years: (holidays.years ?? []).join(' / '),
          at: formatWhen(holidays.updatedAt),
        })
        : tt('holidayMissing')
      const todayLine = holidays?.today
        ? tt('holidayToday', {
          date: holidays.today.date,
          weekday: holidays.today.weekday,
          label: holidays.today.label,
        })
        : ''

      // 模型清单/强度以前只在点「保存并连接」时落盘，很多人加完模型就直接
      // 关页面，DSH 一重启就全没了。这里改成增删改后 350ms 自动保存。
      const autoSaveTimer = React.useRef(null)
      const persistModels = (next) => {
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
        autoSaveTimer.current = setTimeout(async () => {
          try {
            const res = await fetch(CONFIG_PATH, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ models: next, connect: false }),
            })
            const body = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
            setNote(tt('autoSaved'))
            setTimeout(() => setNote((prev) => (prev === tt('autoSaved') ? '' : prev)), 1800)
          } catch (error) {
            setNote(tt('autoSaveFailed', { message: String(error?.message ?? error) }))
          }
        }, 350)
      }

      const addModel = () => {
        if (!current) return
        if (models.some((m) => m.provider === current.provider && m.model === current.model)) {
          setNote('这个模型已经在列表里了。')
          return
        }
        const effort = effectivePickEffort
        const next = [...models, {
          short: current.short,
          provider: current.provider,
          model: current.model,
          full: current.full,
          effort,
          efforts: current.efforts ?? [],
          origin: current.origin ?? '',
          sourceLabel: current.sourceLabel ?? '',
        }]
        setModels(next)
        persistModels(next)
        setPickEffort('')
      }

      const removeModel = (i) => {
        const next = models.filter((_, idx) => idx !== i)
        setModels(next)
        persistModels(next)
      }
      const moveModel = (i, delta) => {
        const j = i + delta
        if (j < 0 || j >= models.length) return
        const next = [...models]
        const [row] = next.splice(i, 1)
        next.splice(j, 0, row)
        setModels(next)
        persistModels(next)
      }
      const setModelEffort = (i, effort) => {
        const next = models.map((m, idx) => (idx === i ? { ...m, effort } : m))
        setModels(next)
        persistModels(next)
      }

      const children = [
        React.createElement('h3', { key: 'h', style: { margin: '0 0 4px' } }, tt('title')),
        React.createElement('p', { key: 'i', style: { fontSize: 13, opacity: 0.75, margin: '0 0 16px' } }, tt('intro')),
        React.createElement(Field, { key: 'aid', label: tt('appIdLabel'), hint: tt('appIdHint') },
        React.createElement('input', {
            style: inputStyle,
            value: appId,
          placeholder: '请输入APPID',
            onChange: (e) => setAppId(e.target.value.trim()),
          })),
        React.createElement(Field, {
          key: 'sec',
          label: tt('secretLabel'),
          hint: `${secretSet ? tt('secretSet') : tt('secretUnset')}　${tt('secretTip')}`,
        }, React.createElement('input', {
          style: inputStyle,
          type: 'password',
          value: secret,
          placeholder: secretSet ? tt('secretKeep') : tt('secretNew'),
          onChange: (e) => setSecret(e.target.value.trim()),
        })),
        React.createElement('div', { key: 'btns', style: { display: 'flex', gap: 8, marginBottom: 16 } },
          React.createElement('button', { onClick: save, disabled: busy || !loaded, style: buttonStyle },
            busy ? tt('saving') : tt('save')),
          secretSet
            ? React.createElement('button', { onClick: clearSecret, disabled: busy, style: buttonStyle }, tt('clear'))
            : null),
      ]

      if (note) {
        children.push(React.createElement('div',
          { key: 'note', style: { fontSize: 13, marginBottom: 12, opacity: 0.85 } }, note))
      }

      children.push(
        React.createElement('div', { key: 'sh', style: { fontSize: 13, opacity: 0.85, marginBottom: 4 } }, tt('status')),
        React.createElement('div', { key: 'sv', style: { fontSize: 13, marginBottom: 8, opacity: 0.9 } },
          connected
            ? tt('connected')
            : connectError
              ? tt('connectFailed', { message: connectError })
              : connecting
                ? tt('connecting')
                : tt('disconnected')),
      )
      if (!secretSet) {
        children.push(React.createElement('div',
          { key: 'nc', style: { fontSize: 12, opacity: 0.7, marginBottom: 16 } }, tt('notConfigured')))
      } else if (credentialsPersisted) {
        children.push(React.createElement('div',
          { key: 'cred', style: { fontSize: 12, opacity: 0.7, marginBottom: 16 } }, tt('persisted')))
      }

      children.push(
        React.createElement('div', { key: 'rh', style: { fontSize: 13, opacity: 0.85, margin: '16px 0 6px' } },
          tt('runtime')),
        React.createElement('label',
          {
            key: 'idleg',
            style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10, cursor: 'pointer' },
          },
          React.createElement('input', {
            type: 'checkbox',
            checked: idleGate,
            onChange: (e) => void saveRuntime({ idleGate: e.target.checked }),
            style: { marginTop: 3, accentColor: '#4f8cff' },
          }),
          React.createElement('span', { style: { flex: 1 } },
            React.createElement('div', { style: { fontSize: 13 } }, tt('idleGate')),
            React.createElement('div', { style: { fontSize: 12, opacity: 0.62, marginTop: 2 } }, tt('idleGateHint')))),
        React.createElement('label',
          {
            key: 'voiceg',
            style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4, cursor: 'pointer' },
          },
          React.createElement('input', {
            type: 'checkbox',
            checked: voiceTranscribe,
            onChange: (e) => void saveRuntime({ voiceTranscribe: e.target.checked }),
            style: { marginTop: 3, accentColor: '#4f8cff' },
          }),
          React.createElement('span', { style: { flex: 1 } },
            React.createElement('div', { style: { fontSize: 13 } }, tt('voiceTranscribe')),
            React.createElement('div', { style: { fontSize: 12, opacity: 0.62, marginTop: 2 } }, tt('voiceTranscribeHint')))),
        React.createElement('div',
          { key: 'vts', style: { fontSize: 12, opacity: 0.72, margin: '2px 0 12px 22px' } },
          voiceTools?.ok
            ? tt('voiceToolsOk')
            : tt('voiceToolsMissing', { items: missingVoiceTools.join('、') || '未知' })),
        // 每个模型的闲时开关已经搬到下方模型行的推理强度旁边（和「添加模型」
        // 在一起），这里只留一句概览，省掉一整块重复的开关列表。
        React.createElement('div', { key: 'idmh', style: { fontSize: 13, opacity: 0.85, margin: '4px 0 2px' } },
          tt('idleModels')),
        React.createElement('div', { key: 'idmi', style: { fontSize: 12, opacity: 0.65, marginBottom: 4 } },
          tt('idleModelsHint')),
        React.createElement('div',
          { key: 'idms', style: { fontSize: 12, opacity: 0.72, marginBottom: 12 } },
          !idleGate
            ? tt('idleSummaryOff')
            : (() => {
              const on = idleModels.filter((x) => x.idle === true)
              return on.length
                ? tt('idleSummarySome', {
                  count: on.length,
                  names: on.map((x) => x.name || x.model).join('、'),
                })
                : tt('idleSummaryNone')
            })()),
        React.createElement('div', { key: 'holh', style: { fontSize: 13, opacity: 0.85, margin: '4px 0 4px' } },
          tt('holidays')),
        React.createElement('div', { key: 'holl', style: { fontSize: 12, opacity: 0.72, marginBottom: 2 } },
          holidayLine),
        React.createElement('div', { key: 'hola', style: { fontSize: 12, opacity: 0.6, marginBottom: 2 } },
          tt('holidayAuto', { hours: holidays?.refreshEveryHours ?? 6 })),
        holidays?.retryPending
          ? React.createElement('div', { key: 'holr', style: { fontSize: 12, opacity: 0.7, marginBottom: 2 } },
            `来年数据还没发布，明天 08:10 再试${holidays.nextRetryAt ? `（${formatWhen(holidays.nextRetryAt)}）` : ''}`)
          : null,
        todayLine
          ? React.createElement('div', { key: 'holtd', style: { fontSize: 12, opacity: 0.72, marginBottom: 2 } },
            todayLine)
          : null,
        holidays?.stale
          ? React.createElement('div', { key: 'holst', style: { fontSize: 12, opacity: 0.8, marginBottom: 2 } },
            tt('holidayStale'))
          : null,
        holidays?.lastError
          ? React.createElement('div', { key: 'holer', style: { fontSize: 12, opacity: 0.7, marginBottom: 2 } },
            tt('holidayError', { message: holidays.lastError }))
          : null,
        React.createElement('div', { key: 'holb', style: { display: 'flex', gap: 8, margin: '6px 0 4px' } },
          React.createElement('button', { onClick: refreshHolidays, disabled: holidayBusy, style: buttonStyle },
            holidayBusy ? tt('holidayRefreshing') : tt('refreshHolidays'))),
        holidayNote
          ? React.createElement('div', { key: 'holn', style: { fontSize: 12, opacity: 0.8, marginBottom: 8 } }, holidayNote)
          : null,
        React.createElement('div', { key: 'medh', style: { fontSize: 13, opacity: 0.85, margin: '12px 0 4px' } },
          tt('media')),
        React.createElement('div', { key: 'med', style: { fontSize: 12, opacity: 0.65, marginBottom: 16 } },
          tt('mediaHint', { max: mediaMaxMB })),
      )

      children.push(
        React.createElement('div', { key: 'mh', style: { fontSize: 13, opacity: 0.85, margin: '16px 0 4px' } },
          tt('models', { count: models.length })),
        React.createElement('div', { key: 'mi', style: { fontSize: 12, opacity: 0.65, marginBottom: 8 } },
          tt('modelsHint')),
      )

      if (models.length) {
        const modelRows = models.map((m, i) => {
          const effortSelect = React.createElement(
            'select',
            {
              style: { ...selectStyle, width: 'auto', padding: '2px 4px' },
              value: m.effort ?? '',
              onChange: (e) => setModelEffort(i, e.target.value),
            },
            sortEfforts(m.efforts?.length ? m.efforts : ['']).map((e) =>
              React.createElement('option', { key: e || 'default', value: e, style: optionStyle }, effortLabel(e))),
          )
          // 这一行的闲时状态。开关一改就立刻落盘，不用等「保存并连接」——
          // 和推理强度是同一套语义：模型加进来默认关，想用才勾。
          const rowKey = `${m.provider}/${m.model}`
          const rowIdle = idleModels.find((x) => x.key === rowKey)?.idle === true
          const idleToggle = React.createElement(
            'label',
            {
              title: tt('idleRowHint'),
              style: {
                display: 'flex', alignItems: 'center', gap: 4, fontSize: 12,
                cursor: idleGate ? 'pointer' : 'not-allowed', opacity: idleGate ? 1 : 0.45,
              },
            },
            React.createElement('input', {
              type: 'checkbox',
              checked: rowIdle,
              disabled: !idleGate,
              onChange: (e) => {
                const on = e.target.checked
                const known = idleModels.some((x) => x.key === rowKey)
                const next = known
                  ? idleModels.map((x) => (x.key === rowKey ? { ...x, idle: on } : x))
                  : [...idleModels, {
                    provider: m.provider,
                    model: m.model,
                    key: rowKey,
                    name: m.full || m.model,
                    idle: on,
                  }]
                void saveRuntime({ idleModels: next })
              },
              style: { accentColor: '#4f8cff', margin: 0 },
            }),
            React.createElement('span', null, tt('idleRow')),
          )
          return React.createElement(
            'div',
            {
              key: `${m.provider}:${m.model}`,
              style: {
                display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                fontSize: 12, padding: '4px 0', borderBottom: '1px solid rgba(128,128,128,0.15)',
              },
            },
            React.createElement('span', { style: { flex: '1 1 160px' } },
              `${i + 1}. ${m.full || m.model}${i === 0 ? ` · ${tt('default')}` : ''}${m.provider ? ` · ${m.provider}` : ''}${m.sourceLabel ? ` · ${m.sourceLabel}` : ''}`),
            effortSelect,
            idleToggle,
            React.createElement('button', { style: smallButton, onClick: () => moveModel(i, -1) }, '↑'),
            React.createElement('button', { style: smallButton, onClick: () => moveModel(i, 1) }, '↓'),
            React.createElement('button', { style: smallButton, onClick: () => removeModel(i) }, tt('remove')),
          )
        })
        children.push(React.createElement('div', { key: 'ml', style: { marginBottom: 8 } }, modelRows))
      } else {
        children.push(React.createElement('div',
          { key: 'me', style: { fontSize: 12, opacity: 0.65, marginBottom: 8 } }, tt('emptyModels')))
      }

      // 模型多起来以后一长条平铺很难找；按 provider + 来源分组渲染成
      // optgroup，value 仍是 catalog 的下标，选中逻辑不变。
      const catalogGroups = []
      const catalogGroupIndex = new Map()
      catalog.forEach((m, i) => {
        const label = `${m.provider}${m.sourceLabel ? ` · ${m.sourceLabel}` : ''}`
        let group = catalogGroupIndex.get(label)
        if (!group) {
          group = { label, items: [] }
          catalogGroupIndex.set(label, group)
          catalogGroups.push(group)
        }
        group.items.push({ m, i })
      })
      const catalogOptions = catalogGroups.map((group) =>
        React.createElement('optgroup', { key: group.label, label: group.label, style: groupStyle },
          group.items.map(({ m, i }) =>
            React.createElement('option', { key: `${m.provider}:${m.model}:${i}`, value: i, style: optionStyle },
              `${m.full || m.model} · ${m.provider}${m.sourceLabel ? ` · ${m.sourceLabel}` : ''}`))))

      const catalogSelect = catalog.length
        ? React.createElement('select', {
          style: { ...selectStyle, flex: '1 1 220px', width: 'auto' },
          value: pick,
          onChange: (e) => {
            const next = Number(e.target.value)
            setPick(next)
            setPickEffort(catalog[next]?.defaultEffort || catalog[next]?.efforts?.[0] || '')
          },
        }, catalogOptions)
        : React.createElement('select', {
          style: { ...selectStyle, flex: '1 1 220px', width: 'auto' },
          disabled: true,
          value: '',
        }, React.createElement('option', { value: '' }, tt('catalogEmpty', { count: models.length })))

      children.push(
        React.createElement('div', { key: 'ch', style: { fontSize: 12, opacity: 0.7, margin: '8px 0 4px' } },
          tt('catalog')),
        React.createElement('div', { key: 'cr', style: { display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' } },
          catalogSelect,
          React.createElement('select', {
            style: { ...selectStyle, width: 'auto', padding: '2px 4px' },
            value: effectivePickEffort,
            onChange: (e) => setPickEffort(e.target.value),
          }, effortOptions.map((e) =>
            React.createElement('option', { key: e || 'default', value: e, style: optionStyle }, effortLabel(e)))),
          React.createElement('button', {
            style: buttonStyle, disabled: !current, onClick: addModel,
          }, tt('add'))),
      )
      if (hasCachedCatalog) {
        children.push(React.createElement('div',
          { key: 'cachehint', style: { fontSize: 12, opacity: 0.65, margin: '-10px 0 16px' } },
          tt('catalogCachedHint')))
      }

      children.push(
        React.createElement('div', { key: 'mnh', style: { fontSize: 13, opacity: 0.85, margin: '16px 0 4px' } },
          tt('menu')),
        React.createElement('div', { key: 'mnd', style: { fontSize: 12, opacity: 0.7, marginBottom: 8 } },
          menu?.error
            ? tt('menuFail', { message: menu.error })
            : menu?.note
              ? menu.note
              : menu?.auto === false
                ? tt('menuOff')
                : menu?.registeredAt
                  ? `${tt('menuAuto', { seconds: menu.everySeconds ?? '?' })} · ${tt('menuAt', {
                    at: menu.registeredAt,
                    version: menu.version ?? '?',
                    groups: menu.groups ?? '?',
                  })}`
                  : tt('menuNever')),
        React.createElement('div', { key: 'mnb', style: { display: 'flex', gap: 8, marginBottom: 8 } },
          React.createElement('button', { onClick: refreshMenu, disabled: menuBusy, style: buttonStyle },
            menuBusy ? tt('refreshing') : tt('refresh'))),
        menuNote
          ? React.createElement('div', { key: 'mnn', style: { fontSize: 12, opacity: 0.8, marginBottom: 8 } }, menuNote)
          : null,
        React.createElement('p', { key: 'hh', style: { fontSize: 12, opacity: 0.6, marginTop: 16 } }, tt('help')),
      )

      return React.createElement('div', { style: { padding: 4 } }, children)
    }

    const inject = ['slots', 'locale']
    const name = NAME

    function apply(ctx) {
      const namespace = 'settings.qq-console-v2'

      guard('settings copy', () => {
        ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-qq-console-v2: settings copy')
      })

      const t = ctx.locale.bind(namespace)
      const label = 'plugins.bundle.config page'

      guard(label, () => {
        ctx.slots.inject(
          'plugins.bundle.config',
          () => guard(label, () => ctx.slots.register(
            { name: 'plugins.bundle.config', key: BUNDLE_NAME, locale: namespace, inject: () => ({ t }) },
            QqConsoleConfigPage,
          )) ?? NOOP_DISPOSER,
        )
      })
    }

    exports.BUNDLE_NAME = BUNDLE_NAME
    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
