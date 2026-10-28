// @vitest-environment happy-dom
// The phone and the watch end up in the same place: a workout the watch finished (or another
// device saved) does not stay running on the phone, and a native call that never answers does not
// stop the phone from ever applying the watch's events again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetWatchSync, _setWatchPluginForTest, bindWatchAppActions, drainWatchEvents, endedElsewhere, reconcileActive, BRIDGE_TIMEOUT_MS } from './watch-sync.js'

beforeEach(() => { localStorage.clear(); _resetWatchSync() })
afterEach(() => { _resetWatchSync(); vi.useRealTimers() })

describe('a workout finished elsewhere', () => {
  it('is the one running here with a saved workout of the same id', () => {
    expect(endedElsewhere({ active: { id: 'w1' }, workouts: [{ id: 'w1' }] })).toBe('w1')
    expect(endedElsewhere({ active: { id: 'w1' }, workouts: [{ id: 'w0' }] })).toBe(null)
    expect(endedElsewhere({ active: null, workouts: [{ id: 'w1' }] })).toBe(null)
    // a saved workout opened for editing carries its own id on purpose
    expect(endedElsewhere({ active: { id: 'w1', editingWorkoutId: 'w1' }, workouts: [{ id: 'w1' }] })).toBe(null)
  })

  it("ends here with the app's own Discard (nothing saved a second time)", () => {
    const discard = vi.fn()
    bindWatchAppActions({ discard })
    expect(reconcileActive({ active: { id: 'watch-1' }, workouts: [{ id: 'watch-1', d: '2026-10-28' }] })).toBe('watch-1')
    expect(discard).toHaveBeenCalledWith('watch-1')
    discard.mockClear()
    reconcileActive({ active: { id: 'watch-2' }, workouts: [] })
    expect(discard).not.toHaveBeenCalled()
  })
})

describe('a native drain that never answers', () => {
  it('gives up after a while, so the next drain runs', async () => {
    vi.useFakeTimers()
    const st = { S: { workouts: [], active: null }, ready: true, update: fn => fn(st.S), saveNow: async () => {} }
    let calls = 0
    const drain = vi.fn(() => { calls++; return calls === 1 ? new Promise(() => {}) : Promise.resolve({ events: [] }) })
    _setWatchPluginForTest({ drain, ack: async () => {} }, () => st)
    const first = drainWatchEvents()
    await vi.advanceTimersByTimeAsync(BRIDGE_TIMEOUT_MS + 10)
    expect(await first).toEqual([])
    await drainWatchEvents()
    expect(drain).toHaveBeenCalledTimes(2)
  })
})
