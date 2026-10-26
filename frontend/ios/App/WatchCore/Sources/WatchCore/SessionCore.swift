import Foundation

/*
 * The session as the watch keeps it, and every change to it, as pure functions: the watch app's
 * SessionStore only calls these, saves the state after each, and sends the events they return.
 * Tested with `swift test` (Tests/WatchCoreTests), no watch needed.
 *
 * The sync, case by case (the phone's side: frontend lib/watch-sync.js):
 *
 *   watch app never opened before the workout started on the phone
 *       the phone keeps its snapshot as the application context, which the watch reads when it
 *       launches (applySnapshot): it picks the running workout up where the phone has it.
 *   watch app killed and relaunched mid-workout
 *       the whole state is saved after every change and restored at launch; then the latest
 *       snapshot is applied over it, with the watch's own unconfirmed ticks kept (below).
 *   phone asleep, locked in a pocket, app killed, Bluetooth off, out of range
 *       the watch runs the session alone; each tick, start and finish is an event sent with
 *       transferUserInfo, which the system queues and delivers, in order, when it can; the phone
 *       applies each one once, by its id.
 *   a snapshot older than the watch's own ticks (sent before the phone applied them)
 *       a tick stays pending until a snapshot shows that set done at the tick's time or later;
 *       until then the snapshot's copy of that set is replaced by the watch's.
 *   the same set changed on both sides
 *       the later tick (`at`) wins, on both sides: here in applySnapshot, on the phone in the
 *       workout screen's watch handler.
 *   finished on the watch while the phone was away
 *       the workout leaves the watch at once; a snapshot that still shows it running (the phone
 *       has not heard yet) does not bring it back.
 *   finished on the phone while the watch was away
 *       a snapshot without it ends it here; ticks the watch made meanwhile are still sent, and
 *       the phone writes them into the saved workout.
 *   started on the watch while the phone was away
 *       kept until the phone reports it back running; a snapshot without it does not end it.
 */

struct PendingTick: Codable, Equatable {
    var w: Double?
    var r: Double?
    var at: Double
    /// A hold's seconds.
    var sec: Double?
    /// Cardio: minutes and speed (km/h).
    var min: Double?
    var speed: Double?
}

struct SessionState: Codable, Equatable {
    var workout: ActiveWorkout?
    var ready: Ready?
    var settings = WatchSettings()
    var unit = "kg"
    var restSec: Double = 90
    /// A session started here that the phone has not reported back running yet.
    var startedHere: String?
    /// Sessions finished here that the phone may still report running for a while.
    var finishedHere: [String] = []
    /// Ticks made here, by "exerciseId#setIndex", until a snapshot shows them.
    var pending: [String: PendingTick] = [:]
    /// The exercise on screen.
    var entryIndex = 0
    /// Sets passed over here ("exerciseId#setIndex"), not done: the next one comes up instead.
    /// Optional, like every field added later, so a state saved by an older build still loads.
    var skipped: [String]?
    /// Changes made here to the session's shape (a set added or removed), by event id, until a
    /// snapshot says the phone applied them: until then they are laid over each snapshot.
    var edits: [WatchEdit]?
    /// The exercises beside the ready routines' that the watch can add or swap in.
    var catalog: ExerciseCatalog?
}

/// A change made here to the session's shape, as it is laid over a snapshot again.
struct WatchEdit: Codable, Equatable {
    /// The event's id, which the phone names in `applied` once it has it.
    var id: String
    /// "addSet", "removeSet", "addExercise" or "swapExercise".
    var kind: String
    var exId: String
    /// The exercise's place when the change was made (found by `exId` when it moved); for an
    /// exercise added, where it went.
    var entry: Int
    /// removeSet: the set taken out.
    var set: Int?
    /// addSet: the rows added.
    var rows: [SetRow]?
    /// addExercise, swapExercise: the exercise that came in.
    var added: Entry?
}

typealias Event = [String: Any]

enum SessionCore {
    static func key(_ exId: String, _ si: Int, _ side: String? = nil) -> String {
        side.map { "\(exId)#\(si)#\($0)" } ?? "\(exId)#\(si)"
    }

