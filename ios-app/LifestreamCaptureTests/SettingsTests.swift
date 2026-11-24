import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

final class SettingsTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "pages"), "pages/\(name).json")
        return try Data(contentsOf: url)
    }

    private func page(_ name: String) throws -> HomeLink.Pages.SettingsPage {
        try JSONDecoder().decode(HomeLink.Pages.SettingsPage.self, from: fixture(name))
    }

    private func storage() throws -> HomeLink.Pages.Storage {
        try JSONDecoder().decode(HomeLink.Pages.Storage.self, from: fixture("storage.counted"))
    }

    @MainActor
    func testAChoiceEndIsAMenuOfItsChoicesWithTheHeldAndTheDefaultMarked() throws {
        let advanced = try page("settingsPage.advanced")
        let lines = SettingsPage.lines(advanced.parts[0].rows)
        XCTAssertEqual(lines.map(\.id), ["model-cap", "helpers", "max-bundle"])
        guard case let .choice(key, choices) = lines[0].end else { return XCTFail("model.cap is a choice: \(lines[0].end)") }
        XCTAssertEqual(key, "model.cap")
        XCTAssertEqual(choices.map(\.words), ["1", "2", "4", "8", "16", "32"])
        XCTAssertEqual(choices.filter(\.chosen).map(\.value), [8])
        XCTAssertEqual(choices.filter(\.isDefault).map(\.value), [8])
        XCTAssertEqual(SettingsRows.held(choices), 8, "the menu shows the value the settings hold")
        XCTAssertEqual(SettingsPage.held("model.cap", in: advanced), 8)
        XCTAssertNil(SettingsPage.held("door.port", in: advanced), "a key no choice names holds nothing to compare")
        XCTAssertEqual(lines[0].line, "The most model calls Lifestream makes at the same time.")
    }

    @MainActor
    func testAValueEndIsItsWordsAndATimeIsWordedByThePhone() throws {
        let advanced = try page("settingsPage.advanced")
        XCTAssertEqual(SettingsPage.lines(advanced.parts[0].rows)[1].end, .value("Automatic · 6", signal: nil))
        XCTAssertEqual(advanced.parts[1].label, "Network")

        let time = try page("settingsPage.time")
        let rows = SettingsPage.lines(time.parts[0].rows)
        guard case let .time(when)? = time.parts[0].rows[1].end.flatMap({ end -> HomeLink.Pages.PhrasePart? in
            if case let .value(value, _) = end { return value.first } else { return nil }
        }), let phrased = when.phrased else { return XCTFail("the day's start is a When") }
        XCTAssertEqual(rows[1].end, .value(Words.lineWhen(phrased), signal: nil), "the home sends a clock, the phone words it")
        XCTAssertEqual(rows[0].end, .value("Asia/Kolkata · GMT+5:30", signal: nil))
    }

    @MainActor
    func testAnEndOfAKindThePhoneDoesNotKnowIsLabelAndLineWithNoControl() throws {
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("settingsPage.advanced")) as? [String: Any])
        var parts = try XCTUnwrap(raw["parts"] as? [[String: Any]])
        var rows = try XCTUnwrap(parts[0]["rows"] as? [[String: Any]])
        rows[0]["end"] = ["kind": "slider", "key": "model.cap", "low": 1, "high": 32]
        parts[0]["rows"] = rows
        raw["parts"] = parts
        let later = try JSONDecoder().decode(HomeLink.Pages.SettingsPage.self, from: JSONSerialization.data(withJSONObject: raw))
        let line = SettingsPage.lines(later.parts[0].rows)[0]
        XCTAssertEqual(line.end, .none, "an older phone draws a newer page readable and unchangeable")
        XCTAssertEqual(line.label, "Model calls at once")
        XCTAssertEqual(line.line, "The most model calls Lifestream makes at the same time.")
        XCTAssertEqual(SettingsPage.end(nil), .none, "a row with no end is label and line")
    }

    @MainActor
    func testAPickIsSentAsTheValuePickedAndOneThatDidNotLandSaysSoAndKeepsTheValue() async throws {
        let sent = Sent()
        let writes = SettingsWrites { key, value in
            sent.calls.append((key, value))
            return sent.outcomes.removeFirst()
        }
        sent.outcomes = [.taken(.number(8)), .refused, .unreachable]

        let landed = await writes.set("model.cap", 8)
        XCTAssertTrue(landed, "a taken write reads the page again")
        XCTAssertEqual(sent.calls.first?.0, "model.cap")
        XCTAssertEqual(sent.calls.first?.1, .number(8), "a picked default is sent as picked, never null")
        XCTAssertTrue(writes.busy.isEmpty)
        XCTAssertTrue(writes.unlanded.isEmpty)

        let refused = await writes.set("model.cap", 16)
        XCTAssertFalse(refused)
        XCTAssertEqual(writes.unlanded["model.cap"], SettingsWrites.Unlanded(said: .refused(ReachWords.refused), value: 16))

        let unsent = await writes.set("model.cap", 32)
        XCTAssertFalse(unsent)
        XCTAssertEqual(writes.unlanded["model.cap"], SettingsWrites.Unlanded(said: .notSent, value: 32), "the last pick is the one offered again")
        XCTAssertTrue(writes.busy.isEmpty)
    }

    @MainActor
    func testAWriteThatThrowsIsNotSent() async {
        let writes = SettingsWrites { _, _ in throw LinkFailure.unpaired }
        let landed = await writes.set("model.cap", 8)
        XCTAssertFalse(landed)
        XCTAssertEqual(writes.unlanded["model.cap"]?.said, .notSent)
    }

    func testTheCannedHomeTakesOneDeviceKeyAndMarksItChosen() throws {
        let home = CannedHome.HomeSettings()
        XCTAssertEqual(home.set(Data(#"{"door.port":4690}"#.utf8)).0, 403, "a key no row lets a device set")
        XCTAssertEqual(home.set(Data(#"{"model.cap":8,"history.start":null}"#.utf8)).0, 422, "two keys")
        XCTAssertEqual(home.set(Data(#"{"model.cap":12}"#.utf8)).0, 200)
        let page = try JSONDecoder().decode(HomeLink.Pages.SettingsPage.self, from: home.page(fixture("settingsPage.advanced")))
        guard case let .choice(_, choices)? = page.parts[0].rows[0].end else { return XCTFail("still a choice") }
        XCTAssertEqual(choices.map(\.value), [1, 2, 4, 8, 12, 16, 32], "the held value is offered with the rest")
        XCTAssertEqual(choices.filter(\.chosen).map(\.value), [12])
        XCTAssertEqual(choices.filter { $0.default }.map(\.value), [8])
        XCTAssertNotNil(CannedHome.CannedPages.settingsPage("time"))
        XCTAssertNil(CannedHome.CannedPages.settingsPage("recovery"), "a Mac-only page is no phone's")
        XCTAssertNil(CannedHome.CannedPages.settingsPage("storage"), "Storage has its own answer")
    }

    @MainActor
    func testStorageShowsItsUnfoldedUsesUntilAskedAndEveryToneItsOwn() throws {
        let page = try storage()
        XCTAssertTrue(StoragePage.folds(page))
        XCTAssertEqual(StoragePage.shown(page.uses, unfolded: false).map(\.id), ["screen", "apple-photos", "granola", "claude", "whatsapp", "own"])
        XCTAssertEqual(StoragePage.shown(page.uses, unfolded: true).count, page.uses.count)
        XCTAssertEqual(StoragePage.parts(page.bar).map(\.tone), [.s1, .s2, .s3, .s4, .s5, .other, .own, .disk, .free])
        XCTAssertEqual(StoragePage.key(page.bar).count, page.bar.key.count)
        XCTAssertEqual(StoragePage.tone(.unknown), .other, "a tone the phone does not know is drawn as other")
        for tone in DiskBar.Tone.allCases {
            XCTAssertEqual(StoragePage.tone(HomeLink.Pages.StorageTone(rawValue: tone.rawValue) ?? .unknown), tone)
        }
    }

    @MainActor
    func testAPhraseIsItsPartsJoinedAsTheHomeSpacedThem() throws {
        let page = try storage()
        let said = Words.phrase(page.sentence)
        XCTAssertTrue(said.hasPrefix("T9 fills by about 2.1\u{00A0}GB a day. At this rate it is full around "), said)
        XCTAssertTrue(said.hasSuffix("."), said)
        XCTAssertFalse(said.contains("  "), said)
        XCTAssertFalse(said.contains(" ."), said)
    }

    @MainActor
    func testACountingStorageIsReadAgainAndACountedOneIsNot() throws {
        let counting = try JSONDecoder().decode(HomeLink.Pages.Storage.self, from: fixture("storage.counting"))
        XCTAssertFalse(counting.counted)
        XCTAssertTrue(try storage().counted)
        XCTAssertFalse(counting.counting, "the shelf never asks a settled read of Storage: the page reads again itself")
    }
}

@MainActor
private final class Sent {
    var calls: [(String, HomeLink.JSON)] = []
    var outcomes: [SettingOutcome] = []
}
