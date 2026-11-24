import CoreGraphics
import Foundation
import HomeLink
import ImageIO
import Observation
import UniformTypeIdentifiers
import XCTest

@testable import LifestreamCaptureCore

@MainActor
final class PicturesTests: XCTestCase {

    func testACropIsDrawnBeforeTheCardsPhoto() {
        XCTAssertEqual(Self.photo(crop: "sha256:crop", card: "sha256:card").hash, "sha256:crop")
        XCTAssertEqual(Self.photo(crop: nil, card: "sha256:card").hash, "sha256:card")
        XCTAssertNil(Self.photo(crop: nil, card: nil).hash)
    }


    func testAFaceIsDecodedAtThePixelsItIsDrawn() throws {
        let square = try XCTUnwrap(PictureDecode.decode(Self.jpeg(width: 1_024, height: 1_024), side: 108))
        XCTAssertEqual([square.width, square.height], [108, 108], "the 1,024 square drawn down to the row's face, never whole")
    }

    func testAPhotoThatIsNotSquareFillsTheFace() throws {
        let wide = try XCTUnwrap(PictureDecode.decode(Self.jpeg(width: 600, height: 400), side: 108))
        XCTAssertEqual([wide.width, wide.height], [162, 108], "its shorter side covers the face")
        let tall = try XCTUnwrap(PictureDecode.decode(Self.jpeg(width: 400, height: 600), side: 108))
        XCTAssertEqual([tall.width, tall.height], [108, 162])
    }

    func testAPictureSmallerThanTheFaceIsNeverDrawnUp() throws {
        let small = try XCTUnwrap(PictureDecode.decode(Self.jpeg(width: 64, height: 48), side: 216))
        XCTAssertEqual([small.width, small.height], [64, 48])
    }

    func testNoPictureIsDecodedPastTheScreenSize() throws {
        let large = try Self.jpeg(width: 3_200, height: 1_600)
        for side in [1_600, 100_000] {
            let drawn = try XCTUnwrap(PictureDecode.decode(large, side: side))
            XCTAssertEqual([drawn.width, drawn.height], [2_560, 1_280], "asked \(side) across, it is the screen size at most")
        }
    }

    func testAnOriginalZoomedIsDecodedAtThePixelsTheZoomShows() throws {
        let large = try XCTUnwrap(PictureDecode.decode(Self.jpeg(width: 3_000, height: 2_000), fittedIn: CGSize(width: 100, height: 100), zoom: 6))
        XCTAssertEqual([large.width, large.height], [600, 400], "never whole where the zoom cannot show it")
        let whole = try XCTUnwrap(PictureDecode.decode(Self.jpeg(width: 3_000, height: 2_000), fittedIn: CGSize(width: 1_170, height: 2_532), zoom: 6))
        XCTAssertEqual([whole.width, whole.height], [3_000, 2_000], "never drawn up")
        let turned = try XCTUnwrap(PictureDecode.decode(Self.jpeg(width: 600, height: 400, orientation: 6), fittedIn: CGSize(width: 100, height: 150), zoom: 2))
        XCTAssertEqual([turned.width, turned.height], [200, 300], "fitted as it stands upright")
        XCTAssertNil(PictureDecode.decode(Data("no picture".utf8), fittedIn: CGSize(width: 100, height: 100), zoom: 6))
    }

    func testATurnedPhotoIsDecodedUpright() throws {
        let turned = try XCTUnwrap(PictureDecode.decode(Self.jpeg(width: 600, height: 400, orientation: 6), side: 108))
        XCTAssertEqual([turned.width, turned.height], [108, 162])
    }

    func testBytesThatAreNoPictureDecodeToNothing() {
        XCTAssertNil(PictureDecode.decode(Data("no picture".utf8), side: 108))
        XCTAssertNil(PictureDecode.decode(Data(), side: 108))
    }


    func testTwoFacesOfOnePersonReadTheirBytesOnce() async throws {
        let home = Home()
        let cache = Self.cache(home)
        let tile = Task { try await cache.read("a", .tile, side: 168) }
        let row = Task { try await cache.read("a", .tile, side: 108) }
        try await until("the tile's read asks the home") { home.asked == ["a.tile"] }
        try await until("the row waits on the tile's read") { cache.waiters("a", .tile) == 2 }
        home.answer("a", Self.picture(400))
        _ = try await tile.value
        _ = try await row.value
        XCTAssertEqual(home.asked, ["a.tile"], "one download for both faces")
        XCTAssertEqual(cache.picture("a", .tile)?.side, 168, "decoded at the larger face's size, which serves both")
        XCTAssertTrue(cache.holds("a", .tile, side: 108))
        XCTAssertTrue(cache.holds("a", .tile, side: 168))
    }

