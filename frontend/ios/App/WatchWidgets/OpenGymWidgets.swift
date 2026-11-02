import SwiftUI
import WidgetKit

/*
 * OliGym on the watch face: its logo, and a tap opens the app. One complication, the same at every
 * moment: no workout data and no buttons (the iPhone's Live Activity carries the live workout, in
 * the Smart Stack too). The logo is a shape, so it takes the face's tint in every rendering mode.
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
