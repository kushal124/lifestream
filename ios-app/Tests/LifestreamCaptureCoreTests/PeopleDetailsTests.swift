import CoreGraphics
import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

@MainActor
final class PeopleDetailsTests: XCTestCase {

    func testPagesReachedBeforeTheReadUnderWayLandsAskEachReadOnce() async throws {
        let home = PagedHome(total: 300)
        let pages = home.pages()
        await pages.read()
        XCTAssertEqual(pages.photos.count, 60)

        home.holding = true
        let asked = expectation(description: "the read after the first is asked")
        home.heard = { if $0 == "c60" { asked.fulfill() } }
        let third = Task { await pages.need(72) }
        await fulfillment(of: [asked], timeout: 30)
        let fourth = Task { await pages.need(144) }
        let answered = Task { home.release() }
        await answered.value
        await third.value
        await fourth.value

        XCTAssertEqual(home.asked, [nil, "c60", "c120"], "each read asked once, the next one after the read waited for")
        XCTAssertEqual(pages.photos.count, 180)
        XCTAssertEqual(Set(pages.photos.map(\.face)).count, 180, "no photo twice")
        XCTAssertEqual(pages.next, "c180")
        XCTAssertEqual(pages.total, 300)
    }

    func testRetryAsksAgainTheReadThatFailed() async throws {
        let home = PagedHome(total: 150)
        let pages = home.pages()

        home.failing = ["top"]
        await pages.read()
        XCTAssertNotNil(pages.failure)
        XCTAssertTrue(pages.photos.isEmpty)
        await pages.need(24)
        XCTAssertEqual(home.asked, [nil], "after a failure nothing is asked until Retry")
        await pages.retry(24)
        XCTAssertNil(pages.failure)
        XCTAssertEqual(home.asked, [nil, nil], "the first read, which never landed, asked again")
        XCTAssertEqual(pages.photos.count, 60)

        home.failing = ["c60"]
        await pages.need(72)
        XCTAssertNotNil(pages.failure)
        XCTAssertEqual(pages.photos.count, 60, "the photos read stay")
        await pages.need(96)
        XCTAssertEqual(home.asked, [nil, nil, "c60"], "the next page reached asks nothing by itself")
        await pages.retry(96)
        XCTAssertNil(pages.failure)
        XCTAssertEqual(home.asked, [nil, nil, "c60", "c60"], "the read that failed, not the top")
        XCTAssertEqual(pages.photos.count, 120)

        await pages.retry(1_000)
        XCTAssertEqual(pages.photos.count, 150, "on to the last")
        XCTAssertNil(pages.next)
        XCTAssertEqual(home.asked.last, "c120")
    }

    func testRetryAsksAgainAFailedRefreshOfTheTopWithItsTag() async throws {
        let home = PagedHome(total: 70)
        let pages = home.pages()
        await pages.need(1_000)
        XCTAssertEqual(pages.photos.count, 70)
        XCTAssertNil(pages.next)

        home.failing = ["top"]
        await pages.read()
        XCTAssertNotNil(pages.failure, "the refresh failed")
        XCTAssertEqual(pages.photos.count, 70, "the photos read stay")
        await pages.retry(71)
        XCTAssertEqual(home.asked, [nil, "c60", nil, nil], "Try Again asks the refresh again")
        XCTAssertEqual(home.etags.last, "\"p-0\"", "with the tag it holds")
        XCTAssertNil(pages.failure)

        let more = PagedHome(total: 150)
        let paged = more.pages()
        await paged.read()
        more.failing = ["top"]
        await paged.read()
        await paged.retry(61)
        XCTAssertEqual(more.asked, [nil, nil, nil, "c60"], "the top first, then the page the count reaches")
        XCTAssertEqual(paged.photos.count, 120)
        XCTAssertNil(paged.failure)
    }


    func testASmallFaceInALargePhotoStartsOnTheWebsSquare() throws {
        let box = [2_000.0, 2_000, 2_100, 2_100]
        let photo = CGSize(width: 8_192, height: 6_144)
        XCTAssertEqual(PeopleDetails.around(box, photo: photo, picture: photo), .init(x: 1_925, y: 1_925, side: 250))
        let square = try XCTUnwrap(PeopleDetails.around(box, photo: photo, picture: CGSize(width: 4_096, height: 3_072)))
        XCTAssertEqual(square.side * 2, 250, "250 of the photo's pixels")
        XCTAssertEqual(Double(square.x) + Double(square.side) / 2, 1_025, accuracy: 0.5, "centred on the face")
        XCTAssertEqual(Double(square.y) + Double(square.side) / 2, 1_025, accuracy: 0.5)
    }

