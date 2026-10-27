import { z } from 'zod'

export const AppRoleSchema = z.enum(['unselected', 'host', 'student'])
export type AppRole = z.infer<typeof AppRoleSchema>

export function isOperationalRole(role: AppRole): role is Exclude<AppRole, 'unselected'> {
  return role === 'host' || role === 'student'
}