    func testALargerFaceAskedDuringASmallerReadIsDecodedAtItsSize() async throws {
        let home = Home()
        let cache = Self.cache(home)
        let row = Task { try await cache.read("a", .tile, side: 108) }
        try await until("the row's read asks the home") { home.asked == ["a.tile"] }
        let head = Task { try await cache.read("a", .tile, side: 216) }
        try await until("the head waits on the row's read") { cache.waiters("a", .tile) == 2 }
        home.answer("a", Self.picture(400))
        _ = try await row.value
        let drawn = try await head.value
        XCTAssertEqual(home.asked, ["a.tile"])
        XCTAssertEqual(drawn?.side, 216, "each waiter is handed the picture that serves it")
        XCTAssertEqual(cache.picture("a", .tile)?.side, 216)
    }

    func testALargerFaceAskedWhileASmallerDecodesIsDecodedAgainAtItsSize() async throws {
        let home = Home()
        let decoding = Happened()
        let release = Gate()
        let cache = Pictures<Drawn>(budget: 1_000_000, read: home.reader) { _, side in
            if side == 108 {
                decoding.note()
                release.wait()
            }
            return (Drawn(side: side), side * side)
        }
        let row = Task { try await cache.read("a", .tile, side: 108) }
        try await until("the row's read asks the home") { home.asked == ["a.tile"] }
        home.answer("a", Self.picture(400))
        try await until("the row's bytes are decoding") { decoding.value }
        let head = Task { try await cache.read("a", .tile, side: 216) }
        try await until("the head waits on the row's read") { cache.waiters("a", .tile) == 2 }
        release.open()
        _ = try await row.value
        _ = try await head.value
        XCTAssertEqual(home.asked, ["a.tile"], "the bytes kept are decoded again, never downloaded again")
        XCTAssertEqual(cache.picture("a", .tile)?.side, 216, "the head draws at its own size")
    }

    func testASmallerPictureNeverReplacesALargerAndALargerIsDrawnFromTheSmallerMeanwhile() async throws {
        let home = Home(answering: Self.picture(400))
        let cache = Self.cache(home)
        try await cache.read("a", .tile, side: 108)
        XCTAssertEqual(cache.picture("a", .tile)?.side, 108)
        XCTAssertFalse(cache.holds("a", .tile, side: 216), "the head asks for its own")
        XCTAssertEqual(cache.picture("a", .tile)?.side, 108, "and draws the row's meanwhile, never the monogram")

        try await cache.read("a", .tile, side: 216)
        XCTAssertEqual(cache.picture("a", .tile)?.side, 216)
        let held = try await cache.read("a", .tile, side: 108)
        XCTAssertEqual(held?.side, 216, "the larger held serves the smaller")
        XCTAssertEqual(home.asked, ["a.tile", "a.tile"], "held at a larger size: nothing is asked")
        XCTAssertEqual(cache.picture("a", .tile)?.side, 216, "the larger stays")
    }

    func testATileAndAScreenOfOneHashAreTwoPictures() async throws {
        let home = Home()
        let cache = Self.cache(home)
        let tile = Task { try await cache.read("a", .tile, side: 390) }
        let screen = Task { try await cache.read("a", .screen, side: 900) }
        try await until("each size asks the home its own") { Set(home.asked) == ["a.tile", "a.screen"] }
        home.answer("a", Self.picture(400))
        _ = try await tile.value
        _ = try await screen.value
        XCTAssertEqual(home.asked.count, 2, "one read each")
        XCTAssertEqual(cache.picture("a", .tile)?.side, 390)
        XCTAssertEqual(cache.picture("a", .screen)?.side, 900, "a screen is never the tile's picture drawn up")
        XCTAssertFalse(cache.holds("a", .screen, side: 1_200), "a tile held is never a screen")
    }

