import XCTest

let waitLimit: TimeInterval = 30

enum TestClock {
    static let now = Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 11, day: 7, hour: 22, minute: 30))!
}

@MainActor
func until(_ what: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line, _ ready: () -> Bool) {
    let ends = Date().addingTimeInterval(waitLimit)
    while !ready() {
        guard Date() < ends else {
            return XCTFail("never came in \(Int(waitLimit)) s: \(what())", file: file, line: line)
        }
        // paces: the poll; the app records nothing to wait on for a label's words.
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
}

struct HomeReport {
    static let unit = "iphone-aa01"
    let object: [String: Any]

    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("homelink/Tests/Fixtures/report.json"), encoding: .utf8)
        let named = text.replacingOccurrences(of: "\"iphone-17-pro-aa01\"", with: "\"\(Self.unit)\"")
        object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(named.utf8)) as? [String: Any], "report.json is an object")
    }

    var connectors: [[String: Any]] { object["connectors"] as? [[String: Any]] ?? [] }
    var needs: [[String: Any]] { object["needs"] as? [[String: Any]] ?? [] }
    var devices: [[String: Any]] { object["devices"] as? [[String: Any]] ?? [] }

    func shows(_ id: String) -> Bool {
        connectors.contains { $0["id"] as? String == id && ["stream", "device"].contains($0["shown"] as? String ?? "") }
    }

    func connector(_ id: String) throws -> [String: Any] {
        try XCTUnwrap(connectors.first { $0["id"] as? String == id }, "report.json has no connector \(id)")
    }

    func need(of connector: [String: Any]) throws -> [String: Any] {
        let id = Self.said(connector, "id")
        let acts = Self.acts(connector) as NSArray
        return try XCTUnwrap(needs.first { Self.said($0, "connector") == id && (Self.acts($0) as NSArray).isEqual(acts) }, "report.json has no need of \(id)")
    }

    static func said(_ object: [String: Any]?, _ key: String) -> String { object?[key] as? String ?? "" }

    static func health(_ object: [String: Any]) -> [String: Any] { object["health"] as? [String: Any] ?? object }

    static func acts(_ object: [String: Any]) -> [[String: Any]] { health(object)["acts"] as? [[String: Any]] ?? [] }

    static func member(_ connector: [String: Any], _ key: String) throws -> [String: Any] {
        try XCTUnwrap((connector["members"] as? [[String: Any]])?.first { $0["key"] as? String == key }, "\(said(connector, "id")).\(key)")
    }
}

extension XCUIElement {
    func appears(_ what: @autoclosure () -> String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        if exists || waitForExistence(timeout: waitLimit) { return }
        XCTFail("never came in \(Int(waitLimit)) s: \(what() ?? "\(self)")", file: file, line: line)
    }

    func vanishes(_ what: @autoclosure () -> String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        if !exists || waitForNonExistence(timeout: waitLimit) { return }
        XCTFail("never came in \(Int(waitLimit)) s: \(what() ?? "\(self) gone")", file: file, line: line)
    }

    func appears(within timeout: TimeInterval) -> Bool {
        exists || waitForExistence(timeout: timeout)
    }

    func vanishes(within timeout: TimeInterval) -> Bool {
        !exists || waitForNonExistence(timeout: timeout)
    }

    func part(_ label: String) -> XCUIElement {
        staticTexts.matching(NSPredicate(format: "label ==[c] %@", label)).firstMatch
    }
}

extension XCUIApplication {
    func trip() {
        XCUIDevice.shared.press(.home)
        until("the app went away") { self.state == .runningBackground }
        activate()
        until("the app came back") { self.state == .runningForeground }
    }

