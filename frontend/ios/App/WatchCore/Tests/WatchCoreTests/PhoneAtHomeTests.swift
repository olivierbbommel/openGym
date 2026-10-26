import XCTest
@testable import WatchCore

/// The session changed at the wrist with the phone left at home: sets added and removed. Each
/// change is an event for the phone and is laid over the phone's snapshots until it has it.
final class PhoneAtHomeTests: XCTestCase {
    func row(_ w: Double, _ r: Double, done: Bool = false, at: Double? = nil) -> SetRow {
        SetRow(w: w, r: r, sec: nil, done: done, warmup: false, at: at)
    }

    func workout(_ id: String, _ bench: [SetRow]) -> ActiveWorkout {
        ActiveWorkout(id: id, name: "Push", unit: "kg", cur: 0, restSec: 90, rest: nil,
                      entries: [Entry(id: "0025", name: "Bench Press", mode: "reps", restSec: nil, last: nil, sets: bench),
                                Entry(id: "0426", name: "Overhead Press", mode: "reps", restSec: nil, last: nil, sets: [row(40, 8)])])
    }

    func snap(_ w: ActiveWorkout?, applied: [String]? = []) -> Snapshot {
        Snapshot(v: 1, unit: "kg", restSec: 90, active: w, ready: nil, settings: nil, applied: applied)
    }

    func running(_ bench: [SetRow]) -> SessionState { SessionCore.applySnapshot(SessionState(), snap(workout("p1", bench))) }

    func testAddSetCopiesTheLastWorkSetNotDoneAndTellsThePhoneTheRows() {
        let s0 = running([row(60, 8, done: true, at: 1), row(62.5, 6, done: true, at: 2)])
        let (s, ev) = SessionCore.addSet(s0, entry: 0, at: 10, id: "a1")
        XCTAssertEqual(s.workout?.entries[0].sets.count, 3)
        XCTAssertEqual(s.workout?.entries[0].sets[2], row(62.5, 6))
        XCTAssertEqual(SessionCore.setIndex(s, entry: 0), 2)
        XCTAssertEqual(ev?["type"] as? String, "addSet")
        XCTAssertEqual(ev?["exId"] as? String, "0025")
        XCTAssertEqual((ev?["rows"] as? [[String: Any]])?.count, 3)
        XCTAssertEqual(s.edits?.map(\.id), ["a1"])
    }

    func testAddSetOnAPerSideSetCopiesBothSidesNotDone() {
        var e = Entry(id: "split", name: "Split Squat", mode: "reps", restSec: nil, last: nil,
                      sets: [SetRow(w: 20, r: 16, sec: nil, done: true, warmup: false, at: 1,
                                    sides: Sides(L: SideRow(w: 20, r: 8, done: true), R: SideRow(w: 20, r: 8, done: true)))])
        e.perSide = true
        var s0 = SessionState()
        s0.workout = ActiveWorkout(id: "p1", name: "Legs", unit: "kg", cur: 0, restSec: 90, rest: nil, entries: [e])
        let s = SessionCore.addSet(s0, entry: 0, at: 10, id: "a1").0
        let added = s.workout?.entries[0].sets[1]
        XCTAssertEqual(added?.done, false)
        XCTAssertEqual(added?.sides?.L, SideRow(w: 20, r: 8, done: false))
        XCTAssertEqual(added?.sideUp, "L")
    }

    func testATimedPerSideHoldGetsOneSetForEachSideAsOnThePhone() {
        var e = Entry(id: "plank-side", name: "Side Plank", mode: "time", restSec: nil, last: nil,
                      sets: [SetRow(w: nil, r: nil, sec: 30, done: false, warmup: false)])
        e.perSide = true
        var s0 = SessionState()
        s0.workout = ActiveWorkout(id: "p1", name: "Core", unit: "kg", cur: 0, restSec: 90, rest: nil, entries: [e])
        XCTAssertEqual(SessionCore.addSet(s0, entry: 0, at: 1, id: "a").0.workout?.entries[0].sets.count, 3)
    }

    func testRemoveSetTakesOnlyASetNotDoneAndNeverTheLastOne() {
        let s0 = running([row(60, 8, done: true, at: 1), row(60, 8), row(60, 8)])
        XCTAssertNil(SessionCore.removeSet(s0, entry: 0, set: 0, at: 5, id: "r0").1, "a set done stays")
        let (s, ev) = SessionCore.removeSet(s0, entry: 0, set: 1, at: 5, id: "r1")
        XCTAssertEqual(s.workout?.entries[0].sets.count, 2)
        XCTAssertEqual(ev?["setIdx"] as? Int, 1)
        let one = running([row(60, 8)])
        XCTAssertNil(SessionCore.removeSet(one, entry: 0, set: 0, at: 5, id: "r2").1, "one set always stays")
    }

    func testRemovingASetMovesTheTicksAndSkipsAfterItUp() {
        var s = running([row(60, 8), row(60, 8), row(60, 8), row(60, 8)])
        s = SessionCore.tick(s, entry: 0, set: 2, w: 60, r: 8, at: 100, id: "t2").0
        s = SessionCore.skip(s, entry: 0, set: 3)
        s = SessionCore.removeSet(s, entry: 0, set: 1, at: 200, id: "r1").0
        XCTAssertNotNil(s.pending["0025#1"], "the tick of the old third set is now the second's")
        XCTAssertNil(s.pending["0025#2"])
        XCTAssertEqual(s.skipped, ["0025#2"])
        XCTAssertEqual(s.workout?.entries[0].sets[1].done, true)
    }

    func testAChangeStaysOverOlderSnapshotsUntilThePhoneNamesItApplied() {
        var s = running([row(60, 8, done: true, at: 1), row(60, 8)])
        s = SessionCore.addSet(s, entry: 0, at: 10, id: "a1").0
        s = SessionCore.tick(s, entry: 0, set: 2, w: 62.5, r: 8, at: 20, id: "t1").0
        // a snapshot sent before the phone applied either: the added set and its tick stay
        s = SessionCore.applySnapshot(s, snap(workout("p1", [row(60, 8, done: true, at: 1), row(60, 8)])))
        XCTAssertEqual(s.workout?.entries[0].sets.count, 3)
        XCTAssertEqual(s.workout?.entries[0].sets[2].done, true)
        // the phone has the set now (and names it applied): laid over no longer, nothing doubled
        s = SessionCore.applySnapshot(s, snap(workout("p1", [row(60, 8, done: true, at: 1), row(60, 8), row(62.5, 8, done: true, at: 20)]), applied: ["a1", "t1"]))
        XCTAssertEqual(s.workout?.entries[0].sets.count, 3)
        XCTAssertNil(s.edits)
    }

    func testAPhoneThatKnowsNothingOfChangesIsTakenAsItIs() {
        var s = running([row(60, 8)])
        s = SessionCore.addSet(s, entry: 0, at: 10, id: "a1").0
        s = SessionCore.applySnapshot(s, snap(workout("p1", [row(60, 8)]), applied: nil))
        XCTAssertEqual(s.workout?.entries[0].sets.count, 1)
        XCTAssertNil(s.edits)
    }

    func testARemovedSetStaysRemovedOverAnOlderSnapshot() {
        var s = running([row(60, 8), row(60, 8), row(60, 8)])
        s = SessionCore.removeSet(s, entry: 0, set: 2, at: 10, id: "r1").0
        s = SessionCore.applySnapshot(s, snap(workout("p1", [row(60, 8), row(60, 8), row(60, 8)])))
        XCTAssertEqual(s.workout?.entries[0].sets.count, 2)
    }
}
