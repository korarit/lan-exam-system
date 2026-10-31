import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReconnectTokenStore, type TokenVault } from './token-store'

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztexam-token-'))
  return path.join(dir, name)
}

const xorVault: TokenVault = {
  encrypt: (plain) => `x${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (cipher) =>
    cipher.startsWith('x')
      ? Buffer.from(cipher.slice(1), 'base64').toString('utf8')
      : null
}

describe('ReconnectTokenStore', () => {
  it('stores and loads a token through the injected OS vault', () => {
    const filePath = tempFile('reconnect.enc.json')
    const store = new ReconnectTokenStore({ filePath, vault: xorVault })
    store.save('room-1', 'std-1', 'token-1234567890')
    expect(store.load('room-1', 'std-1')).toBe('token-1234567890')
    // ไฟล์ต้องไม่เก็บ token แบบตรง ๆ
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('token-1234567890')
  })

  it('migrates a legacy plaintext token on read', () => {
    const filePath = tempFile('reconnect.enc.json')
    const legacyFilePath = tempFile('reconnect.json')
    fs.writeFileSync(legacyFilePath, JSON.stringify({ 'room-1:std-1': 'legacy-token' }), 'utf8')
    const store = new ReconnectTokenStore({ filePath, legacyFilePath, vault: xorVault })
    expect(store.load('room-1', 'std-1')).toBe('legacy-token')
    expect(fs.readFileSync(filePath, 'utf8')).toContain('enc:')
  })

  it('falls back to a base64 plaintext record when the OS vault is unavailable', () => {
    const filePath = tempFile('reconnect.enc.json')
    const unavailable: TokenVault = { encrypt: () => null, decrypt: () => null }
    const store = new ReconnectTokenStore({ filePath, vault: unavailable })
    store.save('room-1', 'std-1', 'fallback-token')
    expect(store.load('room-1', 'std-1')).toBe('fallback-token')
    expect(fs.readFileSync(filePath, 'utf8')).toContain('plain:')
  })
})
