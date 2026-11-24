import XCTest

@MainActor
final class AppDiscoveryUITests: XCTestCase {
    func testLifestreamAppearsInSpotlight() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let start = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
        start.press(forDuration: 0.1, thenDragTo: springboard.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
        let spotlight = XCUIApplication(bundleIdentifier: "com.apple.Spotlight")
        let search = spotlight.textFields["SpotlightSearchField"]
        search.appears()
        spotlight.focus(search)
        let introduction = spotlight.otherElements["UIContinuousPathIntroductionView"].buttons["Continue"]
        if introduction.exists { introduction.tap() }
        for _ in 0..<3 {
            guard let current = search.value as? String, current != "Search", !current.isEmpty else { break }
            search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        search.typeText("Lifestream")
        if introduction.exists { introduction.tap() }
        let result = spotlight.icons["Lifestream"]
        result.appears()
        // paces: Spotlight's results settling for the screenshot; SpringBoard records nothing to wait on.
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Lifestream in Spotlight"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        result.tap()
        until("the result opens the app") { app.state == .runningForeground }
    }
}
