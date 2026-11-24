import AppKit
import Darwin
import Evidence
import Foundation
import XCTest
@testable import Lifestream

@MainActor final class MacHygieneTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("hygiene-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func mode(_ url: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int)
    }

    func testEveryJobDumpsNoCoreAndStartsWithTheMask077AsTheBundleWritesIt() throws {
        try HomeJob.writeDefinitions(into: folder)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted(),
                       HomeJob.allCases.map(\.plistName).sorted())
        for job in HomeJob.allCases {
            let data = try Data(contentsOf: folder.appendingPathComponent(job.plistName))
            let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? NSDictionary)
            XCTAssertEqual(plist, job.definition as NSDictionary, "\(job): the bundle's file is not its definition")
            XCTAssertEqual(plist["Label"] as? String, job.label)
            XCTAssertEqual((plist["SoftResourceLimits"] as? [String: Int])?["Core"], 0, "\(job) may dump core")
            XCTAssertEqual((plist["HardResourceLimits"] as? [String: Int])?["Core"], 0, "\(job) may raise its core limit")
            XCTAssertEqual(plist["Umask"] as? Int, 0o077, "\(job) makes files others can read")
            XCTAssertEqual(plist["KeepAlive"] as? Bool, true)
            XCTAssertEqual(plist["ThrottleInterval"] as? Int, 60)
        }
        XCTAssertNil(HomeJob.home.definition["AbandonProcessGroup"], "a held home's check outlives the home")
        XCTAssertEqual(HomeJob.door.definition["AbandonProcessGroup"] as? Bool, true)
        XCTAssertEqual(HomeJob.home.definition["ProgramArguments"] as? [String], ["Lifestream", "launch", "--job", "home"])
        XCTAssertEqual(HomeJob.resourceWatch.definition["ProgramArguments"] as? [String], ["Lifestream", "resource-watch"])
        XCTAssertEqual(HomeJob.resourceWatch.definition["ProcessType"] as? String, "Background")
        XCTAssertEqual(HomeJob.door.definition["ProcessType"] as? String, "Interactive", "a person waits on every request the door serves")
        XCTAssertNil(HomeJob.home.definition["ProcessType"], "the home's helpers would be raised with it")
    }

    func testALogIsTheOwnersAloneAndAnOlderWiderOneIsNarrowedNotEmptied() throws {
        let log = folder.appendingPathComponent("logs/door.log")
        OwnLog.append(Data("one\n".utf8), to: log)
        XCTAssertEqual(try mode(log), 0o600)
        XCTAssertEqual(try mode(log.deletingLastPathComponent()), 0o700)

        let old = folder.appendingPathComponent("old/home.log")
        try FileManager.default.createDirectory(at: old.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o755])
        try Data("kept\n".utf8).write(to: old)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: old.path)
        let fd = OwnLog.open(old)
        XCTAssertGreaterThanOrEqual(fd, 0)
        FileHandle(fileDescriptor: fd, closeOnDealloc: true).write(Data("more\n".utf8))
        XCTAssertEqual(try mode(old), 0o600)
        XCTAssertEqual(try mode(old.deletingLastPathComponent()), 0o700)
        XCTAssertEqual(try String(contentsOf: old, encoding: .utf8), "kept\nmore\n")
    }

    func testTheLauncherSetsTheMaskAndNoCoreBeforeTheJobRuns() {
        let before = umask(0o022)
        defer { umask(before) }
        Launcher.hush()
        XCTAssertEqual(umask(0o022), 0o077)
        var limit = rlimit()
        getrlimit(RLIMIT_CORE, &limit)
        XCTAssertEqual(limit.rlim_cur, 0)
        XCTAssertEqual(limit.rlim_max, 0)
    }

    func testOneListOfPasswordManagersEveryOneNeverRecordedByDefault() {
        XCTAssertEqual(RecordingModes.passwordManagers.count, 9)
        XCTAssertEqual(HostState.Apps.passwordManagers, RecordingModes.passwordManagers, "the dialog reads another list")
        XCTAssertEqual(RecordingModes.defaultExcluded, Set(RecordingModes.passwordManagers))
        for id in RecordingModes.passwordManagers {
            XCTAssertEqual(RecordingModes.defaults.mode(of: id), .exclude, "\(id) recorded by default")
        }
    }

    func testTheKeysCopyIsConcealedAndClearedAfter90SecondsOnlyIfStillHeld() {
        let board = NSPasteboard(name: NSPasteboard.Name("hygiene-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        var waits: [(TimeInterval, @MainActor () -> Void)] = []
        let later: SecretCopy.Later = { seconds, work in waits.append((seconds, work)) }

        SecretCopy.put("KEY1 KEY2", on: board, later: later)
        XCTAssertEqual(board.string(forType: .string), "KEY1 KEY2")
        let types = board.types ?? []
        XCTAssertTrue(types.contains(SecretCopy.concealed), "not concealed")
        XCTAssertTrue(types.contains(SecretCopy.transient), "not transient")
        XCTAssertEqual(waits.map(\.0), [90])
        waits[0].1()
        XCTAssertNil(board.string(forType: .string), "the key outlived its 90 seconds")

        SecretCopy.put("KEY1 KEY2", on: board, later: later)
        board.clearContents()
        board.setString("their own", forType: .string)
        waits[1].1()
        XCTAssertEqual(board.string(forType: .string), "their own", "a later copy of the person's was cleared")
    }

    func testTheAppsEndClearsTheKeysCopyOnlyIfStillHeld() {
        let board = NSPasteboard(name: NSPasteboard.Name("hygiene-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        let never: SecretCopy.Later = { _, _ in }

        SecretCopy.put("KEY1 KEY2", on: board, later: never)
        SecretCopy.leaving()
        XCTAssertNil(board.string(forType: .string), "the key outlived the app")

        SecretCopy.put("KEY1 KEY2", on: board, later: never)
        board.clearContents()
        board.setString("their own", forType: .string)
        SecretCopy.leaving()
        XCTAssertEqual(board.string(forType: .string), "their own", "the app's end cleared the person's own copy")
    }
}
