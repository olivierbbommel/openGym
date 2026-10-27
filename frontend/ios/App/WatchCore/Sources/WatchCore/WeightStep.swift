import Foundation

/// The weight editor's arithmetic. The crown turns the weight in tenths (any weight a lifter
/// can load, 62.3 kg included), the − and + beside it jump by the exercise's own step (its plates
/// or machine stack) from wherever the crown left it, and nothing snaps it back to that grid.
public enum WeightStep {
    /// What one detent of the crown moves the weight by, in kg or lb alike.
    public static let crown = 0.1

    /// A weight to the tenth, without the drift adding tenths leaves (62.300000000000004).
    public static func clean(_ v: Double) -> Double { (v * 10).rounded() / 10 }

    /// − or +: the weight moved by `d`, kept in `range`, not put back on the step's grid.
    public static func nudge(_ v: Double, by d: Double, in range: ClosedRange<Double>) -> Double {
        min(range.upperBound, max(range.lowerBound, clean(v + d)))
    }
}
