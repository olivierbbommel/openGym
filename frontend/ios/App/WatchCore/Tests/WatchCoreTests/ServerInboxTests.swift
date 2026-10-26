import XCTest
@testable import WatchCore

/// The phone left at home: the watch's events into the profile on the server (ServerInbox).
final class ServerInboxTests: XCTestCase {
    func json(_ d: [String: Any]) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: d), encoding: .utf8)!
    }

    func testTheServerTheSnapshotNamesNeedsHttpsAndAToken() {
        let ok = ServerInbox.Server(["base": "https://gym.olibos.com/", "headers": ["Authorization": "Bearer t", "X": 3]])
        XCTAssertEqual(ok?.base, "https://gym.olibos.com")
        XCTAssertEqual(ok?.headers, ["Authorization": "Bearer t"])
        XCTAssertEqual(ok?.url("/api/data")?.absoluteString, "https://gym.olibos.com/api/data")
        XCTAssertNil(ServerInbox.Server(["base": "http://gym.olibos.com", "headers": ["Authorization": "Bearer t"]]))
        XCTAssertNil(ServerInbox.Server(["base": "https://gym.olibos.com", "headers": [:]]))
        XCTAssertNil(ServerInbox.Server(nil))
    }

    func testEventsThatDoNotParseAreLeftOut() {
        let evs = ServerInbox.events([json(["id": "a", "type": "start"]), "{", json(["type": "x"])])
        XCTAssertEqual(evs.map { $0["id"] as? String }, ["a"])
    }

    func testAddsWhatTheProfileLacksAfterWhatIsThereAndKeepsTheRest() {
        let profile: [String: Any] = ["workouts": [["id": "w0"]], "_rev": 7,
                                      "watchInbox": [["id": "a", "type": "start"]]]
        let evs = ServerInbox.events([json(["id": "a", "type": "start"]), json(["id": "b", "type": "setDone"])])
        let out = ServerInbox.adding(evs, to: profile)
        XCTAssertEqual((out?["watchInbox"] as? [[String: Any]])?.map { $0["id"] as? String }, ["a", "b"])
        XCTAssertEqual((out?["workouts"] as? [[String: Any]])?.first?["id"] as? String, "w0")
    }

    func testNothingToWriteWhenEverythingIsThereOrApplied() {
        let profile: [String: Any] = ["watchInbox": [["id": "a", "type": "start"]], "watchInboxDone": ["b"]]
        let evs = ServerInbox.events([json(["id": "a", "type": "start"]), json(["id": "b", "type": "setDone"])])
        XCTAssertNil(ServerInbox.adding(evs, to: profile))
    }

    func testThePutCarriesTheRevisionAndWriteIdItWasReadAt() {
        let body = ServerInbox.putBody(["_wid": "abc", "watchInbox": []], rev: 12)
        XCTAssertEqual(body["baseRev"] as? Int, 12)
        XCTAssertEqual(body["baseWid"] as? String, "abc")
        XCTAssertNil(ServerInbox.putBody([:], rev: 0)["baseWid"])
    }
}
