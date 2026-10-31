import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import FloatingHud from './core-student/FloatingHud'
import './index.css'

// Phase 5: floating HUD (Mode 3) วิ่งในหน้าต่างจิ๋วของตัวเอง — hash ระบุ route
const isFloatingHud = window.location.hash.includes('floating-hud')

function readSelectedText(): string {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
  }
  return window.getSelection()?.toString() ?? ''
}

document.addEventListener('copy', () => {
  const text = readSelectedText()
  if (!text) return
  void window.ztExam.markInternalCopy({ text }).catch(() => undefined)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isFloatingHud ? <FloatingHud /> : <App />}</React.StrictMode>
)
