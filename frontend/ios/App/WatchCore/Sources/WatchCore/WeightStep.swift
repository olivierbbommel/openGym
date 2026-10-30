import Foundation

/// The weight editor's arithmetic. The crown turns the weight in tenths (any weight a lifter
/// can load, 62.3 kg included), the − and + beside it jump by the exercise's own step (its plates
/// or machine stack) from wherever the crown left it, and nothing snaps it back to that grid.
public enum WeightStep {
    /// What one detent of the crown moves the weight by, in kg or lb alike.
    public static let crown = 0.1

    /// A weight to the tenth, without the drift adding tenths leaves (62.300000000000004).
    public static func clean(_ v: Double) -> Double { (v * 10).rounded() / 10 }

    /// How far the crown can turn from where the weight was, in detents each way (±15 kg or lb).
    /// The crown counts detents over this small range, at a low sensitivity, rather than turning
    /// the weight over its whole 0 to 700: over that range one small turn ran through kilos of
    /// tenths. A deliberate small turn is now a tenth, a bigger one about a kilo.
    public static let crownSpan = 150.0

    /// The weight `ticks` detents of the crown away from `base`, in tenths, kept in `range`.
    public static func fromTicks(_ base: Double, _ ticks: Double, in range: ClosedRange<Double>) -> Double {
        nudge(base, by: ticks.rounded() * crown, in: range)
    }

    /// − or +: the weight moved by `d`, kept in `range`, not put back on the step's grid.
    public static func nudge(_ v: Double, by d: Double, in range: ClosedRange<Double>) -> Double {
        min(range.upperBound, max(range.lowerBound, clean(v + d)))
    }
}
