import DeviceFiles
import Foundation
import HomeLink
import Passwords
import Recorder
import Shipping
import UserNotifications
import XCTest
@testable import Lifestream

@MainActor final class ImportsHostTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("imports-host-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    private final class Seen {
        var told: [[MacImport]] = []
        var ships = 0
        var notices: [String] = []
        var marks = 0
        var report: HomeLink.StreamsReport?
        var took: Set<HomeLink.ImportDigest> = []
        var refused: Set<HomeLink.ImportDigest> = []
        var letGo: Set<HomeLink.ImportDigest> = []
        var reads = 0
        var delays = false
        var reached: XCTestExpectation?
        private var held: CheckedContinuation<Void, Never>?

        func read() async -> HomeLink.StreamsReport? {
            reads += 1
            if delays {
                await withCheckedContinuation { continuation in
                    held = continuation
                    reached?.fulfill()
                }
            }
            return report
        }

        func answer() {
            delays = false
            held?.resume()
            held = nil
        }
    }

    private func imports(_ seen: Seen, carried: URL? = nil, notify: (@MainActor (String, String) -> Void)? = nil) -> Imports {
        Imports(world: Imports.World(
            carried: carried ?? scratch.appendingPathComponent("carried", isDirectory: true), files: DeviceFiles(.plain), clock: { Date() },
            ship: { seen.ships += 1 }, report: { await seen.read() },
            notify: notify ?? { title, body in seen.notices.append("\(title) | \(body)") },
            homeFree: HomeFree(), tell: { seen.told.append($0) },
            looked: { asked in
                Dictionary(uniqueKeysWithValues: seen.took.intersection(asked).map { ($0, .admitted) }
                    + seen.refused.subtracting(seen.took).intersection(asked).map { ($0, .refused) }
                    + seen.letGo.subtracting(seen.took.union(seen.refused)).intersection(asked).map { ($0, .letGo) })
            }, mark: { seen.marks += 1 }))
    }

    private func sent(_ id: String, _ digest: Character) throws {
        try ledger.change { contents in
            var record = ImportLedger.Record(id: id, kind: "spotify", path: "/nowhere/\(id).zip", bytes: 9, modified: Date(), state: .sent)
            record.seal = 1
            record.pass = "pass-a"
            record.sha256 = String(repeating: digest, count: 64)
            contents.files.append(record)
        }
    }

    private static func digest(_ digest: Character) -> HomeLink.ImportDigest {
        HomeLink.ImportDigest(kind: "spotify", digest: String(repeating: digest, count: 64))
    }

    private var ledger: ImportLedger { .in(scratch.appendingPathComponent("carried", isDirectory: true), files: DeviceFiles(.plain)) }

    private func folder(_ name: String, _ members: [String]) throws -> URL {
        let root = scratch.appendingPathComponent(name, isDirectory: true)
        for member in members {
            let file = root.appendingPathComponent(member)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("synthetic".utf8).write(to: file)
        }
        return root
    }

    private static func report(coming: [[String: Any]] = [], held: [[String: Any]] = []) throws -> HomeLink.StreamsReport {
        var fixture = HomeReport.fixture
        let kinds = (fixture["imports"] as! [[String: Any]]).map { kind -> [String: Any] in
            kind["kind"] as? String == "spotify" ? kind.merging(["coming": coming, "held": held]) { $1 } : kind
        }
        fixture["imports"] = kinds
        return try JSONDecoder().decode(HomeLink.StreamsReport.self, from: JSONSerialization.data(withJSONObject: fixture))
    }

    private static func coming(_ id: String, _ state: String) -> [String: Any] {
        ["id": id, "name": "my_spotify_data.zip", "bytes": 9, "state": state, "words": "Already in", "line": "9 bytes", "acts": [Any]()]
    }

    private static func held(_ id: String, _ state: String, _ line: String, ask: Bool = false, reason: String? = nil,
                             notice: (String, String)? = nil) -> [String: Any] {
        ["id": id, "account": ask ? NSNull() : "person-a", "made_at": "2026-11-01T00:00:00.000Z", "name": "1 Nov 2026 · person-a",
         "health": ["state": state, "reason": reason ?? NSNull(), "words": "", "since_ms": NSNull(), "next_ms": NSNull(), "acts": [Any](), "detail": NSNull()],
         "line": line,
         "ask": ask ? ["words": "Whose Spotify is this?", "choices": ["person-a"], "other": true, "choose": "Choose", "another": "Another…"] as [String: Any] : NSNull(),
         "files": [Any](), "products": [Any](), "span": NSNull(), "open_day": NSNull(), "open": notice == nil ? NSNull() : "Open a day",
         "downloaded": notice == nil ? NSNull() : "You can delete the file you downloaded.",
         "notice": notice.map { ["title": $0.0, "body": $0.1] as [String: Any] } ?? NSNull()]
    }

    private func refusal(_ work: () async throws -> Void) async -> String? {
        do {
            try await work()
            return nil
        } catch {
            return (error as? HostRefusal)?.words ?? "not words: \(error)"
        }
    }

    func testAFileHandedOverIsCheckedAgainstItsKindThenToldAndSent() async throws {
        let seen = Seen()
        seen.report = try Self.report()
        let model = imports(seen)
        let spotify = try folder("my_spotify_data", ["Spotify Extended Streaming History/Streaming_History_Audio_2024.json"])
        let photos = try folder("photos", ["DCIM/IMG_0001.jpg"])
        try await model.handOver([spotify, photos], kind: "spotify")
        let files = try ledger.read().files
        XCTAssertEqual(files.map(\.state), [.waiting, .refused])
        XCTAssertEqual(files.map(\.why), [.turn, .notThisKind])
        XCTAssertEqual(seen.ships, 1, "checked, the upload lane runs once")
        XCTAssertEqual(seen.marks, 1, "the first hand-over marks the home's imports step")
        XCTAssertEqual(seen.told.first?.first?.files.map(\.state), [.checking, .checking], "recorded before the check, and told")
        XCTAssertEqual(seen.told.last, [MacImport(kind: "spotify", files: [
            MacImport.File(id: files[0].id, name: "my_spotify_data", bytes: files[0].bytes, state: .waiting, why: .turn),
            MacImport.File(id: files[1].id, name: "photos", bytes: files[1].bytes, state: .refused, why: .notThisKind),
        ])])

        let drive = try folder("takeout-drive", ["Takeout/Drive/notes.pdf"])
        try await model.handOver([drive], kind: "google-takeout")
        XCTAssertEqual(try ledger.read().files.last.map { [$0.state.rawValue, $0.why?.rawValue] }, ["refused", "nothing-read"])
        XCTAssertEqual(seen.ships, 2)
        XCTAssertEqual(seen.marks, 1, "once an app's life")
    }

    func testAFileHandedOverBeforeAnyReportIsCheckedOnceOneNamesItsKind() async throws {
        let seen = Seen()
        let model = imports(seen)
        let spotify = try folder("my_spotify_data", ["Spotify Extended Streaming History/Streaming_History_Audio_2024.json"])
        try await model.handOver([spotify], kind: "spotify")
        XCTAssertEqual(try ledger.read().files.map(\.state), [.checking], "no report: kept, never refused")
        XCTAssertEqual(seen.ships, 0)
        seen.report = try Self.report()
        await model.read().value
        XCTAssertEqual(try ledger.read().files.map(\.state), [.waiting])
        XCTAssertEqual(seen.ships, 1)
    }

    func testALedgerThatCannotBeWrittenRefusesTheDropInWords() async throws {
        let seen = Seen()
        let notAFolder = scratch.appendingPathComponent("carried")
        try Data().write(to: notAFolder)
        let model = imports(seen, carried: notAFolder)
        let spotify = try folder("my_spotify_data", ["Spotify Extended Streaming History/Streaming_History_Audio_2024.json"])
        let said = await refusal { try await model.handOver([spotify], kind: "spotify") }
        XCTAssertEqual(said, "Lifestream couldn't save its list of your files.")
        XCTAssertEqual(seen.ships, 0)

        let host = host(model)
        var told: [String] = []
        host.droppedOn = { told.append($0) }
        let drop = try XCTUnwrap(host.dropped(on: "import:spotify"))
        drop([spotify])
        XCTAssertEqual(told, ["spotify"])
        let dropped = await refusal { _ = try await host.perform(.import(.dropped(kind: "spotify"))) }
        XCTAssertEqual(dropped, "Lifestream couldn't save its list of your files.")
        XCTAssertEqual(host.drops["spotify"], [spotify], "the files are kept for Try again")
        XCTAssertEqual(seen.ships, 0)
        let more = try folder("my_spotify_data_2", ["Spotify Extended Streaming History/Streaming_History_Audio_2025.json"])
        drop([more])
        XCTAssertEqual(host.drops["spotify"], [spotify, more])
        XCTAssertEqual(told, ["spotify", "spotify"])

        try FileManager.default.removeItem(at: notAFolder)
        let again = await refusal { _ = try await host.perform(.import(.dropped(kind: "spotify"))) }
        XCTAssertNil(again)
        XCTAssertNil(host.drops["spotify"])
        XCTAssertEqual(try ledger.read().files.map(\.kind), ["spotify", "spotify"], "both drops' files are on the list")
        let none = await refusal { _ = try await host.perform(.import(.dropped(kind: "spotify"))) }
        XCTAssertEqual(none, "Drop the files on this window again.")
    }

    func testTheWindowsActsAndADropOnAnImportWindowAlone() async throws {
        let seen = Seen()
        seen.report = try Self.report()
        let model = imports(seen)
        let host = host(model)
        var panels: [Bool] = []
        let spotify = try folder("my_spotify_data", ["Spotify Extended Streaming History/Streaming_History_Audio_2024.json"])
        let photos = try folder("photos", ["DCIM/IMG_0001.jpg"])
        host.chooseImport = { several in panels.append(several); return [photos] }
        _ = try await host.perform(.import(.choose(kind: "spotify")))
        let refused = try XCTUnwrap(try ledger.read().files.first)
        XCTAssertEqual([refused.state], [.refused])

        let notMissing = await refusal { _ = try await host.perform(.import(.again(kind: "spotify", file: refused.id))) }
        XCTAssertEqual(notMissing, "That file is no longer missing.")
        XCTAssertEqual(panels, [true])
        try ledger.change { $0.files[0].state = .missing }
        host.chooseImport = { several in panels.append(several); return [spotify] }
        let otherKind = await refusal { _ = try await host.perform(.import(.again(kind: "google-takeout", file: refused.id))) }
        XCTAssertEqual(otherKind, "That file is no longer missing.", "a file is its kind's")
        _ = try await host.perform(.import(.again(kind: "spotify", file: refused.id)))
        XCTAssertEqual(panels, [true, false], "Choose again's panel takes one")
        XCTAssertEqual(try ledger.read().files.map { [$0.id, $0.path, $0.state.rawValue] }, [[refused.id, spotify.path, "waiting"]])

        let owed = await refusal { _ = try await host.perform(.import(.forget(kind: "spotify", file: refused.id))) }
        XCTAssertEqual(owed, "That file is on its way to Lifestream.")
        _ = try await host.perform(.import(.forget(kind: "spotify", file: "another-macs-file")))
        _ = try await host.perform(.import(.forget(kind: "google-takeout", file: refused.id)))
        XCTAssertEqual(try ledger.read().files.count, 1)
        try ledger.change { $0.files[0].state = .refused }
        _ = try await host.perform(.import(.forget(kind: "spotify", file: refused.id)))
        XCTAssertEqual(try ledger.read().files, [])

        XCTAssertNil(host.dropped(on: nil))
        XCTAssertNil(host.dropped(on: "stream:spotify"))
        XCTAssertNil(host.dropped(on: "import:"))
        XCTAssertNotNil(host.dropped(on: "import:spotify"))

        let none = await refusal { _ = try await self.host(nil).perform(.import(.choose(kind: "spotify"))) }
        XCTAssertEqual(none, "Lifestream on this Mac takes no files yet.")
    }

    func testAFileInAlreadyGoesAtLaunchAndASentOneOnceItsImportIsInNotifiedOnce() async throws {
        let seen = Seen()
        let model = imports(seen)
        try sent("file-a", "a")
        try sent("file-b", "b")
        seen.report = try Self.report(coming: [Self.coming("file-a", "sent"), Self.coming("file-b", "already")])
        await model.read().value
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent, .already])
        try ledger.launch()
        XCTAssertEqual(try ledger.read().files.map(\.id), ["file-a"])

        seen.report = try Self.report(held: [Self.held("import-1", "syncing", "Bringing in · Plays 12 so far")])
        await model.read().value
        seen.report = try Self.report(held: [Self.held("import-1", "needs-you", "Whose Spotify is this?", ask: true)])
        await model.read().value
        XCTAssertEqual(try ledger.read().files.map(\.id), ["file-a"])
        XCTAssertEqual(seen.notices, [])

        let notice = ("Your Spotify export is in", "2014–2026 · 48,112 plays")
        seen.report = try Self.report(held: [Self.held("import-1", "ok", "In · 2014–2026 · 48,112 plays", notice: notice)])
        await model.read().value
        XCTAssertEqual(try ledger.read().files.map(\.id), ["file-a"])
        XCTAssertEqual(seen.notices, ["Your Spotify export is in | 2014–2026 · 48,112 plays"], "in: notified, in the home's words")

        seen.took = [Self.digest("a")]
        await model.read().value
        XCTAssertEqual(try ledger.read().files, [])
        await model.read().value
        XCTAssertEqual(seen.notices, ["Your Spotify export is in | 2014–2026 · 48,112 plays"])
    }

    func testAnImportAskedWhichPhoneIsNotSettledAndIsNotifiedOnceIn() async throws {
        let seen = Seen()
        let model = imports(seen)
        try sent("file-a", "a")
        seen.took = [Self.digest("a")]
        seen.report = try Self.report(held: [Self.held("import-1", "needs-you", "Which iPhone is this backup from?", reason: "choose")])
        await model.read().value
        await model.read().value
        XCTAssertEqual(try ledger.read().files.map(\.id), ["file-a"], "the question held across reads: the file stays")
        XCTAssertEqual(seen.notices, [])

        let notice = ("Your Spotify export is in", "2014–2026 · 48,112 plays")
        seen.report = try Self.report(held: [Self.held("import-1", "ok", "In · 2014–2026 · 48,112 plays", notice: notice)])
        await model.read().value
        XCTAssertEqual(try ledger.read().files, [])
        XCTAssertEqual(seen.notices, ["Your Spotify export is in | 2014–2026 · 48,112 plays"], "answered and in: notified once")
        await model.read().value
        XCTAssertEqual(seen.notices.count, 1)
    }

    func testASentFileTheHomeRefusedWholeGoes() async throws {
        let seen = Seen()
        let model = imports(seen)
        try sent("file-a", "a")
        try sent("file-b", "b")
        seen.report = try Self.report(held: [Self.held("import-1", "broken", "Lifestream couldn't read this file")])
        await model.read().value
        XCTAssertEqual(try ledger.read().files.map(\.id), ["file-a", "file-b"], "looked at by none: both stay")
        seen.refused = [Self.digest("a")]
        await model.read().value
        XCTAssertEqual(try ledger.read().files.map(\.id), ["file-b"], "refused whole: gone; never looked at: stays")
        XCTAssertEqual(seen.told.last?.first?.files.map(\.id), ["file-b"], "the home is told")
        XCTAssertEqual(seen.notices, [])
    }

    func testASentFileLetGoAtTheHomeGoesAndTheSamePathDroppedAgainSendsAgain() async throws {
        let seen = Seen()
        seen.report = try Self.report(held: [Self.held("import-1", "ok", "Whose is this?", ask: true)])
        let model = imports(seen)
        let spotify = try folder("my_spotify_data", ["Spotify Extended Streaming History/Streaming_History_Audio_2024.json"])
        try await model.handOver([spotify], kind: "spotify")
        let first = try XCTUnwrap(try ledger.read().files.first)
        XCTAssertEqual(first.state, .waiting)
        try ledger.change { contents in
            contents.files[0].state = .sent
            contents.files[0].why = nil
            contents.files[0].seal = 1
            contents.files[0].pass = "pass-a"
            contents.files[0].sha256 = String(repeating: "a", count: 64)
        }
        await model.read().value
        XCTAssertEqual(try ledger.read().files.map(\.id), [first.id], "asked whose: it stays")
        try await model.handOver([spotify], kind: "spotify")
        XCTAssertEqual(try ledger.read().files.map { [$0.id, $0.state.rawValue] }, [[first.id, "sent"]])
        seen.letGo = [Self.digest("a")]
        seen.report = try Self.report()
        await model.read().value
        XCTAssertEqual(try ledger.read().files, [], "let go at the home: the Mac's record goes")
        XCTAssertEqual(seen.told.last?.first?.files ?? [], [], "the home is told")
        XCTAssertEqual(seen.notices, [])
        try await model.handOver([spotify], kind: "spotify")
        let again = try XCTUnwrap(try ledger.read().files.first)
        XCTAssertEqual(try ledger.read().files.count, 1)
        XCTAssertEqual([again.path, again.state.rawValue], [spotify.path, "waiting"])
        XCTAssertNotEqual(again.id, first.id)
    }

    func testAReadNeverWaitsOnTheNotificationItPosts() async throws {
        let seen = Seen()
        let prompt = Prompt()
        let model = imports(seen, notify: Imports.World.posting { request in
            seen.notices.append(request.content.title)
            await prompt.unanswered()
        })
        try sent("file-a", "a")
        seen.took = [Self.digest("a")]
        seen.report = try Self.report(held: [Self.held("import-1", "ok", "In", notice: ("Your Spotify export is in", "3 plays"))])
        await model.read().value
        XCTAssertEqual(try ledger.read().files, [], "the read ended and its record retired, the prompt unanswered")
        try sent("file-b", "b")
        seen.took.insert(Self.digest("b"))
        await model.read().value
        XCTAssertEqual(seen.reads, 2, "the next read is a read of its own")
        XCTAssertEqual(try ledger.read().files, [])
        prompt.answer()
    }

    func testAFileLetGoAtTheHomeIsTakenAgainAtOnceWhenChosenAgain() async throws {
        let seen = Seen()
        seen.report = try Self.report()
        let model = imports(seen)
        let spotify = try folder("my_spotify_data", ["Spotify Extended Streaming History/Streaming_History_Audio_2024.json"])
        try await model.handOver([spotify], kind: "spotify")
        let first = try XCTUnwrap(try ledger.read().files.first)
        try ledger.change { contents in
            contents.files[0].state = .sent
            contents.files[0].why = nil
            contents.files[0].seal = 1
            contents.files[0].pass = "pass-a"
            contents.files[0].sha256 = String(repeating: "a", count: 64)
        }
        seen.took = [Self.digest("a")]
        try await model.handOver([spotify], kind: "spotify")
        XCTAssertEqual(try ledger.read().files.map { [$0.id, $0.state.rawValue] }, [[first.id, "sent"]])
        seen.took = []
        seen.letGo = [Self.digest("a")]
        let reads = seen.reads, ships = seen.ships
        try await model.handOver([spotify], kind: "spotify")
        let again = try XCTUnwrap(try ledger.read().files.first)
        XCTAssertEqual(try ledger.read().files.count, 1)
        XCTAssertNotEqual(again.id, first.id)
        XCTAssertEqual([again.path, again.state.rawValue], [spotify.path, "waiting"])
        XCTAssertEqual(seen.reads, reads, "no report read: the home was asked of the record alone")
        XCTAssertEqual(seen.ships, ships + 1, "the upload lane sends it")
        XCTAssertEqual(seen.told.last?.first?.files.map(\.id), [again.id])
    }

    func testAnImportIsInByTheHomesNoticeAndItsWordsArePostedAsWritten() async throws {
        let seen = Seen()
        let model = imports(seen)
        try sent("file-a", "a")
        seen.report = try Self.report(held: [Self.held("import-1", "syncing", "Bringing in")])
        await model.read().value
        seen.report = try Self.report(held: [Self.held("import-1", "ok", "In · 2014–2026 · 48,112 plays")])
        await model.read().value
        XCTAssertEqual(seen.notices, [], "a line in the home's old words is no notice")
        seen.report = try Self.report(held: [Self.held("import-1", "ok", "Brought in", notice: ("Spotify is in your home", "48,112 plays"))])
        await model.read().value
        XCTAssertEqual(seen.notices, ["Spotify is in your home | 48,112 plays"])
    }

    func testAnOlderReportNeverLetsGoAFileSentWhileItWasRead() async throws {
        let seen = Seen()
        let model = imports(seen)
        try sent("file-a", "a")
        seen.took = [Self.digest("a")]
        seen.report = try Self.report(held: [Self.held("import-1", "ok", "In", notice: ("Your Spotify export is in", "3 plays"))])
        seen.delays = true
        let reached = expectation(description: "the report is asked")
        seen.reached = reached
        let first = model.read()
        await fulfillment(of: [reached], timeout: 30)
        try sent("file-b", "b")
        seen.took.insert(Self.digest("b"))
        let second = model.read()
        seen.answer()
        await first.value
        await second.value
        XCTAssertEqual(seen.reads, 1, "one read at a time")
        XCTAssertEqual(try ledger.read().files.map(\.id), ["file-a", "file-b"],
                       "file-b, sent after the home was asked what it took, is not taken: its kind's sent files stay")
        XCTAssertEqual(seen.notices, [])
        await model.read().value
        XCTAssertEqual(try ledger.read().files, [], "the next read asks of file-b too, and both go")
        XCTAssertEqual(seen.notices, ["Your Spotify export is in | 3 plays"])
    }

    func testTheFactsCarryEachFilesPassAndTheBytesSent() throws {
        let seen = Seen()
        let model = imports(seen)
        try ledger.change { contents in
            var sending = ImportLedger.Record(id: "file-a", kind: "spotify", path: "/nowhere/a.zip", bytes: 41_000_000, modified: Date(), state: .sending)
            sending.seal = 3
            sending.pass = "pass-a"
            var waiting = ImportLedger.Record(id: "file-b", kind: "spotify", path: "/nowhere/b.zip", bytes: 9, modified: Date(), state: .waiting, why: .turn)
            waiting.pass = "pass-a"
            contents.files = [sending, waiting]
        }
        model.moved("file-a", bytes: 12_000_000)
        model.moved("file-b", bytes: 5)
        let files = try XCTUnwrap(seen.told.last?.first?.files)
        XCTAssertEqual(files.map(\.pass), ["pass-a", nil], "a pass beside its seal alone")
        XCTAssertEqual(files.map(\.seal), [3, nil])
        XCTAssertEqual(files.map(\.sentBytes), [12_000_000, nil], "the bytes sent of the file sending alone")
        try ledger.change { $0.files[0].state = .sent }
        model.tell()
        XCTAssertEqual(seen.told.last?.first?.files.map(\.sentBytes), [nil, nil], "said no more once it is sent")
    }

    func testAnImportInWhileTheAppWasNotRunningIsNotifiedAtTheFirstRead() async throws {
        let seen = Seen()
        let model = imports(seen)
        try sent("file-a", "a")
        seen.took = [Self.digest("a")]
        seen.report = try Self.report(held: [
            Self.held("import-2", "needs-you", "In · 2014–2026 · 1 file couldn't be read",
                      notice: ("Your Spotify export is in", "2014–2026 · 1 file couldn't be read")),
            Self.held("import-1", "ok", "In · 2014–2026 · 48,112 plays", notice: ("Your Spotify export is in", "2014–2026 · 48,112 plays")),
        ])
        await model.read().value
        XCTAssertEqual(try ledger.read().files, [])
        XCTAssertEqual(seen.notices, ["Your Spotify export is in | 2014–2026 · 1 file couldn't be read"], "the newest, in with a refusal standing")
    }

    func testAnUploadCopiesTheFileChosenIntoTheDropFolder() async throws {
        let drop = scratch.appendingPathComponent("drop", isDirectory: true)
        let host = host(nil, drop: drop)
        let file = scratch.appendingPathComponent("health-export-synthetic.zip")
        try Data("synthetic".utf8).write(to: file)
        var panels: [FilePanel] = []
        host.choose = { panels.append($0); return nil }
        _ = try await host.perform(.upload(connector: "health"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: drop.path), "Cancel copies nothing")
        host.choose = { panels.append($0); return file }
        _ = try await host.perform(.upload(connector: "health"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: drop.path), ["health-export-synthetic.zip"])
        XCTAssertEqual(panels, Array(repeating: FilePanel(title: "Choose the file to send to Lifestream", folder: false), count: 2))
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "the person's file stays where it was")
    }

    @MainActor private final class Prompt {
        private var waiting: [CheckedContinuation<Void, Never>] = []

        func unanswered() async {
            await withCheckedContinuation { waiting.append($0) }
        }

        func answer() {
            waiting.forEach { $0.resume() }
            waiting = []
        }
    }

    private func host(_ imports: Imports?, drop: URL? = nil) -> MacHost {
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let needs = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        let lines = StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        return MacHost(needs: needs, lines: lines, socket: { nil }, readGrants: { [:] }, readFolder: { nil }, ask: .untouched,
                       imports: imports, drop: { drop ?? self.scratch.appendingPathComponent("drop", isDirectory: true) })
    }
}
