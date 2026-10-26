// The watch's events by way of the server: the phone left at home.
//
// The watch sends what happens at the wrist to the phone (lib/watch-sync.js). With the phone out of
// reach those events wait on the watch, so a workout done with the phone at home reached the
// server only once the two met again. Now the watch, with Wi-Fi or its own cellular, also writes
// them into the profile itself, with the paired phone's token: `watchInbox`, a list of the same
// events. The next client that opens the profile applies them with the same code as a tick that
// came straight from the watch (applyEvents), and notes their ids in `watchInboxDone`. Nothing on
// the server reads either field: it keeps them as it keeps every other key of the profile.
//
// Each event carries its own id, and every way of applying it checks that id first: the device's
// own list of applied ids, and `watchInboxDone` for what another device applied. The workout the
// events build has the watch's id too, so two devices that both apply a start before either has
// synced end up with the one workout once their copies meet (sync-merge's union by id).

// The events waiting at most (a workout of several hundred sets is a few hundred events).
export const INBOX_MAX = 500
// The ids applied somewhere, kept so a copy that still lists one does not bring it back.
export const INBOX_DONE_MAX = 1000

const list = v => (Array.isArray(v) ? v : [])
const okEvent = ev => ev && typeof ev === 'object' && typeof ev.id === 'string' && typeof ev.type === 'string'

/**
 * The two fields of two copies, merged: every event either copy has, once, in the order they
 * were made, without those either copy has applied. Returns { watchInbox, watchInboxDone },
 * either null when there is nothing to keep.
 */
export function mergeInbox (a, b) {
  const done = [...new Set([...list(a?.watchInboxDone), ...list(b?.watchInboxDone)].filter(x => typeof x === 'string'))]
    .slice(-INBOX_DONE_MAX)
  const gone = new Set(done)
  const seen = new Set()
  const inbox = []
  for (const ev of [...list(a?.watchInbox), ...list(b?.watchInbox)]) {
    if (!okEvent(ev) || gone.has(ev.id) || seen.has(ev.id)) continue
    seen.add(ev.id)
    inbox.push(ev)
  }
  // The watch stamps each event's place in its queue (`seq`); the order it was made in is the
  // order it applies in (a start before its sets).
  inbox.sort((x, y) => (num(x.seq) ?? Infinity) - (num(y.seq) ?? Infinity))
  return { watchInbox: inbox.length ? inbox.slice(-INBOX_MAX) : null, watchInboxDone: done.length ? done : null }
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Writes mergeInbox's result into `out` (a field with nothing to keep is left out). */
export function putInbox (out, merged) {
  for (const k of ['watchInbox', 'watchInboxDone']) {
    if (merged[k]) out[k] = merged[k]
    else delete out[k]
  }
  return out
}

/** The profile's waiting events that this device has not applied, in order. */
export function inboxPending (S, applied = []) {
  const skip = new Set([...list(applied), ...list(S?.watchInboxDone)])
  return list(S?.watchInbox).filter(ev => okEvent(ev) && !skip.has(ev.id))
}

/** Takes `ids` out of the profile's inbox and notes them as applied. Mutates `s` (a store update). */
export function markInboxDone (s, ids) {
  const these = list(ids).filter(x => typeof x === 'string')
  if (!these.length) return s
  return putInbox(s, mergeInbox({ watchInbox: s.watchInbox, watchInboxDone: [...list(s.watchInboxDone), ...these] }, null))
}
