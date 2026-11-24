import XCTest


enum Opens {
    case shell
    case firstRun
    case lock
    case unwaited
}

enum TextSize {
    case standard
    case extraLarge
    case largest
}

@MainActor
@discardableResult
func launch(_ arguments: String..., open: String? = nil, push: String? = nil, opens: Opens = .shell,
            text: TextSize = .standard, moving: Bool = false, file: StaticString = #filePath, line: UInt = #line) -> XCUIApplication {
    let app = XCUIApplication()
    app.start(["--ui-test-reset"] + (opens == .firstRun ? [] : ["--ui-test-started"]) + arguments, open: open,
              push: push, opens: opens, text: text, moving: moving, file: file, line: line)
    return app
}

@MainActor
let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

extension XCUIApplication {
    func relaunch(_ arguments: String..., open: String? = nil, push: String? = nil, opens: Opens = .shell,
                  text: TextSize = .standard, moving: Bool = false, file: StaticString = #filePath, line: UInt = #line) {
        terminate()
        start(arguments, open: open, push: push, opens: opens, text: text, moving: moving, file: file, line: line)
    }

    fileprivate func start(_ arguments: [String], open: String?, push: String?, opens: Opens, text: TextSize,
                           moving: Bool, file: StaticString, line: UInt) {
        let size: [String] = switch text {
        case .standard: []
        case .extraLarge: ["--ui-test-accessibility-extra-large"]
        case .largest: ["--ui-test-accessibility-largest"]
        }
        launchArguments = ["--ui-testing", "--ui-test-dark-appearance"] + arguments + size
            + (opens == .lock ? ["--ui-test-locked"] : []) + (moving ? ["--ui-test-moving"] : [])
            + (open.map { ["--ui-test-open", $0] } ?? [])
            + (push.map { ["--ui-test-push", $0] } ?? [])
        launch()
        switch opens {
        case .shell: awaitShell()
        case .firstRun: buttons["firstrun.setup"].appears("the first run opens at Welcome", file: file, line: line)
        case .lock: buttons["life.unlock"].appears("the app opens locked", file: file, line: line)
        case .unwaited: break
        }
    }

    var viewer: XCUIElement {
        descendants(matching: .any)["viewer"].firstMatch
    }

    func plays(at: String, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        viewer.appears("\(what): the viewer", file: file, line: line)
        let count = { self.descendants(matching: .any)["viewer.count"].firstMatch.value as? String ?? "" }
        until("\(what): at the video: \(count())", file: file, line: line) { count() == at }
        let page = descendants(matching: .any)["viewer.photo"].firstMatch
        let drawn = { page.exists ? page.value as? String ?? "" : "" }
        until("\(what): the page is the video: \(drawn())", file: file, line: line) { drawn().hasPrefix("video ") }
        let scrubber = descendants(matching: .any)["viewer.video.scrubber"].firstMatch
        scrubber.appears("\(what): its bar", file: file, line: line)
        let place = { scrubber.exists ? scrubber.value as? String ?? "" : "" }
        until("\(what): it plays: \(place())", file: file, line: line) { place().contains(" of ") && !place().hasPrefix("0:00 ") }
    }

    func asks(_ route: String) -> Int {
        Int(descendants(matching: .any)["ui-test.asks." + route].firstMatch.label) ?? -1
    }

    func asks(_ route: String, reach count: Int, file: StaticString = #filePath, line: UInt = #line) {
        until("the door asked \(route) \(count) times: \(asks(route))", file: file, line: line) { self.asks(route) == count }
    }

    func menuItem(_ words: String) -> XCUIElement {
        descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", words, words + ",")).firstMatch
    }

    func openHit(_ words: String, file: StaticString = #filePath, line: UInt = #line) {
        openSearch()
        let field = searchTabField
        let clear = buttons.matching(NSPredicate(format: "label == 'Clear' AND identifier != 'search.recent.clear'")).firstMatch
        if clear.exists {
            clear.tap()
            until("the field emptied: \(field.value as? String ?? "")", file: file, line: line) { (field.value as? String ?? "").isEmpty }
        }
        type(words, into: field)
        let hit = descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == 'search.hit.0' AND label CONTAINS[c] %@", words)).firstMatch
        hit.appears("the words \(words) bring a hit", file: file, line: line)
        hit.tap()
    }
}

extension XCTestCase {
    @MainActor
    func keep(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let shot = XCUIScreen.main.screenshot()
        let folder = String(describing: type(of: self))
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "\(folder)/\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        let shots = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/shots/\(folder)", isDirectory: true)
        XCTAssertNoThrow(try FileManager.default.createDirectory(at: shots, withIntermediateDirectories: true), file: file, line: line)
        XCTAssertNoThrow(try shot.pngRepresentation.write(to: shots.appendingPathComponent("\(name).png")), file: file, line: line)
    }
}
