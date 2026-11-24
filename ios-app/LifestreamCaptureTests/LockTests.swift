import SwiftUI
import XCTest
@testable import Lifestream

@MainActor
final class LockTests: XCTestCase {
    private let mac = String(repeating: "A", count: 52)
    private let other = String(repeating: "B", count: 52)

    func testALinkShowingTheCertificateThePassHoldsIsNoMoveAndAnyOtherIs() {
        XCTAssertFalse(HomeMove.moves(held: .paired(pin: mac), to: mac),
                       "the same Mac at any address: the certificate is the Mac, an address only a road")
        XCTAssertTrue(HomeMove.moves(held: .paired(pin: mac), to: other),
                      "another certificate, though the link names an address the pass holds")
    }

    func testAPhoneWithNoPassMovesNowhereAndOneThatCannotTellItsMacMoves() {
        XCTAssertFalse(HomeMove.moves(held: .unpaired, to: mac), "the first pairing")
        XCTAssertTrue(HomeMove.moves(held: nil, to: mac), "a pass that cannot be read is no proof of the same Mac")
        XCTAssertTrue(HomeMove.moves(held: .paired(pin: nil), to: mac), "a pass holding no certificate cannot say")
    }

    func testAMoveProvedStandsForThatMacUnderThatLockAlone() {
        let proof = HomeMove.Proof(mac: other, turn: 3)
        XCTAssertTrue(proof.covers(other, turn: 3), "the which-phone step after it asks no second time")
        XCTAssertFalse(proof.covers(other, turn: 4), "the app locked again since: asked again")
        XCTAssertFalse(proof.covers(mac, turn: 3), "another Mac")
    }

    func testAPassOpensWhileActiveWaitsWhileInactiveAndGoesInTheBackgroundUnderItsLockAlone() {
        var turns = LockTurns()
        let asked = turns.generation
        XCTAssertEqual(turns.judge(asked, .active), .open)
        XCTAssertEqual(turns.judge(asked, .inactive), .wait, "Face ID's own prompt still leaves the app inactive")
        XCTAssertEqual(turns.judge(asked, .background), .shut)
        turns.lock()
        XCTAssertEqual(turns.judge(asked, .active), .shut, "the app locked again while it was asked")
        XCTAssertEqual(turns.judge(asked, .inactive), .shut, "nothing waits for a lock gone")
        XCTAssertEqual(turns.judge(turns.generation, .active), .open, "the next ask counts")
    }

    func testAPassThatLandsInactiveOpensOnceTheAppIsActive() async {
        let app = AppState()
        let passes = Passes { app.state }
        let settled = Task { await passes.settle(passes.turn) }
        await waitUntil { passes.held == 1 }
        passes.changed()
        await waitUntil { passes.held == 1 }
        XCTAssertEqual(passes.held, 1, "still inactive: it waits again")
        app.state = .active
        passes.changed()
        let opened = await settled.value
        XCTAssertTrue(opened, "active under the same lock")
    }

    func testAPassThatLandsInactiveIsThrownAwayInTheBackground() async {
        let app = AppState()
        let passes = Passes { app.state }
        let settled = Task { await passes.settle(passes.turn) }
        await waitUntil { passes.held == 1 }
        app.state = .background
        passes.changed()
        let opened = await settled.value
        XCTAssertFalse(opened)
    }

    func testAPassThatLandsInactiveOpensNothingOnceTheAppLocked() async {
        let app = AppState()
        let passes = Passes { app.state }
        let settled = Task { await passes.settle(passes.turn) }
        await waitUntil { passes.held == 1 }
        passes.lock()
        app.state = .active
        passes.changed()
        let opened = await settled.value
        XCTAssertFalse(opened, "active again, but under a new lock")
    }

    func testAPassThatLandsActiveOpensAtOnce() async {
        let passes = Passes { .active }
        let opened = await passes.settle(passes.turn)
        XCTAssertTrue(opened)
        XCTAssertEqual(passes.held, 0)
    }

    private func waitUntil(_ done: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<10_000 where !done() { await Task.yield() }
        XCTAssertTrue(done(), "never came", file: file, line: line)
    }

    func testTheCoverStandsWheneverTheAppIsNotActive() {
        XCTAssertFalse(PrivacyCover.shows(.active))
        XCTAssertTrue(PrivacyCover.shows(.inactive), "the app switcher, Control Centre, Face ID's own prompt")
        XCTAssertTrue(PrivacyCover.shows(.background))
    }

    func testTheCoverOffersUnlockOnlyOnceNoAskIsOnScreenOrComingByItself() {
        XCTAssertEqual(LockFace(locked: true, asking: false, due: true), .waits, "the app arriving: Face ID comes, no Unlock flashes first")
        XCTAssertEqual(LockFace(locked: true, asking: true, due: false), .waits, "Face ID's prompt over the cover alone")
        XCTAssertEqual(LockFace(locked: true, asking: true, due: true), .waits)
        XCTAssertEqual(LockFace(locked: true, asking: false, due: false), .offers, "declined, or a build that never asks by itself")
        XCTAssertEqual(LockFace(locked: false, asking: true, due: true), .open, "passed: the app, never the cover again")
        XCTAssertEqual(LockFace(locked: false, asking: false, due: false), .open)
    }

    func testTheNotesAndACheckInWaitBehindTheLockAndACaptureDoesNot() {
        let navigation = AppNavigation.shared
        let presented = navigation.presented
        let route = navigation.checkInRoute
        defer {
            navigation.presented = presented
            navigation.checkInRoute = route
        }
        navigation.checkInRoute = nil
        navigation.presented = .notes(.folders)
        XCTAssertNil(navigation.shown(locked: true), "the notes are the person's own words")
        XCTAssertEqual(navigation.shown(locked: false), .notes(.folders))
        XCTAssertTrue(navigation.waitsBehindLock)
        navigation.presented = .camera
        XCTAssertEqual(navigation.shown(locked: true), .camera, "a capture stands over the cover")
        XCTAssertFalse(navigation.waitsBehindLock)
        navigation.presented = nil
        navigation.checkInRoute = CheckInRoute(destination: .prompt)
        XCTAssertTrue(navigation.waitsBehindLock, "a check-in a notification opened")
    }
}

@MainActor
private final class AppState {
    var state = UIApplication.State.inactive
}
