import { describe, expect, it } from 'vitest'
import {
  canonicalDeploymentConfigBytes,
  verifyDeploymentConfig,
  type DeploymentConfig
} from './deployment-config'
import { ed25519Sign, generateEd25519KeyPair } from './crypto/primitives'

function makeSigned(config: DeploymentConfig) {
  const pair = generateEd25519KeyPair()
  const signature = ed25519Sign(canonicalDeploymentConfigBytes(config), pair.privateKey)
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    signed: { config, keyId: 'deploy-key', signature: signature.toString('base64') },
    trusted: { 'deploy-key': publicPem }
  }
}

describe('signed deployment config', () => {
  it('accepts a valid Ed25519 signature', () => {
    const { signed, trusted } = makeSigned({
      version: 1,
      allowedProfiles: ['seat-01'],
      allowedRoles: ['student'],
      lockedRole: 'student',
      roster: ['65010001']
    })
    const config = verifyDeploymentConfig(signed, trusted)
    expect(config?.lockedRole).toBe('student')
    expect(config?.roster).toEqual(['65010001'])
  })

  it('rejects a tampered config', () => {
    const { signed, trusted } = makeSigned({ version: 1, lockedRole: 'student' })
    const tampered = {
      ...signed,
      config: { ...signed.config, lockedRole: 'host' as const }
    }
    expect(verifyDeploymentConfig(tampered, trusted)).toBeNull()
  })

  it('rejects an unknown key id', () => {
    const { signed } = makeSigned({ version: 1, lockedRole: 'student' })
    expect(verifyDeploymentConfig(signed, {})).toBeNull()
  })
})
