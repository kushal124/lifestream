import Foundation
import HomeLink
import XCTest
@testable import Lifestream
@testable import LifestreamCaptureCore

actor FakeContactSource: ContactSource {
    nonisolated let authorization: ContactsAuthorization
    var values: [ContactCard]
    var reads = 0
    var requests = 0
    var fails = false
    private var holds = false
    private var held: [CheckedContinuation<Void, Never>] = []
    private var begun: [CheckedContinuation<Void, Never>] = []

    init(cards: [ContactCard], authorization: ContactsAuthorization = .authorized) {
        values = cards
        self.authorization = authorization
    }
    nonisolated func authorizationStatus() -> ContactsAuthorization { authorization }
    func requestAuthorization() -> ContactsAuthorization { requests += 1; return authorization }
    func read() async throws -> ContactsRead {
        reads += 1
        begun.forEach { $0.resume() }
        begun = []
        if holds { await withCheckedContinuation { held.append($0) } }
        if fails { throw POSIXError(.EIO) }
        return ContactsRead(marks: Dictionary(values.map { ($0.id, $0.mark) }, uniquingKeysWith: { $1 }),
                            bytes: Dictionary(values.map { ($0.id, $0.bytes) }, uniquingKeysWith: { $1 }), authorization: authorization)
    }
    func cards(_ ids: [String]) -> [ContactCard] { values.filter { ids.contains($0.id) } }
    func hold() { holds = true }
    func readBegins() async {
        if reads > 0 { return }
        await withCheckedContinuation { begun.append($0) }
    }
    func release() {
        holds = false
        held.forEach { $0.resume() }
        held = []
    }
    func change(_ cards: [ContactCard]) { values = cards }
    func fail() { fails = true }
    func recover() { fails = false }
}

extension ContactCard {
    static func synthetic(_ id: String, _ name: String = "Synthetic Person", photo: Data? = nil) -> ContactCard {
        try! ContactCard(id: id, card: Data("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:\(name)\r\nEND:VCARD\r\n".utf8), photo: photo)
    }
}

@MainActor
final class ContactsTests: XCTestCase {
    private let card = ContactCard.synthetic("A")
    private let date = Date(timeIntervalSince1970: 1_800_000_000)

