/** บีบรูปด้วย canvas (สูงสุดตาม maxDim, JPEG คุณภาพตาม quality) → dataUrl */
function downscaleToDataUrl(
  bitmap: ImageBitmap,
  maxDim: number,
  quality: number
): Promise<string> {
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return Promise.reject(new Error('CANVAS_UNAVAILABLE'))
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  return Promise.resolve(canvas.toDataURL('image/jpeg', quality))
}

async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface AttachedAsset {
  assetId: string
  mimeType: string
  dataBase64: string
}

/** อ่านไฟล์รูป + บีบขนาด + แปลงเป็น asset แบบ Content-Addressed (sha256) */
export async function attachImageAsset(file: File): Promise<AttachedAsset> {
  if (!file.type.startsWith('image/')) throw new Error('NOT_AN_IMAGE')
  const bitmap = await createImageBitmap(file)
  try {
    const dataUrl = await downscaleToDataUrl(bitmap, 1280, 0.82)
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    const bytes = base64ToArrayBuffer(base64)
    const assetId = await sha256HexOfBytes(bytes)
    return { assetId, mimeType: 'image/jpeg', dataBase64: base64 }
  } finally {
    bitmap.close()
  }
}

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** dataURL สำหรับ <img src> จาก asset map */
export function assetDataUrl(
  assets: Record<string, { mimeType: string; dataBase64: string }>,
  assetId: string | undefined
): string | null {
  if (assetId === undefined) return null
  const asset = assets[assetId]
  if (asset === undefined) return null
  return `data:${asset.mimeType};base64,${asset.dataBase64}`
}
