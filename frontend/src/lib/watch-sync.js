// The Apple Watch link, the page's side (native: ios/App/App/WatchBridgePlugin.swift, the watch
// app: ios/App/Watch).
//
// Phone → watch: while a workout runs, a snapshot of it (each exercise by name, its sets with
// weight, reps and done, the rest, where you are) goes to the watch whenever it changes. The watch
// then runs the session on its own: the phone's page sleeps once the phone is locked in a pocket.
//
// Watch → phone: what happened on the watch comes back as small events ({ id, type: 'setDone',
// wid, exId, entryIdx, setIdx, w, r, at }). They are applied through the workout screen's own
// actions (bindWatchActions), the same ones a tap on the phone runs (rest timer, the high-water
// mark, the end-of-workout sheet), never a second copy of them. Each event is applied once, by its
// id, and only then acknowledged, which takes it out of the native queue; until the workout screen
// is there to apply it, it waits in that queue.
//
// The iPhone app only. Without a paired watch with the app on it, nothing is sent and nothing
// arrives: the phone behaves exactly as before.
import { MOBILE, nativePlatform } from './mobile.js'
import { EXIDX, gifSrc, figureOf, isAssisted } from './exercises.js'
import { packId, packDrawingId } from './anim-quality.js'
import { getState as animPacks } from './anim-packs.js'
import { t, exerciseNameFor, getLang, baseLang, onLangChange } from './i18n.js'
import { modeOf, setLabel, lastEntryFor, effectiveRoutineIds, isBw, isPerSide, freestyleConfig, defaultConfig, effortOf, capEffort } from './history.js'
import { isWarmupRow, isSideSet, syncSideAggregate } from './workout-model.js'
import { bestSetFor } from './exercise-history.js'
import { weightIncrement } from './progression.js'
import { sessionHistory } from './backfill.js'
import { buildCombinedEntries, deriveSessionName } from './session-merge.js'
import { todayISO, isoOf } from './format.js'
import { sanitizeHr } from './heart-rate.js'
import { mediaOf, MEDIA_MIMES } from './media-refs.js'
import { speedUnitOf } from './speed.js'
import { readWatchPrefs, settingsForWatch, writeWatchStatus, onWatchPrefs } from './watch-settings.js'

export const SNAPSHOT_VERSION = 1
const APPLIED_KEY = 'gym_watch_applied'
const APPLIED_MAX = 300
const SEND_DEBOUNCE_MS = 400
// Routines the watch can start besides today's: every one a lifter keeps in practice, so the phone
// can stay at home. fitSnapshot trims them (their "last time" lines first) when the snapshot would
// not fit the application context.
export const READY_MAX = 30

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// A body weight from the watch that holds up (kg or lb, whatever the profile uses).
const okBw = v => { const n = num(v); return n != null && n > 0 && n < 700 }
// One side of a per-side set, from the watch: 'L', 'R', or none (the whole set).
const sideOf = v => (v === 'L' || v === 'R' ? v : null)
// What a tick of a hold (`sec`) or of one side carries besides the numbers; nothing for a plain set.
const extraOf = ev => ({
  ...(num(ev.sec) != null ? { sec: num(ev.sec) } : {}),
  ...(sideOf(ev.side) ? { side: sideOf(ev.side) } : {}),
  // a cardio set's minutes and speed (km/h, as the phone keeps it)
  ...(num(ev.min) != null ? { min: num(ev.min) } : {}),
  ...(num(ev.speed) != null ? { speed: num(ev.speed) } : {}),
  // the effort logged with it, on the profile's scale (lib/history.js EFFORT)
  ...(num(ev.rir) != null ? { rir: capEffort('rir', num(ev.rir)) } : {}),
  ...(num(ev.rpe) != null ? { rpe: capEffort('rpe', num(ev.rpe)) } : {}),
})

/* ---------- the snapshot ---------- */

// The best set before today, per exercise and mode, for the watch's PRs at the finish. Worked out
// once per history (S.workouts), not on every tick of the running session.
let bestCache = { workouts: null, map: new Map() }
function bestFor (S, id, mode) {
  if (mode !== 'reps' && mode !== 'time') return null
  if (bestCache.workouts !== S?.workouts) bestCache = { workouts: S?.workouts, map: new Map() }
  const key = id + '|' + mode
  if (!bestCache.map.has(key)) {
    let b = null
    try { b = bestSetFor(S, id, mode)?.set || null } catch { b = null }
    bestCache.map.set(key, b ? (mode === 'time' ? { sec: num(b.sec), w: num(b.w) } : { w: num(b.w), r: num(b.r) }) : null)
  }
  return bestCache.map.get(key)
}

const stepOf = (cfg, S) => { try { return num(weightIncrement(cfg, S?.unit === 'lb' ? 'lb' : 'kg')) } catch { return null } }

const sideRow = v => ({ w: num(v?.w), r: num(v?.r), done: v?.done === true })

// One set as the watch shows it. A per-side set (a unilateral exercise) carries its two sides,
// each ticked on its own; `done` is both.
function watchSet (s) {
  return {
    w: num(s.w), r: num(s.r), sec: num(s.sec), done: !!s.done, warmup: !!isWarmupRow(s),
    // when it was ticked: of two ticks of the same set (phone and watch), the later wins
    ...(num(s.at) ? { at: num(s.at) } : {}),
    ...(isSideSet(s) ? { sides: { L: sideRow(s.sides.L), R: sideRow(s.sides.R) } } : {}),
    // cardio: minutes, speed (km/h) and incline, which the watch now logs too
    ...(num(s.min) != null ? { min: num(s.min) } : {}),
    ...(num(s.speed) != null ? { speed: num(s.speed) } : {}),
    ...(num(s.incline) != null ? { incline: num(s.incline) } : {}),
    // the effort already logged (or planned) on it
    ...(num(s.rir) != null ? { rir: num(s.rir) } : {}),
    ...(num(s.rpe) != null ? { rpe: num(s.rpe) } : {}),
  }
}

