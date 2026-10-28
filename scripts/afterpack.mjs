// scripts/afterpack.mjs — afterPack hook ของ electron-builder
// เรียก scripts/apply-fuses.ts (runAfterPack) เพื่อตั้ง Electron Fuses หลังแพ็ก
export default async function afterPackHook(context) {
  const module = await import('./apply-fuses.ts')
  await module.runAfterPack(context)
}