    /// A snapshot from the phone, over what the watch has.
    static func applySnapshot(_ s0: SessionState, _ snap: Snapshot) -> SessionState {
        var s = s0
        s.ready = snap.ready
        s.catalog = snap.exercises
        if let u = snap.unit { s.unit = u }
        if let r = snap.restSec, r > 0 { s.restSec = r }
        if let st = snap.settings { s.settings = st }

        // A session started here that the phone has not reported back yet stays, whatever it sends.
        let unconfirmed = s.workout?.id != nil && s.workout?.id == s.startedHere
        guard var next = snap.active, !(next.id.map { s.finishedHere.contains($0) } ?? false) else {
            // No workout on the phone, or one the watch has finished already.
            if unconfirmed { return s }
            s.workout = nil
            s.pending = [:]
            return s
        }
        let same = next.id != nil && next.id == s.workout?.id
        if next.id != nil && next.id == s.startedHere { s.startedHere = nil }
        if !same && unconfirmed {
            // The phone runs a different workout than the one started here and not yet confirmed:
            // the watch keeps its own; the phone keeps its own (frontend: a start while another runs).
            return s
        }
        if !same {
            // Another workout (or the first one this watch sees): its own position, no old ticks.
            s.pending = [:]
            s.skipped = nil
            s.edits = nil
            s.entryIndex = next.cur
        } else if let edits = s.edits, !edits.isEmpty {
            // This watch's own changes to the session's shape the phone has not applied yet are laid
            // over its snapshot again; a phone that names nothing applied knows no such changes.
            let applied = Set(snap.applied ?? [])
            let open = snap.applied == nil ? [] : edits.filter { !applied.contains($0.id) }
            for e in open { next = applyEdit(next, e) }
            s.edits = open.isEmpty ? nil : open
        }
        // The watch's ticks the phone has not shown yet win; the later tick wins on a set both changed.
        for (ei, e) in next.entries.enumerated() {
            for (si, row) in e.sets.enumerated() {
                let k = key(e.id, si)
                if let p = s.pending[k] {
                    if row.done && (row.at ?? .infinity) >= p.at {
                        s.pending[k] = nil          // the phone has it (or a later change of its own)
                    } else {
                        next.entries[ei].sets[si].done = true
                        next.entries[ei].sets[si].w = p.w ?? row.w
                        next.entries[ei].sets[si].r = p.r ?? row.r
                        if let sec = p.sec { next.entries[ei].sets[si].sec = sec }
                        if let m = p.min { next.entries[ei].sets[si].min = m }
                        if let v = p.speed { next.entries[ei].sets[si].speed = v }
                        next.entries[ei].sets[si].at = p.at
                    }
                }
                // A per-side set: each side by itself, the same way.
                for side in ["L", "R"] {
                    let ks = key(e.id, si, side)
                    guard let p = s.pending[ks] else { continue }
                    let have = next.entries[ei].sets[si]
                    if have.sides?[side].done == true && (row.at ?? .infinity) >= p.at {
                        s.pending[ks] = nil
                    } else if have.sides != nil {
                        next.entries[ei].sets[si] = markSide(have, side, w: p.w, r: p.r, at: p.at)
                    } else {
                        s.pending[ks] = nil         // no longer a per-side set on the phone
                    }
                }
            }
        }
        s.entryIndex = min(max(0, s.entryIndex), next.entries.count)   // the last page is Finish
        s.workout = next
        return s
    }

    /// One side of a per-side set done, the row's own numbers following both sides (as the phone's
    /// syncSideAggregate: reps the sum, weight the heavier, done when both are).
    static func markSide(_ row0: SetRow, _ side: String, w: Double?, r: Double?, at: Double) -> SetRow {
        guard var sides = row0.sides else { return row0 }
        var row = row0
        var one = sides[side]
        one.done = true
        if let w = w { one.w = w }
        if let r = r { one.r = r }
        sides[side] = one
        row.sides = sides
        row.done = sides.L.done && sides.R.done
        row.r = (sides.L.r ?? 0) + (sides.R.r ?? 0)
        row.w = max(sides.L.w ?? 0, sides.R.w ?? 0)
        row.at = max(row0.at ?? 0, at)
        return row
    }