// One exercise as the watch shows it. Only optional fields were added over time (bodyweight,
// perSide, group, best, assisted), so an older watch app reads a newer phone's snapshot.
function watchEntry (e, H, S) {
  const ex = EXIDX[e.id]
  const target = e.target || {}
  const cfg = { ...target, id: e.id }
  const mode = modeOf(cfg)
  let last = null
  try {
    const l = H ? lastEntryFor(H, e.id, e.rid) : null
    if (l && Array.isArray(l.sets) && l.sets.length) last = l.sets.map(s => setLabel(e.id, s, l.target)).join(', ')
  } catch { last = null }
  const best = S ? bestFor(S, e.id, mode) : null
  return {
    id: e.id,
    name: ex ? exerciseNameFor(ex) : String(target.name || e.name || e.id),
    mode,
    restSec: num(target.restSec),
    last,
    sets: (e.sets || []).map(watchSet),
    ...(isBw(cfg) ? { bodyweight: true } : {}),
    ...(isPerSide(cfg) ? { perSide: true } : {}),
    // a superset: the exercises next to each other with the same group, done in turns
    ...(e.sg ? { group: String(e.sg) } : {}),
    ...(best ? { best } : {}),
    ...(mode === 'reps' && isAssisted(e.id) ? { assisted: true } : {}),
    // the step the weight moves in, as on the phone (this exercise's own, else its plates' default)
    ...(mode === 'reps' && stepOf(cfg, S) ? { step: stepOf(cfg, S) } : {}),
  }
}

/**
 * What the watch can start by itself, the phone asleep: today's planned session and a few other
 * routines, each with its exercises built exactly as starting it on the phone builds them
 * (buildCombinedEntries, as sheets.jsx beginWorkout does).
 */
export function buildReady (S, today = todayISO()) {
  let H = null
  try { H = sessionHistory(S) } catch { H = null }
  const session = ids => {
    const { entries, routineIds, routines } = buildCombinedEntries(S, ids)
    if (!routines.length) return null
    return { routineIds, name: deriveSessionName(routines.map(r => r.name)) || '', entries: entries.map(e => watchEntry(e, H, S)) }
  }
  let todayIds = []
  try { todayIds = effectiveRoutineIds({ ...S, routines: S.routines || [], week: S.week || {}, dayPlan: S.dayPlan || {} }, today, today) || [] } catch { todayIds = [] }
  const planned = todayIds.length ? session(todayIds) : null
  const others = (S.routines || []).filter(r => r && !todayIds.includes(r.id)).slice(0, READY_MAX).map(r => session([r.id])).filter(Boolean)
  return { today: planned, others, ...(planned ? {} : { next: nextPlanned(S, today) }) }
}

/**
 * On a day with nothing planned: the next day that has a routine, within a week, as the watch's
 * complications show it ("Push A", "Tue"), or nothing.
 */
export function nextPlanned (S, today = todayISO()) {
  const plan = { ...S, routines: S.routines || [], week: S.week || {}, dayPlan: S.dayPlan || {} }
  for (let d = 1; d <= 7; d++) {
    const day = new Date(today + 'T12:00:00')
    day.setDate(day.getDate() + d)
    const iso = isoOf(day)
    let ids = []
    try { ids = effectiveRoutineIds(plan, iso, today) || [] } catch { ids = [] }
    const names = ids.map(id => plan.routines.find(r => r && r.id === id)?.name).filter(Boolean)
    if (!names.length) continue
    let label = iso
    try { label = new Intl.DateTimeFormat(getLang() || 'en', { weekday: 'short' }).format(day) } catch { /* the date then */ }
    return { name: deriveSessionName(names) || names[0], day: label }
  }
  return undefined
}

// The body parts as the app names them (views/CoachChat.jsx), for the watch's exercise list.
const BP_LABEL = { back: 'Back muscles', cardio: 'Cardio', chest: 'Chest', 'lower arms': 'Forearms', 'lower legs': 'Calves', neck: 'Neck', shoulders: 'Shoulders', 'upper arms': 'Arms', 'upper legs': 'Legs', waist: 'Core', other: 'Other' }
const partOf = id => { const bp = EXIDX[id]?.bp || 'other'; try { return t(BP_LABEL[bp] || bp) } catch { return BP_LABEL[bp] || bp } }
// Exercises the watch can add or swap in besides those of the ready routines, and how many recent ones it names.
export const EXTRA_MAX = 25
export const RECENT_MAX = 25

// A row as it is up next: the numbers kept, nothing done.
const fresh = s => (isSideSet(s)
  ? { ...s, done: false, at: undefined, sides: { L: { ...s.sides.L, done: false }, R: { ...s.sides.R, done: false } } }
  : { ...s, done: false, at: undefined })

/**
 * What the watch can add to a session, or swap an exercise for, with the phone at home: every
 * exercise of the ready routines (the watch takes those from `ready`, as they would be built
 * there), plus the ones done lately or made by the lifter that no routine has (`extra`, each with
 * last time's work sets, or the phone's defaults for a new one). `recent` names the latest done,
 * newest first; `parts` the body part of each, for the watch's list. Cardio too: the watch logs
 * its minutes and speed.
 */
export function buildExercises (S, ready) {
  let H = null
  try { H = sessionHistory(S) } catch { H = S }
  const fromReady = [...(ready?.today?.entries || []), ...(ready?.others || []).flatMap(r => r.entries || [])].map(e => e.id)
  const recent = []
  const byNewest = [...(S?.workouts || [])].filter(w => w && Array.isArray(w.entries)).sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')))
  for (const w of byNewest) {
    for (const e of w.entries) if (e?.id && !recent.includes(e.id)) recent.push(e.id)
    if (recent.length >= RECENT_MAX) break
  }
  const custom = (S?.customEx || []).map(x => x && x.id).filter(id => typeof id === 'string')
  const extraIds = [...new Set([...recent, ...custom])].filter(id => !fromReady.includes(id)).slice(0, EXTRA_MAX)
  const extra = []
  for (const id of extraIds) {
    try {
      const cfg = { ...freestyleConfig(H, { id, ...defaultConfig(id) }), id }
      const last = lastEntryFor(H, id)
      const work = last && Array.isArray(last.sets) ? last.sets.filter(s => s && !isWarmupRow(s)).map(fresh) : []
      const rows = work.length ? work : Array.from({ length: Math.max(1, cfg.sets || 3) }, () => (modeOf(cfg) === 'cardio'
        ? { min: num(cfg.min) || 20, speed: num(cfg.speed) || 0, done: false }
        : { w: num(cfg.weight) || 0, r: num(cfg.reps), sec: num(cfg.sec), done: false }))
      extra.push(watchEntry({ id, target: cfg, sets: rows }, H, S))
    } catch { /* an exercise that no longer exists: left out */ }
  }
  const parts = {}
  for (const id of [...fromReady, ...extra.map(e => e.id)]) if (!parts[id]) parts[id] = partOf(id)
  return { recent: recent.slice(0, RECENT_MAX), parts, extra }
}