    func testARefusalReachesEveryoneWaitingAndIsAskedAgain() async throws {
        let home = Home()
        let cache = Self.cache(home)
        let row = Task { try await cache.read("a", .tile, side: 108) }
        let head = Task { try await cache.read("a", .tile, side: 216) }
        try await until("both wait on one read") { cache.waiters("a", .tile) == 2 }
        home.refuse("a")
        for face in [row, head] {
            do { _ = try await face.value; XCTFail("refused") } catch Refused.notHeld {}
        }
        XCTAssertNil(cache.picture("a", .tile))
        let again = Task { try await cache.read("a", .tile, side: 108) }
        try await until("asked again as a face asks again") { home.asked == ["a.tile", "a.tile"] }
        home.answer("a", Self.picture(400))
        _ = try await again.value
        XCTAssertNotNil(cache.picture("a", .tile))
    }

    func testAPictureNotMadeJustNowIsAskedAgainAtItsRetryAfterWhileAViewWaits() async throws {
        let home = Home()
        let cache = Self.cache(home)
        let poster = Task { try await cache.read("a", .screen, side: 1_200) }
        try await until("the poster asks the home") { home.asked == ["a.screen"] }
        home.fail("a", Self.notNow(after: 0))
        try await until("asked again at its Retry-After, the view still waiting") { home.asked == ["a.screen", "a.screen"] }
        home.answer("a", Self.picture(400))
        _ = try await poster.value
        XCTAssertNotNil(cache.picture("a", .screen), "drawn once made")

        let gone = Task { try await cache.read("b", .screen, side: 1_200) }
        try await until("the second poster asks the home") { home.asked.last == "b.screen" }
        home.fail("b", Self.notNow(after: 3_600))
        gone.cancel()
        do { _ = try await gone.value; XCTFail("a view gone draws nothing") } catch is CancellationError {}
        XCTAssertEqual(home.asked.filter { $0 == "b.screen" }.count, 1, "the wait ended with the view: never asked again")
        XCTAssertEqual(cache.waiters("b", .screen), 0)

        let none = Task { try await cache.read("c", .screen, side: 1_200) }
        try await until("the third poster asks the home") { home.asked.last == "c.screen" }
        home.fail("c", LinkFailure.refused(status: 404, code: "NOT_A_PICTURE", message: "no picture"))
        do { _ = try await none.value; XCTFail("a 404 draws nothing") } catch LinkFailure.refused(404, _, _) {}
        XCTAssertEqual(home.asked.filter { $0 == "c.screen" }.count, 1, "a 404 is final")
    }

    func testTwoReadsPastTheBudgetBothAnswerTheirPicture() async throws {
        let home = Home()
        let decoding = (a: Happened(), b: Happened())
        let release = Gate()
        let decoded = Gate()
        let cache = Pictures<Drawn>(budget: 108 * 108, read: home.reader) { data, side in
            (data.count == 400 ? decoding.a : decoding.b).note()
            release.wait()
            defer { decoded.open() }
            return (Drawn(side: side), side * side)
        }
        let a = Task { try await cache.read("a", .tile, side: 108) }
        let b = Task { try await cache.read("b", .tile, side: 108) }
        try await until("both reads ask the home") { Set(home.asked) == ["a.tile", "b.tile"] }
        home.answer("a", Self.picture(400))
        home.answer("b", Self.picture(401))
        try await until("both decode") { decoding.a.value && decoding.b.value }
        release.open()
        release.open()
        for _ in 0..<2 {
            guard decoded.wait(within: waitLimit) else { return XCTFail("never came in 30 s: both decodes end") }
        }
        let drawnA = try await a.value
        let drawnB = try await b.value
        XCTAssertEqual(drawnA?.side, 108, "a's read landed: its view draws it, though shed since")
        XCTAssertEqual(drawnB?.side, 108)
        XCTAssertEqual([cache.picture("a", .tile), cache.picture("b", .tile)].compactMap { $0 }.count, 1, "room for one: the other was shed")
        XCTAssertEqual(home.asked.count, 2, "neither asked again")
    }

    func testBytesThatAreNoPictureAreHandedBackAsNone() async throws {
        let home = Home(answering: Data())
        let cache = Self.cache(home)
        let drawn = try await cache.read("a", .tile, side: 108)
        XCTAssertNil(drawn, "no picture: the view says so")
        XCTAssertNil(cache.picture("a", .tile))
    }


