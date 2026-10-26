// @vitest-environment happy-dom
// The Apple Watch with the phone left at home: every routine to start from, sets and exercises
// changed at the wrist, a workout started empty. The snapshot carries what that needs and still
// fits; the watch's changes come back as events the workout screen applies with its own actions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReady, buildSnapshot, fitSnapshot, READY_MAX, SNAPSHOT_MAX_BYTES, _resetWatchSync, applyEvents, bindWatchActions, alignToWatchRows, recentlyApplied } from './watch-sync.js'
import { EXDB } from './exercises-data.js'

const bytes = v => new TextEncoder().encode(JSON.stringify(v)).length

// A lifter's library as it looks after a year: a dozen routines of seven exercises, each with a
// few months of history behind it (the "last time" lines and the records the snapshot carries).
const ids = EXDB.filter(e => e.bp !== 'cardio').slice(0, 84).map(e => e.id)
const routines = Array.from({ length: 12 }, (_, i) => ({
  id: 'r' + i, name: 'Routine number ' + (i + 1),
  ex: ids.slice(i * 7, i * 7 + 7).map(id => ({ id, sets: 4, reps: 8, weight: 40 })),
}))
const workouts = Array.from({ length: 60 }, (_, n) => {
  const r = routines[n % routines.length]
  const d = new Date(Date.UTC(2026, 6, 1 + n)).toISOString().slice(0, 10)
  return { id: 'w' + n, d, routineIds: [r.id], entries: r.ex.map(e => ({ id: e.id, rid: r.id, target: { sets: 4, reps: 8, weight: 40 }, sets: Array.from({ length: 4 }, () => ({ w: 42.5, r: 8, done: true })) })) }
})
const library = { unit: 'kg', restSec: 90, routines, workouts, week: { 1: 'r0' }, dayPlan: {} }

beforeEach(() => { localStorage.clear(); _resetWatchSync() })
afterEach(() => _resetWatchSync())

describe('every routine on the watch', () => {
  it('the phone offers all of them, not the first eight', () => {
    expect(READY_MAX).toBeGreaterThanOrEqual(24)
    const ready = buildReady(library, '2026-10-26')   // a Monday: r0 is today's
    expect(ready.today.routineIds).toEqual(['r0'])
    expect(ready.others).toHaveLength(11)
  })

  it('a year of history still fits with all eleven others kept, today\'s with its "last time" lines', () => {
    const ready = buildReady(library, '2026-10-26')
    const snap = fitSnapshot(buildSnapshot(library, { ready }))
    expect(bytes(snap)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    expect(snap.ready.others).toHaveLength(11)
    expect(snap.ready.today.entries[0].last).toMatch(/42.5/)
  })

  it('a snapshot that would not fit loses the others\' "last time" lines, then routines a dozen at a time', () => {
    const many = { ...library, routines: Array.from({ length: 30 }, (_, i) => ({ ...routines[i % 12], id: 'm' + i, name: 'Routine ' + i })) }
    const ready = buildReady(many, '2026-10-26')
    expect(ready.others.length).toBe(30)
    const small = fitSnapshot(buildSnapshot(many, { ready }), 30 * 1024)
    expect(bytes(small)).toBeLessThanOrEqual(30 * 1024)
    expect(small.ready.others.every(r => r.entries.every(e => e.last === undefined))).toBe(true)
    expect(small.ready.others.length).toBeGreaterThanOrEqual(12)
  })
})

describe('a set added or removed at the wrist', () => {
  const active = () => ({
    id: 'w-1', cur: 0,
    entries: [{ id: '0025', target: { sets: 2, reps: 8 }, sets: [{ w: 60, r: 8, done: true, at: 5 }, { w: 60, r: 8, done: false }] }],
  })

  it('goes through the workout screen\'s own Add set and remove, with the watch\'s rows', () => {
    const S = { active: active() }
    const addSet = vi.fn(), removeSet = vi.fn()
    bindWatchActions({ addSet, removeSet })
    const rows3 = [{ w: 60, r: 8 }, { w: 62.5, r: 8 }, { w: 62.5, r: 8 }]
    const done = applyEvents([
      { id: 'a1', type: 'addSet', wid: 'w-1', exId: '0025', entryIdx: 0, rows: rows3, at: 1 },
      { id: 'r1', type: 'removeSet', wid: 'w-1', exId: '0025', entryIdx: 0, setIdx: 2, rows: rows3.slice(0, 2), at: 2 },
      // another workout's change is done with, applied to nothing
      { id: 'x1', type: 'addSet', wid: 'w-old', exId: '0025', entryIdx: 0, rows: rows3, at: 3 },
    ], () => ({ S }))
    expect(done).toEqual(['a1', 'r1', 'x1'])
    expect(addSet).toHaveBeenCalledWith(0, [{ w: 60, r: 8, sec: null, warmup: false }, { w: 62.5, r: 8, sec: null, warmup: false }, { w: 62.5, r: 8, sec: null, warmup: false }])
    expect(removeSet).toHaveBeenCalledWith(0, 2, expect.any(Array))
    expect(addSet).toHaveBeenCalledTimes(1)
    // the snapshot names them, so the watch stops laying its own copy over the phone's
    expect(recentlyApplied()).toEqual(['a1', 'r1', 'x1'])
  })

  it('waits for the workout screen like a tick does', () => {
    const S = { active: active() }
    expect(applyEvents([{ id: 'a2', type: 'addSet', wid: 'w-1', exId: '0025', entryIdx: 0, rows: [], at: 1 }], () => ({ S }))).toEqual([])
  })

  it('the rows even out with the watch\'s: same count, its numbers on the rows not done, done rows untouched', () => {
    const sets = [{ w: 60, r: 8, done: true, at: 5 }, { w: 60, r: 8, done: false }]
    expect(alignToWatchRows(sets, [{ w: 60, r: 8 }, { w: 65, r: 6 }, { w: 65, r: 6 }])).toEqual([
      { w: 60, r: 8, done: true, at: 5 }, { w: 65, r: 6, done: false }, { w: 65, r: 6, done: false },
    ])
    // fewer rows: the last not-done ones go, never a done one
    expect(alignToWatchRows([{ w: 1, r: 1, done: false }, { w: 2, r: 2, done: true }], [{ w: 9, r: 9 }])).toEqual([{ w: 2, r: 2, done: true }])
    expect(alignToWatchRows([{ w: 2, r: 2, done: true }], [])).toEqual([{ w: 2, r: 2, done: true }])
    // a copy of a ticked row comes back not done, without its tick time or heart rate
    expect(alignToWatchRows([{ w: 50, r: 5, done: true, at: 9, hr: { avg: 120 } }], [{ w: 50, r: 5 }, { w: 50, r: 5 }])[1]).toEqual({ w: 50, r: 5, done: false })
  })
})