/** What the watch needs to run the session: plain data, no media (licence: text only). */
export function buildSnapshot(S, { timer = null, ready = null } = {}) {
  const A = S && S.active
  const unit = S && S.unit === 'lb' ? 'lb' : 'kg'
  const restSec = num(S && S.restSec) || 0
  if (!A || !Array.isArray(A.entries)) return { v: SNAPSHOT_VERSION, unit, restSec, active: null, ready }
  let H = null
  try { H = sessionHistory(S) } catch { H = null }
  return {
    v: SNAPSHOT_VERSION,
    unit,
    restSec,
    ready,
    active: {
      id: A.id || null,
      name: A.name || '',
      // when it started (ms), for the watch's summary at the finish
      ...(num(A.start) ? { start: num(A.start) } : {}),
      unit,
      cur: Math.max(0, Math.min(A.entries.length - 1, A.cur || 0)),
      restSec: num(S.restSec) || 0,
      // a rest running on the phone, so the watch counts down the same one
      rest: timer && !timer.paused && !timer.ready && num(timer.endsAt) ? { endsAt: timer.endsAt } : null,
      entries: A.entries.map(e => watchEntry(e, H, S)),
    },
  }
}

/**
 * The running workout's animations for the watch, from what this phone itself shows for each
 * exercise: the smallest downloaded animation pack of the figure (240 px, `packId` + `drawing`, read
 * through Background Assets on the phone) when there is one, else the app's built-in clip (`path` inside the app package:
 * the 180 px animated WebP of the store build, an MP4 loop in other builds). The native side makes
 * each into a small GIF and sends it as a file; the watch deletes them when the workout ends.
 * Nothing is ever fetched from anywhere.
 */
export const WATCH_PACK_PX = 240

// A custom exercise's own photo or video, as a file in the phone's media folder the native side
// may read (lib/media-store-fs.js names them <hash>.<playExt>); WebM is not something it decodes.
const MEDIA_FILE_RE = /^[0-9a-f]{64}\.(jpg|png|webp|gif|mp4)$/

/**
 * Where the watch's animation of one exercise comes from, as the phone itself shows it, or null:
 * the downloaded pack of the figure, the built-in clip in the app package, or (a custom exercise)
 * its own photo or video in the phone's media folder. `key` names the source, so the watch's
 * copy is sent again only when it changes (another figure, a pack downloaded, a new photo).
 */
