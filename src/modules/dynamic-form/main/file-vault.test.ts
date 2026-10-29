import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileVault, makeSafeVaultFileName, ArtifactTamperedError } from './file-vault'
import { createHash, pbkdf2Sync } from 'node:crypto'

const key = pbkdf2Sync('k', 's', 10_000, 32, 'sha256')

describe('7.1.2 FileVault (AES-256-GCM at-rest)', () => {
  it('บันทึกแล้วถอดรหัสกลับได้เป๊ะ + เขียนไฟล์ .enc จริง', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'form-vault-'))
    const vault = new FileVault(root, () => key)
    const content = Buffer.from('หลักฐานรบันทึกไว้ที่ vault — เนื้อไฟล์จะต้องถูกเข้ารหัส')
    const record = vault.saveArtifact({
      roomId: 'room-1',
      studentId: 's1',
      itemId: 'q1',
      artifactId: 'ar1',
      fileName: 'solution.py',
      mimeType: 'text/x-python',
      content
    })
    expect(record.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    expect(fs.existsSync(record.filePath)).toBe(true)
    // เนื้อไฟล์บนดิสก์ต้องไม่ใช่ plaintext
    expect(fs.readFileSync(record.filePath, 'utf8')).not.toContain('หลักฐานรบันทึกไว้ที่ vault')
    const decoded = vault.readArtifact(
      {
        studentId: 's1',
        itemId: 'q1',
        artifactId: 'ar1',
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        sha256: record.sha256,
        filePath: record.filePath,
        iv: record.payload.iv,
        tag: record.payload.tag,
        rowHmac: record.rowHmac
      },
      'room-1'
    )
    expect(decoded.equals(content)).toBe(true)
  })

  it('SHA-256 ไม่ตรง → reject / ไฟล์ถูกแก้ → ArtifactTamperedError', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'form-vault-'))
    const vault = new FileVault(root, () => key)
    expect(() =>
      vault.saveArtifact({
        roomId: 'r',
        studentId: 's',
        itemId: 'i',
        artifactId: 'a',
        fileName: 'f.bin',
        mimeType: 'application/octet-stream',
        content: Buffer.from('ok'),
        expectedSha256: '0'.repeat(64)
      })
    ).toThrow('SHA256_MISMATCH')

    const record = vault.saveArtifact({
      roomId: 'r',
      studentId: 's',
      itemId: 'i',
      artifactId: 'a',
      fileName: 'f.bin',
      mimeType: 'application/octet-stream',
      content: Buffer.from('ok')
    })
    expect(() =>
      vault.readArtifact(
        {
          studentId: 's',
          itemId: 'i',
          artifactId: 'a',
          fileName: record.fileName,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          sha256: record.sha256,
          filePath: record.filePath,
          iv: record.payload.iv,
          tag: record.payload.tag,
          rowHmac: 'AAAA'
        },
        'r'
      )
    ).toThrow(ArtifactTamperedError)

    // แก้ไฟล์ .enc โดยตรง → HMAC/decrypt fail
    fs.writeFileSync(record.filePath, 'XX.YY.ZZ', 'utf8')
    expect(() =>
      vault.readArtifact(
        {
          studentId: 's',
          itemId: 'i',
          artifactId: 'a',
          fileName: record.fileName,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          sha256: record.sha256,
          filePath: record.filePath,
          iv: record.payload.iv,
          tag: record.payload.tag,
          rowHmac: record.rowHmac
        },
        'r'
      )
    ).toThrow(ArtifactTamperedError)
  })

  it('maxFileSizeBytes ของครูมีผล', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'form-vault-'))
    const vault = new FileVault(root, () => key)
    expect(() =>
      vault.saveArtifact({
        roomId: 'r',
        studentId: 's',
        itemId: 'i',
        artifactId: 'a',
        fileName: 'f.bin',
        mimeType: 'application/octet-stream',
        content: Buffer.alloc(20, 1),
        maxFileSizeBytes: 10
      })
    ).toThrow('ARTIFACT_EXCEEDS_LIMIT')
  })
})

describe('safeVaultFileName', () => {
  it('ตัดอักขระแปลกปลอม + คงส่วนขยายไฟล์', () => {
    const safe = makeSafeVaultFileName('..\\evil name.py')
    expect(safe).not.toContain('\\')
    expect(safe).not.toContain(' ')
    expect(safe.endsWith('.py')).toBe(true)
    expect(makeSafeVaultFileName('plain.txt')).toBe('plain.txt')
  })
})
