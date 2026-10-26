import { describe, expect, it } from 'vitest'
import { importCardio, exerciseFor, cardioSet, importedIds, CARDIO_FOR } from './health-import.js'
import { mergeStates } from './sync-merge.js'

// A local-time ms for a day and hour, so the day a session lands on does not depend on the TZ.
const at = (d, h, m = 0) => { const [y, mo, da] = d.split('-').map(Number); return new Date(y, mo - 1, da, h, m).getTime() }
const tread = (uuid, d, h, min = 30, km = 5) => ({ uuid, type: 'running', indoor: true, start: at(d, h), end: at(d, h, min), sec: min * 60, meters: km * 1000, kcal: 310.4 })

describe('cardio from Apple Health', () => {
  it('a treadmill run goes onto that day\'s workout as a cardio set, minutes and km/h', () => {
    const s = { workouts: [{ id: 'w1', d: '2026-10-20', start: at('2026-10-20', 18), end: at('2026-10-20', 19), entries: [{ id: '0025', sets: [{ w: 60, r: 8, done: true }] }] }] }
    const r = importCardio(s, [tread('A', '2026-10-20', 19, 30, 5)])
    expect(r.added).toEqual(['A'])
    const w = s.workouts[0]
    expect(w.entries).toHaveLength(2)
    expect(w.entries[1]).toMatchObject({ id: '2197', hk: 'A', km: 5, kcal: 310, sets: [{ min: 30, speed: 10, done: true }] })
    expect(w.end).toBe(at('2026-10-20', 19, 30))
    expect(w._ts).toBeGreaterThan(0)
    expect(s.healthImported).toEqual(['A'])
  })

  it('a day without a workout gets a small cardio one', () => {
    const s = { workouts: [] }
    importCardio(s, [{ uuid: 'B', type: 'elliptical', indoor: false, start: at('2026-10-21', 7), end: at('2026-10-21', 7, 20), sec: 1200 }], { name: 'Cardio' })
    expect(s.workouts).toHaveLength(1)
    expect(s.workouts[0]).toMatchObject({ id: 'hk-B', d: '2026-10-21', name: 'Cardio', routineIds: [], entries: [{ id: '2192', sets: [{ min: 20, done: true }] }] })
    // no distance: no speed made up
    expect(s.workouts[0].entries[0].sets[0].speed).toBeUndefined()
  })

  it('taken once, and never again once deleted', () => {
    const s = { workouts: [] }
    importCardio(s, [tread('C', '2026-10-22', 8)])
    importCardio(s, [tread('C', '2026-10-22', 8)])
    expect(s.workouts).toHaveLength(1)
    s.workouts = []
    expect(importCardio(s, [tread('C', '2026-10-22', 8)]).added).toEqual([])
    expect(s.workouts).toHaveLength(0)
  })

  it('a run, walk or ride outside is not gym cardio, and an unknown kind is left alone', () => {
    expect(exerciseFor({ type: 'running', indoor: false }, {})).toBe(null)
    expect(exerciseFor({ type: 'yoga', indoor: true }, {})).toBe(null)
    expect(exerciseFor({ type: 'rowing', indoor: false }, {})).toBe('1161')
  })

  it('the lifter\'s own pick of exercise for that kind wins', () => {
    const S = { workouts: [{ d: '2026-10-01', entries: [{ id: '3666' }] }] }
    expect(exerciseFor({ type: 'walking', indoor: true }, S)).toBe('3666')
    expect(CARDIO_FOR.walking[0]).toBe('2259')
  })

  it('a session on the day of the workout running here waits for it', () => {
    const s = { workouts: [], active: { id: 'x', d: '2026-10-23', entries: [] } }
    const r = importCardio(s, [tread('D', '2026-10-23', 9)])
    expect(r.added).toEqual([])
    expect(r.wait.map(x => x.uuid)).toEqual(['D'])
    expect(s.workouts).toHaveLength(0)
  })

  it('the set: minutes to a tenth, speed from distance and time', () => {
    expect(cardioSet({ sec: 1500, meters: 4000, end: 9 })).toEqual({ min: 25, speed: 9.6, done: true, at: 9 })
  })

  it('two phones: the UUIDs taken on either are kept in the merge', () => {
    const a = { _ts: 2, workouts: [], healthImported: ['A'] }
    const b = { _ts: 1, workouts: [{ id: 'hk-B', d: '2026-10-21', entries: [{ id: '2192', hk: 'B', sets: [] }] }], healthImported: ['B'] }
    const out = mergeStates(a, b)
    expect([...importedIds(out)].sort()).toEqual(['A', 'B'])
    expect(out.healthImported.sort()).toEqual(['A', 'B'])
  })
})
