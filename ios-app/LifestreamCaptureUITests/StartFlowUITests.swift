import XCTest

@MainActor
final class StartFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyEachScreenInOrderAndAYesMovesOnAfterItsFind() throws {
        let home = try HomeWords()
        let app = launch("--ui-test-unpaired", "--ui-test-grants",
                         "location=late-always,motion=on,health=on,photos=on,contacts=on,screen-time=on", opens: .firstRun)
        XCTAssertTrue(app.descendants(matching: .any)["start.privacy"].exists, "the privacy policy is the plain line under Set up")
        XCTAssertFalse(marksElement(app).exists, "Welcome carries no marks")
        keep("welcome")
        app.buttons["firstrun.setup"].tap()

        app.buttons["pairing.scan"].appears("an unpaired phone is asked to pair, cold")
        XCTAssertTrue(app.descendants(matching: .any)["pairing.cold"].exists, "cold, Pair says Lifestream starts on the Mac")
        XCTAssertTrue(marksElement(app).exists, "Pair carries the marks")
        keep("pair-cold")
        app.buttons["pairing.later"].tap()

        let line = app.staticTexts["firstrun.line"].firstMatch
        let note = app.staticTexts["firstrun.note"].firstMatch
        var carried: [PhoneStream] = []
        for stream in home.order {
            let screen = app.descendants(matching: .any)["firstrun.\(stream.screen)"]
            if stream.grant == "screen-time" {
                let done = app.descendants(matching: .any)["firstrun.done"]
                until("Screen Time's screen, or Done where the build has none") { screen.exists || done.exists }
                if !screen.exists { break }
            }
            carried.append(stream)
            screen.appears("\(stream.screen) is next, in the home's order")
            let why = home.why(stream.connector)
            XCTAssertEqual(line.label, why, "before its ask, \(stream.screen) says why")
            XCTAssertEqual(note.exists, Self.noted.contains(stream.screen), "\(stream.screen): the note over Allow where iOS asks more than once")
            keep("\(stream.name)-before")
            let allow = app.buttons[stream.screen == "location" ? "start.capture" : "firstrun.allow"]
            XCTAssertTrue(allow.exists)
            let notNow = app.buttons["firstrun.notnow"]
            XCTAssertTrue(notNow.exists)
            let place = allow.frame
            XCTAssertGreaterThanOrEqual(notNow.frame.minY, place.maxY, "the one plain way past stands under the primary")
            allow.tap()
            until("a yes shows what it found: \(line.label)") { line.label != why }
            XCTAssertEqual(allow.label, "Allowed", "the same capsule says Allowed while the find stands")
            XCTAssertEqual(allow.frame, place, "in its place, its size kept")
            notNow.vanishes("the plain leaves its slot: nothing is left to pass")
            note.vanishes("the note goes once the answer lands")
            keep("\(stream.name)-found")
            screen.vanishes("the find stands, then the screen moves on by itself")
        }

        app.descendants(matching: .any)["firstrun.done"].appears()
        for stream in carried {
            let done = row(app, "permissions.row.\(stream.grant)")
            XCTAssertEqual(done.value as? String ?? "", "", "\(stream.grant) on: nothing left to do")
        }
        XCTAssertFalse(marksElement(app).exists, "Done carries no marks")
        let mac = row(app, "firstrun.mac")
        XCTAssertTrue(mac.label.contains("Not paired"), mac.label)
        XCTAssertEqual(mac.value as? String, "Pair", "Pair is offered once, on its row")
        keep("done-all-allowed")

        app.buttons["firstrun.mac"].tap()
        app.descendants(matching: .any)["pairing.cold"].appears("Done's Pair opens the pairing sheet")
        app.type("11111111", into: app.textFields["pairing.code.field"])
        app.buttons["pairing.find"].tap()
        app.buttons["pairing.yes"].appears("the Mac found is asked about")
        app.buttons["pairing.yes"].tap()
        let refused = app.descendants(matching: .any)["pairing.code-refused"]
        refused.appears("a code the home no longer takes says so")
        XCTAssertTrue(app.buttons["pairing.again"].exists, "Scan again")
        keep("pair-code-refused")
        open(Self.link, in: app, until: app.buttons["pairing.confirm"], "the link opens the first run's own Pair, filled in")
        refused.vanishes("the sheet gives way to it")
        app.buttons["pairing.confirm"].tap()
        app.descendants(matching: .any)["pairing.which"].appears("a home that holds a phone asks which this one is")
        XCTAssertTrue(app.descendants(matching: .any)["pairing.phone.iphone-aa01"].exists, "the phone it holds, listed")
        keep("pair-which")
        let another = app.buttons["pairing.another"]
        another.tap()
        app.descendants(matching: .any)["pairing.paired"].appears("another phone: paired")
        XCTAssertEqual(another.label, "Paired", "the capsule pressed says Paired while it stands")
        app.descendants(matching: .any)["firstrun.done"].appears("the stand ends and the run moves on")
        XCTAssertTrue(row(app, "firstrun.mac").label.contains("Paired"), "Done's Mac row says it")

