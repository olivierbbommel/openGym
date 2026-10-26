// Cardio from Apple Health (the iPhone app): the sessions Apple's own Workout app recorded on the
// watch, above all a gym machine tapped with the watch (GymKit: a treadmill, a bike, an elliptical,
// a stepper, a rower), which no other app can record. Each comes in as a cardio exercise with its
// minutes and speed, the way a cardio set logged at the wrist looks: on that day's workout when
// there is one, else as a small workout of its own.
//
// Each Apple Health workout is taken once, by its UUID: the profile keeps the UUIDs it took
// (`healthImported`, merged across devices by sync-merge), and the entry carries its own (`hk`).
// A workout deleted here is not brought back, and a second phone does not import it again.
// The native side (AppleHealthPlugin.swift `cardio`) never hands over a workout openGym wrote.
import { isoOf } from './format.js'
import { workoutVolume } from './history.js'

// The UUIDs kept at most (years of gym cardio).
export const IMPORTED_MAX = 5000

// What each kind of session becomes, best first: the first of them this lifter has logged before
// wins, else the first. Running, walking and cycling only indoors: a run outside is not gym work.
export const CARDIO_FOR = {
  running: ['2197', '0685'],                 // run on treadmill, run
  walking: ['2259', '3666', '9608'],         // walking on treadmill, on an incline treadmill
  cycling: ['2138', '2279', '0798', '3893'], // stationary bike
  elliptical: ['2192', '2141', '4259', '2658'],
  stairs: ['2311', '0938'],                  // stepmill, stepper
  rowing: ['1161'],                          // rowing machine
}
const INDOOR_ONLY = new Set(['running', 'walking', 'cycling'])

const list = v => (Array.isArray(v) ? v : [])
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const round1 = v => Math.round(v * 10) / 10
// sync-merge's stampWorkout (which imports this file): the change, timed, so the next sync keeps it.
const stampWorkout = (w, now) => { w._ts = now; return w }

/** The exercise a session becomes, or null for one that is not gym cardio. */
export function exerciseFor (item, S) {
  const ids = CARDIO_FOR[item?.type]
  if (!ids || (INDOOR_ONLY.has(item.type) && !item.indoor)) return null
  const ws = list(S?.workouts)
  for (let i = ws.length - 1; i >= 0; i--) {
    const hit = list(ws[i]?.entries).find(e => ids.includes(e?.id))
    if (hit) return hit.id
  }
  return ids[0]
}

/** Every Apple Health UUID the profile has: the list, and the entries that carry one. */
export function importedIds (S) {
  const out = new Set(list(S?.healthImported).filter(x => typeof x === 'string'))
  for (const w of list(S?.workouts)) for (const e of list(w?.entries)) if (typeof e?.hk === 'string') out.add(e.hk)
  return out
}

/** The set a session is: its minutes, and its speed (km/h) when it has a distance. */
export function cardioSet (item) {
  const sec = num(item.sec) ?? ((num(item.end) ?? 0) - (num(item.start) ?? 0)) / 1000
  const km = num(item.meters) != null ? item.meters / 1000 : null
  return {
    min: round1(Math.max(0, sec) / 60),
    ...(km && sec > 0 ? { speed: round1(km / (sec / 3600)) } : {}),
    done: true,
    at: num(item.end) ?? num(item.start) ?? 0,
  }
}

/**
 * Imports `items` (from AppleHealthPlugin `cardio`) into `s` (a store update: it mutates). A session
 * on the day of the workout running here waits (`wait`): it goes onto that workout once it is
 * saved. Returns { added, wait }: the UUIDs taken now, and the sessions to try again later.
 * `name` is what a workout of cardio alone is called.
 */
export function importCardio (s, items, { name = 'Cardio', now = Date.now() } = {}) {
  const seen = importedIds(s)
  const added = [], wait = []
  const sorted = list(items).filter(x => x && typeof x.uuid === 'string' && num(x.start) != null)
    .sort((a, b) => a.start - b.start)
  for (const item of sorted) {
    if (seen.has(item.uuid)) continue
    const exId = exerciseFor(item, s)
    if (!exId) continue
    const d = isoOf(new Date(item.start))
    if (s.active && s.active.d === d) { wait.push(item); continue }
    const end = num(item.end) ?? item.start
    const entry = {
      id: exId, sets: [cardioSet(item)], topW: null, target: null, hk: item.uuid,
      ...(num(item.meters) ? { km: Math.round(item.meters / 10) / 100 } : {}),
      ...(num(item.kcal) ? { kcal: Math.round(item.kcal) } : {}),
    }
    s.workouts = list(s.workouts)
    // That day's workout nearest in time to the session; else one of its own.
    const days = s.workouts.filter(w => w && w.d === d)
    const w = days.sort((a, b) => Math.abs((a.start || 0) - item.start) - Math.abs((b.start || 0) - item.start))[0]
    if (w) {
      w.entries = [...list(w.entries), entry]
      if (num(w.end) != null && end > w.end) w.end = end
      if (num(w.start) != null && item.start < w.start) w.start = item.start
      w.vol = workoutVolume(w)
      stampWorkout(w, now)
    } else {
      const fresh = { id: 'hk-' + item.uuid, d, start: item.start, end, routineIds: [], routineId: null, name, bw: null, entries: [entry], prs: [] }
      fresh.vol = workoutVolume(fresh)
      stampWorkout(fresh, now)
      s.workouts.push(fresh)
      s.workouts.sort((a, b) => String(a.d).localeCompare(String(b.d)) || (a.start || 0) - (b.start || 0))
    }
    seen.add(item.uuid)
    added.push(item.uuid)
  }
  if (added.length) s.healthImported = [...list(s.healthImported), ...added].slice(-IMPORTED_MAX)
  return { added, wait }
}
