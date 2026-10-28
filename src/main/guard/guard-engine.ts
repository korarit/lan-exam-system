import { randomUUID } from 'node:crypto'
import {
  SignedDetectionPolicySchema,
  type DetectionEvent,
  type DetectionPolicyBody,
  type SignedDetectionPolicy
} from '@shared/policy-schema'
import { MAX_EVENTS_PER_REPORT } from '@shared/policy-schema'
import { NetMsgType } from '@shared/protocol-schema'
import { JitteredScheduler, CrossDetectorWatchdog } from './scheduler'
import { verifySignedPolicy } from './policy-signing'
import { ProcessInspector } from './process-inspector'
import { OverlayInspector, type Rect } from './overlay-inspector'
import { NetworkInspector } from './network-inspector'
import { InputClipboardGuard } from './input-clipboard-guard'
import { SelfIntegrityGuard } from './self-integrity-guard'
import { HardwareVmGuard } from './hardware-vm-guard'

/* ============================================================
 * GuardEngine — ตัวคุมการสอบฝั่งเครื่องนักเรียน (Phase 3a)
 * - รับนโยบายเซ็นลายเซ็นจากเครื่องแม่ แล้วคุม detector ทุกมิติ
 * - Event-driven (trace / hotplug) + jittered polling ผสมกัน
 * - รวม event แบบ batch ส่งเครื่องแม่ผ่าน TLS (GUARD_EVENT)
 * ============================================================ */

export interface GuardEngineOptions {
  /** ส่งข้อความผ่าน TLS ไปเครื่องแม่ (ครอบ HMAC โดย SecureConnection แล้ว) */
  sendToHost: (type: string, payload: unknown) => void
  /** ขอบเขตหน้าต่างข้อสอบ (ตรวจ overlay ทับจอ) */
  getExamBounds: () => Rect | null
  /** IP เครื่องแม่ + พอร์ต proxy (Mode 3) */
  getHostIp: () => string | null
  getLocalProxyPort: () => number
  now?: () => number
}

const EVENT_FLUSH_INTERVAL_MS = 1_000