        app.buttons["permissions.continue"].tap()
        app.tab("Timeline").appears()
        XCTAssertTrue(app.tab("Timeline").isSelected, "Start opens Days")
        let report = try HomeReport()
        app.openStreams()
        for device in report.devices where HomeReport.said(device, "unit") != HomeReport.unit {
            let row = app.descendants(matching: .any)["machinery.device.\(HomeReport.said(device, "unit"))"].firstMatch
            app.bringIntoView(row)
            XCTAssertTrue(row.label.contains(HomeReport.said(HomeReport.health(device), "words")), "\(HomeReport.said(device, "unit")): \(row.label)")
        }
        XCTAssertFalse(app.descendants(matching: .any)["machinery.device.\(HomeReport.unit)"].exists, "this phone is no other device")

        app.relaunch("--ui-test-unpaired")
        app.tab("Chat").appears("after Start, a launch opens the app")
        XCTAssertFalse(app.buttons["firstrun.setup"].exists)

        app.terminate()
        let again = launch("--ui-test-grants", "location=always", opens: .firstRun)
        again.buttons["firstrun.setup"].tap()
        again.descendants(matching: .any)["firstrun.location"].appears("paired: Pair is passed")
        open(Self.link, in: again, until: again.buttons["pairing.confirm"], "a link in hand always shows its pairing")
        keep("pair-link-paired-phone")
        again.buttons["pairing.confirm"].tap()
        again.descendants(matching: .any)["pairing.paired"].appears("it pairs as the phone it is")
        XCTAssertFalse(again.descendants(matching: .any)["pairing.which"].exists, "never asked which")
        again.descendants(matching: .any)["firstrun.location"].appears("the stand ends and the run moves on")
    }

    func testAnswersThatAreNotAPlainYesStayAndARelaunchOpensTheSameScreen() throws {
        let home = try HomeWords()
        let grants = "location=while-using,motion=off,health=asked,photos=limited,contacts=limited"
        let app = launch("--ui-test-grants", grants, opens: .firstRun)
        app.buttons["firstrun.setup"].tap()
        let line = app.staticTexts["firstrun.line"].firstMatch
        let note = app.staticTexts["firstrun.note"].firstMatch

        for (stream, allow, closes) in [("location", "start.capture", false), ("motion", "firstrun.allow", true),
                                        ("health", "firstrun.allow", false), ("photos", "firstrun.allow", false)] {
            app.descendants(matching: .any)["firstrun.\(stream)"].appears("\(stream) is next")
            let why = line.label
            app.buttons[allow].tap()
            app.buttons["firstrun.continue"].appears("\(stream) stays, with Continue")
            until("\(stream) says what it costs: \(line.label)") { line.label != why }
            XCTAssertTrue(app.buttons["firstrun.change"].exists, "\(stream): the way to change it")
            XCTAssertEqual(note.exists, closes, "\(stream): iOS closes the app when this one changes")
            XCTAssertFalse(app.buttons["firstrun.allow"].exists, "never a second Allow")
            keep("\(stream)-stays")
            if stream == "photos" { break }
            app.buttons["firstrun.continue"].tap()
        }

        let said = line.label
        app.relaunch("--ui-test-grants", grants, opens: .unwaited)
        app.descendants(matching: .any)["firstrun.photos"].appears("a relaunch opens the same screen")
        until("saying what it costs: \(line.label)") { line.label == said }
        XCTAssertTrue(app.buttons["firstrun.continue"].exists, "with its Continue")
        XCTAssertFalse(app.buttons["firstrun.allow"].exists, "never a second Allow")
        keep("photos-relaunched")
        app.buttons["firstrun.continue"].tap()

        app.descendants(matching: .any)["firstrun.contacts"].appears()
        app.buttons["firstrun.notnow"].tap()
        let screenTime = app.descendants(matching: .any)["firstrun.screenTime"]
        let done = app.descendants(matching: .any)["firstrun.done"]
        until("Not now moves on at once") { screenTime.exists || done.exists }
        let carriesScreenTime = screenTime.exists
        if carriesScreenTime { app.buttons["firstrun.notnow"].tap() }

        done.appears()
        for (id, act) in [("location", "Open Settings"), ("motion", "Open Settings"), ("health", ""), ("photos", "Open Settings"),
                          ("contacts", "Allow"), ("screen-time", "Allow")] where id != "screen-time" || carriesScreenTime {
            let stream = row(app, "permissions.row.\(id)")
            XCTAssertTrue(stream.exists, id)
            XCTAssertEqual(stream.value as? String ?? "", act, "\(id)'s one act")
        }
        XCTAssertTrue(row(app, "firstrun.mac").label.contains("Paired"))
        keep("done-states")

        let contacts = row(app, "permissions.row.contacts")
        app.buttons["permissions.row.contacts"].tap()
        until("the answer lands on its row: \(contacts.label)") { contacts.label.contains(home.word("contacts", "limited")) }
        app.buttons["permissions.continue"].tap()
        app.tab("Timeline").appears()
    }

    func testPairFromTheLinkAndFromACodeTyped() throws {
        var app = launch("--ui-test-grants", "", "--ui-test-unpaired", "--ui-test-home-silent", opens: .firstRun)
        open(Self.link, in: app, until: app.buttons["pairing.confirm"], "the link opens Pair, Welcome passed")
        XCTAssertEqual(app.staticTexts["pairing.name"].label, "iPhone Simulator", "the phone is named by its model until renamed")
        XCTAssertTrue(app.buttons["pairing.rename"].exists)
        XCTAssertEqual(app.staticTexts["pairing.account"].label, "person-a@example.com", "the link's Apple ID, filled in")
        XCTAssertTrue(app.staticTexts["pairing.account.mac"].exists, "the Mac's Apple ID, said the same")
        XCTAssertTrue(app.buttons["pairing.account.change"].exists)
        XCTAssertFalse(app.staticTexts["apple-id.waits"].exists)
        keep("pair-link")
        app.buttons["pairing.confirm"].tap()
        app.descendants(matching: .any)["pairing.unreachable"].appears("no answer on the link's addresses: the Mac out of reach")
        let network = app.descendants(matching: .any)["pairing.local-network"].firstMatch
        XCTAssertTrue(network.exists, "the local network, with Open Settings")
        XCTAssertTrue(network.label.contains("Local network"), network.label)
        XCTAssertEqual(network.value as? String, "Open Settings", "its one act")
        XCTAssertTrue(app.buttons["pairing.retry"].exists)
        keep("pair-unreachable")
        app.buttons["pairing.later"].tap()
        app.descendants(matching: .any)["firstrun.location"].appears("Pair later moves on")
        app.terminate()

        app = launch("--ui-test-grants", "", "--ui-test-unpaired", opens: .firstRun)
        app.buttons["firstrun.setup"].tap()
        app.buttons["pairing.scan"].appears("the camera is not asked until the person chooses to scan")
        XCTAssertTrue(app.descendants(matching: .any)["pairing.cold"].exists)
        let field = app.textFields["pairing.code.field"]
        app.type("4821390", into: field)
        XCTAssertFalse(app.buttons["pairing.find"].exists, "seven digits: the primary still scans")
        app.type("7", into: field)
        app.buttons["pairing.find"].appears("eight digits: the same capsule reads Find your Mac")
        XCTAssertTrue(field.isHittable, "the field is in view")
        XCTAssertLessThanOrEqual(field.frame.maxY, app.buttons["pairing.find"].frame.minY, "the foot never covers the field")
        keep("pair-typed")
        app.buttons["pairing.find"].tap()
        app.descendants(matching: .any)["pairing.match"].appears("the Mac found is asked about")
        XCTAssertTrue(app.buttons["pairing.yes"].exists)
        app.buttons["pairing.rename"].tap()
        let name = app.descendants(matching: .any)["pairing.name.field"]
        name.appears()
        app.type(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "iPhone Simulator".count) + "Work iPhone\n", into: name)
        XCTAssertEqual(app.staticTexts["pairing.name"].label, "Work iPhone")
        let account = app.descendants(matching: .any)["pairing.account.field"]
        XCTAssertTrue(["", "Email or phone number"].contains(account.value as? String ?? ""),
                      "a typed code carries none: empty, not \(String(describing: account.value))")
        XCTAssertTrue(app.staticTexts["apple-id.waits"].exists, "an empty Apple ID says what waits for it")
        keep("pair-match")
        XCTAssertTrue(app.staticTexts["Apple ID"].exists, "said optional once: by the line under it")
        app.buttons["pairing.no"].tap()
        app.descendants(matching: .any)["pairing.not-this-mac"].appears("after the last Mac found, No says so")
        XCTAssertTrue(app.buttons["pairing.later"].exists, "every Pair screen keeps Pair later")
        keep("pair-not-this-mac")
        app.buttons["pairing.again"].tap()
        app.buttons["pairing.scan"].appears("Scan again starts over")
    }

    func testTheScreensAtAnAccessibilityTextSize() throws {
        let app = launch("--ui-test-grants", "location=always", "--ui-test-unpaired", opens: .firstRun, text: .largest)
        keep("welcome-accessibility")
        app.buttons["firstrun.setup"].tap()
        app.buttons["pairing.later"].appears()
        keep("pair-cold-accessibility")
        app.buttons["pairing.later"].tap()
        app.buttons["start.capture"].appears()
        XCTAssertTrue(app.buttons["start.capture"].isHittable, "the primary stands on screen")
        XCTAssertTrue(app.buttons["firstrun.notnow"].isHittable, "and the plain under it")
        keep("location-accessibility")
        let done = app.descendants(matching: .any)["firstrun.done"]
        for _ in 0..<6 where !done.exists {
            let step = marksElement(app).value as? String
            app.buttons["firstrun.notnow"].tap()
            until("the next step opens") { done.exists || self.marksElement(app).value as? String != step }
        }
        done.appears()
        keep("done-accessibility")
    }

    private func open(_ url: URL, in app: XCUIApplication, until next: XCUIElement, _ what: String) {
        XCUIDevice.shared.system.open(url)
        app.allowing(["Open"], until: next, what)
    }

    private static let noted: Set<String> = ["location", "health", "contacts"]

    private static let link = URL(string: "lifestream://pair?code=48213907&host=lifestream-canned.local&port=4682&fp=\(String(repeating: "A", count: 52))&account=person-a%40example.com")!

    private func marksElement(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["firstrun.marks"]
    }

    private func row(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        let row = app.staticTexts[identifier].firstMatch
        app.bringIntoView(row)
        return row
    }
}