    /// A set ticked here: the state with it done, and the event for the phone. `side` ticks one
    /// side of a per-side set; `sec` is a hold's seconds; a cardio set carries its minutes and speed.
    static func tick(_ s0: SessionState, entry ei: Int, set si: Int, side: String? = nil, w: Double?, r: Double?, sec: Double? = nil,
                     min: Double? = nil, speed: Double? = nil,
                     at: Double, id: String, hr: [String: Double]? = nil) -> (SessionState, Event?) {
        guard var workout = s0.workout, workout.entries.indices.contains(ei), workout.entries[ei].sets.indices.contains(si) else { return (s0, nil) }
        var s = s0
        let e = workout.entries[ei]
        let oneSide = side.flatMap { e.sets[si].sides != nil ? $0 : nil }
        if let side = oneSide {
            workout.entries[ei].sets[si] = markSide(e.sets[si], side, w: w, r: r, at: at)
        } else {
            workout.entries[ei].sets[si].done = true
            if let w = w { workout.entries[ei].sets[si].w = w }
            if let r = r { workout.entries[ei].sets[si].r = r }
            if let sec = sec { workout.entries[ei].sets[si].sec = sec }
            if let m = min { workout.entries[ei].sets[si].min = m }
            if let v = speed { workout.entries[ei].sets[si].speed = v }
            workout.entries[ei].sets[si].at = at
        }
        s.workout = workout
        s.pending[key(e.id, si, oneSide)] = PendingTick(w: w, r: r, at: at, sec: sec, min: min, speed: speed)
        var event: Event = [
            "id": id, "type": "setDone", "wid": workout.id ?? "", "exId": e.id,
            "entryIdx": ei, "setIdx": si, "at": at,
        ]
        if let w = w { event["w"] = w }
        if let r = r { event["r"] = r }
        if let sec = sec { event["sec"] = sec }
        if let m = min { event["min"] = m }
        if let v = speed { event["speed"] = v }
        if let side = oneSide { event["side"] = side }
        if let hr = hr { event["hr"] = hr }
        return (s, event)
    }

    /* ---------- the session's shape, changed here (the phone at home) ---------- */

    /// The exercise an edit means: at its old place while that still holds it, else found by id.
    static func entryIndex(_ w: ActiveWorkout, _ ei: Int, _ exId: String) -> Int? {
        if w.entries.indices.contains(ei), w.entries[ei].id == exId { return ei }
        return w.entries.firstIndex { $0.id == exId }
    }

    /// One change made here, laid over a workout (a snapshot that does not have it yet).
    static func applyEdit(_ w0: ActiveWorkout, _ e: WatchEdit) -> ActiveWorkout {
        var w = w0
        if e.kind == "addExercise", let added = e.added {
            w.entries.insert(added, at: min(max(0, e.entry), w.entries.count))
            return w
        }
        guard let ei = entryIndex(w, e.entry, e.exId) else { return w }
        switch e.kind {
        case "swapExercise":
            if let added = e.added { w.entries = swapped(w.entries, at: ei, with: added).entries }
        case "addSet":
            w.entries[ei].sets.append(contentsOf: e.rows ?? [])
        case "removeSet":
            if let si = e.set, w.entries[ei].sets.indices.contains(si), !w.entries[ei].sets[si].done, w.entries[ei].sets.count > 1 {
                w.entries[ei].sets.remove(at: si)
            }
        default:
            break
        }
        return w
    }

    /// An exercise's rows as an event carries them, for the phone to even its own out with.
    static func rowsPayload(_ sets: [SetRow]) -> [[String: Any]] {
        sets.map { row in
            var out: [String: Any] = ["warmup": row.warmup]
            if let w = row.w { out["w"] = w }
            if let r = row.r { out["r"] = r }
            if let sec = row.sec { out["sec"] = sec }
            if let m = row.min { out["min"] = m }
            if let v = row.speed { out["speed"] = v }
            return out
        }
    }

    /// A row like `base`, not done: what Add set appends (the phone's addSet copies the last set too).
    static func freshRow(like base: SetRow?) -> SetRow {
        guard let b = base else { return SetRow(w: 0, r: 10, sec: nil, done: false, warmup: false) }
        let sides = b.sides.map { Sides(L: SideRow(w: $0.L.w, r: $0.L.r, done: false), R: SideRow(w: $0.R.w, r: $0.R.r, done: false)) }
        return SetRow(w: b.w, r: b.r, sec: b.sec, done: false, warmup: false, at: nil, sides: sides, min: b.min, speed: b.speed, incline: b.incline)
    }