export function clipFor (S, exId, { packs = {}, figure = figureOf(S) } = {}) {
  const custom = (S?.customEx || []).find(x => x && x.id === exId)
  const m = custom ? mediaOf(custom) : null
  if (m) {
    const file = m.hash + '.' + (MEDIA_MIMES[m.mime]?.playExt || '')
    return MEDIA_FILE_RE.test(file) ? { exId, media: file, key: 'm:' + m.hash } : null
  }
  const ex = EXIDX[exId]
  if (!ex || !ex.gif) return null
  const pid = packId(WATCH_PACK_PX, figure)
  const pack = packs[pid] && packs[pid].state === 'ready' ? pid : null
  const drawing = packDrawingId(ex, figure)
  // a pack's files are read through Background Assets on the phone, never by a path
  if (pack && drawing && /^[A-Za-z0-9_-]+$/.test(drawing)) return { exId, packId: pack, drawing, key: 'p:' + pack + ':' + drawing }
  const path = gifSrc(ex, figure)
  if (!/\.(webp|mp4|gif)$/i.test(path) || /^[a-z]+:|^\//i.test(path) || path.includes('..')) return null
  return { exId, path, key: 'f:' + path }
}

export function clipsFor (S, packs = animPacks().packs || {}) {
  const A = S && S.active
  if (!A || !Array.isArray(A.entries)) return []
  const figure = figureOf(S)
  const out = [], seen = new Set()
  for (const e of A.entries) {
    if (!e || seen.has(e.id)) continue
    seen.add(e.id)
    const c = clipFor(S, e.id, { packs, figure })
    if (c) { const { key: _k, ...clip } = c; out.push(clip) }
  }
  return out
}

/*
 * The animations the watch keeps for good, so a workout with the phone at home still shows them:
 * one for every exercise of the ready routines and of the exercise list (buildExercises), made
 * small (160 px GIFs) by the native side and sent once each. The watch says which it has (its
 * status event's `clips`, exercise → key), and only the missing or changed ones go.
 */
export const CLIP_LIBRARY_MAX = 150
export function libraryClipsFor (S, ready, exercises, packs = animPacks().packs || {}) {
  const ids = [...(ready?.today?.entries || []), ...(ready?.others || []).flatMap(r => r.entries || []), ...(exercises?.extra || [])].map(e => e && e.id)
  const figure = figureOf(S)
  const out = []
  for (const id of [...new Set(ids)]) {
    if (typeof id !== 'string') continue
    const c = clipFor(S, id, { packs, figure })
    if (c) out.push(c)
    if (out.length >= CLIP_LIBRARY_MAX) break
  }
  return out
}

/** Of the library, what the watch does not have yet (or has from another source). */
export const clipsMissing = (library, have) => library.filter(c => !have || have[c.exId] !== c.key)

const CLIP_LIB_KEY = 'gym_watch_clip_lib'
/** What the watch said it keeps (exercise → key), sanitized. */
export function readWatchClips () { try { return JSON.parse(localStorage.getItem(CLIP_LIB_KEY)) || {} } catch { return {} } }
function writeWatchClips (v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return
  const out = {}
  for (const [k, key] of Object.entries(v).slice(0, 500)) if (typeof k === 'string' && typeof key === 'string' && k.length < 100 && key.length < 200) out[k] = key
  try { localStorage.setItem(CLIP_LIB_KEY, JSON.stringify(out)) } catch { /* asked again next status */ }
  afterClips?.()
}
let afterClips = null

/* ---------- applying the watch's events ---------- */

let handlers = null      // the workout screen's: setDone, finish
let appHandlers = null   // the app's: start
const readApplied = () => { try { return JSON.parse(localStorage.getItem(APPLIED_KEY)) || [] } catch { return [] } }
const writeApplied = ids => { try { localStorage.setItem(APPLIED_KEY, JSON.stringify(ids.slice(-APPLIED_MAX))) } catch { /* the queue's ack is what counts */ } }

// The rows an exercise has on the watch after a change made there ({ w, r, sec, warmup }).
const ROWS_MAX = 50
function rowsOf (v) {
  if (!Array.isArray(v)) return null
  return v.slice(0, ROWS_MAX).filter(x => x && typeof x === 'object').map(x => ({
    w: num(x.w), r: num(x.r), sec: num(x.sec), warmup: x.warmup === true,
    ...(num(x.min) != null ? { min: num(x.min) } : {}), ...(num(x.speed) != null ? { speed: num(x.speed) } : {}),
  }))
}

/**
 * An exercise's sets made to match the watch's after a change made there (a set added or removed,
 * an exercise added or swapped): the same number of rows, so the ticks that follow by position
 * land on the same sets, and the numbers the watch showed on the rows not done yet. The phone's
 * own change runs first (its rest timer, its per-side rows, its Undo); this only evens out what
 * the two still disagree on. Done rows are never touched or dropped.
 */
export function alignToWatchRows (sets, rows) {
  if (!Array.isArray(sets) || !Array.isArray(rows) || !rows.length) return Array.isArray(sets) ? sets : []
  const out = sets.slice()
  while (out.length > rows.length) {
    let i = out.length - 1
    while (i >= 0 && out[i]?.done) i--
    if (i < 0) break
    out.splice(i, 1)
  }
  while (out.length < rows.length) {
    const last = out[out.length - 1]
    const { done: _d, at: _a, hr: _h, restHr: _rh, ...rest } = last || {}
    const copy = isSideSet(last)
      ? { ...rest, sides: { L: { ...last.sides.L, done: false }, R: { ...last.sides.R, done: false } }, done: false }
      : { ...rest, done: false }
    out.push(last ? copy : { w: 0, r: 0, done: false })
  }
  return out.map((s, i) => {
    const row = rows[i]
    if (!row || s?.done || isSideSet(s)) return s
    const next = { ...s }
    if (row.w != null) next.w = row.w
    if (row.r != null) next.r = row.r
    if (row.sec != null) next.sec = row.sec
    if (row.min != null) next.min = row.min
    if (row.speed != null) next.speed = row.speed
    return next
  })
}

/**
 * A change to the session's shape made at the wrist, arriving after the phone saved that workout
 * (finished here while the watch was away): applied to the saved copy, so the ticks that follow
 * (written into it by patchSet) find their sets. Returns whether anything changed; the caller
 * recounts and stamps the workout. Never touches a set that was done.
 */
export function editSavedWorkout (w, ev) {
  if (!w || !Array.isArray(w.entries)) return false
  const rows = rowsOf(ev.rows)
  const fromRows = () => (rows || []).map(r => ({
    ...(r.w != null ? { w: r.w } : {}), ...(r.r != null ? { r: r.r } : {}), ...(r.sec != null ? { sec: r.sec } : {}),
    ...(r.min != null ? { min: r.min } : {}), ...(r.speed != null ? { speed: r.speed } : {}), done: false,
  }))
  const idx = entryIndexOf(w, ev)
  if (ev.type === 'addSet') {
    if (idx < 0 || !rows) return false
    w.entries[idx].sets = alignToWatchRows(w.entries[idx].sets || [], rows)
    return true
  }
  if (ev.type === 'removeSet') {
    const sets = idx >= 0 ? w.entries[idx].sets || [] : []
    if (!Number.isInteger(ev.setIdx) || !sets[ev.setIdx] || sets[ev.setIdx].done || sets.length < 2) return false
    sets.splice(ev.setIdx, 1)
    return true
  }
  if (ev.type === 'addExercise' && typeof ev.exId === 'string') {
    const at = Number.isInteger(ev.index) ? Math.max(0, Math.min(w.entries.length, ev.index)) : w.entries.length
    w.entries.splice(at, 0, { id: ev.exId, target: defaultConfig(ev.exId), sets: fromRows() })
    return true
  }
  if (ev.type === 'swapExercise' && typeof ev.to === 'string' && idx >= 0) {
    const old = w.entries[idx]
    const next = { id: ev.to, target: defaultConfig(ev.to), sets: fromRows(), ...(old.rid ? { rid: old.rid } : {}), ...(old.sg ? { sg: old.sg } : {}) }
    if ((old.sets || []).some(s => s && s.done)) w.entries.splice(idx + 1, 0, next)
    else w.entries[idx] = next
    return true
  }
  return false
}

/** The entry an event means: by position when it still holds that exercise, else by the exercise. */
function entryIndexOf (A, ev) {
  if (A.entries[ev.entryIdx] && A.entries[ev.entryIdx].id === ev.exId) return ev.entryIdx
  return A.entries.findIndex(e => e.id === ev.exId)
}

/**
 * Applies the events not applied yet, in order. Returns the ids that are done with: applied now,
 * applied before, or about a workout that is not running any more. An event whose actions are not
 * there yet (a set before the workout screen is open) stops the run: it and everything after it
 * stay queued, in order, for the next drain.
 *
 *   start   { routineIds, wid, at }  the app starts that session with the watch's id and start
 *   setDone { wid, exId, entryIdx, setIdx, w, r, at }   the workout screen's own tick
 *   finish  { wid, at }              the workout screen's own Finish and save
 *   discard { wid, at }              the app's own Discard: the session goes, nothing saved
 *   moveExercise { wid, exId, entryIdx, direction }  the workout screen's own move (-1 up, 1 down)
 *   setRest { sec }                  the phone's rest timer setting, as its workout ⋯ sets it
 *   setHr   { wid, exId, entryIdx, setIdx, hr?, restHr? }   heart rate on a set (lib/heart-rate.js)
 *   addSet    { wid, exId, entryIdx, rows }            the workout screen's own Add set
 *   removeSet { wid, exId, entryIdx, setIdx, rows }    its own remove, a set not done only
 *   addExercise  { wid, exId, index, rows }            its own Add exercise (quick add), at `index`
 *   swapExercise { wid, exId, entryIdx, to, rows }     its own Swap exercise to `to`; a swap of
 *                                                      one with logged sets inserts beside it
 *
 * `rows` are the exercise's sets as the watch has them after the change, which the phone's own
 * change is evened out with (alignToWatchRows). The snapshot names the events applied lately
 * (`applied`), so the watch keeps showing its own change until the phone's copy has it.
 *
 * A tick for a workout already saved (finished on the phone while the watch was away) is written
 * into that saved workout, stamped so the next sync keeps it. A tick while the workout screen is
 * not open opens it (appHandlers.openWorkout), and the queue drains once it is there. Of two
 * changes of the same set, the later one (`at`) wins.
 */
export function applyEvents (events, getState) {
  if (!Array.isArray(events)) return []
  const applied = readApplied()
  const done = []
  for (const ev of events) {
    if (!ev || typeof ev.id !== 'string') continue
    if (applied.includes(ev.id)) { done.push(ev.id); continue }
    const S = getState()?.S
    const A = S?.active
    const ours = A && Array.isArray(A.entries) && (!ev.wid || ev.wid === A.id)
    // A workout finished on the phone while the watch was away: its later ticks still count.
    const saved = !ours && ev.wid && Array.isArray(S?.workouts) ? S.workouts.find(w => w && w.id === ev.wid) : null
    if (ev.type === 'start') {
      if (!A) {
        if (!appHandlers) break
        // Started at the wrist: the watch app is open already, nothing to open there (startWatchSync).
        if (ev.wid) startedOnWatch.add(ev.wid)
        appHandlers.start(Array.isArray(ev.routineIds) ? ev.routineIds : [], { id: ev.wid || null, start: num(ev.at), ...(okBw(ev.bw) ? { bw: num(ev.bw) } : {}) })
      }
      // A workout already running on the phone is kept; one with the watch's id is this one.
    } else if (ev.type === 'setDone' && saved) {
      if (!appHandlers) break
      const { side: _side, ...more } = extraOf(ev)
      const fields = { done: true, ...(num(ev.w) != null ? { w: num(ev.w) } : {}), ...(num(ev.r) != null ? { r: num(ev.r) } : {}), ...more, ...(num(ev.at) ? { at: num(ev.at) } : {}) }
      const hr = sanitizeHr(ev.hr)
      if (hr) fields.hr = hr
      appHandlers.patchSet({ wid: ev.wid, exId: ev.exId, entryIdx: ev.entryIdx, setIdx: ev.setIdx, ...(sideOf(ev.side) ? { side: sideOf(ev.side) } : {}) }, fields, { ifNewer: num(ev.at) })
    } else if (ev.type === 'setDone' && ours) {
      if (!handlers) {
        // The tick is the workout screen's to apply: open it, and the queue drains when it binds.
        if (appHandlers?.openWorkout) appHandlers.openWorkout()
        break
      }
      const idx = entryIndexOf(A, ev)
      const set = idx >= 0 ? A.entries[idx].sets?.[ev.setIdx] : null
      if (set) handlers.setDone(idx, ev.setIdx, { w: num(ev.w), r: num(ev.r), at: num(ev.at), hr: sanitizeHr(ev.hr), ...extraOf(ev) })
    } else if (ev.type === 'setRest') {
      // The rest timer changed at the wrist: the phone's own setting (Settings, the workout's ⋯).
      if (num(ev.sec) != null) {
        if (!appHandlers?.setRest) break
        appHandlers.setRest(Math.max(0, Math.min(600, num(ev.sec))))
      }
    } else if (ev.type === 'moveExercise' && ours) {
      // Moved up or down at the wrist: the workout screen's own move, the whole superset with it.
      if (!handlers) {
        if (appHandlers?.openWorkout) appHandlers.openWorkout()
        break
      }
      const idx = entryIndexOf(A, ev)
      if (idx >= 0 && (ev.direction === 1 || ev.direction === -1) && handlers.moveExercise) handlers.moveExercise(idx, ev.direction)
    } else if (['addSet', 'removeSet', 'addExercise', 'swapExercise'].includes(ev.type) && saved) {
      // Changed at the wrist after the phone saved it: the saved copy follows (editSavedWorkout).
      if (!appHandlers?.patchWorkout) break
      appHandlers.patchWorkout(ev.wid, w => editSavedWorkout(w, ev))
    } else if ((ev.type === 'addSet' || ev.type === 'removeSet') && ours) {
      // A set added or removed at the wrist: the workout screen's own Add set / remove, then the
      // rows evened out with the watch's (alignToWatchRows).
      if (!handlers) {
        if (appHandlers?.openWorkout) appHandlers.openWorkout()
        break
      }
      const idx = entryIndexOf(A, ev)
      const rows = rowsOf(ev.rows)
      if (idx >= 0 && ev.type === 'addSet' && handlers.addSet) handlers.addSet(idx, rows)
      if (idx >= 0 && ev.type === 'removeSet' && handlers.removeSet && Number.isInteger(ev.setIdx)) handlers.removeSet(idx, ev.setIdx, rows)
    } else if ((ev.type === 'addExercise' || ev.type === 'swapExercise') && ours) {
      // An exercise added or swapped at the wrist: the workout screen's own add and swap, built as
      // a quick add from the phone's picker builds it, then its rows evened out with the watch's.
      if (!handlers) {
        if (appHandlers?.openWorkout) appHandlers.openWorkout()
        break
      }
      const rows = rowsOf(ev.rows)
      const at = Number.isInteger(ev.index) ? Math.max(0, Math.min(A.entries.length, ev.index)) : A.entries.length
      if (ev.type === 'addExercise' && typeof ev.exId === 'string' && handlers.addExercise) handlers.addExercise(ev.exId, at, rows)
      if (ev.type === 'swapExercise' && typeof ev.to === 'string' && handlers.swapExercise) {
        const idx = entryIndexOf(A, ev)
        if (idx >= 0) handlers.swapExercise(idx, ev.to, rows)
      }
    } else if (ev.type === 'weighIn') {
      // The weigh-in the watch asks for before a workout it starts: a body weight entry on its
      // day, as the phone's own check-in makes one (today's replaces today's).
      if (okBw(ev.w)) {
        if (!appHandlers?.weighIn) break
        appHandlers.weighIn({ w: num(ev.w), at: num(ev.at) || Date.now() })
      }
    } else if (ev.type === 'healthDeleted') {
      // The watch took its copies of deleted workouts out of Apple Health: the phone's own removal
      // (which kept retrying the ones it could not delete) runs again and now finds them gone.
      if (appHandlers?.healthDeleted) appHandlers.healthDeleted(Array.isArray(ev.ids) ? ev.ids.filter(x => typeof x === 'string') : [])
    } else if (ev.type === 'watchStatus') {
      // What the watch says about itself, for Settings → Apple Watch. Never queued behind anything.
      writeWatchStatus(ev)
      // and the animations it keeps, so only what it lacks is sent
      if (ev.clips) writeWatchClips(ev.clips)
    } else if (ev.type === 'setHr') {
      // The rest's heart rate comes once the rest is over, maybe after the workout was saved:
      // a field on that set, wherever the set is now. Nothing for a reading that does not hold up.
      const fields = {}
      const hr = sanitizeHr(ev.hr), restHr = sanitizeHr(ev.restHr)
      if (hr) fields.hr = hr
      if (restHr) fields.restHr = restHr
      if (Object.keys(fields).length) {
        if (!appHandlers) break
        appHandlers.patchSet({ wid: ev.wid, exId: ev.exId, entryIdx: ev.entryIdx, setIdx: ev.setIdx }, fields)
      }
    } else if (ev.type === 'discard' && ours) {
      // Thrown away at the wrist: the app's own Discard, nothing saved. A workout already saved here
      // (finished on the phone meanwhile) is the phone's to keep or delete.
      if (!appHandlers?.discard) break
      appHandlers.discard(A.id)
    } else if (ev.type === 'finish' && ours) {
      if (!handlers) {
        if (appHandlers?.openWorkout) appHandlers.openWorkout()
        break
      }
      handlers.finish()
    }
    // Applied, or meaningless now (another workout, a set that is gone): either way it is done.
    applied.push(ev.id)
    done.push(ev.id)
  }
  writeApplied(applied)
  return done
}

// How many of the latest applied event ids the snapshot names (the watch's changes in flight).
export const APPLIED_IN_SNAPSHOT = 40
/** The ids of the watch's events applied lately, newest last, for the snapshot. */
export const recentlyApplied = (max = APPLIED_IN_SNAPSHOT) => readApplied().slice(-max)

/** The app's own actions, for what needs no screen (starting a session, a set's heart rate). */
export function bindWatchAppActions (h) {
  appHandlers = h
  drainWatchEvents()
  return () => { if (appHandlers === h) appHandlers = null }
}

/* ---------- the native plugin ---------- */

let pluginP = null
// Inside an object: a Capacitor plugin proxy answers `then`, so a promise must never resolve with
// the bare proxy (lib/rest-alert.js, the Coach hang #42).
const watchPlugin = () => pluginP || (pluginP = (async () => {
  if (!MOBILE || (await nativePlatform()) !== 'ios') return null
  const { registerPlugin } = await import('@capacitor/core')
  return { WatchBridge: registerPlugin('WatchBridge') }
})().catch(() => null))

let getStateRef = null
let draining = null
// The store has its copy back (boot's finishBoot: the file mirror, the server's pull). Before that,
// S can be the empty copy a WebView whose storage was evicted starts with: a tick would find no
// workout, count as meaningless and be acknowledged away, and a "start" would begin a new session
// over it. A store without the flag (a test's) counts as ready.
const storeReady = () => getStateRef?.()?.ready !== false

/**
 * Takes what the watch sent from the native queue, applies it, and acknowledges what is done, but
 * only once the change is on disk (the store's saveNow): the queue is the event's last copy.
 */
export function drainWatchEvents () {
  if (draining) return draining
  draining = (async () => {
    try {
      const p = await watchPlugin()
      if (!p || !getStateRef || !storeReady()) return []
      const { events = [] } = (await p.WatchBridge.drain()) || {}
      const done = applyEvents(events, getStateRef)
      if (done.length) await getStateRef()?.saveNow?.()
      if (done.length) await p.WatchBridge.ack({ ids: done })
      return done
    } catch { return [] } finally { draining = null }
  })()
  return draining
}

/** The workout screen hands over its own actions while it is mounted. Returns the unbind. */
export function bindWatchActions (h) {
  handlers = h
  drainWatchEvents()
  return () => { if (handlers === h) handlers = null }
}

/**
 * Started once by the app. Sends a snapshot whenever the workout or its rest changes (debounced,
 * and only what differs from the last one sent), drains the queue when the app comes back.
 */
// Workouts the watch started, so the phone doesn't open the watch app for them again.
const startedOnWatch = new Set()
/** How long after its start a workout that turns up still opens the watch app (not one restored on launch). */
export const OPEN_ON_WATCH_WINDOW_MS = 2 * 60 * 1000

/**
 * Whether a workout that just appeared on the phone opens the watch app (Settings → Apple Watch,
 * "Open on the watch"): a new live session started here a moment ago, not one the watch started,
 * not a backfilled past one, and not one that came back with the app's saved state.
 */
export function shouldOpenOnWatch (prev, next, { prefs = readWatchPrefs(), now = Date.now(), fromWatch = startedOnWatch } = {}) {
  if (!next || !next.id || (prev && prev.id === next.id)) return false
  if (!prefs.enabled || !prefs.autoShow || next.backfill || fromWatch.has(next.id)) return false
  const start = Number(next.start)
  return Number.isFinite(start) && start > 0 && Math.abs(now - start) <= OPEN_ON_WATCH_WINDOW_MS
}

// The application context has a size limit (about 65 KB); a snapshot over it is refused, and then
// the watch would never hear of the workout. Kept well under it, with room for the settings.
export const SNAPSHOT_MAX_BYTES = 48 * 1024
const bytesOf = v => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)).length

