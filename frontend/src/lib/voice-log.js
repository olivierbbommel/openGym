// "Log by voice": a workout told afterwards in your own words ("four rounds of a ten second
// pull-up hold, six pull-ups with the yellow band and eight pike push-ups…") becomes a past
// workout to check and save. A model reads the words (voice-log-ai.js); everything here is the
// pure part around it: which exercises it may name, what it is asked, and what of its answer
// becomes session entries. Like the Coach's validator, this file and not the prompt decides
// what lands in the log: an id that was not offered, a set without a number, a count out of
// any sane range is dropped here.
import { defaultConfig } from './history.js'

export const DESCRIPTION_MAX = 4000
export const MAX_CANDIDATES = 220
const MAX_ENTRIES = 40
const MAX_SETS = 30
const NAME_MAX = 60
const NOTE_MAX = 200

const STOP = new Set(['the', 'and', 'with', 'then', 'that', 'for', 'after', 'did', 'was', 'were', 'you', 'your', 'had',
  'each', 'set', 'sets', 'rep', 'reps', 'round', 'rounds', 'times', 'time', 'second', 'seconds', 'sec', 'secs', 'minute',
  'minutes', 'min', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'twelve', 'fifteen',
  'twenty', 'first', 'next', 'last', 'until', 'failure', 'hold', 'band', 'yellow', 'red', 'green', 'blue', 'black',
  'purple', 'orange', 'down', 'from', 'over', 'into', 'this', 'what', 'when', 'there', 'they', 'them', 'did', 'done',
  'just', 'about', 'around', 'like', 'some', 'more', 'less', 'today', 'class', 'workout', 'circuit', 'trainer', 'version'])

// The words a name or a description is made of, in one spelling: "Pull-ups" → pull, pullup.
export function wordsOf(text) {
  const out = new Set()
  const s = String(text || '').toLowerCase()
  const add = w => {
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
    if (w.length >= 3 && !STOP.has(w)) out.add(w)
  }
  for (const w of s.split(/[^a-z0-9]+/)) add(w)
  // "pull-up", "pull up" and "pullup" are one word to whoever said it.
  for (const m of s.matchAll(/([a-z]+)[\s-]+(up|ups|over|out)\b/g)) add(m[1] + m[2])
  return out
}

/**
 * The exercises the model may name: the person's own, the ones in their log, and the catalogue
 * exercises whose names share a word with what they said, best match first. Bounded, because a
 * small model picks better from two hundred than from five thousand and the bill is per token.
 */
export function candidateExercises(S, description, catalogue) {
  const said = wordsOf(description)
  const logged = new Set()
  for (const w of (S?.workouts || []).slice(-60)) for (const e of w?.entries || []) if (e?.id) logged.add(e.id)
  const customs = (Array.isArray(S?.customEx) ? S.customEx : []).filter(c => c && typeof c.id === 'string' && c.n)
  // One list per word said, best match first: more of its words said is the better match, and
  // words nobody said cost a little, so "dip" ranks "triceps dip" above "dip on floor with chair".
  const buckets = new Map([...said].map(w => [w, []]))
  for (const e of catalogue || []) {
    if (!e || !e.id || !e.n) continue
    const words = wordsOf(e.n)
    let hit = 0
    for (const w of words) if (said.has(w)) hit++
    if (!hit) continue
    const item = { e, score: hit - 0.15 * (words.size - hit) + (logged.has(e.id) ? 0.5 : 0) }
    for (const w of words) if (buckets.has(w)) buckets.get(w).push(item)
  }
  const lists = [...buckets.values()].filter(l => l.length).map(l => l.sort((a, b) => b.score - a.score))
  const out = []
  const seen = new Set()
  const add = (id, n) => { if (!seen.has(id) && out.length < MAX_CANDIDATES) { seen.add(id); out.push({ id, n: String(n).slice(0, 80) }) } }
  for (const c of customs) add(c.id, c.n)
  // Taken in turns across the words, so "pull" with its hundreds of matches cannot crowd out
  // the dips: every exercise the person named gets its best few in.
  for (let i = 0, more = true; more && out.length < MAX_CANDIDATES; i++) {
    more = false
    for (const l of lists) if (i < l.length) { more = true; add(l[i].e.id, l[i].e.n) }
  }
  const byId = new Map((catalogue || []).map(e => [e.id, e]))
  for (const id of logged) if (byId.has(id)) add(id, byId.get(id).n)
  return out
}

