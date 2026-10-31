import type { ScreenSourceInfo } from '@shared/ipc-channels'

/* ============================================================
 * Phase 3c: ScreenWorker (renderer นักเรียน)
 * - เปิด getUserMedia ต่อทุกจอ (chromeMediaSource desktop) ที่ 1280x720, 30 fps
 * - Thumbnail สุ่มเวลาทุก 5-15s (กำหนดช่วงจากเครื่องแม่) — กันภาระพร้อมกันทั้งห้อง
 * - Recorder 2 วินาทีต่อเซกเมนต์ (1.5 Mbps, สลับตัวเก่า-ใหม่ไม่ให้ภาพขาดช่วง)
 *   → ลง ring buffer ทาง main เสมอ + สตรีมสดผ่าน UDP ขณะผู้คุมเปิดดู (DVR-style)
 * - Live mode jpeg-fallback: 1280px, JPEG q0.7, ~5 fps ผ่าน TLS (เฉพาะเมื่อ UDP ไม่พร้อม)
 * ============================================================ */

const RING_SEGMENT_MS = 2_000
const RING_MIME_CANDIDATES = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']
const LIVE_INTERVAL_MS = 200
const THUMB_WIDTH = 320
const LIVE_WIDTH = 1280
const RECORD_BITRATE = 1_500_000

interface DisplayCapture {
  source: ScreenSourceInfo
  stream: MediaStream
  video: HTMLVideoElement
  seqNo: number
  activeRecorder: MediaRecorder | null
  recorderTimer: ReturnType<typeof setTimeout> | null
  thumbnailTimer: ReturnType<typeof setTimeout> | null
  liveTimer: ReturnType<typeof setInterval> | null
  /** จะส่งเซกเมนต์เพื่อสตรีมสดหรือไม่ (จอที่ผู้คุมกำลังดู) */
  liveDisplayFilter: boolean
  recorderStartedAtMs: number
}

export class ScreenWorker {
  private captures: DisplayCapture[] = []
  private active = false
  private thumbnailMinIntervalMs = 5_000
  private thumbnailMaxIntervalMs = 15_000
  private liveRequestId: string | null = null
  /** transport ของ live mode ล่าสุด ('udp-segments' = main สตรีมเซกเมนต์ทาง UDP) */
  private liveTransport: 'udp-segments' | 'jpeg-fallback' | null = null

  get isActive(): boolean {
    return this.active
  }

  /** เริ่มจับทุกจอ (เรียกเมื่อได้รับ screen:session active=true) */
  async start(thumbnailMinIntervalMs: number, thumbnailMaxIntervalMs: number): Promise<void> {
    await this.stop()
    const { environment, sources } = await window.ztExam.getScreenSources()
    if (!environment.ok) {
      console.warn(`[screen] เริ่มบันทึกหน้าจอไม่ได้: ${environment.reason ?? environment.permission}`)
      throw new Error(environment.reason ?? 'SCREEN_CAPTURE_PERMISSION_DENIED')
    }
    this.active = true
    this.thumbnailMinIntervalMs = Math.max(1_000, Math.min(thumbnailMinIntervalMs, thumbnailMaxIntervalMs))
    this.thumbnailMaxIntervalMs = Math.max(this.thumbnailMinIntervalMs, thumbnailMaxIntervalMs)
    for (const source of sources) {
      try {
        const capture = await this.openDisplay(source)
        this.captures.push(capture)
        this.scheduleThumbnail(capture)
      } catch (err) {
        console.warn(`[screen] เปิดจอ ${source.displayIndex} ไม่สำเร็จ:`, err)
      }
    }
  }

  /** หยุดทุกอย่าง (จบสอบ / เริ่มเซสชันใหม่) */
  async stop(): Promise<void> {
    this.active = false
    this.liveRequestId = null
    for (const capture of this.captures) {
      this.teardownCapture(capture)
    }
    this.captures = []
  }

  /**
   * สลับโหมดภาพสด (SCREEN_INSPECT_REQUEST โหมด live/stop)
   * - transport 'udp-segments': ไม่ต้องทำอะไรเพิ่ม — recorder 2s ทำงานอยู่แล้ว
   *   main จะสตรีมเซกเมนต์ใหม่ออกทาง UDP เอง
   * - transport 'jpeg-fallback'/ไม่ระบุ: ส่งเฟรม JPEG โดยตรง (5 fps) ผ่าน TLS
   */
  setLive(
    active: boolean,
    requestId: string,
    displayId?: string,
    transport?: 'udp-segments' | 'jpeg-fallback'
  ): void {
    this.liveRequestId = active ? requestId : null
    const segmentMode = active && transport === 'udp-segments'
    for (const capture of this.captures) {
      if (!active) {
        capture.liveDisplayFilter = true
      } else {
        capture.liveDisplayFilter = displayId === undefined || capture.source.displayId === displayId
      }
      // โหมด segment ไม่ใช้ JPEG interval — ปิดทิ้งถ้าเปิดค้างไว้
      if (active && segmentMode && capture.liveTimer !== null) {
        clearInterval(capture.liveTimer)
        capture.liveTimer = null
      }
      if (active && !segmentMode && capture.liveTimer === null) {
        capture.liveTimer = setInterval(() => {
          if (!this.active || this.liveRequestId === null) return
          if (this.liveTransport === 'udp-segments') return
          if (!capture.liveDisplayFilter) return
          void this.captureFrame(capture, LIVE_WIDTH, 'image/jpeg', 0.7, 'live')
        }, LIVE_INTERVAL_MS)
      } else if (!active && capture.liveTimer !== null) {
        clearInterval(capture.liveTimer)
        capture.liveTimer = null
      }
    }
    this.liveTransport = active ? (transport ?? 'jpeg-fallback') : null
  }