    private static func remember(_ s: inout SessionState, _ e: WatchEdit) {
        s.edits = Array(((s.edits ?? []) + [e]).suffix(100))
    }

    /// One more set on exercise `ei`, a copy of its last one (a hold done one side at a time gets
    /// one for each side, as on the phone; cardio its minutes, speed and incline).
    static func addSet(_ s0: SessionState, entry ei: Int, at: Double, id: String) -> (SessionState, Event?) {
        guard var w = s0.workout, w.entries.indices.contains(ei) else { return (s0, nil) }
        var s = s0
        let e = w.entries[ei]
        let row = freshRow(like: e.sets.last(where: { !$0.warmup }) ?? e.sets.last)
        let rows = e.isTimed && e.perSide == true ? [row, row] : [row]
        w.entries[ei].sets.append(contentsOf: rows)
        s.workout = w
        remember(&s, WatchEdit(id: id, kind: "addSet", exId: e.id, entry: ei, set: nil, rows: rows))
        return (s, ["id": id, "type": "addSet", "wid": w.id ?? "", "exId": e.id, "entryIdx": ei,
                    "rows": rowsPayload(w.entries[ei].sets), "at": at])
    }

    /// Set `si` of exercise `ei` taken out: only one not done, and never the last one left. The
    /// ticks and skips of the sets after it move up with them.
    static func removeSet(_ s0: SessionState, entry ei: Int, set si: Int, at: Double, id: String) -> (SessionState, Event?) {
        guard var w = s0.workout, w.entries.indices.contains(ei), w.entries[ei].sets.indices.contains(si),
              !w.entries[ei].sets[si].done, w.entries[ei].sets.count > 1 else { return (s0, nil) }
        var s = s0
        let exId = w.entries[ei].id
        w.entries[ei].sets.remove(at: si)
        s.workout = w
        s.pending = shifted(s.pending, exId: exId, after: si)
        if let sk = s.skipped {
            let moved = shifted(Dictionary(uniqueKeysWithValues: sk.map { ($0, true) }), exId: exId, after: si)
            s.skipped = moved.keys.sorted()
        }
        remember(&s, WatchEdit(id: id, kind: "removeSet", exId: exId, entry: ei, set: si, rows: nil))
        return (s, ["id": id, "type": "removeSet", "wid": w.id ?? "", "exId": exId, "entryIdx": ei, "setIdx": si,
                    "rows": rowsPayload(w.entries[ei].sets), "at": at])
    }

    /// An exercise as it starts: its rows not done (the numbers kept), in no superset of its own.
    static func startable(_ e0: Entry) -> Entry {
        var e = e0
        e.group = nil
        e.sets = e.sets.map { row in
            var r = row
            r.done = false
            r.at = nil
            if let s = r.sides { r.sides = Sides(L: SideRow(w: s.L.w, r: s.L.r, done: false), R: SideRow(w: s.R.w, r: s.R.r, done: false)) }
            return r
        }
        return e
    }

    /// What the watch can add or swap in: the ready routines' exercises (as they would start
    /// there), then the phone's others, each once. Recent ones carry
    /// their place among the recent.
    static func picks(_ s: SessionState) -> [Pick] {
        let recent = s.catalog?.recent ?? []
        let parts = s.catalog?.parts ?? [:]
        var seen = Set<String>()
        var out: [Pick] = []
        let all = (s.ready?.today?.entries ?? []) + (s.ready?.others ?? []).flatMap { $0.entries } + (s.catalog?.extra ?? [])
        for e in all where !seen.contains(e.id) {
            seen.insert(e.id)
            out.append(Pick(entry: startable(e), part: parts[e.id] ?? "", recent: recent.firstIndex(of: e.id)))
        }
        return out
    }

    /// Where an exercise added after exercise `ei` goes: after the superset `ei` is in, if any
    /// (the phone's insertionIndexAfterCurrentUnit); after the last from the Finish page.
    static func insertionIndex(_ w: ActiveWorkout, after ei: Int) -> Int {
        guard w.entries.indices.contains(ei) else { return w.entries.count }
        var hi = ei
        if let g = w.entries[ei].group {
            while hi + 1 < w.entries.count && w.entries[hi + 1].group == g { hi += 1 }
        }
        return hi + 1
    }

