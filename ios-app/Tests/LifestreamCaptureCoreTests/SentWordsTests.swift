import Foundation
import HomeLink
import XCTest
@testable import LifestreamCaptureCore

final class SentWordsTests: XCTestCase {
    private let kinds: [HomeLink.PrivacyState.Kind] = try! JSONDecoder().decode([HomeLink.PrivacyState.Kind].self, from: Data(#"""
        [{"type":"person","one":"name","many":"names","subtypes":[]},{"type":"face","one":"face","many":"faces","subtypes":[]},
         {"type":"number","one":"number","many":"numbers","subtypes":[{"type":"number.bank","one":"bank number","many":"bank numbers"}]}]
        """#.utf8))
    private let now = Date(timeIntervalSince1970: 1_794_470_400)

    private func row(level: String = #""all""#, counts: String, atMs: Int64 = 1_794_470_400_000, detector: String = "null") throws -> HomeLink.Outbound {
        try JSONDecoder().decode(HomeLink.Outbound.self, from: Data(#"""
            {"seq":1,"at_ms":\#(atMs),"day":"2026-11-12","receiver":"OpenAI","route":null,"by":null,"what":"ask","tool":null,
             "level":\#(level),"counts":\#(counts),"chars":10,"pictures":0,"detector":\#(detector),"key":null,"attempt":null,"refs":1}
            """#.utf8))
    }

    func testWhatWasHiddenIsSaidInTheHomesWordsMostFirst() {
        XCTAssertEqual(SentWords.hidden(["face": 2, "person": 3, "number.bank": 1200, "phone": 0], kinds: kinds),
                       "1,200 bank numbers hidden · 3 names hidden · 2 faces covered")
        XCTAssertEqual(SentWords.hidden(["person": 1, "face": 1], kinds: kinds), "1 face covered · 1 name hidden", "a tie by type, each one")
        XCTAssertEqual(SentWords.hidden(["secret": 1], kinds: kinds), "1 secret hidden", "a type the table does not name")
        XCTAssertEqual(SentWords.hidden(["number.bank": 1, "number": 2], kinds: kinds), "2 numbers hidden · 1 bank number hidden")
        XCTAssertEqual(SentWords.hidden([:], kinds: kinds), "")
    }

    func testOneItemsFactSaysWhereItWentAndWhatWasHidden() throws {
        HomeClock.current.install(.steady("UTC", startHour: 0))
        XCTAssertEqual(SentWords.fact(try row(counts: #"{"face":2}"#), kinds: kinds, now: now), "Sent to OpenAI, 12 Nov · 2 faces covered")
        XCTAssertEqual(SentWords.fact(try row(level: #""none""#, counts: "{}"), kinds: kinds, now: now), "Sent to OpenAI, 12 Nov · sent as it was")
        XCTAssertEqual(SentWords.fact(try row(counts: "{}"), kinds: kinds, now: now), "Sent to OpenAI, 12 Nov · nothing to hide")
        XCTAssertEqual(SentWords.hid(try row(level: #"["phone"]"#, counts: "{}"), kinds: kinds), "Nothing to hide", "an agent's list is a level that hides")
        XCTAssertEqual(SentWords.to(try row(counts: "{}", atMs: 1_762_934_400_000), now: now), "Sent to OpenAI, 12 Nov 2025")
    }

    func testWhatWasSentSaysWhetherTheHidingModelHidIt() throws {
        XCTAssertEqual(SentWords.hider(try row(counts: #"{"person":2}"#)), "What Lifestream knows")
        XCTAssertEqual(SentWords.hider(try row(counts: #"{"person":2}"#, detector: #""runner-macbook-pro-0001""#)), "The hiding model")
        XCTAssertNil(SentWords.hider(try row(counts: "{}")), "nothing hidden, nothing to say of how")
        XCTAssertNil(SentWords.hider(try row(level: #""none""#, counts: "{}")), "sent as it was")
    }
}
