// @vitest-environment happy-dom
// The Apple Watch with the phone left at home: every routine to start from, sets and exercises
// changed at the wrist, a workout started empty. The snapshot carries what that needs and still
// fits; the watch's changes come back as events the workout screen applies with its own actions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildReady, buildSnapshot, buildExercises, fitSnapshot, READY_MAX, SNAPSHOT_MAX_BYTES, EXTRA_MAX, _resetWatchSync, applyEvents, bindWatchActions, bindWatchAppActions, alignToWatchRows, recentlyApplied } from './watch-sync.js'
import { swapActiveExercise } from './active-exercise-swap.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { bestWeightForEntry } from './history.js'
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

describe('exercises to add or swap in at the wrist', () => {
  const cardio = EXDB.find(e => e.bp === 'cardio').id
  const loose = EXDB.filter(e => e.bp !== 'cardio')[84].id, custom = 'custom-1'

  it('names the recent ones newest first, and sends only those no ready routine has, with last time\'s work sets', () => {
    const S = {
      ...library,
      customEx: [{ id: custom, n: 'My cable thing', bp: 'chest' }],
      workouts: [...workouts, { id: 'late', d: '2026-10-20', entries: [
        { id: loose, target: { sets: 2, reps: 12 }, sets: [{ w: 10, r: 12, done: true, phase: 'warmup' }, { w: 22.5, r: 12, done: true, at: 7 }, { w: 22.5, r: 11, done: true, at: 8 }] },
        { id: cardio, target: { min: 20 }, sets: [{ min: 20, done: true }] },
      ] }],
    }
    const ready = buildReady(S, '2026-10-26')
    const ex = buildExercises(S, ready)
    expect(ex.recent[0]).toBe(loose)
    expect(ex.recent).not.toContain(cardio)
    const ids0 = ex.extra.map(e => e.id)
    expect(ids0).toContain(loose)
    expect(ids0).toContain(custom)
    expect(ids0.some(id => routines.some(r => r.ex.some(e => e.id === id)))).toBe(false)
    const l = ex.extra.find(e => e.id === loose)
    expect(l.sets).toEqual([{ w: 22.5, r: 12, sec: null, done: false, warmup: false }, { w: 22.5, r: 11, sec: null, done: false, warmup: false }])
    // a custom exercise never done: the phone's defaults for a new one
    expect(ex.extra.find(e => e.id === custom).sets.length).toBe(3)
    // a body part for every exercise the watch lists, in words
    expect(ex.parts[routines[0].ex[0].id]).toMatch(/\w/)
    expect(ex.parts[loose]).toMatch(/\w/)
    expect(ex.extra.length).toBeLessThanOrEqual(EXTRA_MAX)
  })

  it('a snapshot with them still fits, their "last time" lines going before the routines\'', () => {
    const ready = buildReady(library, '2026-10-26')
    const snap = { ...buildSnapshot(library, { ready }), exercises: buildExercises(library, ready) }
    const fit = fitSnapshot(snap)
    expect(bytes(fit)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
    expect(fit.ready.others).toHaveLength(11)
    const tight = fitSnapshot({ ...snap, exercises: { ...snap.exercises, extra: [{ id: 'x', name: 'X', mode: 'reps', last: 'a'.repeat(400), sets: [] }] } }, bytes(snap) + 100)
    expect(tight.exercises.extra[0].last).toBeUndefined()
    expect(tight.ready.others[0].entries[0].last).toBeDefined()
  })

  it('an add and a swap go through the workout screen\'s own, at the watch\'s place', () => {
    const S = { active: { id: 'w-1', cur: 0, entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true }] }, { id: '0426', sets: [{ w: 40, r: 8, done: false }] }] } }
    const addExercise = vi.fn(), swapExercise = vi.fn()
    bindWatchActions({ addExercise, swapExercise })
    const rows = [{ w: 20, r: 10 }]
    expect(applyEvents([
      { id: 'x1', type: 'addExercise', wid: 'w-1', exId: '0001', index: 9, rows, at: 1 },
      { id: 'x2', type: 'swapExercise', wid: 'w-1', exId: '0426', entryIdx: 7, to: '0002', rows, at: 2 },
    ], () => ({ S }))).toEqual(['x1', 'x2'])
    expect(addExercise).toHaveBeenCalledWith('0001', 2, [{ w: 20, r: 10, sec: null, warmup: false }])   // the end, at most
    expect(swapExercise).toHaveBeenCalledWith(1, '0002', expect.any(Array))                            // found by its id
  })

  it('an exercise swapped after sets were logged keeps them, and both go into the saved workout and its records', () => {
    const active = {
      id: 'watch-1', d: '2026-10-26', start: 1000, cur: 0, routineIds: ['r0'], name: 'Push',
      entries: [{ id: '0025', rid: 'r0', target: { sets: 3, reps: 8 }, sets: [{ w: 60, r: 8, done: true, at: 2000 }, { w: 60, r: 8, done: false }, { w: 60, r: 8, done: false }] }],
    }
    // the watch swapped bench for another press after one set (the phone's own swap, kept in place)
    const res = swapActiveExercise(active, 0, { id: '0047', target: { sets: 2, reps: 10 }, sets: [{ w: 30, r: 10, done: false }, { w: 30, r: 10, done: false }] }, { loggedConfirmed: true, groupDisposition: 'keep' })
    expect(res).toEqual({ inserted: true, index: 1 })
    // its rows evened out with the watch's (one more set there), then ticked from the watch
    active.entries[1].sets = alignToWatchRows(active.entries[1].sets, [{ w: 32.5, r: 10 }, { w: 32.5, r: 10 }, { w: 32.5, r: 9 }])
    active.entries[1].sets.forEach((s, i) => Object.assign(s, { done: true, at: 3000 + i }))
    const w = buildCompletedWorkout(active, { end: 9000 })
    expect(w.entries.map(e => e.id)).toEqual(['0025', '0047'])
    expect(w.entries[1].rid).toBe('r0')
    expect(w.entries[1].sets.filter(s => s.done)).toHaveLength(3)
    // what Finish takes into exWeights (next time's starting weight) for the swapped-in exercise
    expect(bestWeightForEntry(w.entries[1])).toBe(32.5)
  })
})

describe('a workout started empty at the wrist', () => {
  it('starts on the phone as its Freestyle (no routine), and the exercises the watch adds follow it', () => {
    let S = { active: null }
    const start = vi.fn((ids, opts) => { S = { active: { id: opts.id, entries: [] } } })
    bindWatchAppActions({ start })
    const addExercise = vi.fn()
    bindWatchActions({ addExercise })
    expect(applyEvents([
      { id: 'f1', type: 'start', routineIds: [], wid: 'watch-9', at: 5 },
      { id: 'f2', type: 'addExercise', wid: 'watch-9', exId: '0001', index: 0, rows: [{ w: 20, r: 10 }], at: 6 },
    ], () => ({ S }))).toEqual(['f1', 'f2'])
    expect(start).toHaveBeenCalledWith([], { id: 'watch-9', start: 5 })
    expect(addExercise).toHaveBeenCalledWith('0001', 0, expect.any(Array))
  })
})