    /// `entries` with exercise `ei` swapped for `e`, as the phone swaps (lib/active-exercise-swap.js):
    /// one with no set done is replaced where it is, in its superset; one with sets done keeps them,
    /// and the new one goes right after it, in the same superset (the phone's "keep in group").
    static func swapped(_ entries0: [Entry], at ei: Int, with e: Entry) -> (entries: [Entry], index: Int) {
        var entries = entries0
        var entry = e
        entry.group = entries[ei].group
        if entries[ei].sets.contains(where: { $0.done }) {
            entries.insert(entry, at: ei + 1)
            return (entries, ei + 1)
        }
        entries[ei] = entry
        return (entries, ei)
    }

    /// Exercise `e` added here, after the one on screen (and its superset), and up next.
    static func addExercise(_ s0: SessionState, _ e: Entry, at: Double, id: String) -> (SessionState, Event?) {
        guard var w = s0.workout else { return (s0, nil) }
        var s = s0
        let entry = startable(e)
        let idx = insertionIndex(w, after: s0.entryIndex)
        w.entries.insert(entry, at: idx)
        s.workout = w
        s.entryIndex = idx
        remember(&s, WatchEdit(id: id, kind: "addExercise", exId: entry.id, entry: idx, set: nil, rows: nil, added: entry))
        return (s, ["id": id, "type": "addExercise", "wid": w.id ?? "", "exId": entry.id, "index": idx,
                    "rows": rowsPayload(entry.sets), "at": at])
    }

    /// Exercise `ei` swapped for `e` here (as `swapped`), the new one up next.
    static func swapExercise(_ s0: SessionState, entry ei: Int, to e: Entry, at: Double, id: String) -> (SessionState, Event?) {
        guard var w = s0.workout, w.entries.indices.contains(ei), w.entries[ei].id != e.id else { return (s0, nil) }
        var s = s0
        let old = w.entries[ei]
        let entry = startable(e)
        let (entries, idx) = swapped(w.entries, at: ei, with: entry)
        w.entries = entries
        s.workout = w
        s.entryIndex = idx
        if idx == ei {
            // Replaced where it was: nothing of the old one was done, its skips go with it.
            s.pending = s.pending.filter { !$0.key.hasPrefix(old.id + "#") }
            s.skipped = s.skipped?.filter { !$0.hasPrefix(old.id + "#") }
        }
        remember(&s, WatchEdit(id: id, kind: "swapExercise", exId: old.id, entry: ei, set: nil, rows: nil, added: w.entries[idx]))
        return (s, ["id": id, "type": "swapExercise", "wid": w.id ?? "", "exId": old.id, "entryIdx": ei, "to": entry.id,
                    "index": idx, "rows": rowsPayload(w.entries[idx].sets), "at": at])
    }

    /// Keys "exId#i" (and "exId#i#side") of the sets after `si` moved up one; the one at `si` gone.
    static func shifted<V>(_ d: [String: V], exId: String, after si: Int) -> [String: V] {
        var out: [String: V] = [:]
        for (k, v) in d {
            let parts = k.split(separator: "#", omittingEmptySubsequences: false).map(String.init)
            guard parts.count >= 2, parts[0] == exId, let i = Int(parts[1]) else { out[k] = v; continue }
            if i == si { continue }
            let side = parts.count > 2 ? parts[2] : nil
            out[key(exId, i > si ? i - 1 : i, side)] = v
        }
        return out
    }

    /// A set passed over here: not done, the next one comes up (a tap on its dot brings it back).
    static func skip(_ s0: SessionState, entry ei: Int, set si: Int) -> SessionState {
        guard let w = s0.workout, w.entries.indices.contains(ei), w.entries[ei].sets.indices.contains(si) else { return s0 }
        var s = s0
        let k = key(w.entries[ei].id, si)
        s.skipped = Array(Set((s.skipped ?? []) + [k])).sorted()
        return s
    }

    static func isSkipped(_ s: SessionState, _ exId: String, _ si: Int) -> Bool {
        s.skipped?.contains(key(exId, si)) ?? false
    }

