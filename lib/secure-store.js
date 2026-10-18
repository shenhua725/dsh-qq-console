/**
 * Small credential-at-rest helper.
 *
 * Windows uses DPAPI (PowerShell ConvertFrom-SecureString) so the saved
 * secret can only be decrypted by the same Windows user.  Other platforms
 * fall back to base64, which is intentionally named as such: it is not
 * encryption and must not be confused with it.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'

export const DPAPI_PREFIX = 'dpapi:v1:'
const B64_PREFIX = 'b64:v1:'

function powershellExecutable() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function securityModulePath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return path.join(
    root,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'Modules',
    'Microsoft.PowerShell.Security',
    'Microsoft.PowerShell.Security.psd1',
  )
}

function runPowerShell(script, input) {
  return execFileSync(
    powershellExecutable(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  ).trim()
}

export function protectSecret(plainText, { platform = process.platform } = {}) {
  const value = String(plainText ?? '')
  if (!value) return ''
  if (platform !== 'win32') {
    return B64_PREFIX + Buffer.from(value, 'utf8').toString('base64')
  }
  const script = [
    `Import-Module '${securityModulePath().replace(/'/g, "''")}' -ErrorAction Stop`,
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    '$v=[Console]::In.ReadToEnd()',
    '$s=ConvertTo-SecureString -String $v -AsPlainText -Force',
    'ConvertFrom-SecureString -SecureString $s',
  ].join(';')
  const encrypted = runPowerShell(script, value)
  if (!encrypted) throw new Error('DPAPI 返回空密文')
  return DPAPI_PREFIX + encrypted
}

export function unprotectSecret(stored, { platform = process.platform } = {}) {
  const value = String(stored ?? '')
  if (!value) return ''
  if (value.startsWith(B64_PREFIX)) {
    return Buffer.from(value.slice(B64_PREFIX.length), 'base64').toString('utf8')
  }
  if (!value.startsWith(DPAPI_PREFIX)) {
    // Legacy / plaintext value: return it so the caller can migrate on save.
    return value
  }
  if (platform !== 'win32') throw new Error('DPAPI 密文只能在 Windows 当前用户下解密')
  const script = [
    `Import-Module '${securityModulePath().replace(/'/g, "''")}' -ErrorAction Stop`,
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    '$e=([Console]::In.ReadToEnd()).Trim()',
    '$s=ConvertTo-SecureString -String $e',
    '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)',
    'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
  ].join(';')
  return runPowerShell(script, value.slice(DPAPI_PREFIX.length))
}

export function isProtectedSecret(value) {
  return String(value ?? '').startsWith(DPAPI_PREFIX)
}