/**
 * The snapshot made small enough to send, dropping first what matters least: the "last time" lines
 * of the exercises the watch could add and of the routines it could start, then those exercises
 * and routines (down to a dozen, three, none), then today's own "last
 * time" lines and records, then the "last time" of the running workout, then what is ready
 * altogether. The running workout's sets are never cut: without them the watch has nothing to do.
 */
export function fitSnapshot (snap, max = SNAPSHOT_MAX_BYTES) {
  if (bytesOf(snap) <= max) return snap
  const out = JSON.parse(JSON.stringify(snap))
  const strip = (entries, ...keys) => { for (const e of entries || []) for (const k of keys) delete e[k] }
  const steps = [
    () => strip(out.exercises?.extra, 'last', 'best'),
    () => { for (const r of out.ready?.others || []) strip(r.entries, 'last', 'best') },
    () => { if (out.exercises) out.exercises.extra = (out.exercises.extra || []).slice(0, 10) },
    () => { if (out.ready) out.ready.others = (out.ready.others || []).slice(0, 12) },
    () => { if (out.ready) out.ready.others = (out.ready.others || []).slice(0, 3) },
    () => { if (out.exercises) out.exercises.extra = [] },
    () => { if (out.ready) out.ready.others = [] },
    () => { if (out.ready?.today) strip(out.ready.today.entries, 'last', 'best') },
    () => { if (out.active) strip(out.active.entries, 'last') },
    () => { out.ready = null; delete out.exercises },
    () => { if (out.active) strip(out.active.entries, 'best') },
  ]
  for (const step of steps) {
    step()
    if (bytesOf(out) <= max) return out
  }
  return out
}

