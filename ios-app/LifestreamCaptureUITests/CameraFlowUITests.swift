import XCTest

@MainActor
final class CameraFlowUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testJourneySampleShotPersistsAcrossRelaunch() throws {
    let app = launch()
    app.openCamera()
    let sample = app.buttons["camera.sample"]
    sample.appears()
    XCTAssertTrue(app.staticTexts["camera.none"].exists, "the simulator's camera says it has none")
    keep("camera-no-camera")
    sample.tap()
    let recent = app.buttons["camera.recent"]
    recent.appears()
    recent.tap()
    app.navigationBars["Shots"].appears()
    let cells = app.buttons.matching(identifier: "camera.shots.cell")
    cells.firstMatch.appears()
    XCTAssertEqual(cells.count, 1)
    keep("camera-shots")
    cells.firstMatch.tap()
    app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'sha256 '")).firstMatch
        .appears()
    XCTAssertFalse(app.staticTexts["Size unknown"].exists)
    app.relaunch()
    app.openCamera()
    recent.appears()
    recent.tap()
    cells.firstMatch.appears()
    XCTAssertEqual(cells.count, 1)
    keep("camera-shots-relaunched")
  }
}
