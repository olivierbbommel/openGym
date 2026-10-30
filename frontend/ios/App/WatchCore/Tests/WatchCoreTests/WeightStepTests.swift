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

    func testTheCrownCountsDetentsFromWhereTheWeightWas() {
        XCTAssertEqual(WeightStep.fromTicks(62.5, 0, in: 0...700), 62.5)
        XCTAssertEqual(WeightStep.fromTicks(62.5, 3, in: 0...700), 62.8)
        XCTAssertEqual(WeightStep.fromTicks(62.5, -10, in: 0...700), 61.5)
        // a detent is a whole one: a half-turned crown does not leave 62.55
        XCTAssertEqual(WeightStep.fromTicks(62.5, 0.4, in: 0...700), 62.5)
        XCTAssertEqual(WeightStep.fromTicks(0.5, -10, in: 0...700), 0)
        XCTAssertEqual(WeightStep.crownSpan * WeightStep.crown, 15, accuracy: 1e-9)
    }
}
