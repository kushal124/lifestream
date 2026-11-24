import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class PlacesBookTests: XCTestCase {
    private static let name = "https://lifestream.example.ts.net"
    private static let start = Date(timeIntervalSince1970: 1_791_000_000)
    private static let gym = PlaceCoordinate(latitude: 37.3187, longitude: -122.0090)

    private var root: URL!
    private var clock: TestClock!
    private var home: FakeHome!
    private var link: HomeLink!
    private let credentials = MemoryCredentials()

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-places-\(UUID().uuidString)")
        clock = TestClock(Self.start)
        let clock = self.clock!
        home = FakeHome(clock: { clock.now })
        link = HomeLink(device: .init(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil), credentials: credentials,
                        folder: root.appendingPathComponent("exports"), transport: home, clock: { clock.now })
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func book(ahead: TimeInterval = 0) -> PlacesBook {
        let clock = self.clock!
        return PlacesBook(folder: root.appendingPathComponent("places"), link: link, clock: { clock.now.addingTimeInterval(ahead) })
    }

    private func kept() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("places").path).filter { !$0.hasPrefix(".") }.sorted()
    }

    private static func circle(_ centre: PlaceCoordinate = gym, radius: Double = 80) -> HomeLink.Place.Circle {
        HomeLink.Place.Circle(latitude: centre.latitude, longitude: centre.longitude, radiusM: radius)
    }

    private struct Unanswered: Error {
        let acted: HomeLink.Acted
    }

    private static func slug(_ acted: HomeLink.Acted) throws -> String {
        guard case .answered(let answer) = acted, let id = answer.id, let colon = id.firstIndex(of: ":") else { throw Unanswered(acted: acted) }
        return String(id[id.index(after: colon)...])
    }


    func testAnEmptyFolderAndTheHomeAnswerTheWholeListAndTheCopyServesOffline() async throws {
        home.name("synthetic-home", "Synthetic Home", latitude: 37.30, longitude: -122.03, radius: 150, ids: ["google:abc"])
        home.name("synthetic-gym", "Synthetic Gym", latitude: Self.gym.latitude, longitude: Self.gym.longitude, radius: 60)
        home.stayFigures = ["synthetic-gym": ["stays": 12, "days": 9, "hours": 36.5, "longest_day_hours": 2.5,
                                         "first_ms": 1_780_000_000_000, "last_ms": 1_790_000_000_000]]
        home.spots = [["latitude": 37.3215, "longitude": -122.0126, "stays": 3, "days": 3, "hours": 4.75, "longest_day_hours": 1.5,
                       "first_ms": 1_785_000_000_000, "last_ms": 1_790_500_000_000, "worth": true,
                       "key": "spot:37.3215,-122.0126", "witnessed": "You were here on 3 days in 2026.",
                       "last": "Last time Tue 20 Oct 2026 from 14:10 to 15:30",
                       "photos": [["image": String(repeating: "ab", count: 32), "at_ms": 1_790_499_000_000]], "photos_count": 1]]
        let fresh = book()
        let empty = await fresh.snapshot
        XCTAssertEqual(empty, .empty, "no copy and no home: the list is empty")

        await fresh.refresh()
        let snapshot = await fresh.snapshot
        XCTAssertEqual(snapshot.places.map(\.id), ["synthetic-gym", "synthetic-home"], "by name, as the home sends them")
        let gym = try XCTUnwrap(snapshot.places.first)
        XCTAssertEqual(gym.name, "Synthetic Gym")
        XCTAssertEqual(gym.radiusMeters, 60)
        XCTAssertEqual(gym.stays, 12)
        XCTAssertEqual(gym.hours, 36.5)
        XCTAssertEqual(gym.last, Date(timeIntervalSince1970: 1_790_000_000))
        XCTAssertEqual(snapshot.places.last?.ids, ["google:abc"])
        XCTAssertEqual(snapshot.spots.count, 1)
        XCTAssertEqual(snapshot.spots.first?.worth, true)
        let spot = try XCTUnwrap(snapshot.spots.first)
        XCTAssertEqual(spot.key, "spot:37.3215,-122.0126", "the key as the home spelt it, which naming echoes")
        XCTAssertEqual(spot.witnessed, "You were here on 3 days in 2026.", "the home's words of what witnessed it")
        XCTAssertEqual(spot.last, "Last time Tue 20 Oct 2026 from 14:10 to 15:30", "and of its last time, as they are")
        XCTAssertEqual(spot.photos.map(\.blob), ["sha256:" + String(repeating: "ab", count: 32)], "its photos, read by their blob")
        XCTAssertEqual(spot.photosCount, 1)
        XCTAssertEqual(gym.also, [], "a place of one circle")

        await fresh.refresh()
        XCTAssertEqual(home.placesReads.asked, 2)
        XCTAssertEqual(home.placesReads.unchanged, 1, "the second ask carried the ETag")
        let unchanged = await fresh.snapshot
        XCTAssertEqual(unchanged, snapshot)

        home.silence()
        let offline = book()
        await offline.refresh()
        let copied = await offline.snapshot
        XCTAssertEqual(copied, snapshot)
    }

    func testTheCopyStaysOutOfBackupsAndOneUnreadableAtAWakeIsReadAgainAtTheNextUse() async throws {
        home.name("synthetic-gym", "Synthetic Gym", latitude: Self.gym.latitude, longitude: Self.gym.longitude, radius: 60)
        await book().refresh()
        let folder = root.appendingPathComponent("places", isDirectory: true)
        XCTAssertEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)

        let copy = folder.appendingPathComponent("places.json").path
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: copy)
        let woken = book()
        let locked = await woken.snapshot
        XCTAssertEqual(locked.places, [], "no copy can be read")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: copy)
        let unlocked = await woken.snapshot
        XCTAssertEqual(unlocked.places.map(\.id), ["synthetic-gym"], "read again once it opens, the empty one not kept")
    }

    func testASpotsWhyTheHomeAsksIsRead() async throws {
        home.spots = [["latitude": 37.3412, "longitude": -122.0215, "worth": true, "ask_home": "You’ve slept here 3 nights, since Monday."]]
        let places = book()
        await places.refresh()
        let read = await places.snapshot
        XCTAssertEqual(read.spots.first?.askHome, "You’ve slept here 3 nights, since Monday.", "a spot's why-line")
    }

    func testTodaysHoursFollowTheHomesDayWhateverThePhonesZone() async throws {
        home.name("synthetic-gym", "Synthetic Gym", latitude: Self.gym.latitude, longitude: Self.gym.longitude, radius: 80)
        home.stayFigures = ["synthetic-gym": ["stays": 4, "days": 3, "hours": 6.5, "today_hours": 1.5]]
        let until = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-03T14:00:00Z"))
        home.today = ("2026-10-03", until)
        let places = book()
        await places.refresh()
        let snapshot = await places.snapshot
        let gym = try XCTUnwrap(snapshot.places.first)
        XCTAssertEqual(snapshot.dayUntil, until)
        let before = until.addingTimeInterval(-3_600)
        let phone = HomeClock.placeholder(at: before, zone: try XCTUnwrap(TimeZone(secondsFromGMT: -10 * 3_600)))
        XCTAssertEqual(phone.dayAt(before).day, "2026-10-02")
        XCTAssertEqual(snapshot.hoursToday(gym, now: before), 1.5, "the home's day, whatever the phone's")
        XCTAssertEqual(snapshot.hoursToday(gym, now: until), 0, "a copy of a day that has ended says none")
        XCTAssertEqual(PlacesSnapshot(places: [gym], spots: []).hoursToday(gym, now: before), 0)
    }


    func testASaveIsAnActWhoseNextReadDrawsTheHomesAnswerAndThePhoneKeepsNoEdit() async throws {
        let places = book()
        await places.refresh()
        let made = await places.act(.create(name: "Synthetic Gym", Self.circle(), ids: ["google:gym"]))
        let slug = try Self.slug(made)
        XCTAssertTrue(slug.hasPrefix("synthetic-gym-"), "the home mints the slug: \(slug)")
        let action = try XCTUnwrap(home.ownerActs.last)
        XCTAssertEqual(action["of"] as? String, "places")
        XCTAssertEqual(action["kind"] as? String, "create")
        XCTAssertNil(action["slug"], "the phone mints nothing")
        let drawn = await places.snapshot
        let gym = try XCTUnwrap(drawn.places.first { $0.id == slug }, "the next read draws it, from the home")
        XCTAssertEqual(gym.name, "Synthetic Gym")
        XCTAssertEqual(gym.ids, ["google:gym"])
        XCTAssertTrue(gym.counting, "its visits are counted after: the page draws the skeleton there")
        XCTAssertEqual([gym.stays, gym.days], [0, 0])

        home.derive()
        await places.refresh()
        let counted = await places.snapshot
        XCTAssertEqual(counted.places.first { $0.id == slug }?.counting, false, "the home's run has counted it")

        let renamed = await places.act(.edit(slug: slug, HomeLink.PlaceFields(name: .init(was: "Synthetic Gym", to: "Synthetic Gym North"))))
        XCTAssertNil(renamed.said, "answered: \(renamed)")
        XCTAssertEqual(Set(try XCTUnwrap(home.ownerActs.last).keys), ["of", "kind", "request", "slug", "name", "was"],
                       "only the field it changes, with what it was")
        let after = await places.snapshot
        XCTAssertEqual(after.places.first { $0.id == slug }?.name, "Synthetic Gym North", "the next read, from the home's head")
        XCTAssertEqual(after.places.first { $0.id == slug }?.ids, ["google:gym"], "what the edit leaves out stands")

        _ = await places.act(.remove(slug: slug))
        let removed = await places.snapshot
        XCTAssertNil(removed.places.first { $0.id == slug })
        XCTAssertEqual(try kept(), ["places.json"], "the phone keeps the home's copy and nothing else")
    }


    func testANewHomeIsOneCreateCarryingHome() async throws {
        let places = book()
        await places.refresh()
        let before = home.ownerActs.count
        let made = await places.act(.create(name: "Synthetic Cottage", Self.circle(), ids: [], home: true))
        let slug = try Self.slug(made)
        XCTAssertEqual(home.ownerActs.count, before + 1, "one act, never a create then an edit")
        let action = try XCTUnwrap(home.ownerActs.last)
        XCTAssertEqual(action["kind"] as? String, "create")
        XCTAssertEqual(action["home"] as? Bool, true)
        let drawn = await places.snapshot
        XCTAssertEqual(drawn.places.first { $0.id == slug }?.home, true, "the next read draws it as home")
    }

    @MainActor
    func testAnUnreachableHomeReadsNotSentKeepsNothingAndTryAgainSendsTheSameRequest() async throws {
        let places = book()
        await places.refresh()
        let change = HomeLink.PlaceAct.create(name: "Corner Cafe", Self.circle(), ids: [])
        let save = PlaceAttempt()
        home.silence()
        let unsent = await save.act(change, on: places)
        XCTAssertEqual(unsent, .unanswered(.notSent), "Not sent · Try again")
        let shown = await places.snapshot
        XCTAssertEqual(shown.places, [], "nothing drawn the home has not answered")
        XCTAssertEqual(try kept(), ["places.json"], "and nothing kept to send later")
        home.speak()
        let quiet = await places.snapshot
        XCTAssertEqual(quiet.places, [], "nothing appears by itself")

        home.loseAnswers(2)
        let lost = await save.act(change, on: places)
        guard case .unanswered = lost else { return XCTFail("both answers lost: \(lost)") }
        let again = await save.act(change, on: places)
        _ = try Self.slug(again)
        let requests = home.ownerActs.compactMap { $0["request"] as? String }
        XCTAssertEqual(requests.count, 3, "two sends lost, then Try again")
        XCTAssertEqual(Set(requests).count, 1, "one request, made at the first Save, sent unchanged on every retry")
        let drawn = await places.snapshot
        XCTAssertEqual(drawn.places.map(\.name), ["Corner Cafe"], "one place, however many sends")

        _ = await save.act(change, on: places)
        XCTAssertEqual(Set(home.ownerActs.compactMap { $0["request"] as? String }).count, 2, "answered: the same change again is a new save")
    }

    @MainActor
    func testARequestBelongsToItsSaveAndALaterSaveOfTheSameChangeIsANewOne() async throws {
        let centre = PlaceCoordinate(latitude: 37.3215, longitude: -122.0126)
        home.spots = [["latitude": centre.latitude, "longitude": centre.longitude, "stays": 3, "days": 3, "hours": 4.75, "worth": true]]
        let places = book()
        await places.refresh()
        let hide = HomeLink.PlaceAct.hide(latitude: centre.latitude, longitude: centre.longitude)

        home.loseAnswers(2)
        let lost = await PlaceAttempt().act(hide, on: places)
        guard case .unanswered = lost else { return XCTFail("the answer was lost: \(lost)") }
        await places.refresh()
        let after = await places.snapshot
        let landed = try XCTUnwrap(after.hidden.first, "it landed at the home all the same")

        let back = await PlaceAttempt().act(.unhide(key: landed.id), on: places)
        XCTAssertNil(back.said, "answered: \(back)")
        let again = await PlaceAttempt().act(hide, on: places)
        XCTAssertNil(again.said, "answered: \(again)")
        let hidden = await places.snapshot
        XCTAssertEqual(hidden.spots, [], "the second hide is its own save, stated again, never the first one's kept answer")
        XCTAssertEqual(hidden.hidden.count, 1)
        XCTAssertEqual(Set(home.ownerActs.compactMap { $0["request"] as? String }).count, 3, "one request a save")
    }

    func testASaveCutByATripToTheBackgroundReadsUnknownNeverNotSent() async throws {
        let places = book()
        await places.refresh()
        home.cutNextAct()
        let cut = await places.act(.create(name: "Corner Cafe", Self.circle(), ids: []))
        XCTAssertEqual(cut, .unanswered(.unknown(ReachWords.unknown)), "the body may have left: unknown, and Try again resends it")
    }

    func testAnEditFromAStaleReadIsRefusedChangedTheBookReadsAgainAndAnotherFieldStillMerges() async throws {
        home.name("harbour-home", "Harbour", latitude: Self.gym.latitude, longitude: Self.gym.longitude, radius: 120)
        let places = book()
        await places.refresh()
        let listed = await places.snapshot
        let read = try XCTUnwrap(listed.places.first)
        home.name("harbour-home", "Harbour House", latitude: Self.gym.latitude, longitude: Self.gym.longitude, radius: 120)

        let stale = await places.act(.edit(slug: read.id, HomeLink.PlaceFields(name: .init(was: read.name, to: "Harbour Cottage"))))
        guard case .refused(let refusal) = stale else { return XCTFail("a stale name is refused: \(stale)") }
        XCTAssertEqual(refusal.code, PlacesBook.changed)
        let standing = await places.snapshot
        XCTAssertEqual(standing.places.first?.name, "Harbour House", "the book read the place again: the other edit stands")

        let circle = Self.circle(radius: 60)
        let grown = await places.act(.edit(slug: read.id, HomeLink.PlaceFields(also: .init(was: [], to: [circle]))))
        XCTAssertNil(grown.said, "a field nobody else changed lands: \(grown)")
        let merged = await places.snapshot
        XCTAssertEqual(merged.places.first?.name, "Harbour House", "the other device's name and this one's circle, both")
        XCTAssertEqual(merged.places.first?.also, [PlaceCircle(centre: Self.gym, radiusMeters: 60)])
    }


    @MainActor
    func testARefusalIsTheHomesWordsAndLetsTheRequestGo() async throws {
        let places = book()
        await places.refresh()
        let change = HomeLink.PlaceAct.edit(slug: "gone-place-0a0b0c", HomeLink.PlaceFields(name: .init(was: "Gone", to: "Anything")))
        let save = PlaceAttempt()
        let refused = await save.act(change, on: places)
        XCTAssertEqual(refused, .refused(HomeLink.Refusal(code: "PLACE_UNKNOWN", words: "There is no such place.")))
        _ = await save.act(change, on: places)
        XCTAssertEqual(Set(home.ownerActs.compactMap { $0["request"] as? String }).count, 2, "a refused save holds no request")

        home.refuse(name: "Refused Name")
        let named = await places.act(.create(name: "Refused Name", Self.circle(), ids: []))
        XCTAssertEqual(named.said, .refused("line 1 is refused"), "the door's words")
        let drawn = await places.snapshot
        XCTAssertEqual(drawn.places, [])
    }


    func testAHiddenSpotLeavesTheSpotsOnTheNextReadAndUnhideBringsItBack() async throws {
        let centre = PlaceCoordinate(latitude: 37.3215, longitude: -122.0126)
        home.spots = [["latitude": centre.latitude, "longitude": centre.longitude, "stays": 3, "days": 3, "hours": 4.75, "worth": true]]
        let places = book()
        await places.refresh()
        let before = await places.snapshot
        XCTAssertEqual(before.spots.count, 1)

        let hid = await places.act(.hide(latitude: centre.latitude, longitude: centre.longitude))
        let key = try Self.slug(hid)
        XCTAssertEqual(try XCTUnwrap(home.ownerActs.last)["kind"] as? String, "hide")
        let hidden = await places.snapshot
        XCTAssertEqual(hidden.spots, [], "the home's read leaves it out")
        XCTAssertEqual(hidden.hidden.map(\.id), [key])
        XCTAssertEqual(hidden.hidden.first?.counting, true, "its days are counted after")

        _ = await places.act(.unhide(key: key))
        let back = await places.snapshot
        XCTAssertEqual(back.hidden, [])
        XCTAssertEqual(back.spots.count, 1, "back on the next read")
    }


    func testANamedSpotLeavesTheSpotsAndTwoSpotsInOneCellAreTwoRows() async throws {
        let spot = { (latitude: Double) -> [String: Any] in
            ["latitude": latitude, "longitude": Self.gym.longitude, "stays": 4, "days": 4, "hours": 5, "longest_day_hours": 1.5,
             "first_ms": 1_785_000_000_000, "last_ms": 1_790_000_000_000, "worth": true, "suggestions": []]
        }
        home.spots = [spot(37.3187), spot(37.3190)]
        let places = book()
        await places.refresh()
        let snapshot = await places.snapshot
        XCTAssertEqual(snapshot.spots.map(\.centre.cell), ["37.319,-122.009", "37.319,-122.009"])
        XCTAssertEqual(Set(snapshot.spots.map(\.id)).count, 2, "one row each")

        _ = await places.act(.create(name: "Synthetic Gym", Self.circle(radius: 150), ids: []))
        let named = await places.snapshot
        XCTAssertEqual(named.spots, [], "the spots inside its circle leave on the first read")
        XCTAssertEqual(named.places.first?.counting, true)
    }


    func testAPlaceOfSeveralCirclesHoldsHereAndAnEditCarriesOnlyWhatItChanges() async throws {
        let south = PlaceCoordinate(latitude: Self.gym.latitude - 2_000.0 / 111_195, longitude: Self.gym.longitude)
        home.name("harbour-home", "Harbour Home", latitude: south.latitude, longitude: south.longitude, radius: 120,
                  also: [(Self.gym.latitude, Self.gym.longitude, 60)], ids: ["google:harbour"])
        home.name("a-big", "Big", latitude: Self.gym.latitude, longitude: Self.gym.longitude, radius: 500)
        let places = book()
        await places.refresh()
        let listed = await places.snapshot
        let harbour = try XCTUnwrap(listed.places.first { $0.id == "harbour-home" })
        XCTAssertEqual(harbour.also, [PlaceCircle(centre: Self.gym, radiusMeters: 60)], "the list's other circle")
        XCTAssertEqual(harbour.centre, south, "the first circle where it is")
        XCTAssertEqual(listed.placeOf(Self.gym)?.id, "harbour-home", "the smallest holding circle, though it is not the first")
        XCTAssertEqual(listed.placeOf(south)?.id, "harbour-home")
        XCTAssertEqual(harbour.distance(to: Self.gym), 0, "measured to the nearest circle")
        let fixes = [0.0, 10, 21].map { PlaceFix(at: Self.start.addingTimeInterval($0 * 60), centre: Self.gym, horizontalAccuracyMeters: 10) }
        let here = await places.snapshot.here(fixes: fixes, now: Self.start.addingTimeInterval(21 * 60))
        XCTAssertEqual(here?.place?.id, "harbour-home", "here, inside the other circle")

        _ = await places.act(.edit(slug: harbour.id, HomeLink.PlaceFields(name: .init(was: harbour.name, to: "Harbour House"))))
        XCTAssertEqual(Set(try XCTUnwrap(home.ownerActs.last).keys), ["of", "kind", "request", "slug", "name", "was"], "the name alone")
        let shown = await places.snapshot
        XCTAssertEqual(shown.places.first { $0.id == "harbour-home" }?.name, "Harbour House")
        XCTAssertEqual(shown.places.first { $0.id == "harbour-home" }?.also, harbour.also, "the circles the edit left out stand")

        _ = await places.act(.addCircle(slug: "a-big", Self.circle(south, radius: 40)))
        let grown = await places.snapshot
        XCTAssertEqual(grown.places.first { $0.id == "a-big" }?.also, [PlaceCircle(centre: south, radiusMeters: 40)], "one circle added")
        _ = await places.act(.edit(slug: "a-big", HomeLink.PlaceFields(also: .init(was: [Self.circle(south, radius: 40)], to: []))))
        XCTAssertEqual((try XCTUnwrap(home.ownerActs.last)["also"] as? [Any])?.count, 0, "no other circle: an empty `also`")
        let shrunk = await places.snapshot
        XCTAssertEqual(shrunk.places.first { $0.id == "a-big" }?.also, [])
        XCTAssertNil(PlaceContent(name: "Twenty", centre: Self.gym, radiusMeters: 80,
                                  also: Array(repeating: PlaceCircle(centre: Self.gym, radiusMeters: 60), count: 20)),
                     "twenty other circles the guard refuses")
    }


    func testHereIsTheTwentyMinuteDwellAndTheSmallestCircleHoldingIt() async throws {
        home.name("b-big", "Big", latitude: Self.gym.latitude, longitude: Self.gym.longitude, radius: 500)
        home.name("c-small", "Small", latitude: Self.gym.latitude, longitude: Self.gym.longitude, radius: 50)
        home.spots = [["latitude": Self.gym.latitude + 5_000.0 / 111_195 + 0.0003, "longitude": Self.gym.longitude, "stays": 4,
                       "days": 4, "hours": 5, "longest_day_hours": 1.5, "first_ms": 1_785_000_000_000, "last_ms": 1_790_000_000_000,
                       "worth": true, "suggestions": []]]
        let places = book()
        await places.refresh()
        func fix(_ minutes: Double, north: Double = 0, accuracy: Double = 10) -> PlaceFix {
            PlaceFix(at: Self.start.addingTimeInterval(minutes * 60),
                     centre: PlaceCoordinate(latitude: Self.gym.latitude + north / 111_195, longitude: Self.gym.longitude),
                     horizontalAccuracyMeters: accuracy)
        }
        let nineteen = await places.snapshot.here(fixes: [fix(0), fix(19)], now: Self.start.addingTimeInterval(19 * 60))
        XCTAssertNil(nineteen, "nineteen minutes is not a stay")
        let fixes = [fix(-200, north: 3_000), fix(-30, north: 900), fix(0), fix(10), fix(21)]
        let dwelling = await places.snapshot.here(fixes: fixes, now: Self.start.addingTimeInterval(21 * 60))
        let here = try XCTUnwrap(dwelling)
        XCTAssertEqual(here.since, Self.start, "the dwell starts where the phone came to the spot")
        XCTAssertEqual(here.place?.id, "c-small", "the smallest circle holding it")
        XCTAssertNil(here.spot, "no spot where a place is")
        let boundary = await places.snapshot.here(fixes: fixes, now: Self.start.addingTimeInterval(31 * 60))
        XCTAssertNotNil(boundary, "the newest fix ten minutes old still says here")
        let stale = await places.snapshot.here(fixes: fixes, now: Self.start.addingTimeInterval(31 * 60 + 1))
        XCTAssertNil(stale)
        let coarse = await places.snapshot.here(fixes: [fix(0), fix(21, accuracy: 150)], now: Self.start.addingTimeInterval(21 * 60))
        XCTAssertNil(coarse, "a fix past the 100 m accuracy ceiling is not read")

        let elsewhere = await places.snapshot.here(fixes: [fix(0, north: 5_000), fix(25, north: 5_010)],
                                                   now: Self.start.addingTimeInterval(25 * 60))
        let away = try XCTUnwrap(elsewhere)
        XCTAssertNil(away.place)
        XCTAssertEqual(away.spot?.stays, 4, "the home's spot within 80 m: been here four times")
    }

    func testThePhonesPlaceOfIsTheHomesRadiusOnlySmallestNearestLowest() throws {
        func place(_ id: String, _ north: Double, radius: Double) -> PlacesSnapshot.Place {
            PlacesSnapshot.Place(id: id, name: id, centre: PlaceCoordinate(latitude: Self.gym.latitude + north / 111_195,
                                                                          longitude: Self.gym.longitude),
                                 radiusMeters: radius)
        }
        let point = Self.gym
        let edge = PlacesSnapshot(places: [place("a-ring", 100, radius: 99)], spots: [])
        XCTAssertNil(edge.placeOf(point), "a metre past the circle is outside: no tolerance")
        XCTAssertEqual(PlacesSnapshot(places: [place("a-ring", 100, radius: 100.5)], spots: []).placeOf(point)?.id, "a-ring")
        let nested = PlacesSnapshot(places: [place("a-big", 0, radius: 500), place("z-small", 30, radius: 60)], spots: [])
        XCTAssertEqual(nested.placeOf(point)?.id, "z-small", "the smallest wins, whatever its id")
        let equal = PlacesSnapshot(places: [place("a-far", 40, radius: 60), place("z-near", 10, radius: 60)], spots: [])
        XCTAssertEqual(equal.placeOf(point)?.id, "z-near", "equal radii: the nearer centre")
        let same = PlacesSnapshot(places: [place("b-twin", 10, radius: 60), place("a-twin", 10, radius: 60)], spots: [])
        XCTAssertEqual(same.placeOf(point)?.id, "a-twin", "then the lower id")
    }

    func testHereReadsOnlyTheLastTwoHoursOfFixesByTheCapturedTimeIndex() async throws {
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        func draft(_ at: Date) -> CaptureDraft {
            CaptureDraft(kind: "fix", observedAt: CaptureTime.rfc3339(at), captured: WallAndMonotonicTime(wall: at),
                         payload: .object(["location": .object([
                            "timestamp_unix_seconds": .number(at.timeIntervalSince1970),
                            "latitude": .number(Self.gym.latitude), "longitude": .number(Self.gym.longitude),
                            "horizontal_accuracy": .number(10)])]))
        }
        let now = Self.start
        _ = try await store.appendBatch(domain: .location, drafts: (0..<500).map { draft(now.addingTimeInterval(-86_400 + Double($0))) })
        _ = try await store.appendBatch(domain: .location, drafts: [draft(now.addingTimeInterval(-25 * 60)), draft(now.addingTimeInterval(-60))])
        let fixes = try await store.placeFixes(since: now.addingTimeInterval(-2 * 3_600))
        XCTAssertEqual(fixes.map(\.at), [now.addingTimeInterval(-25 * 60), now.addingTimeInterval(-60)])
        let plan = try await store.snapshot { database in
            var steps: [String] = []
            try database.query("EXPLAIN QUERY PLAN " + CaptureStore.placeFixesQuery, .real(0)) { steps.append($0.text(3) ?? "") }
            return steps.joined(separator: "; ")
        }
        XCTAssertTrue(plan.contains("location_captured"), "searched by the captured-time index, never scanned: \(plan)")
    }

    func testAnAnswerNamingAPlacesSourceShipsNothing() async throws {
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        _ = try await store.append(domain: .location, draft: .init(kind: "lifecycle", observedAt: CaptureTime.rfc3339(Self.start),
                                                                  payload: .object(["event": .string("synthetic")])))

        let clock = self.clock!
        home = FakeHome(sources: FakeHome.sources + ["places:local:\(FakeHome.unit)"], clock: { clock.now })
        link = HomeLink(device: .init(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil), credentials: credentials,
                        folder: root.appendingPathComponent("exports"), transport: home, clock: { clock.now })
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        let answer = try await link.exchange()
        XCTAssertNotNil(answer.sources["places:local:\(FakeHome.unit)"])
        let custody = PhoneCustody(exporter: CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
        let pending = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles.first
        let sealed = try XCTUnwrap(pending)
        XCTAssertEqual(Array(sealed.seals.keys), ["location:local:\(FakeHome.unit)"], "no seal for a places source")
        XCTAssertNil(try StoredZIPWriter.readManifest(from: custody.file(sealed)).files["places.jsonl"])
    }
}

private extension PlacesBook {
    func act(_ change: HomeLink.PlaceAct) async -> HomeLink.Acted {
        await act(change, request: UUID().uuidString)
    }
}
