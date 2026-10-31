declare module 'os_guard.node' {
  interface OsGuardAddon {
    start(onBlockedShortcut: (code: string) => void): boolean
    stop(): void
    isRunning(): boolean
    lastBlocked(): string
    /** ตั้ง per-device Ed25519 seed (hex 64 ตัว) — '' = ล้าง key (fail-closed) */
    attestationSetDeviceSeed(seedHex: string): boolean
    /** เซ็น attestation payload หลังตรวจ sha256 ของไฟล์จริงด้วย native — null = ไม่ผ่าน/ไม่มีกุญแจ */
    attestationSign(requestJson: string): string | null
    /** raw Ed25519 public key 32 bytes เป็น hex (diagnostics เท่านั้น) */
    attestationPublicKey(): string
    /** ใช้ Windows process mitigation policies (คืน JSON) */
    applyProcessMitigations(): string
  }
  const addon: OsGuardAddon
  export default addon
}
