// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'

vi.mock('./lib/voice-log-ai.js', () => ({
  voiceLogReady: async () => true,
  readDescription: vi.fn(async () => ({
    name: 'Calisthenics class', durationMin: 50, unmatched: [], dropped: 0,
    entries: [{ id: '0970', target: { id: '0970', mode: 'reps', sets: 1, reps: 6, weight: 0 }, sets: [{ w: 0, r: 6, done: true }], note: 'Yellow band' }]
  }))
}))

const { useStore } = await import('./store/useStore.js')
const { useUI } = await import('./store/useUI.js')
const { logPastWorkoutSheet } = await import('./sheets.jsx')
const ai = await import('./lib/voice-log-ai.js')

const mounted = []
function type(el, value) {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function mountTopSheet() {
  const sheet = useUI.getState().sheets.at(-1)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(sheet.render(() => useUI.getState().closeSheet(sheet.id))))
  return host
}
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)

describe('log by voice', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useUI.setState({ sheets: [], toasts: [] })
    useStore.setState(s => ({ S: { ...s.S, active: null, routines: [], workouts: [] } }))
    document.body.innerHTML = ''
  })
  afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

  it('reads what was said into a past session to check before saving', async () => {
    logPastWorkoutSheet()
    const host = mountTopSheet()
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    const area = host.querySelector('textarea.voice-log-desc')
    expect(area).toBeTruthy()
    act(() => { type(area, 'Four rounds of six band pull-ups with the yellow band') })
    expect(host.textContent).not.toContain('Routine')
    await act(async () => { button(host, 'Read it').click(); await new Promise(r => setTimeout(r, 0)) })
    expect(ai.readDescription).toHaveBeenCalledWith(expect.anything(), 'Four rounds of six band pull-ups with the yellow band')
    const A = useStore.getState().S.active
    expect(A.name).toBe('Calisthenics class')
    expect(A.backfill.durationMin).toBe(50)
    expect(A.entries[0].note).toBe('Yellow band')
    expect(A.entries[0].sets[0].done).toBe(true)
  })
})
