/**
 * QQ 开放平台网关客户端。
 *
 * 零第三方依赖：Node 内置 https + 一个手写的 RFC 6455 帧编解码器。
 * 旧 Python 版因为 DSH 自带 Python 没有 websocket-client 而手写了 ws_client.py，
 * 这里同理——不引入 npm 依赖，插件装到哪都能跑。
 *
 * 协议流程（QQ 官方网关）：
 *   GET wss://api.sgroup.qq.com/websocket/  → 拿 url
 *   OP 10 HELLO（含 heartbeat_interval）
 *   OP 2 IDENTIFY（bot token "QQBot <access_token>"）
 *   OP 0 READY  → 就绪，带回 bot 自己的信息
 *   OP 1 HEARTBEAT 按间隔发；OP 11 是 ACK
 *   OP 6 RESUME 断线续连
 *
 * Token 走 https://bots.qq.com/app/getAppAccessToken，带 appId + clientSecret，
 * 返回 access_token + expires_in，到期前必须刷新（官方给 ~7200 秒）。
 */

import https from 'node:https'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'

/** 订阅的事件位：C2C 消息 + 互动回调（按旧桥接的 INTENT = (1<<25)|(1<<26)）。 */
const INTENTS = (1 << 25) | (1 << 26)

const MEDIA_FILE_TYPE = {
  '.png': 1, '.jpg': 1, '.jpeg': 1, '.gif': 1, '.webp': 1, '.bmp': 1,
  '.mp4': 2, '.mov': 2, '.mkv': 2, '.avi': 2, '.webm': 2, '.m4v': 2,
  '.silk': 3, '.amr': 3, '.mp3': 3, '.wav': 3, '.ogg': 3, '.m4a': 3, '.aac': 3,
}

const MEDIA_TYPE_NAME = { 1: '图片', 2: '视频', 3: '语音', 4: '文件' }

export function mediaFileType(filePath) {
  return MEDIA_FILE_TYPE[String(filePath ?? '').toLowerCase().match(/\.[^.\\/]+$/)?.[0] ?? ''] ?? 4
}

export function mediaTypeName(fileType) {
  return MEDIA_TYPE_NAME[Number(fileType)] ?? '文件'
}

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

function errorDetail(body) {
  if (!body || typeof body !== 'object') return String(body ?? '')
  return [body.code, body.message, body.msg, body.error].filter(Boolean).join(' / ')
}