    func inFront(_ identifier: String) -> XCUIElement {
        let matches = descendants(matching: .any).matching(identifier: identifier)
        let width = frame.width
        let copies = matches.allElementsBoundByIndex
        let inFront = copies.filter { (0..<width).contains($0.frame.midX) }
        if let shown = inFront.first(where: { !$0.label.isEmpty }) ?? inFront.first { return shown }
        return copies.isEmpty ? matches.firstMatch : matches.matching(NSPredicate(value: false)).firstMatch
    }

    func appearsInFront(_ identifier: String, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        until(what, file: file, line: line) { inFront(identifier).exists }
    }

    func startCapture() {
        passFirstRun(allowingLocation: true)
        if !buttons["life.unlock"].firstMatch.exists { openTab("Chat") }
    }

    func passFirstRun(allowingLocation: Bool) {
        let setUp = buttons["firstrun.setup"]
        setUp.appears("the first run opens at Welcome")
        setUp.tap()
        let start = buttons["permissions.continue"]
        let marks = descendants(matching: .any)["firstrun.marks"]
        var allowed = !allowingLocation
        for _ in 0..<12 where !start.exists {
            marks.appears("a step of the first run is open")
            let step = marks.value as? String
            if buttons["pairing.later"].exists {
                buttons["pairing.later"].tap()
            } else if !allowed, buttons["start.capture"].exists {
                allowed = true
                buttons["start.capture"].tap()
                let notNow = buttons["firstrun.notnow"]
                until("Location's Allow comes back unanswered") { notNow.exists && notNow.isHittable }
                continue
            } else {
                buttons["firstrun.notnow"].appears("the step offers Not now")
                buttons["firstrun.notnow"].tap()
            }
            until("the next step opens") { start.exists || marks.value as? String != step }
        }
        start.appears("Done ends the first run")
        start.tap()
        let unlock = buttons["life.unlock"].firstMatch
        let days = tab("Timeline")
        until("Start opens Days, or the lock") { unlock.exists || days.exists }
        guard !unlock.exists else { return }
        awaitShell()
        until("Start opens Days") { self.isPlaced(days, selected: true) }
    }

    func awaitShell() {
        let days = tab("Timeline")
        days.appears("the shell opens")
        until("the tab bar is drawn") { self.isPlaced(days, selected: false) }
    }

    private func isPlaced(_ item: XCUIElement, selected: Bool) -> Bool {
        guard item.exists, !selected || item.isSelected else { return false }
        return !item.frame.isEmpty && frame.contains(item.frame)
    }