    private func fixture(authorization: ContactsAuthorization = .authorized) throws
        -> (CaptureStore, FakeContactSource, ContactsRecorder) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try CaptureStore(root: root)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let source = FakeContactSource(cards: [card], authorization: authorization)
        return (store, source, ContactsRecorder(store: store, source: source))
    }

    private func kinds(_ store: CaptureStore) async throws -> [String] {
        try await store.entries(domain: .contacts).map(\.kind)
    }

    func testNoAccessWritesOnlyOneAccessEntryAndNeverRequests() async throws {
        for authorization: ContactsAuthorization in [.notDetermined, .denied, .restricted] {
            let (store, source, recorder) = try fixture(authorization: authorization)
            await recorder.pass(at: date)
            await recorder.pass(at: date)
            let log = try await kinds(store)
            XCTAssertEqual(log, ["access"])
            let reads = await source.reads, requests = await source.requests
            XCTAssertEqual(reads, 0); XCTAssertEqual(requests, 0)
        }
    }

    func testGrantedAccessAndAnUnchangedBookWriteOnceAndTheSheetCountsCards() async throws {
        for authorization: ContactsAuthorization in [.authorized, .limited] {
            let (store, source, recorder) = try fixture(authorization: authorization)
            let photo = Data([0xFF, 0xD8, 0xFF, 1, 2, 3])
            await source.change([card, .synthetic("B", "Other Person", photo: photo)])
            await recorder.pass(at: date)
            await recorder.pass(manual: true, at: date)
            let log = try await kinds(store)
            XCTAssertEqual(log, ["access", "card", "card"])
            let status = await recorder.status()
            XCTAssertEqual(status.contacts, 2); XCTAssertEqual(status.photosKept, 1)
            XCTAssertEqual(status.photoBytesKept, UInt64(photo.count)); XCTAssertNil(status.error)
            XCTAssertEqual(status.lastRead, CaptureTime.rfc3339(date))
        }
    }

    func testCivilDayManualAndRelaunchRules() async throws {
        let (store, source, recorder) = try fixture()
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 3600)!
        let first = calendar.date(from: DateComponents(year: 2026, month: 9, day: 8, hour: 23, minute: 58))!
        await recorder.pass(at: first, calendar: calendar)
        await recorder.pass(at: first.addingTimeInterval(30), calendar: calendar)
        var reads = await source.reads; XCTAssertEqual(reads, 1)
        await recorder.pass(at: first.addingTimeInterval(120), calendar: calendar)
        reads = await source.reads; XCTAssertEqual(reads, 2, "a new civil day reads")
        let relaunched = ContactsRecorder(store: store, source: source)
        await relaunched.pass(at: first.addingTimeInterval(130), calendar: calendar)
        reads = await source.reads; XCTAssertEqual(reads, 2, "the day is kept with the table")
        await relaunched.pass(manual: true, at: first.addingTimeInterval(140), calendar: calendar)
        reads = await source.reads; XCTAssertEqual(reads, 3)
        let log = try await kinds(store); XCTAssertEqual(log, ["access", "card"])
    }

    func testFailedReadAppendsOnlyItsAccessAndIsSaid() async throws {
        let (store, source, recorder) = try fixture()
        await source.fail()
        let failed = await recorder.pass(at: date)
        XCTAssertEqual(failed, .failed(POSIXError(.EIO).localizedDescription), "the shipper is told")
        let log = try await kinds(store), status = await recorder.status()
        XCTAssertEqual(log, ["access"], "the access is said before the read; the read writes nothing")
        XCTAssertNotNil(status.error)
        await source.recover()
        let read = await recorder.pass(manual: true, at: date)
        XCTAssertEqual(read, .read)
        let after = await recorder.status()
        XCTAssertNil(after.error, "a pass that reads ends what failed")
    }

    func testAFullDiskIsNoReadFailure() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let free = Free(Room.bottomBytes - 1)
        let store = try CaptureStore(root: root, volume: Volume(root, every: 0, read: { _ in free.bytes }))
        let recorder = ContactsRecorder(store: store, source: FakeContactSource(cards: [card]))
        let full = await recorder.pass(at: date)
        XCTAssertNil(full, "the shipper is told nothing")
        let status = await recorder.status()
        XCTAssertNil(status.error, "the sheet says nothing")
        let none = try await kinds(store)
        XCTAssertEqual(none, [])
        free.bytes = Room.keepBytes
        let roomy = await recorder.pass(manual: true, at: date)
        XCTAssertEqual(roomy, .read)
        let written = try await kinds(store)
        XCTAssertEqual(written, ["access", "card"])
    }

    func testAllowReturnsBeforeTheReadAndAPassAfterWaitsForIt() async throws {
        let (store, source, recorder) = try fixture()
        await source.change([])
        await source.hold()
        await recorder.requestAuthorization()
        let requests = await source.requests
        XCTAssertEqual(requests, 1)
        await source.readBegins()
        let before = try await kinds(store), unread = await recorder.status()
        XCTAssertEqual(before, ["access"], "Allow returned while the address book's read was held: its access stated, no card")
        XCTAssertNil(unread.contacts, "the held read counts none yet")
        await source.release()
        await recorder.pass()
        let reads = await source.reads
        XCTAssertEqual(reads, 1, "the pass after waited for Allow's read")
        let log = try await kinds(store), status = await recorder.status()
        XCTAssertEqual(log, ["access"])
        XCTAssertEqual(status.contacts, 0, "an empty book read is none, not none yet")
    }

    func testConcurrentDailyPassesReadOnce() async throws {
        let (store, source, recorder) = try fixture()
        let passDate = date
        async let first: ReadOutcome? = recorder.pass(at: passDate)
        async let second: ReadOutcome? = recorder.pass(at: passDate)
        _ = await (first, second)
        let reads = await source.reads, log = try await kinds(store)
        XCTAssertEqual(reads, 1); XCTAssertEqual(log, ["access", "card"])
    }

    func testAppleSerializationIsOneExactCardWithNoPhotoAndTheSameTwice() async throws {
        let plain = try AppleContactSource.syntheticCard()
        XCTAssertTrue(plain.card.hasPrefix("BEGIN:VCARD\r\n"))
        XCTAssertTrue(plain.card.hasSuffix("END:VCARD\r\n"))
        XCTAssertEqual(plain.card.components(separatedBy: "BEGIN:VCARD").count - 1, 1)
        XCTAssertNil(plain.photo)
        let image = Data((0..<180).map { UInt8($0) })
        let withPhoto = try AppleContactSource.syntheticCard(image: image)
        XCTAssertEqual(withPhoto.photo, image, "the image's exact bytes")
        XCTAssertFalse(withPhoto.card.contains("PHOTO"), "the card carries no photo: the photo is its own blob")
        XCTAssertEqual(withPhoto.card, plain.card)
        let again = try AppleContactSource.syntheticCard(image: image)
        XCTAssertEqual(again.card, withPhoto.card, "an unchanged contact serializes to the same bytes")
        let lines = plain.card.components(separatedBy: "\r\n")
        XCTAssertFalse(lines.contains { $0.hasPrefix("REV") || $0.hasPrefix("UID") }, "no time or id of the serializer's own")
        XCTAssertEqual(lines.filter { $0.hasPrefix("PRODID:") }.count, 1, "the one line that names the system")
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/e2e/contacts-serializer.json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["card": plain.card, "with_photo": withPhoto.card, "photo_bytes": image.count],
                                   options: [.sortedKeys, .prettyPrinted]).write(to: file)
    }
}
