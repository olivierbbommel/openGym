// @vitest-environment happy-dom
// The watch's events by way of the server (lib/watch-inbox.js): the phone applies what the watch
// wrote into the profile as it applies the native queue, once per event, and clears them there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetWatchSync, _setWatchPluginForTest, applyEvents, bindWatchAppActions, drainWatchEvents, startInboxSync } from './watch-sync.js'
import { markInboxDone } from './watch-inbox.js'

// A store as small as the drain needs: S, update (immer-free: the function mutates a copy), saveNow.
function store (S) {
  const st = { S, ready: true }
  st.update = fn => { const next = structuredClone(st.S); fn(next); st.S = next }
  st.saveNow = vi.fn(async () => {})
  return st
}

beforeEach(() => { localStorage.clear(); _resetWatchSync() })
afterEach(() => _resetWatchSync())

describe('the watch\'s events from the server', () => {
  it('a start and a weigh-in from the inbox are applied and taken out of it', async () => {
    const st = store({
      workouts: [],
      watchInbox: [
        { id: 'e1', seq: 1, type: 'start', wid: 'w-watch', routineIds: ['r1'], at: 1000 },
        { id: 'e2', seq: 2, type: 'weighIn', w: 80, at: 1001 },
      ],
    })
    const start = vi.fn(), weighIn = vi.fn()
    const ack = vi.fn(async () => {})
    _setWatchPluginForTest({ drain: async () => ({ events: [] }), ack }, () => st)
    bindWatchAppActions({ start, weighIn })
    const done = await drainWatchEvents()
    expect(done).toEqual(['e1', 'e2'])
    expect(start).toHaveBeenCalledWith(['r1'], { id: 'w-watch', start: 1000 })
    expect(weighIn).toHaveBeenCalledWith({ w: 80, at: 1001 })
    expect(st.S.watchInbox).toBeUndefined()
    expect(st.S.watchInboxDone).toEqual(['e1', 'e2'])
    // nothing of the native queue was acknowledged: none of these came from it
    expect(ack).not.toHaveBeenCalled()
  })

  it('the same event in the native queue and the inbox is applied once', async () => {
    const e = { id: 'e1', seq: 1, type: 'weighIn', w: 80, at: 5 }
    const st = store({ workouts: [], watchInbox: [e] })
    const weighIn = vi.fn()
    const ack = vi.fn(async () => {})
    _setWatchPluginForTest({ drain: async () => ({ events: [e] }), ack }, () => st)
    bindWatchAppActions({ weighIn })
    await drainWatchEvents()
    expect(weighIn).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledWith({ ids: ['e1'] })
    expect(st.S.watchInboxDone).toEqual(['e1'])
  })

  it('an event another device applied from the inbox is acknowledged here, not applied again', async () => {
    const st = store({ workouts: [], watchInboxDone: ['e1'] })
    const weighIn = vi.fn()
    const ack = vi.fn(async () => {})
    _setWatchPluginForTest({ drain: async () => ({ events: [{ id: 'e1', type: 'weighIn', w: 80, at: 5 }] }), ack }, () => st)
    bindWatchAppActions({ weighIn })
    await drainWatchEvents()
    expect(weighIn).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ ids: ['e1'] })
  })

  it('a start for a workout already saved under the watch\'s id does not start it again', () => {
    const start = vi.fn()
    bindWatchAppActions({ start })
    const S = { workouts: [{ id: 'w-watch', d: '2026-10-26', entries: [] }] }
    const done = applyEvents([{ id: 's1', type: 'start', wid: 'w-watch', routineIds: [], at: 1 }], () => ({ S }))
    expect(done).toEqual(['s1'])
    expect(start).not.toHaveBeenCalled()
  })

  it('marking done is what a merge of two copies keeps', () => {
    const s = { watchInbox: [{ id: 'a', seq: 1, type: 'start' }, { id: 'b', seq: 2, type: 'setDone' }] }
    markInboxDone(s, ['a'])
    expect(s.watchInbox.map(e => e.id)).toEqual(['b'])
  })
})

describe('the web, with no watch link', () => {
  it('applies the inbox when the profile brings it, and stops when told', async () => {
    let state = { S: { workouts: [] }, ready: true }
    const subs = new Set()
    const useStore = {
      getState: () => state,
      subscribe: fn => { subs.add(fn); return () => subs.delete(fn) },
    }
    state.update = fn => { const next = structuredClone(state.S); fn(next); const prev = state; state = { ...state, S: next }; subs.forEach(f => f(state, prev)) }
    state.saveNow = async () => {}
    _setWatchPluginForTest(null, () => state)
    const weighIn = vi.fn()
    bindWatchAppActions({ weighIn })
    const stop = startInboxSync({ useStore })
    // the server's copy arrives with an event the watch wrote
    const prev = state
    state = { ...state, S: { workouts: [], watchInbox: [{ id: 'w1', seq: 1, type: 'weighIn', w: 81, at: 7 }] } }
    subs.forEach(f => f(state, prev))
    await new Promise(r => setTimeout(r, 0))
    await drainWatchEvents()
    expect(weighIn).toHaveBeenCalledTimes(1)
    expect(state.S.watchInboxDone).toEqual(['w1'])
    stop()
    expect(subs.size).toBe(0)
  })
})