    private func holds(within timeout: TimeInterval, _ condition: @escaping @MainActor () -> Bool) -> Bool {
        if condition() { return true }
        let predicate = NSPredicate { _, _ in MainActor.assumeIsolated { condition() } }
        return XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: nil)], timeout: timeout) == .completed
    }

    func allowing(_ titles: [String] = ["Allow", "OK"], until next: XCUIElement, _ what: String) {
        let allow = springboard.buttons.matching(NSPredicate(format: "label IN %@", titles)).firstMatch
        until("\(what), or the system asks first") { next.exists || allow.exists }
        guard !next.exists, allow.exists else { return }
        for _ in 0..<3 where allow.exists {
            allow.tap()
            _ = holds(within: 2) { !allow.exists }
        }
        XCTAssertFalse(allow.exists, "the system's alert answered")
        next.appears(what)
    }

    func raiseSheet() {
        let grabber = descendants(matching: .any)["sheet.grabber"].firstMatch
        let controls = buttons["search.open"].firstMatch
        let raised = coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: controls.frame.maxY + 14))
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: raised, withVelocity: .slow, thenHoldForDuration: 0.3)
        until("the sheet raised") { grabber.value as? String == "Raised" }
    }

    func lowerSheet() {
        let grabber = descendants(matching: .any)["sheet.grabber"].firstMatch
        let was = grabber.value as? String
        let start = grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 300)), withVelocity: .slow, thenHoldForDuration: 0.3)
        until("the sheet lowered") { grabber.value as? String != was }
    }

    func tab(_ name: String) -> XCUIElement {
        tabBars.buttons[name].firstMatch
    }

    func openTab(_ name: String) {
        if searchClose.exists { closeSearch() }
        bringTabBarIntoReach()
        let item = tab(name)
        until("the bar holds \(name)") { self.isPlaced(item, selected: false) }
        item.tap()
        until("\(name) is the tab shown") { self.isPlaced(item, selected: true) }
    }

    func openSearch() {
        let field = searchTabField
        if !field.exists {
            let open = buttons["search.open"].firstMatch
            open.appears("the top bar's Search")
            open.tap()
            field.appears("Search opens over the tab")
        }
        focus(field)
    }

    var searchTabField: XCUIElement {
        searchFields["Search your life"].firstMatch
    }

    func bringTabBarIntoReach() {
        guard keyboards.firstMatch.exists else { return }
        typeText("\n")
        keyboards.firstMatch.vanishes("the keyboard went away")
    }

    var searchClose: XCUIElement {
        buttons["search.close"].firstMatch
    }

    func closeSearch() {
        let close = searchClose
        close.appears("a search is up, with its Close")
        close.tap()
        close.vanishes("the search is put away")
    }

    func focus(_ field: XCUIElement, fromEnd: Bool = false) {
        let hasFocus = NSPredicate(format: "hasKeyboardFocus == true")
        let focused = { hasFocus.evaluate(with: field) }
        for _ in 0..<3 where !focused() {
            if fromEnd { field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap() } else { field.tap() }
            _ = holds(within: 2, focused)
        }
        XCTAssertTrue(focused(), "the field holds the keyboard")
    }

    func type(_ text: String, into field: XCUIElement) {
        focus(field)
        field.typeText(text)
    }

    var capturePlus: XCUIElement {
        buttons["capture.open"].firstMatch
    }

    func closeCaptureSheet() {
        closeConnectorDetail()
        for _ in 0..<5 {
            if let close = ["capture.close", "streams.close", "home.check.close"].map({ buttons[$0].firstMatch }).first(where: \.exists) {
                for _ in 0..<3 where close.exists {
                    close.tap()
                    _ = holds(within: 2) { !close.exists }
                }
                XCTAssertFalse(close.exists, "the sheet closes")
                break
            }
            bringTabBarIntoReach()
            let days = tab("Timeline")
            if holds(within: 2, { self.isPlaced(days, selected: false) }), days.isHittable { break }
            let back = navigationBars.buttons.firstMatch
            guard back.exists else { break }
            back.tap()
        }
        tab("Timeline").appears()
    }

    func backFromDay() {
        let back = buttons["day.back"].firstMatch
        back.appears("the pushed day's back")
        back.tap()
        back.vanishes("the day popped")
    }

    func returnToDays() {
        closeCaptureSheet()
        openTab("Timeline")
        capturePlus.appears()
    }

    func openCaptureMenu() {
        returnToDays()
        let photo = buttons["capture.menu.photo"]
        for _ in 0..<5 where !photo.exists {
            capturePlus.tap()
            _ = holds(within: 2) { photo.exists }
        }
        photo.appears()
    }

    func openAllNotes() {
        openCaptureMenu()
        buttons["capture.menu.notes"].tap()
        descendants(matching: .any)["notes.folders"].firstMatch.appears("the folders")
    }

    func openCamera() {
        openCaptureMenu()
        buttons["capture.menu.photo"].tap()
    }

    func noteText(_ title: String) -> XCUIElement {
        collectionViews.staticTexts[title]
    }

    func closeConnectorDetail() {
        let sheet = descendants(matching: .any)["connector.detail"].firstMatch
        guard sheet.exists else { return }
        sheetGrabber().coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .drag(to: coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)), velocity: .fast)
        sheet.vanishes("the sheet closes")
    }

    func sheetGrabber() -> XCUIElement {
        let grabbers = buttons.matching(NSPredicate(format: "label == %@", "Sheet Grabber")).allElementsBoundByIndex
        guard let grabber = grabbers.max(by: { $0.frame.minY < $1.frame.minY }) else {
            XCTFail("the sheet's grabber")
            return buttons["Sheet Grabber"].firstMatch
        }
        return grabber
    }

    func openStreams() {
        closeCaptureSheet()
        let button = buttons["streams.open"].firstMatch
        button.appears("the tab's top bar holds Connectors")
        button.tap()
        rootHead("Connectors").appears()
    }

    var streamsLine: XCUIElement {
        buttons["streams.close"].firstMatch
    }

    func expandSheet() {
        let grabber = sheetGrabber()
        guard grabber.value as? String != "Expanded" else { return }
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)))
    }

    func openMachinery(_ identifier: String, notConnected: Bool = false) {
        let holder = Self.sheets[identifier]
        closeConnectorDetail()
        if !rootHead("Connectors").exists { openStreams() }
        let pill = buttons[notConnected ? "connectors.shown.not" : "connectors.shown.connected"].firstMatch
        pill.appears("the pill of the row's view")
        pill.tap()
        let row = descendants(matching: .any)[holder ?? identifier].firstMatch
        row.appears("its row, once Connectors reads the home")
        bringIntoView(row, between: streamsLine)
        row.tap()
        guard holder != nil else { return }
        descendants(matching: .any)["connector.detail"].firstMatch.appears("the sheet opens")
        scrolledTo(identifier).tap()
    }

    func openAI(_ member: String) {
        let row = scrolledTo("connector.ai.\(member)")
        row.tap()
        part("Model").appears("\(member)'s page, its Model")
    }

    private static let sheets = [
        "machinery.status": "machinery.phone", "machinery.experiments": "machinery.phone",
        "machinery.privacy": "machinery.phone",
        "settings.checkins": "machinery.checkins",
    ]

    func bringIntoView(_ element: @autoclosure () -> XCUIElement, towardTop: Bool = false,
                       between header: XCUIElement? = nil, and foot: XCUIElement? = nil, on surface: XCUIElement? = nil) {
        let bottom = foot?.frame.minY ?? visibleFoot()
        let top = { () -> CGFloat in
            if let header { return header.frame.maxY }
            return self.visibleTop()
        }
        let slack: CGFloat = 8
        let clear = { (shown: CGRect, top: CGFloat) in
            shown.height > bottom - top ? shown.minY >= top - slack && shown.minY < bottom
                : shown.minY >= top - slack && shown.maxY <= bottom + slack
        }
        var last: CGRect?
        var missingUp = !towardTop
        var share: CGFloat = 0.3
        var wentUp: Bool?
        let start = { (up: Bool) -> CGFloat? in
            guard let header, surface == nil, self.frame.height > 0 else { return nil }
            let floor = header.frame.maxY
            return (up ? 0.8 : 0.55) * self.frame.height > floor + slack ? nil : (floor + bottom) / 2 / self.frame.height
        }
        for _ in 0..<20 {
            let target = element()
            guard target.exists else {
                if let last, last.minY < bottom { share = max(share / 2, 0.06) }
                drag(up: missingUp, on: surface, share: share, from: start(missingUp)); last = nil; continue
            }
            let shown = target.frame
            let ceiling = top()
            if clear(shown, ceiling) { return }
            if let last, abs(last.minY - shown.minY) < 1 { break }
            last = shown
            let up = shown.minY >= ceiling
            if let wentUp, wentUp != up { share = max(share / 2, 0.06) }
            wentUp = up
            missingUp = shown.minY >= bottom || !up
            drag(up: up, on: surface, share: share, from: start(up))
        }
        let target = element()
        let at = target.exists ? "at \(target.frame)" : "not in the tree"
        XCTAssertTrue(target.exists && clear(target.frame, top()), "\(target) brought between \(top()) and \(bottom): \(at)")
    }

    private func visibleTop() -> CGFloat {
        let bar = navigationBars.firstMatch
        let controls = buttons["search.open"].firstMatch
        let barFoot = bar.exists ? bar.frame.maxY : 0
        let controlsFoot = controls.exists && controls.isHittable && controls.frame.maxY < frame.midY ? controls.frame.maxY : 0
        return max(barFoot, controlsFoot)
    }

    private func visibleFoot() -> CGFloat {
        let item = tabBars.buttons.firstMatch
        if isPlaced(item, selected: false), item.isHittable { return tabBars.firstMatch.frame.minY }
        return frame.maxY - 44
    }

    func drag(up: Bool, on surface: XCUIElement? = nil, share: CGFloat = 0.3, from start: CGFloat? = nil) {
        let distance = frame.height * share
        let from = surface.flatMap { $0.exists ? $0.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)) : nil }
            ?? coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start ?? (up ? 0.8 : 0.55)))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: up ? -distance : distance)),
                   withVelocity: .default, thenHoldForDuration: 0.1)
    }

    func swipeAway(_ sheet: XCUIElement) {
        for _ in 0..<2 where sheet.exists { sheet.swipeDown(velocity: .fast) }
        sheet.vanishes("the sheet closes")
    }

    func scrolledTo(_ identifier: String) -> XCUIElement {
        let element = descendants(matching: .any)[identifier].firstMatch
        bringIntoView(element)
        return element
    }
}

