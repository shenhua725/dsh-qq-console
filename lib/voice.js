/**
 * QQ 语音条本地转写（零 token、零联网）。
 *
 * 链路：
 *   QQ 语音（SILK v3 / amr / wav …）
 *     → SILK 用 silk_v3_decoder 解成 PCM（非 SILK 跳过）
 *     → ffmpeg 转 16k 单声道 wav
 *     → whisper.cpp large-v3-turbo-q5 转写
 *
 * 全部子进程隐藏窗口运行；模型与二进制默认取本机既有安装，
 * 可在构造时覆盖，方便以后换路径。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SILK_MAGIC = Buffer.from('#!SILK_V3', 'latin1')

export const VOICE_EXTS = new Set([
  '.amr', '.silk', '.slk', '.wav', '.mp3', '.m4a', '.aac',
  '.ogg', '.opus', '.flac', '.wma', '.pcm', '.spx',
])

export const DEFAULT_VOICE_TOOLS = {
  silkDecoder: 'C:\\Users\\Administrator\\.dsh\\qq-console-v2\\bin\\silk_v3_decoder.exe',
  ffmpeg: 'C:\\Users\\Administrator\\.dsh\\qq-console-v2\\bin\\ffmpeg.exe',
  whisperCli: 'F:\\Codex\\VoiceASR\\bin\\Release\\whisper-cli.exe',
  whisperModel: 'F:\\Codex\\VoiceASR\\models\\ggml-large-v3-turbo-q5_0.bin',
}

const HALLUCINATION_RE = new RegExp(
  '^(请不吝点赞|点赞|订阅|转发|打赏|明镜与点点|字幕由|字幕志愿者|' +
  '感谢观看|谢谢观看|谢谢大家|下期再见|再见|bye|thank you|thanks|' +
  'please subscribe|subscribe)[。.!！?？\\s]*$',
  'i',
)

/** 按 MIME、扩展名或文件头判断是不是语音附件。 */
export function isVoiceAttachment({ name = '', contentType = '', buf = null } = {}) {
  if (/^audio\//i.test(String(contentType))) return true
  if (VOICE_EXTS.has(path.extname(String(name)).toLowerCase())) return true
  if (Buffer.isBuffer(buf) && buf.subarray(0, 128).includes(SILK_MAGIC)) return true
  return false
}

function run(file, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: `${stderr}\n超时（${timeoutMs}ms）` })
    }, timeoutMs)
    timer.unref?.()
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: err?.message ?? String(err) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: Number(code ?? -1), stdout, stderr })
    })
  })
}

function readHead(file, length = 128) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(length)
    const n = fs.readSync(fd, buf, 0, length, 0)
    return buf.subarray(0, n)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function validText(text) {
  const value = String(text ?? '').trim()
  if (value.length < 2) return false
  if (HALLUCINATION_RE.test(value)) return false
  return true
}

export class VoiceTranscriber {
  constructor({ tools = {}, logger = null } = {}) {
    this.tools = { ...DEFAULT_VOICE_TOOLS, ...tools }
    this.logger = logger
  }

  describe() {
    const rows = [
      ['silkDecoder', this.tools.silkDecoder],
      ['ffmpeg', this.tools.ffmpeg],
      ['whisperCli', this.tools.whisperCli],
      ['whisperModel', this.tools.whisperModel],
    ]
    const missing = rows.filter(([, file]) => {
      try { return !fs.statSync(file).isFile() } catch { return true }
    }).map(([name, file]) => ({ name, file }))
    return {
      ok: missing.length === 0,
      missing,
      tools: Object.fromEntries(rows),
    }
  }

  async transcribe(filePath, { timeoutMs = 300_000 } = {}) {
    const file = path.resolve(String(filePath ?? ''))
    let stat
    try {
      stat = fs.statSync(file)
    } catch (err) {
      return { ok: false, error: 'file-not-found', detail: String(err?.message ?? err) }
    }
    if (!stat.isFile() || stat.size <= 0) {
      return { ok: false, error: 'empty-file' }
    }

    const availability = this.describe()
    if (!availability.ok) {
      return {
        ok: false,
        error: 'missing-tools',
        missing: availability.missing,
        detail: `缺少 ${availability.missing.map((x) => path.basename(x.file)).join('、')}`,
      }
    }

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-voice-'))
    const tmp = path.resolve(tmpBase)
    const wav = path.join(tmp, 'audio.wav')
    const outBase = path.join(tmp, 'out')
    try {
      const head = readHead(file)
      const silkAt = head.indexOf(SILK_MAGIC)
      let method = 'audio'
      let source = file

      if (silkAt >= 0) {
        method = 'silk'
        const raw = fs.readFileSync(file)
        const silk = path.join(tmp, 'audio.silk')
        fs.writeFileSync(silk, raw.subarray(raw.indexOf(SILK_MAGIC)))
        const pcm = path.join(tmp, 'audio.pcm')
        const decoded = await run(this.tools.silkDecoder, [silk, pcm, '-quiet'], { timeoutMs: 120_000 })
        if (decoded.code !== 0 || !fs.existsSync(pcm)) {
          return {
            ok: false,
            error: 'silk-decode-failed',
            detail: String(decoded.stderr ?? '').trim().slice(-400),
          }
        }
        source = pcm
        const converted = await run(this.tools.ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', source,
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
        ], { timeoutMs: 120_000 })
        if (converted.code !== 0 || !fs.existsSync(wav)) {
          return {
            ok: false,
            error: 'silk-convert-failed',
            detail: String(converted.stderr ?? '').trim().slice(-400),
          }
        }
      } else {
        const converted = await run(this.tools.ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', file, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
        ], { timeoutMs: 180_000 })
        if (converted.code !== 0 || !fs.existsSync(wav)) {
          return {
            ok: false,
            error: 'audio-convert-failed',
            detail: String(converted.stderr ?? '').trim().slice(-400),
          }
        }
      }

      const result = await run(this.tools.whisperCli, [
        '-m', this.tools.whisperModel,
        '-f', wav,
        '-l', 'zh',
        '-otxt',
        '-of', outBase,
        '--no-prints',
        '-t', '8',
      ], { timeoutMs })
      const txtFile = `${outBase}.txt`
      if (result.code !== 0 || !fs.existsSync(txtFile)) {
        return {
          ok: false,
          error: 'whisper-failed',
          detail: String(result.stderr ?? '').trim().slice(-400),
        }
      }
      let text = fs.readFileSync(txtFile, 'utf8').replace(/^\uFEFF/, '')
      text = text.replace(/\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/g, '')
      text = text.replace(/\s+/g, ' ').trim()
      if (!validText(text)) return { ok: false, error: 'empty-or-noise' }
      this.logger?.info?.('[qq-console-v2] 语音转写完成（%s，%d 字）', method, text.length)
      return { ok: true, text, method: `whisper-${method}` }
    } catch (err) {
      return { ok: false, error: 'transcribe-exception', detail: String(err?.message ?? err) }
    } finally {
      // 只删除本函数用 mkdtemp 创建、且确实位于系统临时目录下的目录。
      try {
        const tempRoot = path.resolve(os.tmpdir())
        const prefix = tempRoot.endsWith(path.sep) ? tempRoot : `${tempRoot}${path.sep}`
        if (tmp.startsWith(prefix) && path.basename(tmp).startsWith('dsh-qq-voice-')) {
          fs.rmSync(tmp, { recursive: true, force: true })
        }
      } catch { /* 临时目录清理失败不影响转写结果 */ }
    }
  }
}

