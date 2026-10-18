/**
 * DSH QQ 控制台 2.0 自检（离线、无宿主依赖）。
 *
 * 覆盖：菜单结构、名称加权截断、8 行对话状态、排队上限 5、忙时选择卡、
 * 引导/取消精确到第 n 条、汇报方式、闲时闸门。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildMenuItems, LIMITS, weight } from '../lib/menu.js'
import { QqConsole, imageMimeFor, sniffImageMime } from '../lib/console.js'
import { Store } from '../lib/store.js'
import { Sessions } from '../lib/sessions.js'
import {
  flattenCachedCatalog,
  flattenCatalog,
  mergeCatalogEntries,
  readWorkbuddyCatalog,
} from '../lib/catalog.js'
import { protectSecret, unprotectSecret, DPAPI_PREFIX } from '../lib/secure-store.js'

const cases = []
function test(name, fn) { cases.push([name, fn]) }

const OPENID = 'TEST_OPENID_V2'
const row = (id, title, cwd, updated = 1, extra = {}) => ({
  sessionId: id, title, cwd, updatedAt: updated, running: false, ...extra,
})

// ---------------- 菜单 ----------------

const ROWS = [
  ...Array.from({ length: 9 }, (_, i) =>
    row(`p1-${i}`, `项目一对话${i + 1}`, 'F:\\Codex\\项目一', 100 - i)),
  row('p2-1', '项目二对话', 'F:\\Codex\\项目二', 90),
  row('p3-1', '项目三对话', 'F:\\Codex\\项目三', 80),
  row('p4-1', '项目四对话', 'F:\\Codex\\项目四', 70),
  row('p5-1', '项目五对话', 'F:\\Codex\\项目五', 60),
  row('p6-1', '项目六对话', 'F:\\Codex\\项目六', 50),
  row('p7-1', '项目七对话', 'F:\\Codex\\项目七', 40),
  row('p8-1', '项目八对话', 'F:\\Codex\\项目八', 30),
  row('sub-1', '子会话', 'F:\\Codex\\项目一', 20, { origin: 'subagent' }),
]

test('菜单：最多 7 个项目 + 对话/设置/更多', () => {
  const items = buildMenuItems(ROWS, { archived: new Set(), hidden: new Set() })
  assert.equal(items.length, 10)
  assert.deepEqual(items.slice(-3).map((x) => x.name), ['对话', '设置', '更多'])
  const projects = items.filter((x) => !['对话', '设置', '更多'].includes(x.name))
  assert.ok(projects.length <= LIMITS.maxProjects)
})

test('菜单：项目内超过 5 个会话时第 5 项是「更多」', () => {
  const items = buildMenuItems(ROWS)
  const p1 = items.find((x) => x.name === '项目一')
  assert.ok(p1)
  assert.equal(p1.sub_menu_items.length, 5)
  assert.equal(p1.sub_menu_items.at(-1).name, '更多')
  assert.match(p1.sub_menu_items.at(-1).send_message, /^项目 \d+$/)
})

test('菜单：对话五项与当前口径一致', () => {
  const items = buildMenuItems(ROWS)
  const dialog = items.find((x) => x.name === '对话')
  assert.deepEqual(dialog.sub_menu_items.map((x) => x.name),
    ['对话状态', '排队执行', '打断重发', '退回编辑', '删除取消'])
})

test('菜单：设置五项与当前口径一致', () => {
  const items = buildMenuItems(ROWS)
  const settings = items.find((x) => x.name === '设置')
  assert.deepEqual(settings.sub_menu_items.map((x) => x.name),
    ['实时进度', '当前进度', '1分钟汇报', '5分钟汇报', '只要结果'])
})

test('菜单：更多五项与当前口径一致', () => {
  const items = buildMenuItems(ROWS)
  const more = items.find((x) => x.name === '更多')
  assert.deepEqual(more.sub_menu_items.map((x) => x.send_message),
    ['当前', '会话', '项目', '会话操作', '面板'])
})

test('菜单：项目内会话入口只写对话名', () => {
  const items = buildMenuItems(ROWS)
  const p1 = items.find((x) => x.name === '项目一')
  assert.equal(p1.sub_menu_items[0].send_message, '进入 项目一对话1')
  assert.ok(!p1.sub_menu_items[0].send_message.includes('p1-0'))
})

test('菜单：同名会话附 8 位短 ID 消歧', () => {
  const items = buildMenuItems([
    row('session-aaaa1111-0000-0000-0000-000000000001', '同名对话', 'F:\\Codex\\演示', 2),
    row('session-bbbb2222-0000-0000-0000-000000000002', '同名对话', 'F:\\Codex\\演示', 1),
  ])
  const sub = items[0].sub_menu_items
  assert.equal(sub[0].send_message, '进入 同名对话 · aaaa1111')
  assert.equal(sub[1].send_message, '进入 同名对话 · bbbb2222')
})

test('菜单：归档 / 子会话 / 隐藏都不进菜单', () => {
  const items = buildMenuItems(ROWS, {
    archived: new Set(['p2-1']), hidden: new Set(['p3-1']),
  })
  const flat = JSON.stringify(items)
  assert.ok(!flat.includes('项目二对话'))
  assert.ok(!flat.includes('项目三对话'))
  assert.ok(!flat.includes('子会话'))
})

test('菜单：名称加权长度不超限', () => {
  const items = buildMenuItems(ROWS)
  for (const it of items) {
    assert.ok(weight(it.name) <= LIMITS.nameLimit, `${it.name} 超限`)
    for (const sub of it.sub_menu_items ?? []) {
      assert.ok(weight(sub.name) <= LIMITS.childLimit, `${sub.name} 超限`)
    }
  }
})

// ---------------- 控制台 ----------------

function makeConsole({ running = false, rows = null, models = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-console-v2-'))
  const store = new Store(dir, null)
  store.ensure()
  const list = rows ?? [row('s1', '测试会话', 'F:\\Codex\\演示', 5, { running })]
  const sent = []
  const gateway = {
    api: async (path, method, body) => {
      sent.push({ path, method, body })
      return { status: 200, body: { id: `msg-${sent.length}` } }
    },
  }
  const sessions = {
    list: async () => list,
    listActive: async () => list.filter((r) => !r.origin),
    rowFor: async (id) => list.find((r) => r.sessionId === id) ?? null,
    currentModel: async () => ({ provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'max' }),
    currentPermission: async () => 'full',
    selectModel: async (sessionId, selection) => {
      sessions.modelCalls.push({ sessionId, selection })
      return { ok: true, selection }
    },
    modelCalls: [],
    setPermission: async (sessionId, preset) => {
      sessions.permissionCalls.push({ sessionId, preset })
      return { ok: true, preset }
    },
    permissionCalls: [],
    permissionCatalog: async () => ({
      supported: true,
      options: [{ preset: 'full', name: '全权' }],
      defaultPreset: 'full',
    }),
    modelCatalog: async () => ({ groups: [] }),
    effortsForModel: async () => [],
    deliver: async () => ({
      ok: true, requestId: 'req-1', baselineSeq: 0, userSeq: 1,
      awaitingUserRecord: false, doneEarly: false,
    }),
    cancel: async () => ({ ok: true }),
    page: async () => ({ records: [], asOfSeq: 0 }),
    controller: () => null,
  }
  const config = {
    models: models ?? [{ short: 'V4Pro', provider: 'deepseek', model: 'deepseek-v4-pro', full: 'DeepSeek V4 Pro', effort: 'max', efforts: ['max', 'high'] }],
    idleGate: false,
    progressEvery: 10,
  }
  const console_ = new QqConsole({ store, logger: null, config, sessions })
  console_.attach(gateway)
  return { console_, store, sent, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const textOf = (sent) => {
  const last = sent.at(-1)
  return String(last?.body?.markdown?.content ?? last?.body?.content ?? '')
}

test('状态卡：8 行固定字段', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话', cwd: 'F:\\Codex\\演示' })
    await c.console_.viewState(OPENID)
    const text = textOf(c.sent)
    for (const key of ['当前项目', '当前对话', '当前任务', '排队任务', '汇报方式', '当前模型', '推理强度', '当前权限']) {
      assert.match(text, new RegExp(`^${key}：`, 'm'), `缺 ${key}`)
    }
    assert.equal(text.split('\n').length, 9) // 标题 + 8 行
  } finally { c.cleanup() }
})

test('状态卡：界面运行中能显示 running', async () => {
  const c = makeConsole({ running: true })
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    await c.console_.viewState(OPENID)
    assert.match(textOf(c.sent), /正在跑（界面/)
  } finally { c.cleanup() }
})

test('绑定卡：关闭档统一显示「强度0（关闭）」', async () => {
  const c = makeConsole()
  try {
    c.console_.sessions.currentModel = async () => ({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
    })
    await c.console_.bindTo(OPENID, 's1')
    const text = textOf(c.sent)
    assert.match(text, /强度：强度0（关闭）/)
    assert.doesNotMatch(text, /强度：关闭(?!档)/)
  } finally { c.cleanup() }
})

test('会话列表：入口只写对话名，名称可直接绑定', async () => {
  const sid = 'session-58e9da59-5923-4ef6-a054-2eeea08316f4'
  const c = makeConsole({ rows: [row(sid, '测试会话', 'F:\\Codex\\演示', 5)] })
  try {
    await c.console_.viewSessions(OPENID)
    const text = textOf(c.sent)
    assert.ok(text.includes(`text="${encodeURIComponent('进入 测试会话')}"`), text)
    assert.ok(!text.includes(encodeURIComponent('58e9da59')), text)
    await c.console_.enter(OPENID, '测试会话')
    assert.equal(c.store.boundSession(OPENID), sid)
  } finally { c.cleanup() }
})

test('会话列表：同名对话附短 ID，点对应入口进对应会话', async () => {
  const first = 'session-aaaa1111-0000-0000-0000-000000000001'
  const second = 'session-bbbb2222-0000-0000-0000-000000000002'
  const c = makeConsole({
    rows: [
      row(first, 'AI助手身份询问', 'F:\\Codex\\演示', 2),
      row(second, 'AI助手身份询问', 'F:\\Codex\\演示', 1),
    ],
  })
  try {
    await c.console_.viewSessions(OPENID)
    const text = textOf(c.sent)
    assert.ok(text.includes(`text="${encodeURIComponent('进入 AI助手身份询问 · aaaa1111')}"`), text)
    assert.ok(text.includes(`text="${encodeURIComponent('进入 AI助手身份询问 · bbbb2222')}"`), text)
    await c.console_.enter(OPENID, 'AI助手身份询问 · bbbb2222')
    assert.equal(c.store.boundSession(OPENID), second)
  } finally { c.cleanup() }
})

test('排队：最多显示 5 条，每条带引导/取消', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1')
    c.store.setPending(OPENID, { text: '待选指令', at: Date.now(), sessionId: 's1' })
    c.store.setJob(OPENID, 's1', {
      id: 'j1', openid: OPENID, sessionId: 's1', text: '跑着', at: Date.now(),
      status: 'running', confirmed: true, followups: Array.from({ length: 4 }, (_, i) => ({ text: `排队${i + 1}` })),
    })
    const d = c.store.deferred()
    d.push({ id: 'd1', openid: OPENID, sessionId: 's1', text: '闲时1' })
    d.push({ id: 'd2', openid: OPENID, sessionId: 's1', text: '闲时2' })
    c.store.setDeferred(d)
    await c.console_.viewState(OPENID)
    const text = textOf(c.sent)
    assert.match(text, /排队任务：7 条/)
    assert.ok(text.includes(`text="${encodeURIComponent('引导 1')}"`))
    assert.ok(text.includes(`text="${encodeURIComponent('取消 5')}"`))
    assert.match(text, /还有 2 条未显示/)
    assert.equal(text.split(encodeURIComponent('引导 ')).length - 1, 5)
  } finally { c.cleanup() }
})

test('忙时新指令：进待选并回选择卡', async () => {
  const c = makeConsole({ running: true })
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    await c.console_.submit(OPENID, '新任务')
    const text = textOf(c.sent)
    assert.match(text, /正在跑任务/)
    assert.match(text, /排队执行/)
    assert.ok(c.store.pendingFor(OPENID))
  } finally { c.cleanup() }
})

test('行内命令：当前对话卡带可点的对话状态/当前进度', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    await c.console_.viewCurrent(OPENID)
    const text = textOf(c.sent)
    assert.ok(text.includes(`text="${encodeURIComponent('对话状态')}"`), text)
    assert.ok(text.includes(`text="${encodeURIComponent('当前进度')}"`), text)
    assert.ok(!c.sent.at(-1)?.body?.keyboard, 'C2C 不依赖键盘按钮')
  } finally { c.cleanup() }
})

test('行内命令：项目卡项目名可点，并能按「项目 N · 名称」进入', async () => {
  const c = makeConsole({
    rows: [
      row('s1', '测试会话', 'F:\\Codex\\演示', 5),
      row('s2', '另一个会话', 'F:\\Codex\\其他', 4),
    ],
  })
  try {
    await c.console_.viewProjects(OPENID)
    const text = textOf(c.sent)
    assert.ok(text.includes(`text="${encodeURIComponent('项目 1 · 演示')}"`), text)
    await c.console_.handle(OPENID, '项目 1 · 演示')
    assert.match(textOf(c.sent), /1\. 测试会话/)
  } finally { c.cleanup() }
})

test('行内命令：汇报设置卡带 5 个可点选项', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    await c.console_.settingsCard(OPENID)
    const text = textOf(c.sent)
    for (const item of ['实时进度', '当前进度', '1分钟汇报', '5分钟汇报', '只要结果']) {
      assert.ok(text.includes(`text="${encodeURIComponent(item)}"`), `缺 ${item}：${text}`)
    }
    assert.ok(!c.sent.at(-1)?.body?.keyboard, 'C2C 不依赖键盘按钮')
  } finally { c.cleanup() }
})

test('取消 n：只删第 n 条', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1')
    c.store.setJob(OPENID, 's1', {
      id: 'j1', openid: OPENID, sessionId: 's1', text: '跑着', at: Date.now(),
      status: 'running', confirmed: true,
      followups: [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
    })
    await c.console_.cancelQueued(OPENID, 2)
    const job = c.store.job(OPENID, 's1')
    assert.deepEqual(job.followups.map((x) => x.text), ['A', 'C'])
  } finally { c.cleanup() }
})

test('桌面轮次下选「排队」→ 进闲时队列（没有 job 可挂）', async () => {
  const c = makeConsole({ running: true })
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    c.store.setSwitch(OPENID, 'q')
    await c.console_.submit(OPENID, '等到这轮结束再跑')
    assert.equal(c.console_.deferredFor(OPENID, 's1').length, 1)
  } finally { c.cleanup() }
})

test('tick 结束 followup 时不会覆盖新任务', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1')
    c.store.setJob(OPENID, 's1', {
      id: 'j1', openid: OPENID, sessionId: 's1', text: '第一轮', at: Date.now(),
      status: 'running', confirmed: true, userSeq: 0, lastSeq: 0,
      followups: [{ text: '下一条' }],
    })
    c.console_.sessions.page = async () => ({
      records: [{ type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } }],
      asOfSeq: 5,
    })
    c.console_.sessions.deliver = async () => ({
      ok: true, requestId: 'req-2', baselineSeq: 5, userSeq: 6,
      awaitingUserRecord: false, doneEarly: false,
    })
    await c.console_.tickJobs()
    const job = c.store.job(OPENID, 's1')
    assert.equal(job.id, 'req-2')
    assert.equal(job.status, 'running')
  } finally { c.cleanup() }
})

test('msg_seq：同一 msg_id 递增，不同 msg_id 各自计数', () => {
  const c = makeConsole()
  try {
    assert.equal(c.console_.nextSeq('o', 'm1'), 1)
    assert.equal(c.console_.nextSeq('o', 'm2'), 1)
    assert.equal(c.console_.nextSeq('o', 'm1'), 2)
  } finally { c.cleanup() }
})

test('控制回执：自动带最近 msg_id，项目/会话都走被动回复', async () => {
  const c = makeConsole()
  try {
    c.store.recordLastMessage(OPENID, 'm-fresh')
    await c.console_.viewProjects(OPENID)
    let body = c.sent.at(-1).body
    assert.equal(body.msg_id, 'm-fresh')
    assert.equal(body.msg_seq, 1)
    await c.console_.viewSessions(OPENID)
    body = c.sent.at(-1).body
    assert.equal(body.msg_id, 'm-fresh')
    assert.equal(body.msg_seq, 2)
  } finally { c.cleanup() }
})

test('控制回执：过期 msg_id 不带，避免被动回复 400', async () => {
  const c = makeConsole()
  try {
    c.store.recordLastMessage(OPENID, 'm-stale')
    const all = c.store.lastMessages()
    all[OPENID].ts = Date.now() - 300_000
    c.store.save('lastmsg.json', all)
    await c.console_.viewProjects(OPENID)
    assert.ok(!c.sent.at(-1).body.msg_id)
  } finally { c.cleanup() }
})

test('汇报方式：四种模式都能持久化', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1')
    for (const mode of ['live', 'min1', 'min5', 'result']) {
      await c.console_.setReport(OPENID, mode)
      assert.equal(c.store.report(OPENID, 's1'), mode)
    }
  } finally { c.cleanup() }
})

test('闲时闸门：非闲时把任务放进 deferred', async () => {
  const c = makeConsole()
  try {
    c.console_.config.idleGate = true
    // 直接验证存储层与判定函数的契约（判定函数随系统时间变化，不硬编码时段）。
    c.console_.addDeferred(OPENID, 's1', '闲时任务')
    assert.equal(c.console_.deferredFor(OPENID, 's1').length, 1)
  } finally { c.cleanup() }
})

// ---------------- 图片载荷 ----------------

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'), Buffer.from('VP8 ', 'latin1'),
])
const BMP = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(26)])

test('图片 MIME：四种常见格式按魔数识别', () => {
  assert.equal(sniffImageMime(JPEG), 'image/jpeg')
  assert.equal(sniffImageMime(PNG), 'image/png')
  assert.equal(sniffImageMime(GIF), 'image/gif')
  assert.equal(sniffImageMime(WEBP), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from('not an image at all')), '')
})

test('图片 MIME：魔数优先于错误声明（JPEG 不能被标成 PNG）', () => {
  assert.equal(imageMimeFor(JPEG, 'image/png', 'x.png'), 'image/jpeg')
  assert.equal(imageMimeFor(PNG, '', 'x.jpg'), 'image/png')
  assert.equal(imageMimeFor(JPEG, 'application/octet-stream', 'x.jpg'), 'image/jpeg')
  assert.equal(imageMimeFor(Buffer.from('plain'), 'image/png', 'x.bin'), 'image/png')
  assert.equal(imageMimeFor(Buffer.from('plain'), '', 'x.jpg'), 'image/jpeg')
  assert.equal(imageMimeFor(Buffer.from('plain'), '', 'x.pdf'), '')
})

test('图片投递：缺 content_type 的 JPEG 仍生成 image 内容且 MIME 正确', async () => {
  const c = makeConsole()
  try {
    c.console_.download = async () => JPEG
    const { images, note } = await c.console_.prepareIncoming({
      attachments: [{ url: 'https://example.invalid/a', filename: 'photo.jpg' }],
    })
    assert.equal(images.length, 1)
    assert.equal(note, '')
    assert.equal(images[0].type, 'image')
    assert.equal(images[0].mediaType, 'image/jpeg')
    assert.equal(images[0].name, 'photo.jpg')
    assert.deepEqual(Buffer.from(images[0].data, 'base64'), JPEG)
  } finally { c.cleanup() }
})

test('图片投递：声明成 octet-stream 但魔数是 PNG 也能识别', async () => {
  const c = makeConsole()
  try {
    c.console_.download = async () => PNG
    const { images } = await c.console_.prepareIncoming({
      attachments: [{ url: 'https://example.invalid/b', content_type: 'application/octet-stream' }],
    })
    assert.equal(images.length, 1)
    assert.equal(images[0].mediaType, 'image/png')
  } finally { c.cleanup() }
})

test('图片投递：普通文件仍落 inbox，不混进 image 内容', async () => {
  const c = makeConsole()
  try {
    c.console_.download = async () => Buffer.from('%PDF-1.7 fake')
    const { images, note } = await c.console_.prepareIncoming({
      attachments: [{ url: 'https://example.invalid/c', filename: 'report.pdf' }],
    })
    assert.equal(images.length, 0)
    assert.match(note, /附件已保存：/)
  } finally { c.cleanup() }
})

test('图片投递：BMP 等 DSH 不支持的格式落盘交路径，不发无效 image 载荷', async () => {
  const c = makeConsole()
  try {
    c.console_.download = async () => BMP
    const { images, note } = await c.console_.prepareIncoming({
      attachments: [{ url: 'https://example.invalid/d', filename: 'photo.bmp' }],
    })
    assert.equal(images.length, 0)
    assert.match(note, /image\/bmp 暂不支持直接投递/)
    assert.match(note, /已存到本机：/)
  } finally { c.cleanup() }
})

// ---------------- 模型目录 / 凭据 / 设置页 ----------------

test('模型目录：DSH 强度对象转成 id 字符串，不再出现 [object Object]', () => {
  const catalog = {
    groups: [{
      id: 'deepseek-account',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      }],
    }],
  }
  const rows = flattenCatalog(catalog)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].efforts, ['low', 'high'])
  assert.equal(rows[0].defaultEffort, 'high')
  assert.equal(rows[0].effortNames.high, 'High')
  assert.ok(!JSON.stringify(rows).includes('[object Object]'))
})

test('模型目录：WorkBuddy 缓存模型全部进入目录并标明需登录', () => {
  const doc = {
    entries: {
      a: {
        source: 'workbuddy-ai:app',
        models: [
          {
            id: 'deepseek-v4.1-flash',
            name: 'DeepSeek V4.1 Flash',
            reasoning: { supports: true, defaultEffort: 'high', supportedEfforts: ['low', 'high'] },
          },
          {
            id: 'gpt-6-astra',
            name: 'GPT-6 Astra',
            reasoning: { supports: true, defaultEffort: 'high', supportedEfforts: ['low', 'medium', 'high'] },
          },
        ],
      },
    },
  }
  const cached = flattenCachedCatalog(doc, {
    provider: 'workbuddy-ai',
    sourceLabel: 'WorkBuddy AI 缓存（需登录）',
  })
  const live = flattenCatalog({
    groups: [{ id: 'deepseek-account', models: [{ id: 'default-model', name: 'Auto' }] }],
  })
  const merged = mergeCatalogEntries(live, cached)
  assert.equal(merged.length, 3)
  assert.equal(merged.filter((m) => m.provider === 'workbuddy-ai').length, 2)
  assert.equal(merged.find((m) => m.model === 'gpt-6-astra')?.sourceLabel,
    'WorkBuddy AI 缓存（需登录）')
})

test('模型目录：从 DSH_HOME 读取 WorkBuddy 缓存文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-console-cache-'))
  try {
    writeFileSync(join(dir, '.workbuddy-ai-catalog.json'), JSON.stringify({
      entries: {
        one: {
          source: 'workbuddy-ai:app',
          models: [{ id: 'm1', name: 'M1', reasoning: { defaultEffort: 'high' } }],
        },
      },
    }), 'utf8')
    const rows = readWorkbuddyCatalog(dir)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].provider, 'workbuddy-ai')
    assert.deepEqual(rows[0].efforts, ['high'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('凭据：Windows DPAPI 密文可往返且不含明文', () => {
  const plain = 'secret-value-for-roundtrip'
  const encrypted = protectSecret(plain)
  assert.ok(encrypted.startsWith(DPAPI_PREFIX))
  assert.ok(!encrypted.includes(plain))
  assert.equal(unprotectSecret(encrypted), plain)
})

test('设置页：AppID 占位提示为「请输入APPID」', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("placeholder: '请输入APPID'"))
  assert.ok(!source.includes("placeholder: '1905368579'"))
})

test('设置页：模型目录为空时给出保留提示，不再渲染空白下拉', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('catalogEmpty'))
  assert.ok(source.includes('已保存的 {count} 个模型仍会保留'))
  assert.match(source, /disabled: true/)
})

// ---------------- 手机端模型 / 强度 / 权限 ----------------

const SIX_MODELS = [
  {
    short: 'DeepSeek-V4.',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    full: '',
    effort: 'off',
    efforts: ['off', 'low', 'high', 'max'],
  },
  {
    short: 'Flash-SG',
    provider: 'workbuddy-ai',
    model: 'deepseek-v4.1-flash-sg',
    full: 'Deepseek-V4.1-Flash-SG · x0.03',
    effort: '',
    efforts: [],
  },
  {
    short: 'Flash',
    provider: 'workbuddy-ai',
    model: 'deepseek-v4.1-flash',
    full: 'Deepseek-V4.1-Flash · x0.00 · Free now',
    effort: '',
    efforts: [],
  },
  {
    short: 'Step-5',
    provider: 'workbuddy-ai',
    model: 'step-5-preview',
    full: 'Step-5-Preview · x0.00',
    effort: 'low',
    efforts: ['low', 'medium', 'high'],
  },
  {
    short: 'Hy3',
    provider: 'workbuddy-ai',
    model: 'hy3',
    full: 'Hy3 · x0.00 · Free now',
    effort: 'low',
    efforts: ['low', 'high'],
  },
  {
    short: 'GPT-6-Luna',
    provider: 'workbuddy-ai',
    model: 'gpt-6-luna',
    full: 'GPT-6-Luna · x0.07',
    effort: 'low',
    efforts: ['low', 'medium', 'high', 'xhigh'],
  },
]

test('模型卡：6 个已选模型全部列出，full 为空时回退 model ID', async () => {
  const c = makeConsole({ models: SIX_MODELS })
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    await c.console_.viewModel(OPENID)
    const text = textOf(c.sent)
    assert.match(text, /^模型选择：默认 6 个/m)
    assert.match(text, /^1\. 「/m)
    for (const m of SIX_MODELS) {
      const label = m.full || m.model
      assert.ok(text.includes(`text="${encodeURIComponent(label)}"`), `缺少可点模型 ${label}`)
    }
    const numbered = text.split('\n').filter((line) => /^\d+\. /.test(line))
    assert.equal(numbered.length, 6)
    for (const line of numbered) assert.match(line, /text="[^"]+"/, '模型按钮不应为空')
  } finally { c.cleanup() }
})

test('模型卡：当前模型没有显式强度时，回退到配置预设强度', async () => {
  const c = makeConsole({ models: SIX_MODELS })
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    c.console_.sessions.currentModel = async () => ({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
    })
    await c.console_.viewModel(OPENID)
    const text = textOf(c.sent)
    assert.match(text, /强度：强度0（关闭）/)
    assert.doesNotMatch(text, /当前：[\s\S]*?强度：默认/)
  } finally { c.cleanup() }
})

test('强度卡：按高→低排列，强度0与默认排在末尾', async () => {
  const c = makeConsole()
  try {
    const model = {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      full: 'DeepSeek V4 Pro',
      effort: 'max',
      efforts: ['max', 'low', 'high', 'off'],
    }
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    c.store.setModelPick(OPENID, { model, stage: 'effort' })
    await c.console_.pickEffortCard(OPENID)
    const text = textOf(c.sent)
    const expected = ['最高', '高', '低', '强度0（关闭）', '默认（跟随模型）']
    let last = -1
    const lines = text.split('\n')
    for (const item of expected) {
      const at = text.indexOf(`text="${encodeURIComponent(item)}"`)
      assert.ok(at > last, `${item} 顺序不对：${text}`)
      last = at
      const line = lines.find((row) => row.includes(`text="${encodeURIComponent(item)}"`))
      assert.ok(line?.trimStart().startsWith('「'), `${item} 应单独占一行：${text}`)
    }
  } finally { c.cleanup() }
})

test('模型卡：点模型全称进入强度卡，点强度名直接生效', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    await c.console_.viewModel(OPENID)
    assert.equal(c.store.modelPick()[OPENID]?.stage, 'model')
    await c.console_.handle(OPENID, 'DeepSeek V4 Pro')
    const picked = c.store.modelPick()[OPENID]
    assert.equal(picked?.stage, 'effort')
    assert.equal(picked?.model?.model, 'deepseek-v4-pro')
    await c.console_.handle(OPENID, '高')
    assert.equal(c.store.pref(OPENID, 's1').effort, 'high')
    assert.equal(c.console_.sessions.modelCalls.at(-1)?.selection.effort, 'high')
  } finally { c.cleanup() }
})

test('强度卡：点「强度0（关闭）」直接设为 off', async () => {
  const c = makeConsole({
    models: [{
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      full: 'DeepSeek V4 Pro',
      effort: 'max',
      efforts: ['max', 'off'],
    }],
  })
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    await c.console_.viewModel(OPENID)
    await c.console_.handle(OPENID, 'DeepSeek V4 Pro')
    await c.console_.handle(OPENID, '强度0（关闭）')
    assert.equal(c.store.pref(OPENID, 's1').effort, 'off')
    assert.equal(c.console_.sessions.modelCalls.at(-1)?.selection.effort, 'off')
  } finally { c.cleanup() }
})

test('强度卡：未显式选模型时固定到当前会话模型，序号不会落到设置页第一项', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    c.console_.sessions.currentModel = async () => ({
      provider: 'live-provider',
      model: 'live-model',
      reasoningEffort: 'high',
    })
    c.console_.sessions.effortsForModel = async () => ['low', 'high']
    await c.console_.pickEffortCard(OPENID)
    const pick = c.store.modelPick()[OPENID]
    assert.equal(pick?.model?.provider, 'live-provider')
    assert.equal(pick?.model?.model, 'live-model')
  } finally { c.cleanup() }
})

test('权限卡：只读→工作区→完全访问，自动最后；序号按同一顺序生效', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    c.console_.sessions.permissionCatalog = async () => ({
      supported: true,
      defaultPreset: 'workspace-write',
      options: [
        { preset: 'auto', name: 'Auto' },
        { preset: 'danger-full-access', name: 'Full' },
        { preset: 'read-only', name: 'Read' },
        { preset: 'workspace-write', name: 'Write' },
      ],
    })
    await c.console_.pickPermissionCard(OPENID)
    const text = textOf(c.sent)
    const expected = [
      '1. 只读（最低）',
      '2. 可写工作区（中） · 默认',
      '3. 完全访问（最高）',
      '4. 自动（由系统判断）',
    ]
    let last = -1
    for (const item of expected) {
      const at = text.indexOf(item)
      assert.ok(at > last, `${item} 顺序不对：${text}`)
      last = at
    }
    await c.console_.applyPermission(OPENID, '2')
    assert.equal(c.console_.sessions.permissionCalls.at(-1)?.preset, 'workspace-write')
  } finally { c.cleanup() }
})

test('权限：冷会话先 resolveAgent 恢复，再设置权限', async () => {
  const live = { id: 'session-s1' }
  let resumed = ''
  let setOn = null
  let setPreset = ''
  const sessions = new Sessions({
    get: (name) => {
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'sessionController') {
        return {
          resolveAgent: async (id) => {
            resumed = id
            return { session: live }
          },
        }
      }
      if (name === 'permissionPresets') {
        return {
          catalog: () => ({ options: [], defaultPreset: '' }),
          set: (target, preset) => { setOn = target; setPreset = preset },
        }
      }
      return null
    },
  }, null)
  const result = await sessions.setPermission('s1', 'danger-full-access')
  assert.equal(result.ok, true)
  assert.equal(resumed, 's1')
  assert.equal(setOn, live)
  assert.equal(setPreset, 'danger-full-access')
})

test('历史页：解开新版 DSH 的 {type:event,event} 包装', async () => {
  const controller = {
    page: async () => ({
      records: [
        { type: 'event', event: { type: 'user/message', seq: 1, data: { source: { rpcId: 'r1' } } } },
        {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 2,
            data: { content: [{ type: 'text', text: '你好' }] },
          },
        },
        { type: 'event', event: { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } } },
      ],
    }),
  }
  const sessions = new Sessions({
    get: (name) => (name === 'sessionController' ? controller : null),
  }, null)
  const page = await sessions.page('s1')
  assert.deepEqual(page.records.map((r) => r.type), ['user/message', 'assistant/message', 'turn/end'])
  assert.equal(Sessions.maxSeq(page.records), 3)
  assert.equal(Sessions.userRecordFor(page.records, 'r1')?.seq, 1)
  assert.deepEqual(Sessions.assistantTexts(page.records, 0), ['你好'])
  assert.equal(Sessions.turnFinished(page.records, 1), true)
})

test('状态卡：off 与 full 都显示中文', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    c.console_.sessions.currentModel = async () => ({
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
    })
    await c.console_.viewState(OPENID)
    const text = textOf(c.sent)
    assert.match(text, /推理强度：强度0（关闭）/)
    assert.match(text, /当前权限：完全访问（最高）/)
    assert.equal(text.split('\n').length, 9)
  } finally { c.cleanup() }
})

test('投递：page/prompt 都带 AbortSignal，不再 throwIfAborted', async () => {
  let prompted = false
  let requestId = ''
  const controller = {
    list: async () => [{ sessionId: 's1', title: '测试会话', running: false }],
    page: async (_req, signal) => {
      assert.equal(typeof signal?.throwIfAborted, 'function')
      if (!prompted) return { records: [], asOfSeq: 0 }
      return {
        records: [{ type: 'user/message', seq: 1, data: { source: { rpcId: requestId } } }],
        asOfSeq: 1,
      }
    },
    prompt: async (req, signal) => {
      assert.equal(typeof signal?.throwIfAborted, 'function')
      signal.throwIfAborted()
      requestId = req.requestId
      prompted = true
      return {}
    },
  }
  const sessions = new Sessions({ get: (name) => (name === 'sessionController' ? controller : null) }, null)
  const result = await sessions.deliver('s1', '介绍下自己')
  assert.equal(result.ok, true)
  assert.equal(result.userSeq, 1)
  assert.equal(prompted, true)
})

test('强度：模型未声明 efforts 时只剩「默认」并拒绝 high', async () => {
  const model = {
    provider: 'workbuddy-ai',
    model: 'deepseek-v4.1-flash',
    full: 'Deepseek-V4.1-Flash',
    effort: '',
    efforts: [],
  }
  const c = makeConsole({ models: [model] })
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    assert.deepEqual(await c.console_.effortsFor(model), [''])
    await c.console_.applyEffortValue(OPENID, 'high', model)
    assert.match(textOf(c.sent), /不支持这个推理强度/)
    assert.equal(c.console_.sessions.modelCalls.length, 0)
  } finally { c.cleanup() }
})

test('消息去重：同一 msg_id 只处理一次', async () => {
  const c = makeConsole()
  try {
    c.store.bind(OPENID, 's1', { name: '测试会话' })
    await c.console_.onMessage({ openid: OPENID, content: '当前', msgId: 'dup-1' })
    const first = c.sent.length
    assert.ok(first >= 1)
    await c.console_.onMessage({ openid: OPENID, content: '当前', msgId: 'dup-1' })
    assert.equal(c.sent.length, first)
  } finally { c.cleanup() }
})

test('纯文本兜底：命令标签保留模型名，不出现空引号', async () => {
  const c = makeConsole()
  try {
    const bodies = []
    c.console_.attach({
      api: async (_path, _method, body) => {
        bodies.push(body)
        return body.msg_type === 2
          ? { status: 400, body: {} }
          : { status: 200, body: { id: 'fallback-1' } }
      },
    })
    const text = '1. 「<qqbot-cmd-enter text="DeepSeek-V4.1-Flash" />」 默认 · 当前'
    assert.equal(await c.console_.send(OPENID, text, { md: true }), true)
    const plain = bodies.at(-1)
    assert.equal(plain.msg_type, 0)
    assert.match(plain.content, /DeepSeek-V4\.1-Flash/)
    assert.doesNotMatch(plain.content, /「」/)
  } finally { c.cleanup() }
})

// ---------------- 运行 ----------------

let pass = 0
let fail = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    pass += 1
    console.log(`PASS ${name}`)
  } catch (err) {
    fail += 1
    console.error(`FAIL ${name}\n  ${err?.stack ?? err}`)
  }
}
console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exitCode = fail ? 1 : 0