    /// Where to go after a set of exercise `ei` (set `si`) was done, and whether a rest comes first.
    ///   per-side set with a side to go   the same exercise, no rest (the other side now)
    ///   superset                          the next exercise of the group in turn; the rest only
    ///                                     after the last one of a round
    ///   otherwise                         this exercise while it has sets to do, then the next one
    ///                                     that has; after the last, the Finish page (index = count)
    static func next(after s: SessionState, entry ei: Int, set si: Int) -> (entry: Int, rest: Bool) {
        guard let w = s.workout, w.entries.indices.contains(ei) else { return (s.entryIndex, false) }
        let count = w.entries.count
        if w.entries[ei].sets.indices.contains(si), w.entries[ei].sets[si].sideUp != nil { return (ei, false) }
        let open: (Int) -> Bool = { setIndex(s, entry: $0) != nil }
        if let g = w.entries[ei].group {
            var lo = ei, hi = ei
            while lo > 0 && w.entries[lo - 1].group == g { lo -= 1 }
            while hi + 1 < count && w.entries[hi + 1].group == g { hi += 1 }
            if hi > lo {
                let members = Array(lo...hi)
                let inTurn = members.filter { $0 > ei } + members.filter { $0 <= ei }
                if let n = inTurn.first(where: open) { return (n, n <= ei) }
                if let n = ((hi + 1)..<count).first(where: open) ?? (0..<lo).first(where: open) { return (n, true) }
                return (count, true)
            }
        }
        if open(ei) { return (ei, true) }
        if let n = ((ei + 1)..<count).first(where: open) ?? (0..<ei).first(where: open) { return (n, true) }
        return (count, true)
    }

    /// Of the deleted workouts the phone names, the ones this watch has not taken out of Apple Health
    /// yet (`done`: already removed, or found to have no copy of the watch's). Only workout ids.
    static func healthToDelete(gone: [String]?, done: [String]) -> [String] {
        let seen = Set(done)
        var out: [String] = []
        for id in gone ?? [] where id.hasPrefix("opengym-w-") && !seen.contains(id) && !out.contains(id) { out.append(id) }
        return out
    }

    /// `done` with these ids added, the newest kept (a few hundred is plenty: the phone names at
    /// most the last sixty deletions).
    static func healthDeleted(_ done: [String], adding ids: [String]) -> [String] {
        var out = done.filter { !ids.contains($0) }
        out.append(contentsOf: ids)
        return Array(out.suffix(300))
    }

    /// What the phone is told once they are out, so its own retries of them stop.
    static func healthDeletedEvent(_ ids: [String], id: String) -> Event? {
        ids.isEmpty ? nil : ["id": id, "type": "healthDeleted", "ids": ids]
    }

    /// The weigh-in before a workout started here, for the phone's body weight list.
    static func weighIn(_ w: Double, at: Double, id: String) -> Event? {
        guard w > 0, w < 700 else { return nil }
        return ["id": id, "type": "weighIn", "w": (w * 10).rounded() / 10, "at": at]
    }

    /// A ready session started here, with the body weight just weighed in (or none).
    static func start(_ s0: SessionState, _ session: ReadySession, wid: String, at: Double, id: String, bw: Double? = nil) -> (SessionState, Event) {
        var s = s0
        s.workout = ActiveWorkout(id: wid, name: session.name, unit: s.unit, cur: 0, restSec: s.restSec, rest: nil, entries: session.entries, start: at)
        s.startedHere = wid
        s.pending = [:]
        s.skipped = nil
        s.entryIndex = 0
        var event: Event = ["id": id, "type": "start", "routineIds": session.routineIds, "wid": wid, "at": at]
        if let bw = bw, bw > 0 { event["bw"] = (bw * 10).rounded() / 10 }
        return (s, event)
    }

    /// The session finished here.
    static func finish(_ s0: SessionState, at: Double, id: String) -> (SessionState, Event?) {
        guard let w = s0.workout else { return (s0, nil) }
        var s = s0
        s.workout = nil
        s.pending = [:]
        s.skipped = nil
        s.startedHere = nil
        if let wid = w.id { s.finishedHere = Array((s.finishedHere + [wid]).suffix(5)) }
        return (s, ["id": id, "type": "finish", "wid": w.id ?? "", "at": at])
    }

