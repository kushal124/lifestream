import XCTest

@MainActor
final class StreamTryUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testJourneyTheHomesActOnABrokenStreamIsTakenAndSettles() throws {
        let report = try HomeReport()
        let github = try report.connector("github")
        let health = HomeReport.health(github)
        let act = try XCTUnwrap(HomeReport.acts(github).first, "the report offers GitHub one act")
        let need = try report.need(of: github)
        let needID = HomeReport.said(need, "id")
        let app = launch(open: "streams")
        app.rootHead("Connectors").appears()

        let more = app.descendants(matching: .any)["needs.more"].firstMatch
        more.appears("the canned home's strips folded into the first")
        more.tap()
        let banner = app.descendants(matching: .any)["needs.\(needID)"].firstMatch
        banner.appears("the home's need is drawn")
        XCTAssertTrue(banner.label.contains(HomeReport.said(need, "words")), banner.label)
        XCTAssertEqual(banner.value as? String, HomeReport.said(act, "label"), "the need's act")

        let row = app.buttons["home-connector.github"].firstMatch
        row.appears("the home's connectors are read")
        app.bringIntoView(row)
        XCTAssertTrue(row.label.contains(HomeReport.said(github, "line")), row.label)
        XCTAssertEqual(row.value as? String, HomeReport.said(act, "label"), "the row ends in the home's act")
        keep("01-row")

