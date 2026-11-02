import Foundation

/// When the watch app starts its own workout session (heart rate, the app kept in front), and when
/// it leaves one to another app. watchOS runs one workout session at a time: a session OliGym
/// starts ends the one Apple's Workout app (or a gym machine through it) is recording, and theirs
/// ends ours. OliGym never takes it back on its own: it yields for the rest of that workout and
/// records again only for a new workout or when asked (Record here).
public enum SessionPolicy {
    /// What asks for a session.
    public enum Trigger: Equatable {
        /// A workout started here, or the phone's opening the app for one it started.
        case newWorkout
        /// A workout this watch picks up from the phone's snapshot.
        case pickedUp
        /// The app back in front with a workout running.
        case activation
        /// The ⋯'s Record here.
        case recordHere
    }

    /// How a session that was running came to an end.
    public enum Loss: Equatable {
        /// end(): the workout finished or was thrown away.
        case endedByUs
        /// Another workout session started (another app, or Apple's Workout app for a gym machine),
        /// or watchOS ended ours.
        case anotherApp
        /// It failed for a reason of its own (a permission, the sensors): nobody else records.
        case failed
    }

    /// Whether to start a session now. A running one is kept; after yielding, only a new workout
    /// or Record here starts one, never the app coming back to the front. With `elsewhere` (the
    /// setting Let another app record: Apple's Workout app records, OliGym logs the sets) only
    /// Record here does: watchOS gives no way to see another app's session before ours ends it.
    public static func shouldStart(_ trigger: Trigger, yielded: Bool, live: Bool, elsewhere: Bool = false) -> Bool {
        if live { return false }
        if elsewhere && trigger != .recordHere { return false }
        switch trigger {
        case .newWorkout, .recordHere: return true
        case .pickedUp, .activation: return !yielded
        }
    }

    /// Whether a session lost this way means another app records now (ours yields to it).
    public static func yields(after loss: Loss, workoutRunning: Bool) -> Bool {
        workoutRunning && loss == .anotherApp
    }

    /// Whether a trigger clears an earlier yield (the lifter chose this app again, or a new workout).
    public static func clearsYield(_ trigger: Trigger) -> Bool {
        trigger == .newWorkout || trigger == .recordHere
    }
}
