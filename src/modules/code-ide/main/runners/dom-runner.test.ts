import { describe, expect, it } from 'vitest'
import { documentHtmlFor, runDomTest } from './dom-runner'

/* Phase 10 (ค้าง) — HeadlessDomRunner ตรวจ DOM อัตโนมัติด้วย jsdom + vm timeout */

describe('Phase 10 — dom-runner', () => {
  it('bundle เขียน DOM + assertion ถูก = ผ่าน', async () => {
    const r = await runDomTest({
      testId: 'dom-1',
      bundleJs: `document.getElementById('root').innerHTML = '<h1>Hello</h1>';`,
      documentHtml: documentHtmlFor(null, 't'),
      assertionScript: `assert(document.querySelector('h1').textContent === 'Hello', 'h1 ผิด');`,
      timeoutMs: 3000
    })
    expect(r.passed).toBe(true)
    expect(r.note).toMatch(/ผ่าน/)
  })

  it('assertion ไม่ตรง = ไม่ผ่าน พร้อมข้อความ', async () => {
    const r = await runDomTest({
      testId: 'dom-2',
      bundleJs: `document.getElementById('root').innerHTML = '<h1>Bye</h1>';`,
      documentHtml: documentHtmlFor(null, 't'),
      assertionScript: `assert(document.querySelector('h1').textContent === 'Hello', 'ต้องเป็น Hello');`,
      timeoutMs: 3000
    })
    expect(r.passed).toBe(false)
    expect(r.note).toMatch(/ต้องเป็น Hello/)
  })

  it('helper click กระตุ้น event แล้ว DOM เปลี่ยน', async () => {
    const r = await runDomTest({
      testId: 'dom-3',
      bundleJs: `
        document.getElementById('root').innerHTML = '<button id="b">0</button>';
        let n = 0;
        document.getElementById('b').addEventListener('click', () => {
          n += 1;
          document.getElementById('b').textContent = String(n);
        });`,
      documentHtml: documentHtmlFor(null, 't'),
      assertionScript: `
        await click('#b');
        assert(document.getElementById('b').textContent === '1', 'click แล้วต้องเป็น 1');`,
      timeoutMs: 3000
    })
    expect(r.passed).toBe(true)
  })

  it('bundle พัง (syntax error) = ไม่ผ่าน ไม่ล้มทั้งคิว', async () => {
    const r = await runDomTest({
      testId: 'dom-4',
      bundleJs: `this is not js (((`,
      documentHtml: documentHtmlFor(null, 't'),
      assertionScript: `assert(true);`,
      timeoutMs: 3000
    })
    expect(r.passed).toBe(false)
    expect(r.note).toMatch(/bundle/)
  })

  it('ใช้ HTML ตั้งต้นของนักเรียนเมื่อมีให้', () => {
    const html = documentHtmlFor('<!DOCTYPE html><html><body><div id="app"></div></body></html>', 't')
    expect(html).toContain('id="app"')
    expect(documentHtmlFor(null, 'T & <tle>')).toContain('id="root"')
  })
})