    func testTheSquareIsRoundedAsTheWebsAndHeldInsideThePicture() {
        let picture = CGSize(width: 1_000, height: 800)
        XCTAssertEqual(PeopleDetails.around([400, 300, 501, 401], photo: picture, picture: picture)?.side, 253,
                       "2.5 × 101 rounded, not floored")
        XCTAssertEqual(PeopleDetails.around([0, 0, 100, 100], photo: picture, picture: picture), .init(x: 0, y: 0, side: 250),
                       "held at the corner")
        XCTAssertEqual(PeopleDetails.around([900, 700, 1_000, 800], photo: picture, picture: picture), .init(x: 750, y: 550, side: 250))
        XCTAssertEqual(PeopleDetails.around([100, 100, 900, 700], photo: picture, picture: picture), .init(x: 100, y: 0, side: 800),
                       "never past the shorter side")
        XCTAssertNil(PeopleDetails.around([1, 2, 3], photo: picture, picture: picture))
    }


    func testAProfileSaysAndLinksAsTheWebsDoes() throws {
        func profile(_ network: String, _ value: String) throws -> PeopleDetails.Profile {
            try JSONDecoder().decode(PeopleDetails.Profile.self, from: JSONSerialization.data(withJSONObject: ["network": network, "value": value]))
        }
        let cases: [(PeopleDetails.Profile, words: String, title: String, href: String)] = [
            (try profile("instagram", "person.a"), "@person.a", "@person.a", "https://www.instagram.com/person.a/"),
            (try profile("x", "person_a"), "@person_a", "@person_a", "https://x.com/person_a"),
            (try profile("linkedin", "persön-ä-12"), "persön-ä-12", "persön-ä-12", "https://www.linkedin.com/in/pers%C3%B6n-%C3%A4-12/"),
            (try profile("facebook", "person.a"), "person.a", "person.a", "https://www.facebook.com/person.a"),
            (try profile("github", "person-a"), "person-a", "person-a", "https://github.com/person-a"),
            (try profile("site", "example.com/Person-A/Notes"), "example.com", "example.com/Person-A/Notes", "https://example.com/Person-A/Notes"),
            (try profile("site", "example.com"), "example.com", "example.com", "https://example.com"),
            (try profile("github", "a b/c?d#e!~*'()"), "a b/c?d#e!~*'()", "a b/c?d#e!~*'()", "https://github.com/a%20b%2Fc%3Fd%23e!~*'()"),
        ]
        for (profile, words, title, href) in cases {
            XCTAssertEqual(PeopleDetails.profileWords(profile), words, profile.network)
            XCTAssertEqual(PeopleDetails.profileWords(profile, path: true), title, profile.network)
            XCTAssertEqual(PeopleDetails.profileHref(profile), href, profile.network)
            XCTAssertEqual(URL(string: PeopleDetails.profileHref(profile))?.absoluteString, href, "a link, as written")
        }
        XCTAssertEqual(PeopleDetails.networkName("site"), "Site")
        XCTAssertEqual(PeopleDetails.networkName("linkedin"), "LinkedIn")
    }
}

private struct Refused: Error {}

@MainActor
private final class PagedHome {
    let total: Int
    var asked: [String?] = []
    var etags: [String?] = []
    var holding = false
    var failing: Set<String> = []
    var heard: (String?) -> Void = { _ in }
    private var held: [CheckedContinuation<Void, Never>] = []

    init(total: Int) {
        self.total = total
    }

    func pages() -> PhotoPages<Refused> {
        PhotoPages(read: { after, etag in try await self.answer(after, etag) }, failed: { _ in Refused() })
    }

    func release() {
        holding = false
        held.forEach { $0.resume() }
        held = []
    }

    private func answer(_ after: String?, _ etag: String?) async throws -> HomeLink.Tagged<HomeLink.People.Photos>? {
        asked.append(after)
        etags.append(etag)
        heard(after)
        if holding { await withCheckedContinuation { held.append($0) } }
        if failing.remove(after ?? "top") != nil { throw Refused() }
        let first = after.flatMap { Int($0.dropFirst()) } ?? 0
        if after == nil, etag == "\"p-0\"" { return nil }
        let last = min(total, first + 60)
        let photos: [[String: Any]] = (first..<last).map { at in
            let hex = String(format: "%064lx", at)
            return ["image": hex, "face": "\(hex):10,10,90,90", "box": [10, 10, 90, 90], "at_ms": 1_792_041_000_000 - at]
        }
        var page: [String: Any] = ["photos": photos, "total": total]
        if last < total { page["next"] = "c\(last)" }
        let value = try JSONDecoder().decode(HomeLink.People.Photos.self, from: JSONSerialization.data(withJSONObject: page))
        return HomeLink.Tagged(value: value, etag: "\"p-\(first)\"")
    }
}