export const SYSTEM = `You turn a person's spoken description of a finished workout into JSON for their workout log.

Return only one JSON object, no prose, in this shape:
{"name": string, "durationMin": number|null, "exercises": [{"id": string, "group": string|null, "groupName": string|null, "mode": "reps"|"time", "sets": [{"reps": number|null, "sec": number|null, "kg": number|null, "failure": boolean}], "note": string|null}], "unmatched": [string]}

Rules:
- "id" must be an id from the EXERCISES list. Pick the closest one: a band-assisted pull-up is "band assisted pull-up", pike push-ups with the feet up or lifted are the pike push-up on a bench. If nothing fits, leave the exercise out and put its words in "unmatched".
- One object per exercise in the order they were done. Expand rounds and repeats into separate sets: "4 rounds of 6 pull-ups" is 4 sets of 6 reps.
- A circuit or superset (exercises done one after another, then repeated) gives each of its exercises the same "group" letter ("A", "B", …) and the same "groupName" ("Circuit A" unless the person named it). Exercises done on their own have group null.
- A hold ("hold for 10 seconds") is mode "time" with "sec" on each set. Everything else is mode "reps".
- "to failure" or "until failure" sets have "failure": true; "reps" is the number if they said it, else null.
- "kg" only for added weight they stated (a weight vest, a dumbbell). Body weight alone is null.
- Put what the log has no field for in "note", short, in the person's words: the band colour ("Yellow band"), a pause or tempo ("5 s pause at the bottom"), a variation.
- A number they did not say stays null. Never invent reps, sets or weights.
- "name": a short title for the session (e.g. "Calisthenics class"). "durationMin" only if they said how long it took.`

export function userPrompt(description, candidates) {
  return 'EXERCISES (id | name):\n' + candidates.map(c => `${c.id} | ${c.n}`).join('\n') +
    '\n\nWHAT THE PERSON SAID:\n' + String(description || '').slice(0, DESCRIPTION_MAX)
}

const num = (v, max) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : null
}
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * The model's answer as session entries, done, for the workout screen to show before saving.
 * Returns { name, durationMin, entries, unmatched, dropped }: `dropped` counts what was named
 * but could not be used (an id that was not offered, an exercise with no usable set).
 */
export function draftToEntries(draft, candidates) {
  const offered = new Set((candidates || []).map(c => c.id))
  const unmatched = Array.isArray(draft?.unmatched) ? draft.unmatched.map(u => text(u, NAME_MAX)).filter(Boolean).slice(0, 10) : []
  const entries = []
  let dropped = 0
  const groups = new Map()
  for (const x of (Array.isArray(draft?.exercises) ? draft.exercises : []).slice(0, MAX_ENTRIES)) {
    if (!x || typeof x.id !== 'string' || !offered.has(x.id)) { dropped++; continue }
    const timed = x.mode === 'time'
    const sets = []
    for (const s of (Array.isArray(x.sets) ? x.sets : []).slice(0, MAX_SETS)) {
      if (!s || typeof s !== 'object') continue
      const failure = s.failure === true
      const row = { w: num(s.kg, 500) || 0, done: true }
      if (timed) {
        const sec = num(s.sec, 3600)
        if (!sec) continue
        row.sec = sec
      } else {
        const r = num(s.reps, 1000)
        if (r) row.r = Math.round(r)
        else if (!failure) continue        // a set with no number is only a set if it was to failure
      }
      if (failure && !timed) row.failure = true
      sets.push(row)
    }
    if (!sets.length) { dropped++; continue }
    const base = defaultConfig(x.id, timed ? 'time' : 'reps')
    const target = { ...base, id: x.id, mode: timed ? 'time' : 'reps', sets: sets.length, weight: sets[0].w || 0 }
    if (timed) { target.sec = sets[0].sec; delete target.reps } else if (sets[0].r) target.reps = sets[0].r
    const g = text(x.group, 8)
    if (g) {
      if (!groups.has(g)) groups.set(g, 'sgv' + Math.random().toString(36).slice(2, 10))
      target.sg = groups.get(g)
      const gn = text(x.groupName, 40)
      if (gn) target.sgName = gn
    }
    const entry = { id: x.id, target, sets, topW: sets.reduce((m, s) => Math.max(m, s.w || 0), 0) }
    const note = text(x.note, NOTE_MAX)
    if (note) entry.note = note
    entries.push(entry)
  }
  // A group of one is not a superset.
  for (const sg of groups.values()) {
    const members = entries.filter(e => e.target.sg === sg)
    if (members.length < 2) for (const e of members) { delete e.target.sg; delete e.target.sgName }
  }
  return {
    name: text(draft?.name, NAME_MAX),
    durationMin: num(draft?.durationMin, 24 * 60),
    entries, unmatched, dropped
  }
}
