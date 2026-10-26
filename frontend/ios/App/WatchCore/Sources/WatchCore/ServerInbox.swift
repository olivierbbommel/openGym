import Foundation

/*
 * The phone left at home: the watch writes its waiting events into the profile on the server
 * itself (Wi-Fi or its own cellular), with the paired phone's token, and the next app that opens
 * the profile applies them as it applies a tick from the watch (frontend lib/watch-inbox.js, whose
 * mergeInbox this mirrors). The profile is the server's whole document, read with GET /api/data and
 * written back with PUT /api/data and the revision it was read at; nothing of it but the two inbox
 * fields is touched here.
 */
public enum ServerInbox {
    /// The events waiting at most; the ids applied somewhere, kept at most (as lib/watch-inbox.js).
    public static let inboxMax = 500
    public static let doneMax = 1000

    /// The phone's server and what a request to it carries (its token, an Access service token),
    /// as the phone sends it in the snapshot (`server`). nil for anything else.
    public struct Server: Codable, Equatable {
        public let base: String
        public let headers: [String: String]
        public init(base: String, headers: [String: String]) { self.base = base; self.headers = headers }

        public init?(_ v: Any?) {
            guard let d = v as? [String: Any], let base = d["base"] as? String,
                  let url = URL(string: base), url.scheme == "https" || url.host == "localhost" else { return nil }
            let h = (d["headers"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
            guard h["Authorization"] != nil else { return nil }
            self.init(base: base.hasSuffix("/") ? String(base.dropLast()) : base, headers: h)
        }

        /// An address on the server: `path` starts with a slash.
        public func url(_ path: String) -> URL? { URL(string: base + path) }
    }

    /// The events (JSON, oldest first) as objects; what does not parse, or has no id, is left out.
    public static func events(_ jsons: [String]) -> [[String: Any]] {
        jsons.compactMap { json in
            guard let data = json.data(using: .utf8),
                  let ev = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  ev["id"] is String, ev["type"] is String else { return nil }
            return ev
        }
    }

    /// `profile` with `events` in its inbox: those it lacks, after what is there, none it notes as
    /// applied. nil when nothing changes (all of them there or applied already): no write needed.
    public static func adding(_ events: [[String: Any]], to profile: [String: Any]) -> [String: Any]? {
        let done = Set((profile["watchInboxDone"] as? [Any] ?? []).compactMap { $0 as? String })
        var inbox = (profile["watchInbox"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        var have = Set(inbox.compactMap { $0["id"] as? String })
        var added = false
        for ev in events {
            guard let id = ev["id"] as? String, !done.contains(id), !have.contains(id) else { continue }
            inbox.append(ev)
            have.insert(id)
            added = true
        }
        guard added else { return nil }
        var out = profile
        out["watchInbox"] = Array(inbox.suffix(inboxMax))
        return out
    }

    /// The PUT's body: the profile, and the revision and write id it was read at, so a write by
    /// another device since is refused (409, with the current profile to add to again).
    public static func putBody(_ profile: [String: Any], rev: Int) -> [String: Any] {
        var body: [String: Any] = ["state": profile, "baseRev": rev]
        if let wid = profile["_wid"] as? String { body["baseWid"] = wid }
        return body
    }
}