extension XCUIElement {
    @MainActor
    func comesToRest(_ what: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
        var last = CGRect.null
        until("\(what()): still moving at \(frame), hittable \(isHittable)", file: file, line: line) {
            let now = frame
            defer { last = now }
            return now == last && isHittable
        }
    }

    func holdsStill(for seconds: TimeInterval, _ what: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
        let value = self.value as? String, top = frame.minY
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            MainActor.assumeIsolated { (self.value as? String) != value || abs(self.frame.minY - top) > 1 }
        }, object: nil)
        moved.isInverted = true
        if XCTWaiter.wait(for: [moved], timeout: seconds) != .completed {
            XCTFail("moved on its own: \(what()) (now \(self.value as? String ?? "?") at \(Int(frame.minY)))", file: file, line: line)
        }
    }
}

extension XCUICoordinate {
    func drag(to end: XCUICoordinate, pressing: TimeInterval = 0.05, velocity: XCUIGestureVelocity? = nil, hold: TimeInterval = 0) {
        if velocity == nil, hold == 0 {
            press(forDuration: pressing, thenDragTo: end)
        } else {
            press(forDuration: pressing, thenDragTo: end, withVelocity: velocity ?? .default, thenHoldForDuration: hold)
        }
    }
}

extension XCUIApplication {
    func rootHead(_ name: String) -> XCUIElement {
        descendants(matching: .any).matching(NSPredicate(
            format: "(identifier == 'root.title' AND label == %@) OR (elementType == %d AND identifier == %@)",
            name, XCUIElement.ElementType.navigationBar.rawValue, name)).firstMatch
    }

    func monthItem(_ month: String) -> XCUIElement {
        let name = DateFormatter().standaloneMonthSymbols[(Int(month.suffix(2)) ?? 1) - 1]
        return descendants(matching: .any).matching(NSPredicate(
            format: "(label == %@ OR label == %@) AND NOT (identifier BEGINSWITH 'days.month.')", name, "\(name) \(month.prefix(4))")).firstMatch
    }

    var rootLineFoot: CGFloat {
        buttons["streams.open"].firstMatch.frame.maxY + 4
    }
}

extension XCUIElement {
    func stepDown() { tapFromEnd(47 + 23.5) }

    func stepUp() { tapFromEnd(23.5) }

    private func tapFromEnd(_ points: CGFloat) {
        coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: frame.width - points, dy: 0)).tap()
    }
}
