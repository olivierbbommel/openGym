import Foundation

/*
 * What the phone sends the watch (frontend lib/watch-sync.js buildSnapshot), as the watch reads
 * it. Plain data, no media. Every field the phone may leave out is optional, so an older or a
 * newer phone never makes the watch fail to read a snapshot.
 */

struct Snapshot: Codable, Equatable {
    var v: Int
    var unit: String?
    var restSec: Double?
    var active: ActiveWorkout?
    var ready: Ready?
    var settings: WatchSettings?
    /// Apple Health sync ids of workouts deleted in openGym ("opengym-w-<id>", newest first): the
    /// watch takes out the copies it saved itself, which the phone may not delete.
    var healthGone: [String]?
    /// The ids of the watch's events the phone applied lately: the watch stops laying those of its
    /// own changes over the snapshot (SessionCore.applySnapshot). A phone that sends none knows none.
    var applied: [String]?
    /// What can be added to a session or swapped in besides the ready routines' exercises.
    var exercises: ExerciseCatalog?
}

/// The exercises the watch can add or swap in with the phone at home (frontend buildExercises):
/// those of the ready routines (taken from `ready`), and these beside them.
struct ExerciseCatalog: Codable, Equatable {
    /// Done lately, newest first.
    var recent: [String]?
    /// The body part of each, in the app's words, for the list's sections.
    var parts: [String: String]?
    /// Done lately or made by the lifter, but in no ready routine: each with last time's sets.
    var extra: [Entry]?
}

/// One exercise in the watch's list to add or swap in: as it would start (its rows not done).
struct Pick: Equatable, Identifiable {
    var entry: Entry
    var part: String
    /// Its place among the recent ones (0 the latest), or nil.
    var recent: Int?
    var id: String { entry.id }
}

/// What the watch can start by itself: today's planned session and a few other routines.
struct Ready: Codable, Equatable {
    var today: ReadySession?
    var others: [ReadySession]
    /// On a day with nothing planned: the next planned routine and its day, for the complications.
    var next: NextSession?
}

struct NextSession: Codable, Equatable {
    var name: String
    /// Its day as the phone says it, in the app's language ("Tue", "Tomorrow").
    var day: String
}

struct ReadySession: Codable, Equatable {
    var routineIds: [String]
    var name: String
    var entries: [Entry]
}

struct ActiveWorkout: Codable, Equatable {
    var id: String?
    var name: String
    var unit: String
    var cur: Int
    var restSec: Double
    var rest: RestInfo?
    var entries: [Entry]
    /// When it started (ms since 1970), for the summary's duration.
    var start: Double?
}

struct RestInfo: Codable, Equatable {
    var endsAt: Double
}

struct Entry: Codable, Equatable {
    var id: String
    var name: String
    /// "reps", "time" (a hold, `sec` per set) or "cardio" (logged on the phone).
    var mode: String
    var restSec: Double?
    var last: String?
    var sets: [SetRow]
    /// No load of its own: `w` is added weight, shown only when there is some.
    var bodyweight: Bool?
    /// Unilateral: each set is done one side at a time (`sides`).
    var perSide: Bool?
    /// A superset: neighbours with the same group are done in turns, the rest after each round.
    var group: String?
    /// The best set before this workout, for the PRs at the finish.
    var best: BestSet?
    /// Assisted (a lighter weight is the better one).
    var assisted: Bool?
    /// The weight step this exercise moves in on the phone (its plates or machine stack).
    var step: Double?

    var isTimed: Bool { mode == "time" }
    var isCardio: Bool { mode == "cardio" }
    var isBodyweight: Bool { bodyweight == true }
}

struct BestSet: Codable, Equatable {
    var w: Double?
    var r: Double?
    var sec: Double?
}

/// One side of a per-side set.
struct SideRow: Codable, Equatable {
    var w: Double?
    var r: Double?
    var done: Bool
}

struct Sides: Codable, Equatable {
    var L: SideRow
    var R: SideRow

