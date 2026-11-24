import XCTest
@testable import Cockpit

@MainActor
final class AgentPartsTests: XCTestCase {
    func testSevenKindsFoldToFivePartsAndOther() {
        let parts = (1...7).map { KindBar.Part("Kind \($0)", n: 10 * $0) }
        let folded = KindBar.folded(parts)
        XCTAssertEqual(folded.map(\.name), ["Kind 1", "Kind 2", "Kind 3", "Kind 4", "Kind 5", "Other"])
        XCTAssertEqual(folded.last?.n, 60 + 70)
    }

    func testFiveKindsKeepNoOther() {
        let parts = (1...5).map { KindBar.Part("Kind \($0)", n: $0) }
        XCTAssertEqual(KindBar.folded(parts), parts)
    }

    func testEmptyKindsAreLeftOut() {
        XCTAssertEqual(KindBar.folded([KindBar.Part("Messages", n: 40), KindBar.Part("Health", n: 0)]).map(\.name), ["Messages"])
    }

    func testATinyShareIsDrawnAtLeastTwoPointsWide() {
        let widths = KindBar.widths([1000, 1], in: 300)
        XCTAssertEqual(widths[1], 2)
        XCTAssertEqual(widths.reduce(0, +) + KindBar.gap, 300, accuracy: 0.001)
    }

    func testSharesFillTheBar() {
        let widths = KindBar.widths([40, 30, 26], in: 300)
        XCTAssertEqual(widths.reduce(0, +) + KindBar.gap * 2, 300, accuracy: 0.001)
        XCTAssertGreaterThan(widths[0], widths[1])
    }

    func testBoldLineKeepsEveryRun() {
        let runs = [BoldRun("Mostly your "), BoldRun("messages", bold: true), BoldRun(" and "), BoldRun("email", bold: true), BoldRun(".")]
        XCTAssertEqual(BoldLine.line(runs).words, "Mostly your messages and email.")
    }

    func testBoldRunReadsTheHomesShape() throws {
        let json = Data(#"[{"text":"Orbit sees everything but "},{"text":"Health","bold":true}]"#.utf8)
        XCTAssertEqual(try JSONDecoder().decode([BoldRun].self, from: json), [BoldRun("Orbit sees everything but "), BoldRun("Health", bold: true)])
    }

    func testAWaitingToggleSaysWaiting() {
        XCTAssertEqual(CockpitToggleStyle.spoken(waiting: true), "Waiting")
        XCTAssertNil(CockpitToggleStyle.spoken(waiting: false))
    }

    func testAPickedChipTappedAgainClearsTheFilter() {
        let picked = ChipRow<String>.chosen("messages", in: [], adding: false)
        XCTAssertEqual(picked, ["messages"])
        XCTAssertEqual(ChipRow<String>.chosen("messages", in: picked, adding: false), [])
        XCTAssertEqual(ChipRow<String>.chosen("mail", in: picked, adding: false), ["mail"])
    }
}
