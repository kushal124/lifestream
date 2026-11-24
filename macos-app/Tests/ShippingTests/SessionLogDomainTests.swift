import CryptoKit
import DeviceFiles
import Evidence
import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class SessionLogDomainTests: XCTestCase {
    static let claudeSource = "claude-code:local:synthetic-mac-0001"
    static let codexSource = "codex:local:synthetic-mac-0001"
    static let session = "00000000-0000-4000-8000-0000000000a1"
    static let codexLog = "rollout-2026-10-01T10-00-00-00000000-0000-7000-8000-0000000000d1.jsonl"

    private var root: URL!
    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private var state: URL { root.appendingPathComponent("carried/state.json") }
    private var projects: URL { root.appendingPathComponent(".claude/projects", isDirectory: true) }
    private var codex: URL { root.appendingPathComponent(".codex", isDirectory: true) }

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("session-log-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }


    static func fixtures(_ provider: String) -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/connect/ai/\(provider)/test", isDirectory: true)
    }

    private func claude(budget: Int = SessionLogShipper.defaultBudget, at now: String = "2026-10-01T09:30:00.000Z") throws -> LogsEngine {
        let date = try DomainFixtures.instant(now)
        return try StoreFixtures.logs(Self.claudeSource, home: root, stateFile: state, ledgers: ledgers, budget: budget, clock: { date })
    }

    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }

    private func codexDomain(budget: Int = SessionLogShipper.defaultBudget, at now: String = "2026-10-01T11:00:00.000Z") throws -> LogsEngine {
        let date = try DomainFixtures.instant(now)
        return try StoreFixtures.logs(Self.codexSource, home: root, stateFile: state, ledgers: ledgers, budget: budget, clock: { date })
    }

    private func lay(_ from: URL, onto: URL, append: Bool = false) throws {
        let walk = try XCTUnwrap(FileManager.default.enumerator(atPath: from.path))
        while let relative = walk.nextObject() as? String {
            let source = from.appendingPathComponent(relative)
            guard FileFacts.isRegularFile(source.path) else { continue }
            let target = onto.appendingPathComponent(relative)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            let bytes = try Data(contentsOf: source)
            if append, let handle = try? FileHandle(forWritingTo: target) {
                try handle.seekToEnd()
                try handle.write(contentsOf: bytes)
                try handle.close()
            } else {
                try bytes.write(to: target)
            }
        }
    }

    private func parts(_ sealed: SealedBundle?) throws -> String {
        try XCTUnwrap(StoredZipReader(XCTUnwrap(sealed).file).text("parts.json"))
    }

    private func appendLine(_ text: String, to url: URL) throws {
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(text.utf8))
        try handle.close()
    }

    private func request(_ at: String, after: SealedBundle? = nil) throws -> SealRequest {
        try DomainFixtures.request(work: work, at: at,
                                   custody: SealCustody(pass: ShippingFixture.pass, received: after?.sidecar.seal ?? 0, imported: 0))
    }

    func testTheCheckedInBundlesAreWhatTheseLogsSeal() throws {
        for (provider, folder, target) in [("claude-code", "projects", projects), ("codex", "codex", codex)] {
            try? FileManager.default.removeItem(at: target)
            try? FileManager.default.removeItem(at: state)
            let fixtures = Self.fixtures(provider)
            try lay(fixtures.appendingPathComponent("logs/\(folder)"), onto: target)
            let seal: (SealRequest) throws -> SealedBundle? = provider == "codex"
                ? { try self.codexDomain().sealOne($0) } : { try self.claude().sealOne($0) }
            let first = try XCTUnwrap(try seal(request("2026-10-01T11:00:00.000Z")))
            try lay(fixtures.appendingPathComponent("logs/appended/\(folder)"), onto: target, append: true)
            let second = try XCTUnwrap(try seal(request("2026-10-01T11:05:00.000Z", after: first)))
            XCTAssertEqual(second.sidecar.seal, 2, "the second seal follows the first")

            for (sealed, name) in [(first, "bundle-1.zip"), (second, "bundle-2.zip")] {
                let checkedIn = fixtures.appendingPathComponent(name)
                if ProcessInfo.processInfo.environment["LIFESTREAM_WRITE_FIXTURES"] == "1" {
                    try? FileManager.default.removeItem(at: checkedIn)
                    try FileManager.default.copyItem(at: sealed.file, to: checkedIn)
                }
                XCTAssertEqual(try Data(contentsOf: sealed.file), try Data(contentsOf: checkedIn),
                               "\(provider) \(name) changed: rewrite it and make the home read it")
            }
            let names = try StoredZipReader(first.file).names + StoredZipReader(second.file).names
            XCTAssertFalse(names.contains { $0.contains("person-a") || $0.contains("-private-") })
        }

        let claudeFirst = try StoredZipReader(Self.fixtures("claude-code").appendingPathComponent("bundle-1.zip"))
        let session = Self.session
        let wholes = ["\(session)/subagents/agent-a0000000000000001.meta.json",
                      "\(session)/tool-results/pdf-00000000-0000-4000-8000-0000000000f1/page-1.jpg",
                      "\(session)/tool-results/toolu_01.txt", "\(session)/tool-results/toolu_09.txt"]
        XCTAssertEqual(claudeFirst.names, ["parts.json", "\(session).jsonl", "\(session)/subagents/agent-a0000000000000001.jsonl"]
                       + wholes + ["manifest.json"])
        let index = { (zip: StoredZipReader, name: String) -> String in
            "{\"file\":\"\(name)\",\"sha256\":\"\(SHA256Hex.of(zip.bytes(name)!))\",\"bytes\":\(zip.bytes(name)!.count)}"
        }
        XCTAssertEqual(claudeFirst.text("parts.json"),
                       "{\"parts\":[{\"file\":\"\(session).jsonl\",\"from_byte\":0,\"from_line\":1,\"lines\":11},"
                       + "{\"file\":\"\(session)/subagents/agent-a0000000000000001.jsonl\",\"from_byte\":0,\"from_line\":1,\"lines\":3}],"
                       + "\"files\":[\(wholes.map { index(claudeFirst, $0) }.joined(separator: ","))]}\n")
        let claudeSecond = try StoredZipReader(Self.fixtures("claude-code").appendingPathComponent("bundle-2.zip"))
        let added = "\(session)/tool-results/toolu_02.txt"
        XCTAssertEqual(claudeSecond.names, ["parts.json", "\(session).jsonl", "00000000-0000-4000-8000-0000000000c3.jsonl", added, "manifest.json"])
        let firstSize = try XCTUnwrap(claudeFirst.bytes("\(session).jsonl")).count
        XCTAssertEqual(claudeSecond.text("parts.json"),
                       "{\"parts\":[{\"file\":\"\(session).jsonl\",\"from_byte\":\(firstSize),\"from_line\":12,\"lines\":4},"
                       + "{\"file\":\"00000000-0000-4000-8000-0000000000c3.jsonl\",\"from_byte\":0,\"from_line\":1,\"lines\":2}],"
                       + "\"files\":[\(index(claudeFirst, wholes[0])),\(index(claudeFirst, wholes[1])),\(index(claudeFirst, wholes[2])),"
                       + "\(index(claudeSecond, added)),\(index(claudeFirst, wholes[3]))]}\n")
        XCTAssertTrue(try XCTUnwrap(claudeSecond.text("manifest.json")).contains("\"feeder\":\"claude-code-sessions\""))
    }

    func testCodexShipsOnlyTheSessionsAPersonStarted() throws {
        try lay(Self.fixtures("codex").appendingPathComponent("logs/codex"), onto: codex)
        let zip = try StoredZipReader(XCTUnwrap(try codexDomain().sealOne(request("2026-10-01T11:00:00.000Z"))).file)
        XCTAssertEqual(zip.names, [
            "parts.json",
            "rollout-2026-09-20T08-00-00-00000000-0000-7000-8000-0000000000d3.jsonl",
            Self.codexLog,
            "rollout-2026-10-01T10-30-00-00000000-0000-7000-8000-0000000000d1_00000000-0000-7000-8000-0000000000e1.jsonl",
            "rollout-2026-10-01T10-40-00-00000000-0000-7000-8000-0000000000d4.jsonl",
            "manifest.json",
        ], "the archived one, the person's and its later segment, the sub-agent's; neither exec session, nor the automation's")
    }

    func testEachLineShipsOnceAcrossBundles() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let log = try XCTUnwrap(try claude().logs().first { $0.name == "\(Self.session).jsonl" }).url
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)), "nothing new ships nothing")
        try appendLine("{\"type\":\"mode\",\"mode\":\"plan\",\"sessionId\":\"\(Self.session)\"}\n", to: log)
        let second = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:02:00.000Z", after: first)))
        XCTAssertEqual(try StoredZipReader(second.file).text("\(Self.session).jsonl"),
                       "{\"type\":\"mode\",\"mode\":\"plan\",\"sessionId\":\"\(Self.session)\"}\n")
        XCTAssertTrue(try parts(second).contains("\"from_line\":12,\"lines\":1"))
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:03:00.000Z", after: second)))
    }

    func testARestoreShipsAgainExactlyWhatLaterSealsCarried() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/appended/projects"), onto: projects, append: true)
        let second = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:05:00.000Z", after: first)))
        let restored = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:10:00.000Z", after: first)))
        XCTAssertEqual(restored.sidecar.seal, 2)
        XCTAssertEqual(try StoredZipReader(restored.file).members.filter { $0.name != "manifest.json" },
                       try StoredZipReader(second.file).members.filter { $0.name != "manifest.json" })
    }

    func testARefusedBundleShipsItsLinesAgain() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        let again = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:01:00.000Z")))
        XCTAssertEqual(try StoredZipReader(again.file).members.filter { $0.name != "manifest.json" },
                       try StoredZipReader(first.file).members.filter { $0.name != "manifest.json" })
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:02:00.000Z", after: again)))
    }

    func testALineStillBeingWrittenWaits() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let log = projects.appendingPathComponent("-Users-person-a-project/\(Self.session).jsonl")
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        try appendLine("{\"type\":\"mode\",", to: log)
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)), "half a line is no line")
        try appendLine("\"mode\":\"plan\"}\n", to: log)
        let second = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:02:00.000Z", after: first)))
        XCTAssertEqual(try StoredZipReader(second.file).text("\(Self.session).jsonl"), "{\"type\":\"mode\",\"mode\":\"plan\"}\n")
    }

    func testARewrittenLogShipsAgainFromItsFirstLine() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let log = projects.appendingPathComponent("-Users-person-a-project/\(Self.session).jsonl")
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        var bytes = try Data(contentsOf: log)
        bytes[bytes.count - 3] = UInt8(ascii: "X")
        try (bytes + Data("{\"type\":\"mode\",\"mode\":\"plan\"}\n".utf8)).write(to: log)
        let second = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
        XCTAssertTrue(try parts(second).contains("{\"file\":\"\(Self.session).jsonl\",\"from_byte\":0,\"from_line\":1,\"lines\":12}"))
        try Data("{\"type\":\"mode\",\"mode\":\"plan\"}\n".utf8).write(to: log)
        let third = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:02:00.000Z", after: second)))
        XCTAssertTrue(try parts(third).contains("{\"file\":\"\(Self.session).jsonl\",\"from_byte\":0,\"from_line\":1,\"lines\":1}"))
    }

    func testABundleKeepsToItsBudgetAndALongLineShipsAlone() throws {
        let folder = projects.appendingPathComponent("-Users-person-a-project", isDirectory: true)
        let start = "{\"type\":\"user\",\"entrypoint\":\"cli\",\"uuid\":\"u\",\"timestamp\":\"2026-10-01T09:00:00.000Z\"}\n"
        let a = "00000000-0000-4000-8000-00000000000a", b = "00000000-0000-4000-8000-00000000000b"
        let line = "{\"type\":\"mode\",\"mode\":\"\(String(repeating: "x", count: 100))\"}\n"
        try DomainFixtures.write(start + line + line, to: folder.appendingPathComponent("\(a).jsonl"))
        let long = "{\"type\":\"mode\",\"mode\":\"\(String(repeating: "y", count: 1000))\"}\n"
        try DomainFixtures.write(start + long, to: folder.appendingPathComponent("\(b).jsonl"))
        let budget = start.utf8.count + 2 * line.utf8.count + start.utf8.count + 10
        let first = try XCTUnwrap(try claude(budget: budget).sealOne(request("2026-10-01T11:00:00.000Z")))
        XCTAssertTrue(try parts(first).hasSuffix("{\"file\":\"\(b).jsonl\",\"from_byte\":0,\"from_line\":1,\"lines\":1}],\"files\":[]}\n"))
        try appendLine(line, to: folder.appendingPathComponent("\(a).jsonl"))
        let second = try XCTUnwrap(try claude(budget: budget).sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
        XCTAssertEqual(try parts(second), "{\"parts\":[{\"file\":\"\(b).jsonl\",\"from_byte\":\(start.utf8.count),\"from_line\":2,\"lines\":1}],\"files\":[]}\n")
        let third = try XCTUnwrap(try claude(budget: budget).sealOne(request("2026-10-01T11:02:00.000Z", after: second)))
        XCTAssertEqual(try parts(third), "{\"parts\":[{\"file\":\"\(a).jsonl\",\"from_byte\":\(start.utf8.count + 2 * line.utf8.count),\"from_line\":4,\"lines\":1}],\"files\":[]}\n")
    }

    func testALineNeverShipsBeforeAFileItsSessionHas() throws {
        let folder = projects.appendingPathComponent("-Users-person-a-project", isDirectory: true)
        let s = "00000000-0000-4000-8000-0000000000a7", t = "00000000-0000-4000-8000-0000000000a8"
        let start = "{\"type\":\"user\",\"entrypoint\":\"cli\",\"uuid\":\"u\",\"timestamp\":\"2026-10-01T09:00:00.000Z\"}\n"
        let result = "{\"type\":\"user\",\"toolUseResult\":\"Output saved to tool-results/toolu_07.txt\"}\n"
        try DomainFixtures.write(start + result, to: folder.appendingPathComponent("\(s).jsonl"))
        try DomainFixtures.write(String(repeating: "z", count: 300) + "\n", to: folder.appendingPathComponent("\(s)/tool-results/toolu_07.txt"))
        let line = "{\"type\":\"mode\",\"mode\":\"\(String(repeating: "x", count: 100))\"}\n"
        let budget = 400
        var after: SealedBundle?
        var bundles: [StoredZipReader] = []
        for minute in 0..<4 {
            if minute == 1 {
                try appendLine(line + result.replacingOccurrences(of: "toolu_07", with: "toolu_08"), to: folder.appendingPathComponent("\(s).jsonl"))
                try DomainFixtures.write(String(repeating: "w", count: 200) + "\n", to: folder.appendingPathComponent("\(s)/tool-results/toolu_08.txt"))
                try DomainFixtures.write(start + result.replacingOccurrences(of: "toolu_07", with: "toolu_09"), to: folder.appendingPathComponent("\(t).jsonl"))
                try DomainFixtures.write(String(repeating: "v", count: 300) + "\n", to: folder.appendingPathComponent("\(t)/tool-results/toolu_09.txt"))
            }
            guard let sealed = try claude(budget: budget).sealOne(request("2026-10-01T11:0\(minute):00.000Z", after: after)) else { continue }
            after = sealed
            bundles.append(try StoredZipReader(sealed.file))
        }
        var shipped: [String] = []
        for zip in bundles {
            let index = try XCTUnwrap(zip.text("parts.json"))
            if zip.names.contains("\(s).jsonl") { XCTAssertTrue(index.contains("\"\(s)/tool-results/toolu_07.txt\""), index) }
            if (zip.text("\(s).jsonl") ?? "").contains("toolu_08") { XCTAssertTrue(index.contains("\"\(s)/tool-results/toolu_08.txt\""), index) }
            if zip.names.contains("\(t).jsonl") { XCTAssertTrue(index.contains("\"\(t)/tool-results/toolu_09.txt\""), index) }
            shipped += zip.names
        }
        XCTAssertEqual(Set(shipped.filter { $0.contains("tool-results") }).count, 3)
        XCTAssertEqual(shipped.filter { $0.contains("tool-results") }.count, 3)
        XCTAssertEqual(bundles.compactMap { $0.text("\(s).jsonl") }.joined(), start + result + line + result.replacingOccurrences(of: "toolu_07", with: "toolu_08"))
    }

    func testABacklogShipsTheNewestSessionFirstAndThenOnePageAtATime() throws {
        let folder = projects.appendingPathComponent("-Users-person-a-project", isDirectory: true)
        let start = "{\"type\":\"user\",\"entrypoint\":\"cli\",\"uuid\":\"u\",\"timestamp\":\"2026-09-30T09:00:00.000Z\"}\n"
        let line = "{\"type\":\"mode\",\"mode\":\"\(String(repeating: "x", count: 100))\"}\n"
        let t0 = try DomainFixtures.instant("2026-10-01T11:00:00.000Z")
        let old = (1...6).map { String(format: "00000000-0000-4000-8000-0000000000d%d", $0) }
        let recent = "00000000-0000-4000-8000-0000000000e1"
        let write = { (session: String, text: String, at: Date) throws in
            let url = folder.appendingPathComponent("\(session).jsonl")
            try DomainFixtures.write(text, to: url)
            try FileManager.default.setAttributes([.modificationDate: at], ofItemAtPath: url.path)
        }
        for session in old { try write(session, start + line, t0.addingTimeInterval(-86_400)) }
        try write(recent, start + line, t0.addingTimeInterval(-60))
        let budget = 2 * (start + line).utf8.count + 50
        var owes: [Bool] = []
        let seal = { (minutes: Double, received: Int, imported: Int) throws -> [SealedBundle] in
            let custody = SealCustody(pass: ShippingFixture.pass, received: received, imported: imported)
            let request = try DomainFixtures.request(work: self.work, at: UTCInstant.rfc3339(t0.addingTimeInterval(minutes * 60)), custody: custody)
            let domain = try self.claude(budget: budget)
            defer { owes.append(domain.owesHistory) }
            return try domain.seal(request)
        }
        let logs = { (sealed: SealedBundle) throws -> [String] in
            try StoredZipReader(sealed.file).names.filter { $0.hasSuffix(".jsonl") }
        }
        let history = { (sealed: SealedBundle) throws -> Bool? in
            let manifest = try XCTUnwrap(StoredZipReader(sealed.file).text("manifest.json"))
            let facts = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(manifest.utf8)) as? [String: Any])["facts"] as? [String: Any]
            return facts?["history"] as? Bool
        }

        let first = try seal(0, 0, 0)
        XCTAssertEqual(try first.map { try logs($0) }, [["\(recent).jsonl"], ["\(old[0]).jsonl", "\(old[1]).jsonl"]])
        XCTAssertEqual(first.map(\.sidecar.seal), [1, 2])
        XCTAssertEqual(first.map(\.sidecar.kind), [nil, "history"])
        XCTAssertEqual(try first.map { try history($0) }, [nil, true])

        let again = try seal(1, 1, 1)
        XCTAssertEqual(again.count, 1)
        XCTAssertEqual(try parts(again.first), try parts(first[1]))
        XCTAssertEqual(again.first?.sidecar.seal, 2)

        try appendLine(line, to: folder.appendingPathComponent("\(recent).jsonl"))
        let live = try seal(2, 2, 1)
        XCTAssertEqual(try live.map { try logs($0) }, [["\(recent).jsonl"]])
        XCTAssertTrue(try parts(live.first).contains("\"from_line\":3,\"lines\":1"))
        XCTAssertEqual(try live.map { try history($0) }, [nil])

        let page = try seal(3, 3, 3)
        XCTAssertEqual(try page.map { try logs($0) }, [["\(old[2]).jsonl", "\(old[3]).jsonl"]])
        XCTAssertEqual(try page.map { try history($0) }, [true])
        let rest = try seal(4, 4, 4)
        XCTAssertEqual(try rest.map { try logs($0) }, [["\(old[4]).jsonl", "\(old[5]).jsonl"]])
        XCTAssertEqual(try rest.map { try history($0) }, [nil])
        XCTAssertEqual(try seal(5, 5, 5).count, 0, "nothing is owed")
        XCTAssertEqual(owes, [true, true, true, true, false, false],
                       "the older sessions are owed, paged or held, until what is left ships")

        let taken = try [first[0], again[0], live[0], page[0], rest[0]].map { try StoredZipReader($0.file) }
        for session in old + [recent] {
            let shipped = taken.compactMap { $0.text("\(session).jsonl") }.joined()
            XCTAssertEqual(shipped, try String(contentsOf: folder.appendingPathComponent("\(session).jsonl"), encoding: .utf8), session)
        }
    }

    func testASessionLastWrittenBeforeTheStartStaysHome() throws {
        try lay(Self.fixtures("codex").appendingPathComponent("logs/codex"), onto: codex)
        let old = "rollout-2026-09-20T08-00-00-00000000-0000-7000-8000-0000000000d3.jsonl"
        let walk = try XCTUnwrap(FileManager.default.enumerator(atPath: codex.path))
        while let relative = walk.nextObject() as? String {
            let file = codex.appendingPathComponent(relative)
            guard FileFacts.isRegularFile(file.path) else { continue }
            let written = file.lastPathComponent == old ? "2026-09-20T09:00:00.000Z" : "2026-10-01T10:50:00.000Z"
            try FileManager.default.setAttributes([.modificationDate: try DomainFixtures.instant(written)], ofItemAtPath: file.path)
        }
        let start = try DomainFixtures.instant("2026-09-25T00:00:00.000Z")
        let first = try XCTUnwrap(try codexDomain().sealOne(DomainFixtures.request(work: work, at: "2026-10-01T11:00:00.000Z", start: start)))
        let names = try StoredZipReader(first.file).names
        XCTAssertFalse(names.contains(old), "\(names)")
        XCTAssertTrue(names.contains(Self.codexLog), "\(names)")

        let widened = try XCTUnwrap(try codexDomain().sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
        XCTAssertEqual(try StoredZipReader(widened.file).names, ["parts.json", old, "manifest.json"])
    }

    func testAQuietReadCountsThePersonsLogsByTheMonthTheyWereModifiedBelowTheStartToo() throws {
        try lay(Self.fixtures("codex").appendingPathComponent("logs/codex"), onto: codex)
        let old = "rollout-2026-09-20T08-00-00-00000000-0000-7000-8000-0000000000d3.jsonl"
        let walk = try XCTUnwrap(FileManager.default.enumerator(atPath: codex.path))
        while let relative = walk.nextObject() as? String {
            let file = codex.appendingPathComponent(relative)
            guard FileFacts.isRegularFile(file.path) else { continue }
            let written = file.lastPathComponent == old ? "2026-09-20T09:00:00.000Z" : "2026-10-01T10:50:00.000Z"
            try FileManager.default.setAttributes([.modificationDate: try DomainFixtures.instant(written)], ofItemAtPath: file.path)
        }
        let start = try DomainFixtures.instant("2026-09-25T00:00:00.000Z")
        let first = try XCTUnwrap(try codexDomain().sealOne(DomainFixtures.request(work: work, at: "2026-10-01T11:00:00.000Z", start: start)))
        let after = SealCustody(pass: ShippingFixture.pass, received: first.sidecar.seal, imported: 0)
        let quiet = try DomainFixtures.instant("2026-10-01T11:01:00.000Z")
        XCTAssertEqual(try DomainFixtures.stated(codexDomain(), DomainFixtures.request(work: work, at: "2026-10-01T11:01:00.000Z", custody: after,
                                                                                       owesThrough: true, start: start)),
                       Through(readThrough: quiet, statedAt: quiet,
                               months: ["2026-09": Through.Month(items: 1, bytes: 639), "2026-10": Through.Month(items: 3, bytes: 2373 + 972 + 1184)]),
                       "the person's four logs by the month they were modified, the one below the start too, no program's")
        XCTAssertNil(try DomainFixtures.stated(codexDomain(), DomainFixtures.request(work: work, at: "2026-10-01T11:02:00.000Z", custody: after,
                                                                                     start: start)), "none owed: none stated")
    }

    func testALiveBundleCarriesThePersonsLogCountWhileTheHomeHasNotKeptIt() throws {
        try lay(Self.fixtures("codex").appendingPathComponent("logs/codex"), onto: codex)
        let sealed = try XCTUnwrap(try codexDomain().sealOne(DomainFixtures.request(work: work, at: "2026-10-01T11:00:00.000Z",
                                                                                      monthsOwed: { $0 })))
        let months = try XCTUnwrap(try DomainFixtures.facts(of: sealed)["months"] as? [String: [Int]])
        XCTAssertEqual(months.values.reduce(0) { $0 + $1[0] }, 4, "the person's four logs, counted in the bundle that ships them")
        XCTAssertEqual(sealed.sidecar.months?.mapValues { [$0.items, Int($0.bytes ?? -1)] }, months, "the sidecar keeps the same count")

        try appendLine("{\"type\":\"event_msg\"}\n", to: codex.appendingPathComponent("sessions/2026/10/01/\(Self.codexLog)"))
        let after = SealCustody(pass: ShippingFixture.pass, received: sealed.sidecar.seal, imported: 0)
        let next = try XCTUnwrap(try codexDomain().sealOne(DomainFixtures.request(work: work, at: "2026-10-01T11:01:00.000Z", custody: after)))
        XCTAssertNil(try DomainFixtures.facts(of: next)["months"], "a count the home holds is not carried again")
    }

    func testAnArchivedLogKeepsItsPlace() throws {
        try lay(Self.fixtures("codex").appendingPathComponent("logs/codex"), onto: codex)
        let first = try XCTUnwrap(try codexDomain().sealOne(request("2026-10-01T11:00:00.000Z")))
        let live = codex.appendingPathComponent("sessions/2026/10/01/\(Self.codexLog)")
        let archived = codex.appendingPathComponent("archived_sessions/\(Self.codexLog)")
        try FileManager.default.moveItem(at: live, to: archived)
        XCTAssertNil(try codexDomain().sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
        try appendLine("{\"timestamp\":\"2026-10-01T10:30:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"},\"ordinal\":11}\n", to: archived)
        let second = try XCTUnwrap(try codexDomain().sealOne(request("2026-10-01T11:02:00.000Z", after: first)))
        XCTAssertTrue(try parts(second).contains("\"from_line\":12,\"lines\":1"))
    }

    func testAProgramsLogIsReadOnce() throws {
        try lay(Self.fixtures("codex").appendingPathComponent("logs/codex"), onto: codex)
        let first = try XCTUnwrap(try codexDomain().sealOne(request("2026-10-01T11:00:00.000Z")))
        let program = codex.appendingPathComponent("sessions/2026/10/01/rollout-2026-10-01T10-50-00-00000000-0000-7000-8000-0000000000d2.jsonl")
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_700_000_000)], ofItemAtPath: program.path)
        let later = try DomainFixtures.instant("2026-10-01T11:00:00.000Z")
        for log in try codexDomain().logs(known: [], askFrom: Int.min) where log.name != program.lastPathComponent {
            try FileManager.default.setAttributes([.modificationDate: later.addingTimeInterval(-3600)], ofItemAtPath: log.url.path)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: program.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: program.path) }
        XCTAssertNil(try codexDomain().sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
    }

    func testAQuietRunWritesNothing() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        let old = try DomainFixtures.instant("2026-09-01T00:00:00.000Z")
        for log in try claude().logs() { try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: log.url.path) }
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
        let stamp = try XCTUnwrap(FileFacts.stamp(state.path))
        XCTAssertNil(try claude(at: "2026-10-01T09:40:00.000Z").sealOne(request("2026-10-01T11:02:00.000Z", after: first)))
        XCTAssertEqual(FileFacts.stamp(state.path), stamp)
    }

    func testAnUnreadableStateAsksAgainAndShipsNothingTwice() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        try DomainFixtures.write("not json", to: state)
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
        try DomainFixtures.write("not json", to: state)
        let again = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:02:00.000Z")))
        XCTAssertEqual(try parts(again), try parts(first), "every log again from its first line")
    }

    func testAVanishedLogOrFolderIsNoFailure() throws {
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:00:00.000Z")), "no ~/.claude/projects yet")
        XCTAssertNil(try codexDomain().sealOne(request("2026-10-01T11:00:00.000Z")), "no ~/.codex yet")
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        try FileManager.default.removeItem(at: projects.appendingPathComponent("-Users-person-a-project/\(Self.session)", isDirectory: true))
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)), "a deleted sub-agent log is no news")
        let reader = try JSONDecoder().decode(SessionLogShipper.State.self, from: Data(contentsOf: state))
        XCTAssertEqual(reader.people, ["\(Self.session).jsonl"])
    }

    func testALogThatDoesNotReadWaitsAlone() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let agent = projects.appendingPathComponent("-Users-person-a-project/\(Self.session)/subagents/agent-a0000000000000001.jsonl")
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: agent.path)
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: agent.path)
        XCTAssertFalse(try StoredZipReader(first.file).names.contains("\(Self.session)/subagents/agent-a0000000000000001.jsonl"))
        try appendLine("{\"type\":\"mode\",\"mode\":\"plan\"}\n", to: agent)
        let second = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
        XCTAssertTrue(try parts(second).hasPrefix("{\"parts\":[{\"file\":\"\(Self.session)/subagents/agent-a0000000000000001.jsonl\",\"from_byte\":0,\"from_line\":1,\"lines\":4}],"))
    }

    func testAQuietCodexFolderIsNotWalked() throws {
        try lay(Self.fixtures("codex").appendingPathComponent("logs/codex"), onto: codex)
        let day = codex.appendingPathComponent("sessions/2026/10/01", isDirectory: true)
        let meta = "{\"timestamp\":\"2026-10-01T10:58:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"instructions\":\""
        let stray = "rollout-2026-10-01T10-58-00-00000000-0000-7000-8000-0000000000f7.jsonl"
        let partial = "rollout-2026-10-01T10-58-30-00000000-0000-7000-8000-0000000000f6.jsonl"
        try log(meta, bytes: SessionLogShipper.guardBytes + 1, at: day.appendingPathComponent(stray))
        try DomainFixtures.write(meta, to: day.appendingPathComponent(partial))
        let first = try XCTUnwrap(try codexDomain().sealOne(request("2026-10-01T11:00:00.000Z")))
        let said = { (count: Int, first: String, more: String) in
            "\(count) session log\(count == 1 ? "" : "s") read to 64 MiB without the line that says who started it: \(first)\(more)"
        }
        XCTAssertEqual(try codexDomain().unread?.message, said(1, stray, ""))
        try DomainFixtures.write("{\"timestamp\":\"2026-10-01T10:59:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"00000000-0000-7000-8000-0000000000f9\","
                                 + "\"originator\":\"Codex Desktop\",\"source\":\"vscode\"}}\n",
                                 to: day.appendingPathComponent("rollout-2026-10-01T10-59-00-00000000-0000-7000-8000-0000000000f9.jsonl"))
        let old = try DomainFixtures.instant("2026-09-01T00:00:00.000Z")
        for name in [stray, partial] {
            try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: day.appendingPathComponent(name).path)
        }
        try appendLine("{\"timestamp\":\"2026-10-01T10:30:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"},\"ordinal\":11}\n",
                       to: day.appendingPathComponent(Self.codexLog))
        let quiet = { for folder in [day, self.codex.appendingPathComponent("archived_sessions", isDirectory: true)] {
            try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: folder.path)
        } }
        try quiet()
        let second = try XCTUnwrap(try codexDomain(at: "2026-10-01T12:00:00.000Z").sealOne(request("2026-10-01T12:00:00.000Z", after: first)))
        XCTAssertEqual(try parts(second), "{\"parts\":[{\"file\":\"\(Self.codexLog)\",\"from_byte\":\(try XCTUnwrap(StoredZipReader(first.file).bytes(Self.codexLog)).count),\"from_line\":12,\"lines\":1}],\"files\":[]}\n")
        XCTAssertEqual(try codexDomain().unread?.message, said(1, stray, ""))
        try log(meta, bytes: SessionLogShipper.guardBytes + 1, at: day.appendingPathComponent(partial))
        try quiet()
        XCTAssertNil(try codexDomain(at: "2026-10-01T13:00:00.000Z").sealOne(request("2026-10-01T13:00:00.000Z", after: second)))
        XCTAssertEqual(try codexDomain().unread?.message, said(2, stray, " and 1 more"))
        try FileManager.default.removeItem(at: day.appendingPathComponent(stray))
        try quiet()
        XCTAssertNil(try codexDomain(at: "2026-10-01T14:00:00.000Z").sealOne(request("2026-10-01T14:00:00.000Z", after: second)))
        XCTAssertEqual(try codexDomain().unread?.message, said(1, partial, ""))
    }

    func testAWholeFileShipsOnceAndAgainOnlyWhenItsSizeChanges() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let folder = projects.appendingPathComponent("-Users-person-a-project/\(Self.session)", isDirectory: true)
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)), "shipped once")
        let meta = folder.appendingPathComponent("subagents/agent-a0000000000000001.meta.json")
        try Data((try String(contentsOf: meta, encoding: .utf8)).dropLast().appending(",\"stoppedByUser\":true}").utf8).write(to: meta)
        let second = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:02:00.000Z", after: first)))
        XCTAssertEqual(try StoredZipReader(second.file).names, ["parts.json", "\(Self.session)/subagents/agent-a0000000000000001.meta.json", "manifest.json"])
        try DomainFixtures.write("synthetic", to: projects.appendingPathComponent("-private-tmp-example-run/00000000-0000-4000-8000-0000000000b2/tool-results/toolu_99.txt"))
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:03:00.000Z", after: second)))
    }

    private func log(_ head: String, bytes: Int, at url: URL) throws {
        try DomainFixtures.write(head, to: url)
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(bytes))
        try handle.close()
    }

    func testTheOneReaderDecidesWaitsOrGivesUpAtItsGuard() throws {
        let url = root.appendingPathComponent("one.jsonl")
        let entrypoint = { (line: Data) -> SessionStarter? in
            (SessionLogShipper.object(line)?["entrypoint"] as? String).map { $0.hasPrefix("sdk-") ? .program : .person }
        }
        XCTAssertEqual(SessionLogShipper.guardBytes, 64 << 20)
        try log("{\"type\":\"summary\"}\n", bytes: 4 << 20, at: url)
        try appendLine("\n{\"entrypoint\":\"cli\"}\n", to: url)
        XCTAssertEqual(try SessionLogShipper.starter(in: url, entrypoint), .person)
        try log("{\"type\":\"summary\"}\n{\"entry", bytes: 30, at: url)
        XCTAssertEqual(try SessionLogShipper.starter(in: url, entrypoint), .notYet)
        try log("{\"type\":\"summary\"}\n", bytes: SessionLogShipper.guardBytes + 1, at: url)
        XCTAssertEqual(try SessionLogShipper.starter(in: url, entrypoint), .unreadable)
    }

    func testALogPastTheGuardIsStatedWhileTheOthersShip() throws {
        try lay(Self.fixtures("claude-code").appendingPathComponent("logs/projects"), onto: projects)
        let stray = "00000000-0000-4000-8000-0000000000c3.jsonl"
        let strayURL = projects.appendingPathComponent("-Users-person-a-project/\(stray)")
        try log("{\"type\":\"summary\"}\n", bytes: SessionLogShipper.guardBytes + 1, at: strayURL)
        let first = try XCTUnwrap(try claude().sealOne(request("2026-10-01T11:00:00.000Z")))
        XCTAssertFalse(try StoredZipReader(first.file).names.contains(stray), "never shipped")
        XCTAssertTrue(try StoredZipReader(first.file).names.contains("\(Self.session).jsonl"), "the person's logs ship beside it")
        let said = Unread(code: "SESSION_LOG_UNREADABLE",
                          message: "1 session log read to 64 MiB without the line that says who started it: \(stray)")
        XCTAssertEqual(try claude().unread, said)
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:01:00.000Z", after: first)))
        XCTAssertEqual(try claude().unread, said)
        try FileManager.default.removeItem(at: strayURL)
        XCTAssertNil(try claude().sealOne(request("2026-10-01T11:02:00.000Z", after: first)))
        XCTAssertNil(try claude().unread)

        try FileManager.default.removeItem(at: state)
        try lay(Self.fixtures("codex").appendingPathComponent("logs/codex"), onto: codex)
        let rollout = "rollout-2026-10-01T10-59-00-00000000-0000-7000-8000-0000000000f8.jsonl"
        try log("{\"timestamp\":\"2026-10-01T10:59:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"instructions\":\"",
                bytes: SessionLogShipper.guardBytes + 1, at: codex.appendingPathComponent("sessions/2026/10/01/\(rollout)"))
        XCTAssertNotNil(try codexDomain().sealOne(request("2026-10-01T11:00:00.000Z")), "the person's logs ship")
        XCTAssertEqual(try codexDomain().unread?.message,
                       "1 session log read to 64 MiB without the line that says who started it: \(rollout)")
    }

    func testTheDomainsBuildForTheirSources() throws {
        XCTAssertEqual([try claude().name, try codexDomain().name], ["claude_code", "codex"])
    }
}

enum SHA256Hex {
    static func of(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
