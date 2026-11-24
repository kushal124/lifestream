import XCTest

@MainActor
final class PhotosFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyBringInAllPhotos() throws {
        let app = launch()
        app.openCamera()
        let library = app.buttons["camera.library"]
        library.appears()
        library.tap()
        app.navigationBars["Photos"].appears()

        let bringIn = app.buttons["photos.bringIn"]
        bringIn.appears()
        XCTAssertFalse(app.datePickers.firstMatch.exists, "no cutoff: every photo reaches the home")
        keep("photos-before-dark")
        bringIn.tap()
        let stop = app.buttons["photos.stop"]
        app.allowing(["Allow Full Access", "Allow Access to All Photos", "Allow", "OK"], until: stop,
                     "Bring in all photos runs until the home has them or the person stops it")

        let count = app.descendants(matching: .any)["photos.count"].firstMatch
        count.appears()
        until("the library's photos are counted; label was \(count.label)") { numericValue(count) >= 1 }
        keep("photos-bringing-in-dark")
        stop.tap()
        bringIn.appears("Stop ends it")
        keep("photos-stopped-dark")
    }

    private func numericValue(_ element: XCUIElement) -> Int {
        let text = (element.value as? String).flatMap { $0.isEmpty ? nil : $0 } ?? element.label
        return text.replacingOccurrences(of: ",", with: "").split(whereSeparator: { !$0.isNumber }).last.flatMap { Int($0) } ?? -1
    }
}
