declare module 'os_guard.node' {
  interface OsGuardAddon {
    start(onBlockedShortcut: (code: string) => void): boolean
    stop(): void
    isRunning(): boolean
    lastBlocked(): string
  }
  const addon: OsGuardAddon
  export default addon
}
