import SwiftUI
import WidgetKit

/*
 * OliGym on the watch face: its logo, and a tap opens the app. One complication, the same at every
 * moment: no workout data and no buttons. The workout itself is the Smart Stack card below
 * (SessionCard), there only while you train. The logo is a shape, so it takes the face's tint in every rendering mode.
 *
 * The kind is the one the workout complication had, so a face that had it keeps its slot, now with
 * the logo. The separate launcher (kind "OpenGymLauncher") is gone: a face that had that one has
 * to have OliGym added again.
 */
struct Entry: TimelineEntry {
    let date: Date
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: Date())) }
    // Nothing on it ever changes: one entry, never refreshed.
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: Date())], policy: .never))
    }
}

struct LogoView: View {
    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                OpenGymLogo().padding(9).widgetAccentable()
            }
        case .accessoryCorner:
            OpenGymLogo()
                .padding(4)
                .widgetAccentable()
                .widgetLabel { Text(verbatim: "OliGym") }
        case .accessoryInline:
            Text(verbatim: "OliGym")
        default:
            HStack(spacing: 8) {
                OpenGymLogo().frame(width: 30, height: 20).widgetAccentable()
                Text(verbatim: "OliGym").font(.headline)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

@main
struct OpenGymWidgets: WidgetBundle {
    var body: some Widget {
        OpenGymWidget()
        SessionCard()
    }
}

/*
 * The Smart Stack card while a workout runs in the watch app: the rest counting down, or the set
 * up next with its weight × reps. Relevant only then, and nothing otherwise, so it leaves the stack
 * when you are not training. When the phone in reach runs the same workout its Live Activity is in
 * the stack too: this card then stays below it (a low score) instead of a second card on top.
 * Read from what the watch app writes (WidgetState); never touched for 45 minutes, it is idle.
 */
struct SessionEntry: TimelineEntry {
    let date: Date
    let state: WidgetState

    var relevance: TimelineEntryRelevance? {
        switch state.mode {
        case "rest": return TimelineEntryRelevance(score: state.phoneLive ? 20 : 100)
        case "set": return TimelineEntryRelevance(score: state.phoneLive ? 10 : 60)
        default: return TimelineEntryRelevance(score: 0)
        }
    }
}

struct SessionProvider: TimelineProvider {
    func placeholder(in context: Context) -> SessionEntry {
        SessionEntry(date: Date(), state: WidgetState(mode: "set", title: "Bench Press", detail: "60 kg × 8", restEndsAt: nil, setLabel: "2/4"))
    }
    func getSnapshot(in context: Context, completion: @escaping (SessionEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : SessionEntry(date: Date(), state: WidgetState.read()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SessionEntry>) -> Void) {
        let state = WidgetState.read()
        var entries = [SessionEntry(date: Date(), state: state)]
        // The rest's end needs no app to say so: the card turns back to the set by itself.
        if state.mode == "rest", let end = state.restEndsAt, end > Date() {
            var after = state
            after.mode = "set"
            after.restEndsAt = nil
            entries.append(SessionEntry(date: end, state: after))
        }
        // Not touched by the watch app for 45 minutes: idle, and out of the stack.
        if state.mode == "set" || state.mode == "rest" {
            entries.append(SessionEntry(date: max(Date(), state.updatedAt.addingTimeInterval(45 * 60)), state: .idle))
        }
        completion(Timeline(entries: entries, policy: .never))
    }
}

struct SessionCardView: View {
    let entry: SessionEntry

    var body: some View {
        let s = entry.state
        HStack(spacing: 8) {
            OpenGymLogo().frame(width: 22, height: 14).widgetAccentable()
            VStack(alignment: .leading, spacing: 0) {
                if s.mode == "rest", let end = s.restEndsAt, end > entry.date {
                    Text(timerInterval: entry.date...end, countsDown: true)
                        .font(.system(.title3, design: .rounded).weight(.semibold)).monospacedDigit()
                        .widgetAccentable()
                    Text(verbatim: s.title).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                } else if s.mode == "set" {
                    Text(verbatim: s.title).font(.system(.headline, design: .rounded)).lineLimit(1)
                    Text(verbatim: [s.setLabel, s.detail].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).monospacedDigit().lineLimit(1).widgetAccentable()
                } else {
                    Text(verbatim: "OliGym").font(.headline)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

struct SessionCard: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OpenGymSession", provider: SessionProvider()) { entry in
            SessionCardView(entry: entry)
                .environment(\.locale, entry.state.locale)
                .containerBackground(.black, for: .widget)
                .widgetURL(URL(string: "oligym-watch://open"))
        }
        .configurationDisplayName("OliGym")
        .description("Your rest, your next set, or today's workout.")
        .supportedFamilies([.accessoryRectangular])
    }
}

struct OpenGymWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "OpenGymWorkout", provider: Provider()) { _ in
            LogoView()
                .containerBackground(.black, for: .widget)
                .widgetURL(URL(string: "oligym-watch://open"))
        }
        .configurationDisplayName("OliGym")
        .description("Opens OliGym.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline, .accessoryRectangular])
    }
}