    func testARowScrolledAwayCancelsItsDownload() async throws {
        let home = Home()
        let cache = Self.cache(home)
        let row = Task { try await cache.read("a", .tile, side: 108) }
        try await until("the row's read asks the home") { home.asked == ["a.tile"] }
        row.cancel()
        _ = try? await row.value
        try await until("the download is cancelled") { home.cancelled == ["a"] }
        XCTAssertNil(cache.picture("a", .tile))

        let again = Task { try await cache.read("a", .tile, side: 108) }
        try await until("asked again as the row comes back") { home.asked == ["a.tile", "a.tile"] }
        home.answer("a", Self.picture(400))
        _ = try await again.value
        XCTAssertNotNil(cache.picture("a", .tile))
    }

    func testAFaceScrolledAwayLeavesTheReadAnotherFaceWaitsOn() async throws {
        let home = Home()
        let cache = Self.cache(home)
        let gone = Task { try await cache.read("a", .tile, side: 108) }
        try await until("the first face's read asks the home") { home.asked == ["a.tile"] }
        let staying = Task { try await cache.read("a", .tile, side: 108) }
        try await until("the second face waits on the first's read") { cache.waiters("a", .tile) == 2 }
        gone.cancel()
        try await until("the face scrolled away has left the read") { cache.waiters("a", .tile) == 1 }
        home.answer("a", Self.picture(400))
        _ = try await staying.value
        XCTAssertEqual(home.cancelled, [], "the face still on screen waits on it")
        XCTAssertEqual(home.asked, ["a.tile"])
        XCTAssertNotNil(cache.picture("a", .tile), "and draws")
    }

    func testAReadCancelledWhileItDecodesLandsNothing() async throws {
        let decoding = Happened()
        let release = Gate()
        let cache = Pictures<Drawn>(budget: 1_000_000, read: Home(answering: Self.picture(400)).reader) { _, side in
            decoding.note()
            release.wait()
            return (Drawn(side: side), side * side)
        }
        let row = Task { try await cache.read("a", .tile, side: 108) }
        try await until("the bytes are decoding") { decoding.value }
        row.cancel()
        try await until("the read is let go") { cache.waiters("a", .tile) == 0 }
        release.open()
        _ = try? await row.value
        XCTAssertNil(cache.picture("a", .tile))
    }


    func testAFaceLandingRedrawsItsOwnFacesAlone() async throws {
        let cache = Self.cache(Home(answering: Self.picture(400)))
        let other = Happened()
        let screen = Happened()
        let own = Happened()
        withObservationTracking { _ = cache.picture("b", .tile) } onChange: { other.note() }
        withObservationTracking { _ = cache.picture("a", .screen) } onChange: { screen.note() }
        withObservationTracking { _ = cache.picture("a", .tile) } onChange: { own.note() }
        try await cache.read("a", .tile, side: 108)
        XCTAssertTrue(own.value, "a's face hears a land")
        XCTAssertFalse(other.value, "b's face is not drawn again")
        XCTAssertFalse(screen.value, "nor a's screen")
    }

    func testAFaceForgottenIsHeardAndAskedAgain() async throws {
        let cache = Self.cache(Home(answering: Self.picture(400)))
        try await cache.read("a", .tile, side: 108)
        let heard = Happened()
        withObservationTracking { _ = cache.holds("a", .tile, side: 108) } onChange: { heard.note() }
        cache.forget()
        XCTAssertTrue(heard.value, "the face on screen hears it, so asks again")
        XCTAssertNil(cache.picture("a", .tile))
        XCTAssertEqual(cache.pixels, 0)
    }


    func testTheCacheShedsTheFacesDrawnLongestAgo() async throws {
        let home = Home(answering: Self.picture(400))
        let cache = Pictures<Drawn>(budget: 3 * 108 * 108, read: home.reader) { _, side in (Drawn(side: side), side * side) }
        for hash in ["a", "b", "c"] { try await cache.read(hash, .tile, side: 108) }
        try await cache.read("a", .tile, side: 108)
        XCTAssertEqual(home.asked, ["a.tile", "b.tile", "c.tile"], "a is held")
        try await cache.read("d", .tile, side: 108)
        XCTAssertNotNil(cache.picture("a", .tile))
        XCTAssertNil(cache.picture("b", .tile), "drawn longest ago, shed")
        XCTAssertNotNil(cache.picture("c", .tile))
        XCTAssertNotNil(cache.picture("d", .tile), "the face just landed is never the one shed")
        XCTAssertEqual(cache.pixels, 3 * 108 * 108)

        try await cache.read("e", .screen, side: 216)
        XCTAssertNotNil(cache.picture("e", .screen))
        XCTAssertEqual(cache.pixels, 216 * 216)
    }