  private async openDisplay(source: ScreenSourceInfo): Promise<DisplayCapture> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Electron: จับ desktop ด้วย source id จาก main process (720p / 30 fps สำหรับ live stream)
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.sourceId,
          maxWidth: 1280,
          maxHeight: 720,
          maxFrameRate: 30
        }
      } as unknown as MediaTrackConstraints
    })
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play()

    const capture: DisplayCapture = {
      source,
      stream,
      video,
      seqNo: 0,
      activeRecorder: null,
      recorderTimer: null,
      thumbnailTimer: null,
      liveTimer: null,
      liveDisplayFilter: true,
      recorderStartedAtMs: Date.now()
    }

    // 1) Recorder 2 วินาที: ring buffer + (ขณะถูกดู) สตรีมสดผ่าน UDP — double-buffered ไม่ให้ภาพขาดช่วง
    this.rotateRecorder(capture)

    return capture
  }

  /** ตั้งเวลาภาพย่อครั้งถัดไปแบบสุ่ม 5-15s (ไม่ให้ทุกเครื่องส่งพร้อมกัน) */
  private scheduleThumbnail(capture: DisplayCapture): void {
    if (!this.active || !this.captures.includes(capture)) return
    const spread = this.thumbnailMaxIntervalMs - this.thumbnailMinIntervalMs
    const delayMs = this.thumbnailMinIntervalMs + Math.floor(Math.random() * (spread + 1))
    capture.thumbnailTimer = setTimeout(() => {
      if (!this.active || !this.captures.includes(capture)) return
      void this.captureFrame(capture, THUMB_WIDTH, 'image/webp', 0.55, 'thumbnail').finally(() => {
        this.scheduleThumbnail(capture)
      })
    }, delayMs)
  }

  /** สลับ recorder: เริ่มตัวใหม่ก่อน แล้วหยุดตัวเก่า (แต่ละไฟล์เล่นได้ในตัว) — เซกเมนต์ละ 2 วินาที */
  private rotateRecorder(capture: DisplayCapture): void {
    if (!this.active) return
    const mimeType = RING_MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate))
    if (!mimeType) {
      console.warn('[screen] MediaRecorder ไม่รองรับ webm — ring buffer ปิดใช้งาน')
      return
    }
    const startedAtMs = Date.now()
    const recorder = new MediaRecorder(capture.stream, {
      mimeType,
      videoBitsPerSecond: RECORD_BITRATE
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' })
      const endedAtMs = Date.now()
      void blob.arrayBuffer().then((buffer) => {
        void window.ztExam
          .sendScreenSegment({
            displayId: capture.source.displayId,
            seqNo: capture.seqNo,
            startTimeMs: capture.recorderStartedAtMs,
            endTimeMs: endedAtMs,
            data: new Uint8Array(buffer)
          })
          .catch(() => undefined)
      })
      capture.seqNo += 1
    }
    recorder.start(1_000)
    capture.activeRecorder = recorder
    capture.recorderStartedAtMs = startedAtMs

    capture.recorderTimer = setTimeout(() => {
      const old = capture.activeRecorder
      if (old === recorder) {
        // เริ่มตัวใหม่ทันที แล้วค่อยหยุดตัวเก่า (ภาพไม่ขาดช่วง)
        this.rotateRecorder(capture)
        try {
          old.stop()
        } catch {
          // ปิดไปเอง
        }
        capture.activeRecorder = null
      }
    }, RING_SEGMENT_MS)
  }

  /** วาดเฟรมปัจจุบันลง canvas → บีบอัด → ส่งขึ้น main */
  private async captureFrame(
    capture: DisplayCapture,
    targetWidth: number,
    mimeType: string,
    quality: number,
    mode: 'thumbnail' | 'live'
  ): Promise<void> {
    const video = capture.video
    if (video.videoWidth === 0 || video.videoHeight === 0) return
    const scale = targetWidth / video.videoWidth
    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) return
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, mimeType, quality)
    })
    if (!blob) return
    const data = new Uint8Array(await blob.arrayBuffer())
    void window.ztExam
      .sendScreenThumbnail({
        displayIndex: capture.source.displayIndex,
        displayCount: capture.source.displayCount,
        mode,
        mimeType: blob.type || mimeType,
        timestampMs: Date.now(),
        displayId: capture.source.displayId,
        data
      })
      .catch(() => undefined)
  }

  private teardownCapture(capture: DisplayCapture): void {
    if (capture.recorderTimer) clearTimeout(capture.recorderTimer)
    if (capture.thumbnailTimer) clearTimeout(capture.thumbnailTimer)
    if (capture.liveTimer) clearInterval(capture.liveTimer)
    try {
      capture.activeRecorder?.stop()
    } catch {
      // ปิดไปเอง
    }
    for (const track of capture.stream.getTracks()) track.stop()
    capture.video.srcObject = null
    capture.video.remove()
  }
}

/** instance เดียวต่อหน้าต่างนักเรียน */
let workerInstance: ScreenWorker | null = null
export function getScreenWorker(): ScreenWorker {
  workerInstance ??= new ScreenWorker()
  return workerInstance
}
