import Foundation
import Security

/*
 * The phone left at home: the events waiting for it also go to the server, straight from the watch
 * (WatchCore's ServerInbox says what is written). The server and the phone's token come with the
 * phone's snapshots and are kept in the Keychain, never in the saved session. One upload at a
 * time; an event once on the server is not sent there again. The phone still gets every event
 * through its own queue when the two meet; it applies each one once, by its id.
 */
final class ServerSync {
    static let shared = ServerSync()

    private static let account = "server"
    private static let uploadedKey = "serverUploaded"
    private let queue = DispatchQueue(label: "ServerSync")
    private var busy = false

    /* ---------- the server, in the Keychain ---------- */

    private static let keychain: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "OliGymWatch",
        kSecAttrAccount as String: account,
    ]

    /// Kept when it changed (a renewed token), removed when the phone sends none (local mode, Apple
    /// Watch off in its Settings).
    static func remember(_ server: ServerInbox.Server?) {
        guard let server = server else { SecItemDelete(keychain as CFDictionary); return }
        guard server != load(), let data = try? JSONEncoder().encode(server) else { return }
        SecItemDelete(keychain as CFDictionary)
        var add = keychain
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func load() -> ServerInbox.Server? {
        var q = keychain
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(ServerInbox.Server.self, from: data)
    }

    /* ---------- what is on the server already ---------- */

    private var uploaded: [String] {
        get { UserDefaults.standard.stringArray(forKey: ServerSync.uploadedKey) ?? [] }
        set { UserDefaults.standard.set(Array(newValue.suffix(ServerInbox.doneMax)), forKey: ServerSync.uploadedKey) }
    }

    /// Whether every one of these events (JSON) is on the server.
    func has(_ jsons: [String]) -> Bool {
        let up = Set(uploaded)
        return ServerInbox.events(jsons).allSatisfy { up.contains($0["id"] as? String ?? "") }
    }

    /* ---------- the upload ---------- */

    /// Writes the events (JSON, oldest first) the server lacks into the profile's inbox. `done` says
    /// whether all of them are there now. Nothing without a server; one upload at a time.
    func upload(_ jsons: [String], done: @escaping (Bool) -> Void) {
        queue.async {
            let up = Set(self.uploaded)
            let events = ServerInbox.events(jsons).filter { !up.contains($0["id"] as? String ?? "") }
            guard !events.isEmpty else { return done(true) }
            guard !self.busy, let server = ServerSync.load() else { return done(false) }
            self.busy = true
            self.write(events, to: server, tries: 3) { ok in
                self.queue.async {
                    self.busy = false
                    if ok { self.uploaded = self.uploaded + events.compactMap { $0["id"] as? String } }
                    done(ok)
                }
            }
        }
    }

    private func request(_ server: ServerInbox.Server, _ method: String, body: Data? = nil) -> URLRequest? {
        guard let url = server.url("/api/data") else { return nil }
        var r = URLRequest(url: url, timeoutInterval: method == "GET" ? 20 : 60)
        r.httpMethod = method
        server.headers.forEach { r.setValue($0.value, forHTTPHeaderField: $0.key) }
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    /// Reads the profile, adds the events, writes it back at the revision it was read at. Another
    /// device's write in between (409) hands back the current profile: added to again, a few times.
    private func write(_ events: [[String: Any]], to server: ServerInbox.Server, tries: Int, done: @escaping (Bool) -> Void) {
        guard let get = request(server, "GET") else { return done(false) }
        URLSession.shared.dataTask(with: get) { data, resp, _ in
            guard (resp as? HTTPURLResponse)?.statusCode == 200, let data = data,
                  let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return done(false) }
            self.put(events, doc: doc, to: server, tries: tries, done: done)
        }.resume()
    }

    private func put(_ events: [[String: Any]], doc: [String: Any], to server: ServerInbox.Server, tries: Int, done: @escaping (Bool) -> Void) {
        // A profile with nothing in it yet is the phone's to start, not the watch's.
        guard let profile = doc["state"] as? [String: Any] else { return done(false) }
        let rev = doc["rev"] as? Int ?? 0
        guard let next = ServerInbox.adding(events, to: profile) else { return done(true) }
        guard let body = try? JSONSerialization.data(withJSONObject: ServerInbox.putBody(next, rev: rev)),
              let put = request(server, "PUT", body: body) else { return done(false) }
        URLSession.shared.dataTask(with: put) { data, resp, _ in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200 { return done(true) }
            if status == 409, tries > 1, let data = data,
               let cur = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                return self.put(events, doc: cur, to: server, tries: tries - 1, done: done)
            }
            done(false)
        }.resume()
    }
}
