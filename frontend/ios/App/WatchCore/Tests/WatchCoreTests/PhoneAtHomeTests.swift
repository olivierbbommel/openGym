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

    /* ---------- exercises added and swapped ---------- */

    func entry(_ id: String, _ sets: [SetRow], group: String? = nil) -> Entry {
        var e = Entry(id: id, name: id, mode: "reps", restSec: nil, last: nil, sets: sets)
        e.group = group
        return e
    }

    func testThePickListHasTheRoutinesExercisesThenThePhonesOthersEachOnceNotDone() {
        var s = SessionState()
        s.ready = Ready(today: ReadySession(routineIds: ["r1"], name: "Push", entries: [entry("0025", [row(60, 8, done: true, at: 1)])]),
                        others: [ReadySession(routineIds: ["r2"], name: "Pull", entries: [entry("0025", [row(1, 1)]), entry("pull", [row(0, 8)])])])
        var cardio = entry("run", [row(0, 0)])
        cardio.mode = "cardio"
        s.catalog = ExerciseCatalog(recent: ["fly", "pull"], parts: ["0025": "Chest", "fly": "Chest"], extra: [entry("fly", [row(12, 12)]), cardio])
        let p = SessionCore.picks(s)
        XCTAssertEqual(p.map(\.id), ["0025", "pull", "fly", "run"], "cardio too, logged here now")
        XCTAssertEqual(p[0].entry.sets[0].done, false, "as it would start")
        XCTAssertEqual(p[0].entry.sets[0].w, 60)
        XCTAssertEqual(p[0].part, "Chest")
        XCTAssertEqual(p[2].recent, 0)
        XCTAssertEqual(p[1].recent, 1)
    }

    func testAnAddedExerciseGoesAfterTheOneOnScreenAndItsSupersetAndIsUpNext() {
        var s0 = SessionState()
        s0.workout = ActiveWorkout(id: "p1", name: "Push", unit: "kg", cur: 0, restSec: 90, rest: nil,
                                   entries: [entry("a", [row(1, 1)], group: "g"), entry("b", [row(1, 1)], group: "g"), entry("c", [row(1, 1)])])
        let (s, ev) = SessionCore.addExercise(s0, entry("fly", [row(12, 12, done: true, at: 5)]), at: 10, id: "x1")
        XCTAssertEqual(s.workout?.entries.map(\.id), ["a", "b", "fly", "c"])
        XCTAssertEqual(s.entryIndex, 2)
        XCTAssertEqual(s.workout?.entries[2].sets[0].done, false)
        XCTAssertNil(s.workout?.entries[2].group)
        XCTAssertEqual(ev?["type"] as? String, "addExercise")
        XCTAssertEqual(ev?["index"] as? Int, 2)
        // from the Finish page: at the end
        var f = s0
        f.entryIndex = 3
        XCTAssertEqual(SessionCore.addExercise(f, entry("fly", [row(1, 1)]), at: 1, id: "x2").0.workout?.entries.last?.id, "fly")
    }

    func testASwapReplacesAnExerciseWithNothingDoneWhereItIsInItsSuperset() {
        var s0 = running([row(60, 8), row(60, 8)])
        s0 = SessionCore.skip(s0, entry: 0, set: 0)
        var w = s0.workout!
        w.entries[0].group = "g"
        s0.workout = w
        let (s, ev) = SessionCore.swapExercise(s0, entry: 0, to: entry("db-bench", [row(24, 10)]), at: 10, id: "s1")
        XCTAssertEqual(s.workout?.entries.map(\.id), ["db-bench", "0426"])
        XCTAssertEqual(s.workout?.entries[0].group, "g")
        XCTAssertNil(s.skipped?.first { $0.hasPrefix("0025#") })
        XCTAssertEqual(ev?["to"] as? String, "db-bench")
        XCTAssertEqual(ev?["index"] as? Int, 0)
    }

    func testASwapAfterASetWasDoneKeepsItAndPutsTheNewOneRightAfterAsThePhoneDoes() {
        let s0 = running([row(60, 8, done: true, at: 1), row(60, 8)])
        let (s, ev) = SessionCore.swapExercise(s0, entry: 0, to: entry("db-bench", [row(24, 10)]), at: 10, id: "s1")
        XCTAssertEqual(s.workout?.entries.map(\.id), ["0025", "db-bench", "0426"])
        XCTAssertEqual(s.entryIndex, 1)
        XCTAssertEqual(ev?["index"] as? Int, 1)
        XCTAssertNil(SessionCore.swapExercise(s0, entry: 0, to: entry("0025", []), at: 1, id: "s2").1, "not for itself")
    }

    func testAddedAndSwappedExercisesStayOverOlderSnapshotsAndTheirTicksToo() {
        var s = running([row(60, 8, done: true, at: 1), row(60, 8)])
        s.entryIndex = 1
        s = SessionCore.addExercise(s, entry("fly", [row(12, 12)]), at: 10, id: "x1").0
        s = SessionCore.tick(s, entry: 2, set: 0, w: 12, r: 12, at: 20, id: "t1").0
        s = SessionCore.swapExercise(s, entry: 0, to: entry("db-bench", [row(24, 10)]), at: 30, id: "s1").0
        let before = s.workout?.entries.map(\.id)
        XCTAssertEqual(before, ["0025", "db-bench", "0426", "fly"])
        // the phone has applied none of it yet
        s = SessionCore.applySnapshot(s, snap(workout("p1", [row(60, 8, done: true, at: 1), row(60, 8)])))
        XCTAssertEqual(s.workout?.entries.map(\.id), before)
        XCTAssertEqual(s.workout?.entries[3].sets[0].done, true, "the tick on the added exercise holds")
        // all applied: the phone's copy as it is
        var phone = workout("p1", [row(60, 8, done: true, at: 1), row(60, 8)])
        phone.entries.insert(entry("db-bench", [row(24, 10)]), at: 1)
        phone.entries.append(entry("fly", [row(12, 12, done: true, at: 20)]))
        s = SessionCore.applySnapshot(s, snap(phone, applied: ["x1", "t1", "s1"]))
        XCTAssertEqual(s.workout?.entries.map(\.id), before)
        XCTAssertNil(s.edits)
    }

    /* ---------- a workout started empty ---------- */

    func testAFreestyleStartIsAnEmptySessionThePhoneStartsAsFreestyleAndExercisesGoInFromTheFinishPage() {
        let (s0, ev) = SessionCore.start(SessionState(), ReadySession(routineIds: [], name: "Freestyle", entries: []), wid: "watch-1", at: 1, id: "s1")
        XCTAssertEqual(ev["routineIds"] as? [String], [])
        XCTAssertEqual(s0.workout?.entries.count, 0)
        XCTAssertEqual(s0.entryIndex, 0, "the Finish page, the only one")
        let s1 = SessionCore.addExercise(s0, entry("fly", [row(12, 12)]), at: 2, id: "x1").0
        XCTAssertEqual(s1.workout?.entries.map(\.id), ["fly"])
        XCTAssertEqual(s1.entryIndex, 0)
        let s2 = SessionCore.addExercise(s1, entry("row", [row(40, 10)]), at: 3, id: "x2").0
        XCTAssertEqual(s2.workout?.entries.map(\.id), ["fly", "row"])
        // started here and not confirmed yet: a snapshot without it keeps it, changes and all
        let s3 = SessionCore.applySnapshot(s2, Snapshot(v: 1, unit: "kg", restSec: 90, active: nil, ready: nil, settings: nil, applied: []))
        XCTAssertEqual(s3.workout?.entries.map(\.id), ["fly", "row"])
    }

    /* ---------- cardio at the wrist ---------- */

    func cardio(_ sets: [SetRow]) -> Entry { Entry(id: "treadmill", name: "Treadmill", mode: "cardio", restSec: nil, last: nil, sets: sets) }
    func run(_ min: Double, _ speed: Double, done: Bool = false, at: Double? = nil) -> SetRow {
        SetRow(w: nil, r: nil, sec: nil, done: done, warmup: false, at: at, min: min, speed: speed)
    }

    func testACardioTickCarriesItsMinutesAndSpeedAndHoldsOverAnOlderSnapshot() {
        var s0 = SessionState()
        s0.workout = ActiveWorkout(id: "p1", name: "Run", unit: "kg", cur: 0, restSec: 90, rest: nil, entries: [cardio([run(20, 8), run(20, 8)])])
        let (s, ev) = SessionCore.tick(s0, entry: 0, set: 0, w: nil, r: nil, min: 25, speed: 9.5, at: 10, id: "t1")
        XCTAssertEqual(ev?["min"] as? Double, 25)
        XCTAssertEqual(ev?["speed"] as? Double, 9.5)
        XCTAssertNil(ev?["w"])
        XCTAssertEqual(s.workout?.entries[0].sets[0], run(25, 9.5, done: true, at: 10))
        var w = s0.workout!
        w.cur = 0
        let back = SessionCore.applySnapshot(s, Snapshot(v: 1, unit: "kg", restSec: 90, active: w, ready: nil, settings: nil, applied: []))
        XCTAssertEqual(back.workout?.entries[0].sets[0].min, 25)
        XCTAssertEqual(back.workout?.entries[0].sets[0].speed, 9.5)
    }

    func testCardioGetsSetsAddedAndIsInThePickList() {
        var s0 = SessionState()
        var last = run(30, 10)
        last.incline = 4
        s0.workout = ActiveWorkout(id: "p1", name: "Run", unit: "kg", cur: 0, restSec: 90, rest: nil, entries: [cardio([last])])
        let (s, ev) = SessionCore.addSet(s0, entry: 0, at: 1, id: "a1")
        XCTAssertEqual(s.workout?.entries[0].sets[1].min, 30)
        XCTAssertEqual(s.workout?.entries[0].sets[1].speed, 10)
        XCTAssertEqual(s.workout?.entries[0].sets[1].incline, 4)
        XCTAssertEqual((ev?["rows"] as? [[String: Any]])?[1]["min"] as? Double, 30)
        var r = SessionState()
        r.ready = Ready(today: ReadySession(routineIds: ["r"], name: "Run", entries: [cardio([run(20, 8)])]), others: [])
        XCTAssertEqual(SessionCore.picks(r).map(\.id), ["treadmill"])
    }

    func testSpeedsAreShownInTheProfilesUnitAndKeptInKmh() {
        XCTAssertEqual(Speed.shown(9.66, unit: "kmh"), 9.66)
        XCTAssertEqual(Speed.shown(Speed.kmhPerMph * 6, unit: "mph"), 6, accuracy: 0.0001)
        XCTAssertEqual(Speed.stored(6, unit: "mph"), 9.66)
        XCTAssertEqual(Speed.stored(8.5, unit: nil), 8.5)
        XCTAssertEqual(Speed.label("mph"), "mph")
        XCTAssertEqual(Speed.label(nil), "km/h")
    }
}