function requestUrl(url, { method = 'GET', headers = {}, body, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const lib = target.protocol === 'http:' ? http : https
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        method,
        headers: body === undefined
          ? headers
          : { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: Number(res.statusCode ?? 0),
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`)))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function hashFile(filePath) {
  const md5 = crypto.createHash('md5')
  const sha1 = crypto.createHash('sha1')
  const md5Head = crypto.createHash('md5')
  let size = 0
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) {
    md5.update(chunk)
    sha1.update(chunk)
    if (size < 10_002_432) {
      md5Head.update(chunk.subarray(0, Math.min(chunk.length, 10_002_432 - size)))
    }
    size += chunk.length
  }
  return {
    size,
    md5: md5.digest('hex'),
    sha1: sha1.digest('hex'),
    md5Head: md5Head.digest('hex'),
  }
}

async function readChunk(filePath, start, length) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export class QqGateway extends EventEmitter {
  constructor({ appId, secret, logger, store, onReady, onMessage, onInteraction, onClose, onError }) {
    super()
    this.appId = appId
    this.secret = secret
    this.logger = logger
    this.store = store
    this.onReadyCb = onReady
    this.onMessageCb = onMessage
    this.onInteractionCb = onInteraction
    this.onCloseCb = onClose
    this.onErrorCb = onError

    this.token = null
    this.tokenExpiry = 0
    this.ws = null
    this.heartbeatTimer = null
    this.seq = null
    this.sessionId = null
    this.stopped = false
    this.retryMs = 1000
    this.loopRunning = false
    this.generation = 0
  }

  log(msg) { this.store?.log?.(msg) ?? this.logger?.info?.('[qq-console] %s', msg) }

  start() {
    if (this.loopRunning) return
    this.stopped = false
    this.loopRunning = true
    const gen = ++this.generation
    this.connectLoop(gen)
      .catch((err) => {
        this.logger?.warn?.('[qq-console] 连接循环异常：%s', err?.message ?? err)
      })
      .finally(() => { if (gen === this.generation) this.loopRunning = false })
  }

  stop() {
    this.stopped = true
    this.generation++
    this.loopRunning = false
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    // 重连/换实例时必须立刻断掉旧 socket。只发关闭帧再等 500ms 的话，
    // 对端不回应就会留下 ESTABLISHED 的僵尸连接，新旧两条网关同时收消息，
    // 用户就会看到同一条指令被回复两遍。
    try { this.ws?.destroy?.() } catch { /* ignore */ }
    this.ws = null
  }

  // ---------------- HTTP ----------------

  request(options, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          let parsed = null
          try { parsed = JSON.parse(data) } catch { parsed = { raw: data } }
          resolve({ status: res.statusCode, body: parsed })
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => req.destroy(new Error('请求超时')))
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  /** 取 access_token；带 60 秒安全边界。 */
  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpiry - 60_000) return this.token
    const payload = JSON.stringify({ appId: this.appId, clientSecret: this.secret })
    const res = await this.request(
      {
        hostname: 'bots.qq.com',
        path: '/app/getAppAccessToken',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      payload,
    )
    const token = res.body?.access_token
    if (!token) {
      throw new Error(`取 token 失败：HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`)
    }
    this.token = token
    this.tokenExpiry = Date.now() + (Number(res.body?.expires_in ?? 7200) * 1000)
    this.log('access_token 已刷新')
    return token
  }

  async api(pathname, method = 'GET', body) {
    const token = await this.ensureToken()
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = { Authorization: `QQBot ${token}` }
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const res = await this.request(
      { hostname: 'api.sgroup.qq.com', path: pathname, method, headers },
      payload,
    )
    return res
  }

  // ---------------- 富媒体（C2C 分片上传） ----------------

  /**
   * 上传一个本地文件，返回 QQ 的 file_info。
   *
   * 官方链路：
   *   POST /v2/users/{openid}/upload_prepare
   *   PUT  presigned_url（分片）
   *   POST /v2/users/{openid}/upload_part_finish
   *   POST /v2/users/{openid}/files（合并，拿 file_info）
   */
  async uploadMedia(openid, filePath, { fileType } = {}) {
    const file = String(filePath ?? '')
    let stat
    try {
      stat = await fs.promises.stat(file)
    } catch (err) {
      return { ok: false, error: 'file-not-found', detail: String(err?.message ?? err), file }
    }
    if (!stat.isFile() || stat.size <= 0) {
      return { ok: false, error: 'empty-file', file }
    }

    const type = Number(fileType) || mediaFileType(file)
    const name = file.split(/[\\/]/).pop() || `qq-file-${Date.now()}`
    try {
      const hashes = await hashFile(file)
      const prepared = await this.api(`/v2/users/${encodeURIComponent(openid)}/upload_prepare`, 'POST', {
        file_type: type,
        file_size: String(hashes.size),
        file_name: name,
        md5: hashes.md5,
        sha1: hashes.sha1,
        md5_10m: hashes.md5Head,
      })
      if (prepared.status >= 400 || !prepared.body?.upload_id || !prepared.body?.parts?.length) {
        return {
          ok: false,
          error: 'upload-prepare-failed',
          status: prepared.status,
          code: prepared.body?.code ?? '',
          detail: errorDetail(prepared.body) || JSON.stringify(prepared.body).slice(0, 400),
          file,
          fileType: type,
        }
      }

      const uploadId = String(prepared.body.upload_id)
      const parts = prepared.body.parts
      const blockSize = Number(prepared.body.block_size)
        || Number(parts[0]?.block_size)
        || 0
      for (let pos = 0; pos < parts.length; pos++) {
        const part = parts[pos]
        const index = Number(part?.index) || 0
        const partSize = Number(part?.block_size) || blockSize
        const start = Math.max(0, (index - 1) * blockSize)
        const chunk = await readChunk(file, start, partSize)
        if (!chunk.length) break
        if (!part?.presigned_url) {
          return { ok: false, error: 'missing-presigned-url', detail: `分片 ${index}`, file, fileType: type }
        }
        const uploaded = await requestUrl(part.presigned_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
          timeoutMs: 180_000,
        })
        if (uploaded.status >= 400) {
          return {
            ok: false,
            error: 'part-put-failed',
            status: uploaded.status,
            detail: `分片 ${index} PUT 返回 HTTP ${uploaded.status}`,
            file,
            fileType: type,
          }
        }
        const finished = await this.api(`/v2/users/${encodeURIComponent(openid)}/upload_part_finish`, 'POST', {
          upload_id: uploadId,
          part_index: index,
          block_size: String(chunk.length),
          md5: crypto.createHash('md5').update(chunk).digest('hex'),
        })
        if (finished.status >= 400) {
          return {
            ok: false,
            error: 'part-finish-failed',
            status: finished.status,
            code: finished.body?.code ?? '',
            detail: errorDetail(finished.body),
            file,
            fileType: type,
          }
        }
        this.log(`富媒体分片 ${pos + 1}/${parts.length} 上传完成（${chunk.length} 字节）`)
      }

      let merged = null
      for (let attempt = 0; attempt < 3; attempt++) {
        merged = await this.api(`/v2/users/${encodeURIComponent(openid)}/files`, 'POST', {
          file_type: type,
          srv_send_msg: false,
          file_name: name,
          upload_id: uploadId,
        })
        const code = String(merged.body?.code ?? '')
        const text = errorDetail(merged.body)
        const transient = merged.status >= 500
          || /40093001|40093006/.test(code)
          || /40093001|40093006/.test(text)
        if (!transient || attempt >= 2) break
        this.log(`上传合并瞬时失败（${code || merged.status}），第 ${attempt + 1} 次重试`)
        await sleep(1500 * (attempt + 1))
      }
      if (merged.status >= 400 || !merged.body?.file_info) {
        return {
          ok: false,
          error: 'merge-failed',
          status: merged.status,
          code: merged.body?.code ?? '',
          detail: errorDetail(merged.body) || JSON.stringify(merged.body).slice(0, 400),
          file,
          fileType: type,
        }
      }
      this.log(`富媒体上传成功：${name}（${mediaTypeName(type)}，${hashes.size} 字节，ttl=${merged.body.ttl ?? '?'}）`)
      return {
        ok: true,
        fileInfo: String(merged.body.file_info),
        ttl: merged.body.ttl,
        file,
        name,
        size: hashes.size,
        fileType: type,
      }
    } catch (err) {
      return {
        ok: false,
        error: 'upload-exception',
        detail: String(err?.message ?? err),
        file,
        fileType: type,
      }
    }
  }

  async sendMedia(openid, fileInfo, { msgId = '', msgSeq } = {}) {
    const body = {
      msg_type: 7,
      media: { file_info: String(fileInfo) },
      msg_seq: Number(msgSeq) || (Date.now() & 0x7FFFFFFF),
    }
    if (msgId) body.msg_id = String(msgId)
    try {
      const res = await this.api(`/v2/users/${encodeURIComponent(openid)}/messages`, 'POST', body)
      const code = res.body?.code
      if (res.status >= 400 || (code !== undefined && Number(code) !== 0)) {
        return {
          ok: false,
          status: res.status,
          code: code ?? '',
          detail: errorDetail(res.body) || JSON.stringify(res.body).slice(0, 400),
        }
      }
      return { ok: true, body: res.body }
    } catch (err) {
      return { ok: false, error: 'send-media-exception', detail: String(err?.message ?? err) }
    }
  }

  async sendFile(openid, filePath, { fileType, msgId = '', msgSeq } = {}) {
    const uploaded = await this.uploadMedia(openid, filePath, { fileType })
    if (!uploaded.ok) return uploaded
    const sent = await this.sendMedia(openid, uploaded.fileInfo, { msgId, msgSeq })
    return { ...sent, ...uploaded, ok: sent.ok, uploadOk: true, send: sent }
  }

  // ---------------- WebSocket ----------------

  async connectLoop(gen) {
    while (!this.stopped && gen === this.generation) {
      const startedAt = Date.now()
      let failure = ''
      try {
        // connectOnce 只在连接真正结束（socket 关闭）后返回；握手成功时
        // 不会立刻回来，否则外层会马上再取一次 /gateway 并叠开新连接。
        await this.connectOnce(gen)
      } catch (err) {
        failure = String(err?.message ?? err)
      }
      if (this.stopped) return

      const aliveMs = Date.now() - startedAt
      // 稳定连过 30 秒才算“正常断开”，把退避归零；连接刚建立就掉线
      // 则保留退避，避免把 /gateway 打成频率限制。
      if (aliveMs > 30_000) this.retryMs = 1000
      const rateLimited = /100017|频率限制|rate limit/i.test(failure)
      if (rateLimited) this.retryMs = Math.max(this.retryMs, 60_000)

      const wait = Math.round(this.retryMs * (0.85 + Math.random() * 0.3))
      if (failure) {
        this.log(`连接断开：${failure}；${(wait / 1000).toFixed(1)} 秒后重试`)
        this.onErrorCb?.(failure)
      } else {
        this.log(`网关连接结束（存活 ${Math.round(aliveMs / 1000)} 秒）；${(wait / 1000).toFixed(1)} 秒后重连`)
      }
      await sleep(wait)
      // 频率限制时退得更远（上限 10 分钟），普通断线封顶 60 秒。
      this.retryMs = Math.min(this.retryMs * 2, rateLimited ? 600_000 : 60_000)
    }
  }

  async connectOnce(gen) {
    const gw = await this.api('/gateway')
    const url = gw.body?.url
    if (!url) throw new Error(`取网关地址失败：HTTP ${gw.status} ${JSON.stringify(gw.body).slice(0, 200)}`)

    await this.open(url, gen)
  }

  open(url, gen) {
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      const key = crypto.randomBytes(16).toString('base64')
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      })

      let settled = false
      const timer = setTimeout(() => {
        if (!settled) req.destroy(new Error('WebSocket 握手超时（15 秒）'))
      }, 15_000)
      timer.unref?.()
      req.on('upgrade', (res, socket) => {
        clearTimeout(timer)
        settled = true
        if (this.stopped || gen !== this.generation) {
          try { socket.destroy() } catch { /* ignore */ }
          reject(new Error('连接已停止'))
          return
        }
        // 新连接握手成功时，旧连接立即销毁，避免两个 socket 同时收消息。
        try { this.ws?.destroy?.() } catch { /* 旧连接先收掉，避免叠加 */ }
        this.ws = new WsConn(socket, this.logger)
        this.ws.onMessage((payload) => this.onFrame(payload))
        this.ws.onClose((err) => {
          clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
          if (!this.stopped) {
            this.log(`网关连接关闭${err ? `：${err.message}` : ''}`)
            this.onCloseCb?.(err?.message ?? '')
          }
          // 连接结束才让 connectLoop 进入下一轮。
          resolve()
        })
      })
      req.on('response', (res) => {
        clearTimeout(timer)
        if (!settled) reject(new Error(`握手被拒：HTTP ${res.statusCode}`))
      })
      req.on('error', (err) => {
        clearTimeout(timer)
        if (!settled) reject(err)
      })
      req.end()
    })
  }

  send(op, d) {
    if (!this.ws) return
    this.ws.send(JSON.stringify({ op, d }))
  }

  async onFrame(raw) {
    let frame
    try { frame = JSON.parse(raw) } catch { return }
    const { op, d, s, t } = frame
    if (typeof s === 'number') this.seq = s

    switch (op) {
      case OP.HELLO: {
        const interval = Number(d?.heartbeat_interval ?? 41250)
        this.startHeartbeat(interval)
        try {
          const token = await this.ensureToken()
          if (this.sessionId && this.seq !== null) {
            this.send(OP.RESUME, {
              token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq,
            })
          } else {
            this.send(OP.IDENTIFY, {
              token: `QQBot ${token}`,
              intents: INTENTS,
              shard: [0, 1],
              properties: { $os: 'windows', $browser: 'dsh', $device: 'dsh' },
            })
          }
        } catch (err) {
          this.log(`鉴权失败：${err?.message ?? err}`)
          this.stop()
        }
        break
      }

      case OP.DISPATCH:
        this.onDispatch(t, d)
        break

      case OP.RECONNECT:
        this.log('服务端要求重连')
        try { this.ws?.close?.() } catch { /* ignore */ }
        break

      case OP.INVALID_SESSION:
        this.sessionId = null
        this.seq = null
        try { this.ws?.close?.() } catch { /* ignore */ }
        break

      case OP.HEARTBEAT_ACK:
        break

      default:
        break
    }
  }

  startHeartbeat(intervalMs) {
    clearInterval(this.heartbeatTimer)
    const beat = () => this.send(OP.HEARTBEAT, this.seq)
    beat()
    this.heartbeatTimer = setInterval(beat, intervalMs)
    // interval 是 unref 的：DSH 退出时不该被这个定时器拖住。
    this.heartbeatTimer.unref?.()
  }

  onDispatch(type, data) {
    switch (type) {
      case 'READY': {
        this.sessionId = data?.session_id ?? null
        this.log(`网关就绪：${data?.user?.username ?? this.appId}`)
        this.onReadyCb?.(data)
        break
      }
      case 'RESUMED':
        this.log('网关已恢复')
        break
      case 'C2C_MESSAGE_CREATE':
        this.onMessageCb?.(extractMessage(data))
        break
      case 'INTERACTION_CREATE':
        this.onInteractionCb?.(data, data?.id ?? '')
        break
      case 'C2C_MSG_RECEIVE':
        break
      default:
        break
    }
  }
}

/** 把 QQ 的 C2C 消息归一化成控制台要的形状。 */
export function extractMessage(d) {
  const author = d?.author ?? {}
  return {
    openid: author.user_openid ?? author.union_openid ?? '',
    content: String(d?.content ?? '').trim(),
    msgId: d?.id ?? '',
    attachments: d?.attachments ?? [],
    raw: d,
  }
}

/**
 * 最小 WebSocket 连接：只实现这条链路上用得到的部分。
 *   - 客户端必须给每帧加掩码（RFC 6455 §5.3）
 *   - 服务端帧不加掩码
 *   - 分片帧这里用不到（QQ 网关发的是小 JSON），遇到就丢弃
 */
class WsConn {
  constructor(socket, logger) {
    this.socket = socket
    this.logger = logger
    this.buf = Buffer.alloc(0)
    this.onMsg = null
    this.onCloseCb = null
    this.closed = false

    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('close', () => this.fireClose())
    socket.on('error', (err) => this.fireClose(err))
  }

  onMessage(cb) { this.onMsg = cb }
  onClose(cb) { this.onCloseCb = cb }

  fireClose(err) {
    if (this.closed) return
    this.closed = true
    this.onCloseCb?.(err)
  }

  close() {
    if (this.closed) return
    try {
      // 正常关闭帧：opcode 8，无载荷。
      this.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
    } catch { /* ignore */ }
    try { this.socket.end() } catch { /* ignore */ }
    // 对端不回应关闭帧时，end() 会留下 ESTABLISHED 的僵尸连接；
    // 稍等片刻后强制销毁，避免重连后新旧两条网关同时收消息。
    const timer = setTimeout(() => { try { this.socket.destroy() } catch { /* ignore */ } }, 500)
    timer.unref?.()
    this.fireClose()
  }

  /** 立即断开（不发关闭帧、不等对端），用于重连/停用时的兜底清理。 */
  destroy() {
    try { this.socket.destroy() } catch { /* ignore */ }
    this.fireClose()
  }

  send(text) {
    if (this.closed) return
    const payload = Buffer.from(text, 'utf8')
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.alloc(6)
      header[0] = 0x81
      header[1] = 0x80 | len
      header.writeUInt32BE(0, 2)
      crypto.randomFillSync(header, 2, 4)
    } else if (len < 65536) {
      header = Buffer.alloc(8)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
      crypto.randomFillSync(header, 4, 4)
    } else {
      header = Buffer.alloc(14)
      header[0] = 0x81
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(len), 2)
      crypto.randomFillSync(header, 10, 4)
    }
    const mask = header.subarray(header.length - 4)
    const masked = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3]
    try {
      this.socket.write(Buffer.concat([header, masked]))
    } catch (err) {
      this.logger?.warn?.('[qq-console] ws 发送失败：%s', err?.message ?? err)
    }
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const frame = this.readFrame()
      if (!frame) return
      if (frame.opcode === 0x8) { this.close(); return }
      if (frame.opcode === 0x9) { this.pong(frame.payload); continue }
      if (frame.opcode === 0xA) continue
      if (frame.opcode === 0x1) this.onMsg?.(frame.payload.toString('utf8'))
      // 0x0 续帧 / 0x2 二进制：这条链路上不出现，忽略。
    }
  }

  readFrame() {
    const b = this.buf
    if (b.length < 2) return null
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (b.length < 4) return null
      len = b.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (b.length < 10) return null
      len = Number(b.readBigUInt64BE(2))
      offset = 10
    }
    let mask = null
    if (masked) {
      if (b.length < offset + 4) return null
      mask = b.subarray(offset, offset + 4)
      offset += 4
    }
    if (b.length < offset + len) return null
    const payload = Buffer.from(b.subarray(offset, offset + len))
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3]
    this.buf = b.subarray(offset + len)
    return { opcode, payload }
  }

  pong(payload) {
    try {
      const mask = crypto.randomBytes(4)
      const masked = Buffer.allocUnsafe(payload.length)
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3]
      const header = Buffer.alloc(2)
      header[0] = 0x8A
      header[1] = 0x80 | payload.length
      this.socket.write(Buffer.concat([header, mask, masked]))
    } catch { /* ignore */ }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