// How many deleted workouts the watch is told about at most (the newest deletions).
export const HEALTH_GONE_MAX = 60

/**
 * The Apple Health sync ids of workouts deleted in openGym (S.deleted, newest first), for the watch
 * to take its own copies out of Health: a workout the watch app saved is the watch's, and the phone
 * may not delete it, nor the heart rate and calories saved with it (lib/health-connect.js goneIds
 * names the same ids for the phone's own copies).
 */
export function healthGoneFor (S, max = HEALTH_GONE_MAX) {
  const del = S?.deleted && typeof S.deleted === 'object' && S.deleted.workouts && typeof S.deleted.workouts === 'object' ? S.deleted.workouts : {}
  return Object.entries(del)
    .filter(([, at]) => Number(at) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, max)
    .map(([id]) => 'opengym-w-' + id)
}

/**
 * What the watch takes from the app beyond its own settings: the app's language (the watch shows
 * its words in it, whatever the watch itself is set to), and whether a workout starts with the
 * weigh-in (Settings → During a workout) with the last body weight to start the crown from.
 */
export function watchExtras (S) {
  let lang = 'en'
  try { lang = baseLang(getLang()) || 'en' } catch { lang = 'en' }
  const bw = Array.isArray(S?.bodyweight) && S.bodyweight.length ? S.bodyweight[S.bodyweight.length - 1] : null
  return {
    lang,
    weighIn: S?.weighIn !== false,
    // cardio speeds are kept in km/h; the watch shows them in the profile's unit
    speedUnit: speedUnitOf(S),
    // the effort a set is logged with ('rir', 'rpe' or 'none'), as the phone's set rows show it
    effort: effortOf(S),
    ...(bw && num(bw.w) ? { lastBw: num(bw.w) } : {}),
  }
}

