/** แทนค่า {{key}} ใน template ด้วยค่าพารามิเตอร์ที่สุ่มได้ (ใช้ร่วม main + ฝั่งตรวจ) */
export function renderPromptTemplate(
  template: string,
  values: Record<string, number>
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = values[name]
    return value === undefined ? `{{${name}}}` : String(value)
  })
}