    /// The session thrown away here: gone from the watch, nothing saved. Like a finish it may not
    /// come back with a snapshot that still shows it. The event is for a phone that already has
    /// the session (its own Discard then runs); one that never heard of it is told nothing.
    static func discard(_ s0: SessionState, at: Double, id: String) -> (SessionState, Event?) {
        guard let w = s0.workout else { return (s0, nil) }
        var s = s0
        s.workout = nil
        s.pending = [:]
        s.skipped = nil
        s.edits = nil
        s.startedHere = nil
        if let wid = w.id { s.finishedHere = Array((s.finishedHere + [wid]).suffix(5)) }
        return (s, ["id": id, "type": "discard", "wid": w.id ?? "", "at": at])
    }

    /// Of the events still waiting to go to the phone (JSON, oldest first), those of workout `wid`,
    /// and whether its start is among them: then the phone has never heard of it.
    static func queued(for wid: String, in events: [String]) -> (matches: [Int], startQueued: Bool) {
        var matches: [Int] = []
        var start = false
        for (i, json) in events.enumerated() {
            guard let data = json.data(using: .utf8),
                  let ev = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  ev["wid"] as? String == wid else { continue }
            matches.append(i)
            if ev["type"] as? String == "start" { start = true }
        }
        return (matches, start)
    }

    /// The set to do next in an exercise: the one picked, or the first not done.
    static func setIndex(_ s: SessionState, entry ei: Int, picked: Int? = nil) -> Int? {
        guard let w = s.workout, w.entries.indices.contains(ei) else { return nil }
        let sets = w.entries[ei].sets
        if let p = picked, sets.indices.contains(p), !sets[p].done { return p }
        let exId = w.entries[ei].id
        return sets.indices.first { !sets[$0].done && !isSkipped(s, exId, $0) }
    }

    /// Sets done and sets in all, for the complication's ring.
    static func progress(_ s: SessionState) -> (done: Int, total: Int) {
        guard let w = s.workout else { return (0, 0) }
        let all = w.entries.flatMap { $0.sets }.filter { !$0.warmup }
        return (all.filter { $0.done }.count, all.count)
    }

    /// The workout as the summary shows it at its end (here, or on the phone).
    static func summary(_ w: ActiveWorkout, end: Double, startedAt: Double? = nil, endedOnPhone: Bool = false) -> WorkoutSummary {
        var sets = 0, volume = 0.0
        var prs: [String] = []
        for e in w.entries {
            let work = e.sets.filter { !$0.warmup }
            for row in work {
                if let sides = row.sides {
                    for one in [sides.L, sides.R] where one.done { volume += (one.w ?? 0) * (one.r ?? 0) }
                    if row.done { sets += 1 }
                } else if row.done {
                    sets += 1
                    if !e.isTimed && !e.isCardio { volume += (row.w ?? 0) * (row.r ?? 0) }
                }
            }
            if let best = e.best, beatsBest(e, work.filter { $0.done }, best) { prs.append(e.name) }
        }
        let from = w.start ?? startedAt
        return WorkoutSummary(name: w.name, unit: w.unit, duration: from.map { max(0, (end - $0) / 1000) },
                              sets: sets, volume: volume, prs: prs, endedOnPhone: endedOnPhone)
    }

    /// Whether one of these done sets beats the best before this workout: a heavier weight (a
    /// lighter one when assisted), or more reps at the same; a longer hold. No history, no PR.
    static func beatsBest(_ e: Entry, _ done: [SetRow], _ best: BestSet) -> Bool {
        if e.isTimed {
            guard let b = best.sec, b > 0 else { return false }
            return done.contains { ($0.sec ?? 0) > b }
        }
        guard !e.isCardio, let bw = best.w, let br = best.r, bw > 0 || br > 0 else { return false }
        let assisted = e.assisted == true
        return done.contains { row in
            let w = row.w ?? 0, r = row.r ?? 0
            if w != bw { return w > 0 && (assisted ? w < bw : w > bw) }
            return r > br
        }
    }
}

/// The end of a workout, on one screen: how long, how much, and what was a first.
struct WorkoutSummary: Codable, Equatable {
    var name: String
    var unit: String
    /// Seconds.
    var duration: Double?
    /// Work sets done (a per-side set once both sides are).
    var sets: Int
    var volume: Double
    /// The exercises with a personal record in this workout.
    var prs: [String]
    var hrAvg: Double?
    var hrMax: Double?
    /// Active kilocalories, from the Apple Health workout.
    var calories: Double?
    /// The phone ended it (finished or discarded there) while the watch had it running.
    var endedOnPhone: Bool
}