export async function startWatchSync ({ useStore, useUI }) {
  const p = await watchPlugin()
  if (!p) return () => {}
  getStateRef = () => useStore.getState()
  let lastSent = null, lastClips = null, lastLibrary = null, tm = null
  // The ready sessions only change with the plan, the log or the day: built again only then.
  let readyKey = null, ready = null, exercises = null
  const readyFor = S => {
    const key = [S.routines, S.week, S.dayPlan, S.workouts, S.exWeights, S.unit, S.customEx, todayISO()]
    if (!readyKey || key.some((v, i) => v !== readyKey[i])) {
      readyKey = key
      try { ready = buildReady(S) } catch { ready = null }
      try { exercises = buildExercises(S, ready) } catch { exercises = null }
    }
    return ready
  }
  // Whether a watch with the app is there: asked at start and when the app comes back, not on every
  // change. Without one nothing below runs at all: no snapshot, no clips, no bridge call per tick.
  let linked = false
  const checkLink = async () => {
    try { const st = await p.WatchBridge.status(); linked = !!(st && st.paired && st.installed) } catch { linked = false }
    return linked
  }
  await checkLink()
  // Apple Health on the watch follows the phone's own Apple Health switch (Settings → Data).
  let healthOn = false, offHealth = () => {}
  try {
    const hs = await import('./health-sync.js')
    healthOn = !!(await hs.loadHealth())?.on
    offHealth = hs.onHealthChange(h => { if (!!h?.on !== healthOn) { healthOn = !!h?.on; schedule() } })
  } catch { /* no Apple Health here: the watch measures nothing */ }
  const send = async () => {
    tm = null
    // Not before the store has its copy: an empty one would tell the watch its workout is over.
    if (!linked || !storeReady()) return
    try {
      const S = useStore.getState().S
      const prefs = readWatchPrefs()
      // Settings → Apple Watch: off, the watch is told there is nothing (no workout, nothing ready).
      const snap = prefs.enabled
        ? buildSnapshot(S, { timer: useUI.getState().timer, ready: readyFor(S) })
        : { v: SNAPSHOT_VERSION, unit: S.unit === 'lb' ? 'lb' : 'kg', active: null, ready: null }
      snap.settings = { ...settingsForWatch(prefs, healthOn), ...watchExtras(S) }
      // The watch's own changes the phone has applied: the watch stops laying them over the snapshot.
      if (prefs.enabled) snap.applied = recentlyApplied()
      // What the watch can add or swap in, the phone at home (built with the ready routines).
      if (prefs.enabled && exercises) snap.exercises = exercises
      // With Apple Health on: the deleted workouts, so the watch removes the copies it saved.
      if (healthOn) { const gone = healthGoneFor(S); if (gone.length) snap.healthGone = gone }
      const json = JSON.stringify(fitSnapshot(snap))
      if (json !== lastSent) {
        const r = await p.WatchBridge.sendSnapshot({ json })
        if (r && r.sent) lastSent = json
      }
      // The animations the watch keeps for good (the phone at home): what it lacks, once a change.
      if (prefs.enabled && (prefs.show?.clip ?? true)) {
        const missing = clipsMissing(libraryClipsFor(S, ready, exercises), readWatchClips())
        const libKey = missing.map(c => c.exId + '=' + c.key).join(',')
        if (missing.length && libKey !== lastLibrary) {
          await p.WatchBridge.sendClips({ wid: 'library', clips: missing })
          lastLibrary = libKey
        }
      }
      // The workout's animations, once per workout and exercise (the native side remembers).
      const clips = prefs.enabled ? clipsFor(S) : []
      const key = S.active ? S.active.id + '|' + clips.map(c => c.exId).join(',') : ''
      if (clips.length && key !== lastClips) {
        await p.WatchBridge.sendClips({ wid: S.active.id, clips })
        lastClips = key
      } else if (!S.active && lastClips) {
        // The workout is over: animations still on their way to the watch are not wanted any more.
        lastClips = null
        await p.WatchBridge.dropClips?.()
      }
    } catch { /* no watch, or not now: the next change tries again */ }
  }
  const schedule = () => { if (!linked) return; clearTimeout(tm); tm = setTimeout(send, SEND_DEBOUNCE_MS) }
  // The watch said which animations it keeps: what it lacks goes now.
  afterClips = () => { lastLibrary = null; schedule() }
  const offStore = useStore.subscribe((s, prev) => {
    // Boot done: what the watch sent meanwhile is applied now, and the watch hears the real state.
    if (s.ready && !prev.ready) { drainWatchEvents(); schedule() }
    if (s.S === prev.S) return
    schedule()
    // A workout started on the phone: the watch app opens with it (HealthKit's startWatchApp).
    if (linked && shouldOpenOnWatch(prev.S?.active, s.S?.active)) Promise.resolve().then(() => p.WatchBridge.openOnWatch()).catch(() => {})
  })
  // The rest as the watch needs it changes when it starts, stops or is paused, not every second.
  const restOf = t => (t ? `${t.endsAt}|${!!t.paused}|${!!t.ready}` : '')
  const offUI = useUI.subscribe((s, prev) => { if (s.timer !== prev.timer && restOf(s.timer) !== restOf(prev.timer)) schedule() })
  const offPrefs = onWatchPrefs(() => schedule())
  // The watch speaks the app's language, not its own system's: told again when it changes (the
  // exercise names in the snapshot change with it too).
  let offLang = () => {}
  try { offLang = onLangChange(() => schedule()) } catch { /* a test without i18n */ }
  const sub = await p.WatchBridge.addListener('watchEvent', () => { drainWatchEvents() })
  // The link itself changed (the session finished activating after launch, a watch was paired, the
  // app was installed on it): asked again, and the snapshot sent when there is a watch now.
  const subLink = await Promise.resolve(p.WatchBridge.addListener('watchState', () => { checkLink().then(() => schedule()) })).catch(() => null)
  const onVisible = () => { if (document.visibilityState === 'visible') { drainWatchEvents(); checkLink().then(() => schedule()) } }
  document.addEventListener('visibilitychange', onVisible)
  schedule()
  drainWatchEvents()
  return () => { offStore(); offUI(); offPrefs(); offHealth(); offLang(); sub?.remove?.(); subLink?.remove?.(); document.removeEventListener('visibilitychange', onVisible); clearTimeout(tm) }
}