export class GuardEngine {
  private policyBody: DetectionPolicyBody | null = null
  private scheduler: JitteredScheduler | null = null
  private watchdog: CrossDetectorWatchdog | null = null
  private readonly processInspector: ProcessInspector
  private readonly overlayInspector: OverlayInspector
  private readonly networkInspector: NetworkInspector
  private readonly inputClipboardGuard: InputClipboardGuard
  private readonly selfIntegrityGuard: SelfIntegrityGuard
  private readonly hardwareVmGuard: HardwareVmGuard
  private readonly now: () => number
  private eventQueue: DetectionEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly opts: GuardEngineOptions) {
    this.now = opts.now ?? Date.now
    const emit = (event: DetectionEvent): void => this.enqueueEvent(event)
    this.processInspector = new ProcessInspector({
      getPolicy: () => this.policyBody,
      emit
    })
    this.overlayInspector = new OverlayInspector({
      getExamBounds: opts.getExamBounds,
      emit
    })
    this.networkInspector = new NetworkInspector({
      getPolicy: () => this.policyBody,
      getHostIp: opts.getHostIp,
      getLocalProxyPort: opts.getLocalProxyPort,
      emit
    })
    this.inputClipboardGuard = new InputClipboardGuard({
      getPolicy: () => this.policyBody,
      emit
    })
    this.selfIntegrityGuard = new SelfIntegrityGuard({ emit })
    this.hardwareVmGuard = new HardwareVmGuard({
      getPolicy: () => this.policyBody,
      emit
    })
  }

  get process(): ProcessInspector {
    return this.processInspector
  }
  get clipboard(): InputClipboardGuard {
    return this.inputClipboardGuard
  }
  get hardware(): HardwareVmGuard {
    return this.hardwareVmGuard
  }
  get currentPolicy(): DetectionPolicyBody | null {
    return this.policyBody
  }

  /**
   * รับนโยบายใหม่จากเครื่องแม่ (ตรวจลายเซ็นก่อน — ของปลอมทิ้งทันที)
   * คืน true เมื่อรับและเริ่มใช้สำเร็จ
   */
  applyPolicy(signed: SignedDetectionPolicy, sessionKey: Buffer, verifySignature: boolean): boolean {
    if (!SignedDetectionPolicySchema.safeParse(signed).success) return false
    if (verifySignature && !this.verifySignature(signed, sessionKey)) return false
    this.policyBody = signed.body
    if (signed.body.expiresAtMs > 0 && this.now() > signed.body.expiresAtMs) {
      return false
    }
    this.start()
    return true
  }

  /** ตรวจลายเซ็นของนโยบายก่อนใช้เสมอ */
  private verifySignature(signed: SignedDetectionPolicy, sessionKey: Buffer): boolean {
    return verifySignedPolicy(signed, sessionKey)
  }

  /** เริ่มตรวจจับ (เรียกเมื่อได้นโยบายที่ผ่านการตรวจแล้ว) */
  start(): void {
    if (!this.policyBody || this.scheduler) return
    const scanAll = (): void => {
      void this.scanAllDetectors()
    }
    this.scheduler = new JitteredScheduler({
      minIntervalMs: this.policyBody.scheduler.minPollIntervalMs,
      maxIntervalMs: this.policyBody.scheduler.maxPollIntervalMs,
      task: scanAll
    })
    this.watchdog = new CrossDetectorWatchdog({
      onStalled: (detectorId, idleMs) => {
        this.enqueueEvent({
          eventId: randomUUID(),
          code: 'GUARD_THREAD_STALLED',
          severity: 'critical',
          score: 30,
          detectorId: 'watchdog',
          detail: { stalledDetector: detectorId, idleMs: String(idleMs) },
          occurredAtMs: this.now()
        })
      }
    })
    for (const detector of [
      this.processInspector,
      this.overlayInspector,
      this.networkInspector,
      this.selfIntegrityGuard
    ]) {
      this.watchdog.register(detector)
    }
    this.watchdog.start()
    this.processInspector.start()
    this.inputClipboardGuard.start()
    this.hardwareVmGuard.start()
    this.scheduler.start()
    this.flushTimer = setInterval(() => this.flushEvents(), EVENT_FLUSH_INTERVAL_MS)
  }

  stop(): void {
    this.scheduler?.stop()
    this.scheduler = null
    this.watchdog?.stop()
    this.watchdog = null
    this.processInspector.stop()
    this.overlayInspector.stop()
    this.networkInspector.stop()
    this.inputClipboardGuard.stop()
    this.selfIntegrityGuard.stop()
    this.hardwareVmGuard.stop()
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
    this.flushEvents()
  }

  /** สแกนครบทุก detector หนึ่งรอบ (เรียกโดย JitteredScheduler) */
  private async scanAllDetectors(): Promise<void> {
    await Promise.allSettled([
      this.processInspector.scanOnce(),
      this.overlayInspector.scanOnce(),
      this.networkInspector.scanOnce(),
      this.selfIntegrityGuard.scanOnce(),
      Promise.resolve(this.hardwareVmGuard.scanOnce())
    ])
  }

  /** ต่อคิว event แล้ว flush ทันทีถ้าเต็ม batch */
  private enqueueEvent(event: DetectionEvent): void {
    this.eventQueue.push(event)
    if (this.eventQueue.length >= MAX_EVENTS_PER_REPORT) {
      this.flushEvents()
    }
  }

  private flushEvents(): void {
    if (this.eventQueue.length === 0) return
    const events = this.eventQueue.splice(0, MAX_EVENTS_PER_REPORT)
    try {
      this.opts.sendToHost(NetMsgType.guardEvent, { events })
    } catch {
      // สายหลุด — event ชุดนี้เสีย แต่การสอบยังต่อ (audit ฝั่ง host จะหายชุดเล็ก ๆ ตอนหลุด)
    }
  }

  /** renderer → guard: การคัดลอกภายในแอป (กัน false positive clipboard) */
  markInternalCopy(text: string): void {
    this.inputClipboardGuard.markInternalCopy(text)
  }

  /** renderer → guard: สถิติจังหวะการพิมพ์ (IKI ms) */
  ingestTypingSamples(intervalsMs: number[]): void {
    this.inputClipboardGuard.ingestTypingSamples(intervalsMs)
  }

  /** รายงานสถานะ VM ครั้งเดียวตอนเข้า Lobby */
  async reportVmEnvironment(): Promise<void> {
    await this.hardwareVmGuard.scanVmEnvironment()
  }
}
