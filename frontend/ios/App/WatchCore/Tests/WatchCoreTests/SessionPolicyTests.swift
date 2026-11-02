import XCTest
@testable import WatchCore

/// One workout session at a time on the watch: OliGym never takes it back from another app.
final class SessionPolicyTests: XCTestCase {
    func testARunningSessionIsKept() {
        for t: SessionPolicy.Trigger in [.newWorkout, .pickedUp, .activation, .recordHere] {
            XCTAssertFalse(SessionPolicy.shouldStart(t, yielded: false, live: true))
        }
    }

    func testAfterYieldingTheAppComingBackDoesNotTakeTheSession() {
        XCTAssertFalse(SessionPolicy.shouldStart(.activation, yielded: true, live: false))
        XCTAssertFalse(SessionPolicy.shouldStart(.pickedUp, yielded: true, live: false))
        // a new workout, or Record here, does
        XCTAssertTrue(SessionPolicy.shouldStart(.newWorkout, yielded: true, live: false))
        XCTAssertTrue(SessionPolicy.shouldStart(.recordHere, yielded: true, live: false))
        XCTAssertTrue(SessionPolicy.clearsYield(.recordHere))
        XCTAssertFalse(SessionPolicy.clearsYield(.activation))
    }

    func testADeadSessionNobodyElseRecordsIsStartedAgain() {
        // build 14: failed for a reason of its own, no other app recording
        XCTAssertFalse(SessionPolicy.yields(after: .failed, workoutRunning: true))
        XCTAssertTrue(SessionPolicy.shouldStart(.activation, yielded: false, live: false))
    }

    func testAnotherAppTakingOverMidWorkoutIsAYield() {
        XCTAssertTrue(SessionPolicy.yields(after: .anotherApp, workoutRunning: true))
        // our own end, or no workout left: nothing to yield
        XCTAssertFalse(SessionPolicy.yields(after: .endedByUs, workoutRunning: true))
        XCTAssertFalse(SessionPolicy.yields(after: .anotherApp, workoutRunning: false))
    }

    func testLetAnotherAppRecordNeverStartsOneOnItsOwn() {
        for t: SessionPolicy.Trigger in [.newWorkout, .pickedUp, .activation] {
            XCTAssertFalse(SessionPolicy.shouldStart(t, yielded: false, live: false, elsewhere: true))
        }
        XCTAssertTrue(SessionPolicy.shouldStart(.recordHere, yielded: false, live: false, elsewhere: true))
    }
}