private struct PhoneStream {
    let connector: String
    let screen: String
    let grant: String
    let name: String

    static let all = [
        PhoneStream(connector: "location", screen: "location", grant: "location", name: "Location"),
        PhoneStream(connector: "motion", screen: "motion", grant: "motion", name: "Motion"),
        PhoneStream(connector: "apple-health", screen: "health", grant: "health", name: "Health"),
        PhoneStream(connector: "apple-photos", screen: "photos", grant: "photos", name: "Photos"),
        PhoneStream(connector: "apple-contacts", screen: "contacts", grant: "contacts", name: "Contacts"),
        PhoneStream(connector: "screen-time", screen: "screenTime", grant: "screen-time", name: "Screen Time"),
    ]
}

private struct HomeWords {
    let order = PhoneStream.all
    private let said: [String: String]
    private let whys: [String: String]

    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("LifestreamCapture/Connectors/Declared.swift"), encoding: .utf8)
        var connector = ""
        var whys: [String: String] = [:]
        for line in text.split(separator: "\n") {
            if let id = line.range(of: "DeclaredStream(id: \"") { connector = String(line[id.upperBound...].prefix { $0 != "\"" }) }
            if let why = line.range(of: "why: \""), line.hasSuffix("\")") { whys[connector] = String(line[why.upperBound...].dropLast(2)) }
        }
        self.whys = whys
        let words = try XCTUnwrap(text.range(of: "enum GrantWords {"), "Declared.swift holds the grants' words")
        var grant = ""
        var said: [String: String] = [:]
        for line in text[words.upperBound...].split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            if line.hasPrefix("\""), line.hasSuffix("\": [") {
                grant = String(line.dropFirst().dropLast(4))
            } else if line.hasPrefix("."), let colon = line.firstIndex(of: ":"), line.hasSuffix("\",") {
                let state = line[line.index(after: line.startIndex)..<colon]
                said["\(grant) \(state)"] = String(line[line.index(colon, offsetBy: 3)...].dropLast(2))
            }
        }
        self.said = said
    }

    func why(_ connector: String) -> String {
        guard let why = whys[connector] else {
            XCTFail("Declared.swift has no why for \(connector)")
            return ""
        }
        return why
    }

    func word(_ grant: String, _ state: String) -> String {
        let parts = state.split(separator: "-")
        let camel = parts.first.map(String.init)! + parts.dropFirst().map { $0.capitalized }.joined()
        guard let word = said["\(grant) \(camel)"] else {
            XCTFail("Declared.swift has no word for \(grant) \(state)")
            return ""
        }
        return word
    }
}
