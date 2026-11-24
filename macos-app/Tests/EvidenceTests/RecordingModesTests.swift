import CryptoKit
import DeviceFiles
import Foundation
import XCTest
@testable import Evidence

final class RecordingModesTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("app-modes-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var file: URL { root.appendingPathComponent(RecordingModes.fileName) }

    func testTheFileBytesArePinned() throws {
        XCTAssertEqual(String(decoding: try RecordingModes.defaults.fileBytes(), as: UTF8.self),
            #"{"apps":{"activity":[],"exclude":["com.1password.1password","com.agilebits.onepassword7","com.apple.Passwords","com.apple.keychainaccess","com.bitwarden.desktop","com.dashlane.dashlanephonefinal","com.lastpass.LastPass","com.protonpass.mac","org.keepassxc.keepassxc"]},"sites":{"activity":["127.0.0.1:4317","localhost:4317"],"exclude":[]}}"# + "\n")
        let modes = RecordingModes(activity: ["com.example.zeta", "com.example.alpha"], exclude: ["com.example.vault"],
                                   launchExcluded: ["com.example.run-only"], siteActivity: ["mail.example.com"],
                                   siteExclude: ["bank.example.com", "localhost:4317"])
        XCTAssertEqual(String(decoding: try modes.fileBytes(), as: UTF8.self),
            #"{"apps":{"activity":["com.example.alpha","com.example.zeta"],"exclude":["com.example.vault"]},"sites":{"activity":["mail.example.com"],"exclude":["bank.example.com","localhost:4317"]}}"# + "\n")
    }

    func testModesPersistAndReadBackAndNoStagingFileRemains() throws {
        var modes = RecordingModes.defaults
        try modes.set(.activity, for: "com.example.chat")
        try modes.save(to: root, files: DeviceFiles(.plain))
        XCTAssertEqual(RecordingModes.load(from: root, files: DeviceFiles(.plain)), modes)
        try modes.set(.record, for: "com.example.chat")
        try modes.save(to: root, files: DeviceFiles(.plain))
        XCTAssertEqual(RecordingModes.load(from: root, files: DeviceFiles(.plain)), modes)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [RecordingModes.fileName])
        let sites = RecordingModes(siteExclude: ["bank.example.com"])
        try sites.save(to: root, files: DeviceFiles(.plain))
        XCTAssertEqual(RecordingModes.load(from: root, files: DeviceFiles(.plain)).saved.sites, RecordingModeGroup(exclude: ["bank.example.com"]))
    }

    func testASaveIsOrderedThenRenamedThenCommittedOnce() throws {
        try RecordingModes.defaults.save(to: root, files: DeviceFiles(.plain))
        let modes = RecordingModes(exclude: ["com.example.vault"])
        var seen: [(path: String, level: DeviceFiles.Flush, bytes: Data?)] = []
        DeviceFiles.flushObserver = { [root] url, level in
            guard url.path.hasPrefix(root!.path) else { return }
            seen.append((url.lastPathComponent, level, try? Data(contentsOf: root!.appendingPathComponent(RecordingModes.fileName))))
        }
        defer { DeviceFiles.flushObserver = nil }
        try modes.save(to: root, files: DeviceFiles(.plain))
        XCTAssertEqual(seen.map(\.level), [.barrier, .full])
        guard seen.count == 2 else { return }
        XCTAssertTrue(seen[0].path.hasPrefix(".\(RecordingModes.fileName).") && seen[0].path.hasSuffix(".tmp"))
        XCTAssertEqual(seen[0].bytes, try RecordingModes.defaults.fileBytes(), "the barrier precedes the rename")
        XCTAssertEqual(seen[1].path, root.lastPathComponent, "the folder")
        XCTAssertEqual(seen[1].bytes, try modes.fileBytes(), "the rename precedes the full flush")
    }

    func testAMissingFileMeansTheDefaults() {
        var reports: [String] = []
        XCTAssertEqual(RecordingModes.load(from: root, files: DeviceFiles(.plain)) { reports.append($0) }, .defaults)
        XCTAssertEqual(reports, [])
    }

    func testAFileThatDoesNotReadMeansTheDefaultsAndIsReported() throws {
        let broken = [
            "{",
            #"{"activity":[],"exclude":[]}"#,
            #"{"apps":{"activity":[],"exclude":[]}}"#,
            #"{"apps":{"activity":[],"exclude":[]},"sites":{"activity":[],"exclude":[]},"extra":1}"#,
            #"{"apps":{"activity":["com.example.a"],"exclude":["com.example.a"]},"sites":{"activity":[],"exclude":[]}}"#,
            #"{"apps":{"activity":["com.example.a","com.example.a"],"exclude":[]},"sites":{"activity":[],"exclude":[]}}"#,
            #"{"apps":{"activity":["com example"],"exclude":[]},"sites":{"activity":[],"exclude":[]}}"#,
            #"{"apps":{"activity":[1],"exclude":[]},"sites":{"activity":[],"exclude":[]}}"#,
            #"{"apps":{"activity":[],"exclude":[],"record":[]},"sites":{"activity":[],"exclude":[]}}"#,
            #"{"apps":{"activity":[],"exclude":[]},"sites":{"activity":["Mail.Example.com"],"exclude":[]}}"#,
            #"{"apps":{"activity":[],"exclude":[]},"sites":{"activity":["https://example.com"],"exclude":[]}}"#,
        ]
        for text in broken {
            try Data(text.utf8).write(to: file)
            var reports: [String] = []
            XCTAssertEqual(RecordingModes.load(from: root, files: DeviceFiles(.plain)) { reports.append($0) }, .defaults, text)
            XCTAssertEqual(reports, ["recording modes: app-modes.json could not be read; the defaults apply"], text)
        }
        try Data().write(to: file)
        XCTAssertEqual(RecordingModes.load(from: root, files: DeviceFiles(.plain)), .defaults)
    }

    func testKeyedModesAreEncryptedAndReadBackAndAnAbsentFileIsTheDefaultsInBothForms() throws {
        let keyed = DeviceFiles(.keyed(SymmetricKey(data: Data(repeating: 0x11, count: 32))))
        for files in [DeviceFiles(.plain), keyed] {
            var reported: [String] = []
            XCTAssertEqual(RecordingModes.load(from: root, files: files) { reported.append($0) }, .defaults)
            XCTAssertEqual(reported, [], "an absent file is no fault")
        }
        let modes = RecordingModes(exclude: ["com.example.vault"])
        try modes.save(to: root, files: keyed)
        let disk = try XCTUnwrap(FileManager.default.contents(atPath: file.path))
        XCTAssertNil(disk.range(of: Data("com.example.vault".utf8)))
        XCTAssertEqual(RecordingModes.load(from: root, files: keyed), modes)
        var reported: [String] = []
        XCTAssertEqual(RecordingModes.load(from: root, files: DeviceFiles(.plain)) { reported.append($0) }, .defaults)
        XCTAssertEqual(reported.count, 1, "an encrypted file read plain is a fault, and the defaults apply")
    }

}
