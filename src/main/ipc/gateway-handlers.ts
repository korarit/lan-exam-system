import type { IpcRouter } from './router'
import type { AppRuntimeState } from './app-handlers'
import type { GatewayService } from '../network/gateway/gateway-service'
import type { GatewayStatus } from '@shared/gateway'

export interface GatewayServices {
  getGateway(): GatewayService
}

/**
 * IPC ของ Host-as-Gateway:
 * - ทุก channel ต้องเป็น role=host เท่านั้น (นักเรียนเรียกไม่ได้)
 * - gateway service เองก็ตรวจ role ซ้ำอีกชั้น (defense in depth)
 * - ค่าเริ่มต้นคือ stopped — ไม่ auto-start
 */
export function registerGatewayHandlers(
  router: IpcRouter,
  state: AppRuntimeState,
  services: GatewayServices
): void {
  const requireHost = (): GatewayService => {
    if (state.role !== 'host') throw new Error('HOST_ROLE_REQUIRED')
    return services.getGateway()
  }

  router.register('gateway:interfaces', () => {
    const gateway = requireHost()
    return { interfaces: gateway.listInterfaces() }
  })

  router.register('gateway:start', async (req): Promise<GatewayStatus> => {
    const gateway = requireHost()
    return gateway.start(req)
  })

  router.register('gateway:stop', (): GatewayStatus => {
    const gateway = requireHost()
    return gateway.stop()
  })

  router.register('gateway:status', (): GatewayStatus => {
    const gateway = requireHost()
    return gateway.getStatus()
  })

  router.register('gateway:leases', () => {
    const gateway = requireHost()
    return { leases: gateway.getLeases() }
  })

  router.register('gateway:dns-log', () => {
    const gateway = requireHost()
    return { entries: gateway.getDnsLog() }
  })
}
