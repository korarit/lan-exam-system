// scripts/apply-fuses.ts — ปิดประตูหลังของ Electron ด้วย @electron/fuses (Phase 4.5)
//
// ใช้ได้ 2 อย่าง:
//   1) afterPack hook ของ electron-builder (electron-builder.yml → ./scripts/afterpack.mjs)
//   2) CLI มือขวา: node scripts/apply-fuses.ts --out dist/win-unpacked --platform win32
//
// Fuse ที่ตั้ง (ตามแผน phase-4-attestation-hardening.md 4.5):
//   - RunAsNode: false            (ห้าม ELECTRON_RUN_AS_NODE เปิดโหมด Node ปลื้ม)
//   - EnableCookieEncryption: true
//   - EnableNodeOptionsEnvironmentVariable: false
//   - EnableNodeCliInspectArguments: false
//   - OnlyLoadAppFromAsar: true
//   - EnableEmbeddedAsarIntegrityValidation: (win32 / darwin เท่านั้น — Linux ยังไม่รองรับ)
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  flipFuses,
  FuseVersion,
  FuseV1Options,
  getCurrentFuseWire,
  type FuseConfig
} from '@electron/fuses'

function resolveElectronBinary(appOutDir: string, platform: string, productName: string): string {
  switch (platform) {
    case 'darwin':
      return path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName)
    case 'win32':
      return path.join(appOutDir, `${productName}.exe`)
    default:
      return path.join(appOutDir, productName)
  }
}

export interface AfterPackContext {
  appOutDir: string
  electronPlatformName: string
  packager: { appInfo: { productFilename: string } }
}

/** โทรจาก electron-builder afterPack hook โดยตรง */
export async function runAfterPack(context: AfterPackContext): Promise<void> {
  const binary = resolveElectronBinary(
    context.appOutDir,
    context.electronPlatformName,
    context.packager.appInfo.productFilename
  )
  if (!existsSync(binary)) {
    console.warn(`[fuses] ไม่พบไบนารี Electron ที่ ${binary} — ข้ามการตั้ง fuses`)
    return
  }
  await flipFusesOn(binary, context.electronPlatformName)
}

async function flipFusesOn(binary: string, platform: string): Promise<void> {
  const fuseConfig: FuseConfig<FuseVersion.V1> = {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'win32' || platform === 'darwin'
  }
  await flipFuses(binary, fuseConfig)
  const after = await getCurrentFuseWire(binary)
  const toggledBits = [
    `RunAsNode=${after[FuseV1Options.RunAsNode]}`,
    `NodeOptionsEnv=${after[FuseV1Options.EnableNodeOptionsEnvironmentVariable]}`,
    `NodeInspectArgs=${after[FuseV1Options.EnableNodeCliInspectArguments]}`,
    `OnlyLoadAppFromAsar=${after[FuseV1Options.OnlyLoadAppFromAsar]}`,
    `AsarIntegrity=${after[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]}`
  ].join(' ')
  console.log(`[fuses] ตั้งแล้ว: ${toggledBits}`)
}

function main(): void {
  const argv = process.argv.slice(2)
  const outArg = argv.indexOf('--out')
  const platformArg = argv.indexOf('--platform')
  if (outArg === -1 || outArg + 1 >= argv.length) {
    console.error('การใช้งาน: node scripts/apply-fuses.ts --out <appOutDir> --platform <win32|darwin|linux>')
    process.exitCode = 1
    return
  }
  const appOutDir = path.resolve(argv[outArg + 1] as string)
  const platform = platformArg !== -1 ? (argv[platformArg + 1] as string) : process.platform
  const productName = process.env.ZTEXAM_PRODUCT_NAME ?? 'ZT-Exam'
  void runAfterPack({ appOutDir, electronPlatformName: platform, packager: { appInfo: { productFilename: productName } } })
    .then(() => {
      console.log('[fuses] apply สำเร็จ')
    })
    .catch((error: unknown) => {
      console.error('[fuses] apply ไม่สำเร็จ:', error)
      process.exitCode = 1
    })
}

const invokedDirectly = process.argv[1]?.endsWith('apply-fuses.ts') === true
if (invokedDirectly) {
  main()
}
