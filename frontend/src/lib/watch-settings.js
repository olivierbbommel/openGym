// Settings → Apple Watch (iPhone app only): this phone's choices for its watch, and what the watch
// last said about itself. Per device, in localStorage, never in the profile: a profile signed in on
// two phones may have one watch, or none. The watch gets the choices with every snapshot
// (lib/watch-sync.js, `settings`); it reports back with a watchStatus event.
//
//   enabled      send workouts to the watch at all (off: the watch shows nothing to do)
//   autoShow     a workout started on the phone opens the watch app too (HealthKit's startWatchApp)
//   restHaptics  the wrist taps when a rest is over
//   crown        what the Digital Crown turns first on a set: 'reps' or 'weight' (older watch apps;
//                the watch now edits a value on its own screen, the crown there is that value's)
//   show         what a workout screen shows: clip (the animation), hr, last (last time's sets),
//                elapsed (time so far), kcal, next (the next exercise during a rest), and rest:
//                'ring' or 'plain' (the countdown alone)
// Apple Health on the watch is not a choice of its own: it follows the phone's Apple Health switch
// (Settings → Data, lib/health-sync.js), which the watch gets as `settings.health`. An older build's
// `health` field in the stored prefs is left alone and not read.
export const WATCH_PREFS_KEY = 'gym_watch_v1'
export const WATCH_STATUS_KEY = 'gym_watch_status_v1'
export const SHOW_DEFAULTS = Object.freeze({ clip: true, hr: true, last: true, elapsed: false, kcal: false, next: true, rest: 'ring' })
export const WATCH_DEFAULTS = Object.freeze({ enabled: true, autoShow: true, restHaptics: true, crown: 'reps', show: SHOW_DEFAULTS })

const showOf = v => {
  const o = v && typeof v === 'object' ? v : {}
  const out = {}
  for (const k of ['clip', 'hr', 'last', 'elapsed', 'kcal', 'next']) out[k] = typeof o[k] === 'boolean' ? o[k] : SHOW_DEFAULTS[k]
  out.rest = o.rest === 'plain' ? 'plain' : 'ring'
  return out
}

const listeners = new Set()
export const onWatchPrefs = fn => { listeners.add(fn); return () => listeners.delete(fn) }
const emit = () => { for (const fn of listeners) { try { fn() } catch { /* a listener's problem */ } } }

const read = (key, storage) => { try { return JSON.parse(storage?.getItem(key) || 'null') } catch { return null } }

export function readWatchPrefs(storage = globalThis.localStorage) {
  const v = read(WATCH_PREFS_KEY, storage) || {}
  return {
    enabled: v.enabled !== false,
    autoShow: v.autoShow !== false,
    restHaptics: v.restHaptics !== false,
    crown: v.crown === 'weight' ? 'weight' : 'reps',
    show: showOf(v.show),
  }
}

export function writeWatchPrefs(patch, storage = globalThis.localStorage) {
  const cur = readWatchPrefs(storage)
  // `show` is merged one choice at a time: a patch of one switch keeps the others.
  const merged = { ...cur, ...patch, ...(patch && patch.show ? { show: { ...cur.show, ...patch.show } } : {}) }
  const next = readWatchPrefs({ getItem: () => JSON.stringify(merged) })
  try { storage?.setItem(WATCH_PREFS_KEY, JSON.stringify(next)) } catch { /* private mode: for this run */ }
  emit()
  return next
}

/** What the watch said last: { health: 'on'|'off'|'denied', version, at } or null. */
export function readWatchStatus(storage = globalThis.localStorage) {
  const v = read(WATCH_STATUS_KEY, storage)
  return v && typeof v === 'object' ? v : null
}

export function writeWatchStatus(ev, storage = globalThis.localStorage) {
  const health = ['on', 'off', 'denied'].includes(ev?.health) ? ev.health : null
  const next = { health, session: ev?.session === true, version: typeof ev?.version === 'string' ? ev.version.slice(0, 20) : null, at: Number(ev?.at) || Date.now() }
  try { storage?.setItem(WATCH_STATUS_KEY, JSON.stringify(next)) } catch { /* shown again next time */ }
  emit()
  return next
}

// How long a watch's word that its workout session runs is believed without hearing it again.
export const WATCH_SESSION_TRUST_MS = 3 * 60 * 60 * 1000

/**
 * Whether the watch says a workout session is running on it (its app in front, the rest ending
 * with its own tap on the wrist). The phone's own rest notification is then left out: iOS hands a
 * locked phone's notification to the watch, and dismissing it there left the workout for the
 * watch face. Said within the last few hours only: a watch that went quiet is not believed.
 */
export function watchRunsSession(status = readWatchStatus(), now = Date.now()) {
  return !!status && status.session === true && now - (Number(status.at) || 0) < WATCH_SESSION_TRUST_MS
}

/** The choices as the watch reads them (WatchCore Model.swift WatchSettings); `health` is the phone's Apple Health switch. */
export const settingsForWatch = (p = readWatchPrefs(), health = false) => ({ health: !!health, restHaptics: p.restHaptics, crown: p.crown, show: { ...p.show } })