    subscript(_ side: String) -> SideRow {
        get { side == "R" ? R : L }
        set { if side == "R" { R = newValue } else { L = newValue } }
    }
}

struct SetRow: Codable, Equatable {
    var w: Double?
    var r: Double?
    var sec: Double?
    var done: Bool
    var warmup: Bool
    /// When it was ticked (ms since 1970), on whichever side ticked it: the later tick wins.
    var at: Double?
    /// A per-side set's two sides; `done` is both of them.
    var sides: Sides?
    /// Cardio: the minutes, the speed (km/h, as the phone keeps it) and the incline (%).
    var min: Double?
    var speed: Double?
    var incline: Double?
    /// The effort logged with it, on the scale the profile uses (reps in reserve, or RPE).
    var rir: Double?
    var rpe: Double?

    /// The side up next on a per-side set ("L", then "R"), or nil.
    var sideUp: String? {
        guard let s = sides else { return nil }
        if !s.L.done { return "L" }
        if !s.R.done { return "R" }
        return nil
    }
}

/// The phone's Settings → Apple Watch (frontend lib/watch-settings.js).
struct WatchSettings: Codable, Equatable {
    /// Apple Health workout session (live heart rate, saved workouts).
    var health: Bool?
    /// The wrist taps when a rest is over.
    var restHaptics: Bool?
    /// What the Digital Crown turns first on a set: "reps" or "weight" (older phones).
    var crown: String?
    /// The app's language ("en", "de", "pt-BR", …): the watch shows its words in it.
    var lang: String?
    /// Whether a workout started here asks for the body weight first (the phone's check-in).
    var weighIn: Bool?
    /// The last body weight logged, where the weigh-in's crown starts.
    var lastBw: Double?
    /// What the watch shows during a workout (Settings → Apple Watch); nil is the default.
    var show: WatchShow?
    /// The unit cardio speeds are shown in: "kmh" (default) or "mph". They are kept in km/h.
    var speedUnit: String?
    /// The effort a set is logged with: "rir", "rpe" or "none" (the phone's Settings).
    var effort: String?
}

/// The effort scales, as the phone has them (frontend lib/history.js EFFORT).
enum Effort {
    static func range(_ kind: String) -> ClosedRange<Double> { kind == "rpe" ? 6...10 : 0...10 }
    static let step = 0.5
    static func label(_ kind: String) -> String { kind == "rpe" ? "RPE" : "RIR" }
}

/// What a workout screen shows. Each nil means its default.
struct WatchShow: Codable, Equatable {
    /// The exercise's animation (on).
    var clip: Bool?
    /// The heart rate (on).
    var hr: Bool?
    /// What was lifted last time (on).
    var last: Bool?
    /// The time since the start (off).
    var elapsed: Bool?
    /// Calories so far (off).
    var kcal: Bool?
    /// The next exercise on the rest screen (on).
    var next: Bool?
    /// The rest as a ring with the countdown ("ring", default) or the countdown alone ("plain").
    var rest: String?

    var showClip: Bool { clip ?? true }
    var showHr: Bool { hr ?? true }
    var showLast: Bool { last ?? true }
    var showElapsed: Bool { elapsed ?? false }
    var showKcal: Bool { kcal ?? false }
    var showNext: Bool { next ?? true }
    var restRing: Bool { rest != "plain" }
}

/// Cardio speeds: kept in km/h, shown in the profile's unit (frontend lib/speed.js).
enum Speed {
    static let kmhPerMph = 1.609344

    /// What the screen shows for a stored km/h speed.
    static func shown(_ kmh: Double, unit: String?) -> Double {
        unit == "mph" ? kmh / kmhPerMph : kmh
    }

    /// What is stored for a speed as shown: in mph, kept to hundredths of a km/h, as the phone does.
    static func stored(_ value: Double, unit: String?) -> Double {
        unit == "mph" ? (value * kmhPerMph * 100).rounded() / 100 : value
    }

    static func label(_ unit: String?) -> String { unit == "mph" ? "mph" : "km/h" }
}