    func testForgetCancelsTheReadsUnderWay() async throws {
        let home = Home()
        let cache = Self.cache(home)
        let row = Task { try await cache.read("a", .tile, side: 108) }
        try await until("the row's read asks the home") { home.asked == ["a.tile"] }
        cache.forget()
        try await until("the read of the home forgotten is cancelled") { home.cancelled == ["a"] }
        XCTAssertNil(cache.picture("a", .tile), "another home's face never lands")
        try await until("the face still on screen asks again") { home.asked == ["a.tile", "a.tile"] }
        home.answer("a", Self.picture(400))
        _ = try await row.value
        XCTAssertEqual(cache.picture("a", .tile)?.side, 108)
    }


    func testASquareChosenHereIsKeptUnderItsHashAndNeverAsked() async throws {
        let home = Home()
        let cache = Self.cache(home)
        await cache.keep("a", .tile, side: 216, bytes: Self.picture(400))
        XCTAssertEqual(cache.picture("a", .tile)?.side, 216, "drawn from its own bytes")
        try await cache.read("a", .tile, side: 108)
        XCTAssertEqual(home.asked, [], "the home's crop of the same hash draws it with no download")
    }


    struct Drawn: Sendable, Equatable {
        let side: Int
    }

    private static func cache(_ home: Home) -> Pictures<Drawn> {
        Pictures(budget: 10_000_000, read: home.reader) { data, side in data.isEmpty ? nil : (Drawn(side: side), side * side) }
    }

    private static func notNow(after seconds: TimeInterval) -> LinkFailure {
        .unavailable(code: "NOT_NOW", message: "Pictures are being made.", retryAfter: seconds)
    }

    private static func photo(crop: String?, card: String?) -> HomeLink.PersonPhoto {
        let json = try! JSONSerialization.data(withJSONObject: ["crop": crop.map { $0 as Any } ?? NSNull(), "card": card.map { $0 as Any } ?? NSNull()])
        return try! JSONDecoder().decode(HomeLink.PersonPhoto.self, from: json)
    }

    nonisolated private static func picture(_ size: Int) -> Data {
        Data(repeating: 1, count: size)
    }

    private static func jpeg(width: Int, height: Int, orientation: Int? = nil) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(red: 0.4, green: 0.5, blue: 0.6, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        let properties: [CFString: Any] = orientation.map { [kCGImagePropertyOrientation: $0] } ?? [:]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }
}

private enum Refused: Error {
    case notHeld
}

@MainActor
private final class Home {
    private(set) var asked: [String] = []
    private(set) var cancelled: [String] = []
    private let answering: Data?
    private var waiting: [String: [CheckedContinuation<Data, Error>]] = [:]

    init(answering: Data? = nil) {
        self.answering = answering
    }

    nonisolated var reader: Pictures<PicturesTests.Drawn>.Read {
        { [self] hash, size in try await bytes(hash, size) }
    }

    func bytes(_ hash: String, _ size: HomeLink.PictureSize) async throws -> Data {
        asked.append(hash + "." + size.rawValue)
        if let answering { return answering }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiting[hash, default: []].append($0) }
        } onCancel: {
            Task { @MainActor in self.cancel(hash) }
        }
    }

    func answer(_ hash: String, _ data: Data) {
        waiting.removeValue(forKey: hash)?.forEach { $0.resume(returning: data) }
    }

    func refuse(_ hash: String) {
        fail(hash, Refused.notHeld)
    }

    func fail(_ hash: String, _ error: Error) {
        waiting.removeValue(forKey: hash)?.forEach { $0.resume(throwing: error) }
    }

    private func cancel(_ hash: String) {
        cancelled.append(hash)
        waiting.removeValue(forKey: hash)?.forEach { $0.resume(throwing: CancellationError()) }
    }
}

private final class Gate: @unchecked Sendable {
    private let opened = DispatchSemaphore(value: 0)

    func wait() {
        opened.wait()
    }

    func open() {
        opened.signal()
    }

    func wait(within limit: TimeInterval) -> Bool {
        opened.wait(timeout: .now() + limit) == .success
    }
}