// Test seams.
export function _setWatchPluginForTest (plugin, getState) { pluginP = Promise.resolve(plugin ? { WatchBridge: plugin } : null); getStateRef = getState || null }
export function _resetWatchSync () { startedOnWatch.clear(); handlers = null; appHandlers = null; pluginP = null; getStateRef = null; draining = null; afterClips = null }

/**
 * Writes `fields` (heart rate) onto one set: in the running session when it is that workout, else in
 * the saved workout of that id, which is then stamped as edited so the next sync keeps the change
 * (lib/sync-merge.js: of two copies of a workout the one edited last wins). Only these optional
 * fields are ever added; nothing is removed or renamed.
 */
export function patchSetIn (s, { wid, exId, entryIdx, setIdx, side = null }, fields, stamp, { ifNewer = null, recount = null } = {}) {
  // One side of a per-side set: that side takes the numbers and the tick, the row's own w/r/done
  // follow from both sides (lib/workout-model.js syncSideAggregate).
  const write = (set, f) => {
    if (side && isSideSet(set)) {
      const { w, r, done, ...rest } = f
      const one = { ...set.sides[side] }
      if (w != null) one.w = w
      if (r != null) one.r = r
      if (done) one.done = true
      set.sides = { ...set.sides, [side]: one }
      const agg = syncSideAggregate(set)
      for (const k of Object.keys(set)) if (!(k in agg)) delete set[k]
      Object.assign(set, agg, rest)
    } else Object.assign(set, f)
  }
  const find = w => {
    if (!w || !Array.isArray(w.entries)) return null
    const i = w.entries[entryIdx] && w.entries[entryIdx].id === exId ? entryIdx : w.entries.findIndex(e => e && e.id === exId)
    return i >= 0 ? w.entries[i].sets?.[setIdx] || null : null
  }
  if (s.active && s.active.id === wid) {
    const set = find(s.active)
    if (set) write(set, fields)
    return !!set
  }
  const w = (s.workouts || []).find(x => x && x.id === wid)
  const set = find(w)
  if (!set) return false
  // Two changes of the same set: the later one wins (a tick from the watch older than an edit
  // made on the phone since keeps the phone's numbers; its heart rate still lands).
  let f = fields
  if (ifNewer != null && set.done && Number(set.at) > ifNewer) {
    f = {}
    if (fields.hr) f.hr = fields.hr
    if (fields.restHr) f.restHr = fields.restHr
    if (!Object.keys(f).length) return false
  }
  write(set, f)
  if (recount) recount(w)
  if (stamp) stamp(w)
  return true
}

/** Whether a watch is paired and has the app, for Settings → Apple Watch. */
export async function watchStatus () {
  const p = await watchPlugin()
  if (!p) return { paired: false, installed: false }
  try {
    const st = await p.WatchBridge.status()
    // `activated` false: the link is still starting (right after launch), paired/installed not known yet.
    return { paired: !!st?.paired, installed: !!st?.installed, activated: st?.activated !== false }
  } catch { return { paired: false, installed: false } }
}