        row.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)).tap()
        let state = app.descendants(matching: .any)["connector.detail.state"].firstMatch
        let button = app.buttons["connector.detail.state.act"].firstMatch
        state.appears("the sheet says the stream's health")
        XCTAssertTrue(state.label.contains(HomeReport.said(health, "words")), state.label)
        XCTAssertFalse(state.label.contains("on your Mac"), "the home offers the way out itself: \(state.label)")
        XCTAssertEqual(button.label, HomeReport.said(act, "label"))
        for title in ["What it records", "Where it goes", "What it costs"] {
            XCTAssertFalse(app.staticTexts[title].exists, "no trust row: \(title)")
        }
        keep("02-sheet")

        app.bringIntoView(button)
        button.tap()
        button.vanishes("the act the home took is gone from the sheet")
        XCTAssertTrue(state.label.contains(HomeReport.said(health, "words")), state.label)
        keep("03-sheet-taken")
        app.closeConnectorDetail()
        until("the row's act is gone: \(String(describing: row.value))") { (row.value as? String ?? "").isEmpty }
        XCTAssertTrue(row.label.contains(HomeReport.said(github, "line")), row.label)
        banner.vanishes("the settled need is gone from the top of Connectors")
        keep("04-row-taken")

        let claude = try report.connector("claude")
        let acts = HomeReport.acts(claude)
        XCTAssertEqual(acts.count, 2, "the report offers Claude a choice")
        let offer = try report.need(of: claude)
        let offered = app.descendants(matching: .any)["needs.\(HomeReport.said(offer, "id"))"].firstMatch
        app.bringIntoView(offered, towardTop: true, between: app.streamsLine)
        XCTAssertTrue(offered.label.contains(HomeReport.said(offer, "words")), offered.label)
        XCTAssertTrue((offered.value as? String ?? "").isEmpty, "a choice is its sheet's, never one act on the need's row")
        let claudeRow = app.buttons["home-connector.claude"].firstMatch
        app.bringIntoView(claudeRow, between: app.streamsLine)
        XCTAssertTrue(claudeRow.label.contains(HomeReport.said(claude, "line")), claudeRow.label)
        XCTAssertTrue((claudeRow.value as? String ?? "").isEmpty, "a choice is its sheet's, never one act on the row: \(String(describing: claudeRow.value))")
        app.bringIntoView(offered, towardTop: true, between: app.streamsLine)
        offered.tap()
        state.appears("the need opens the offer's sheet, the offer first in it")
        XCTAssertTrue(state.label.contains(HomeReport.said(HomeReport.health(claude), "words")), state.label)
        let buttons = acts.map { app.buttons["connector.detail.state.act.\(HomeReport.said($0, "do"))"].firstMatch }
        XCTAssertEqual(buttons.map(\.label), acts.map { HomeReport.said($0, "label") })
        XCTAssertTrue(buttons[0].frame.minX < buttons[1].frame.minX || buttons[0].frame.minY < buttons[1].frame.minY, "in the home's order")
        keep("05-offer")
        buttons[1].tap()
        buttons[1].vanishes("the offer settled by its second act")
        XCTAssertFalse(buttons[0].exists, "and its first gone with it")
        app.closeConnectorDetail()
        offered.vanishes("the settled offer is gone from the top of Connectors")
        keep("06-offer-taken")
    }

    func testJourneyLifestreamsDiskFullIsTheBannerOnEveryPageAndFoldedAdviceStripsAreDismissedAndStayGone() throws {
        let app = launch("--ui-test-home-full", "--ui-test-alerts")
        let banner = app.descendants(matching: .any)["home.need.disk:full"].firstMatch
        banner.appears("the banner on Chat")
        XCTAssertFalse(app.buttons["home.need.disk:full.dismiss"].exists, "the banner is never dismissed")
        keep("10-banner-chat")
        for name in ["Timeline", "People"] {
            app.openTab(name)
            banner.appears("the banner on \(name)")
        }
        keep("11-banner-people")

        app.openStreams()
        banner.appears("the banner over Connectors")
        let folded = app.descendants(matching: .any)["needs.more"].firstMatch
        folded.appears("the strips folded into the first, under the title")
        let count = { () -> Int in
            let label = folded.label
            guard let range = label.range(of: #"\d+ more"#, options: .regularExpression) else { return -1 }
            return Int(label[range].split(separator: " ")[0]) ?? -1
        }
        let more = count()
        XCTAssertGreaterThanOrEqual(more, 4, "the canned alerts fold behind the first: \(folded.label)")
        XCTAssertFalse(app.buttons["needs.room:macbook-air-bb07.dismiss"].exists, "a stopped strip has no ×")
        keep("12-strips-folded")

        folded.tap()
        let less = app.buttons["needs.less"].firstMatch
        less.appears("the fold laid out, Show less under it")
        let stopped = app.descendants(matching: .any)["needs.room:macbook-air-bb07"].firstMatch
        let disk = app.descendants(matching: .any)["needs.disk"].firstMatch
        XCTAssertTrue(stopped.exists && disk.exists, "the stopped strip and the advice laid out")
        XCTAssertLessThan(stopped.frame.minY, disk.frame.minY, "the stopped strip sorts first")
        XCTAssertFalse(app.descendants(matching: .any)["needs.disk:full"].exists, "the banner's need is never a strip")
        keep("13-strips-open")
        let diskStood = disk.frame.minY
        let onDisk = disk.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        onDisk.drag(to: onDisk.withOffset(CGVector(dx: 0, dy: -80)), hold: 0.1)
        until("a drag up that starts on an advice strip moves the page, never only the strip: \(disk.frame)") { disk.frame.minY < diskStood - 1 }
        app.bringIntoView(disk, towardTop: true, between: app.streamsLine)
        app.buttons["needs.disk.dismiss"].firstMatch.tap()
        disk.vanishes("× takes the advice strip away")
        let encrypted = app.descendants(matching: .any)["needs.rest:machine"].firstMatch
        app.bringIntoView(encrypted, between: app.streamsLine)
        let lessStood = less.frame.minY
        encrypted.swipeLeft(velocity: .fast)
        encrypted.vanishes("a swipe takes an advice strip away")
        until("the swiped strip's room closes once its dismissal lands: \(less.frame)") { less.frame.minY < lessStood }
        keep("14-strips-dismissed")
        less.tap()
        folded.appears("folded again")
        until("the fold counts two fewer: \(folded.label)") { count() == more - 2 }

        app.buttons["streams.close"].firstMatch.tap()
        app.rootHead("Connectors").vanishes("Connectors closes")
        banner.appears("the banner stays when Connectors closes")
        app.openStreams()
        folded.appears("the fold again")
        XCTAssertEqual(count(), more - 2, "a dismissed strip stays gone while its problem stands: \(folded.label)")
        folded.tap()
        less.appears("laid out again")
        XCTAssertFalse(disk.exists, "the disk's advice stays dismissed")
        XCTAssertFalse(encrypted.exists, "the swiped advice stays dismissed")
    }
}
