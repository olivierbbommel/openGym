import XCTest
@testable import WatchCore

/// The crown turns a weight in tenths and never snaps it to the plate step.
final class WeightStepTests: XCTestCase {
    func testTenthsStayTenthsWithoutDrift() {
        var w = 62.0
        for _ in 0..<3 { w += WeightStep.crown }
        XCTAssertNotEqual(w, 62.3)              // what plain adding gives: 62.300000000000004
        XCTAssertEqual(WeightStep.clean(w), 62.3)
        XCTAssertEqual(WeightStep.clean(62.3), 62.3)
    }

    func testTheButtonsJumpByTheStepFromWhereTheCrownLeftIt() {
        XCTAssertEqual(WeightStep.nudge(62.3, by: 2.5, in: 0...700), 64.8)
        XCTAssertEqual(WeightStep.nudge(62.3, by: -2.5, in: 0...700), 59.8)
        XCTAssertEqual(WeightStep.nudge(1.0, by: -2.5, in: 0...700), 0)
        XCTAssertEqual(WeightStep.nudge(699.0, by: 5, in: 0...700), 700)
    }
}
