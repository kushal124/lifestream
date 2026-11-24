import Foundation
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

final class DisplayCacheTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("display-caches-\(UUID().uuidString)")
        root = base.appendingPathComponent("support", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
    }

    func testADisplayCacheIsWrittenUnderCompleteProtection() {
        XCTAssertTrue(FileDurability.unlockedOnly.contains(.completeFileProtection))
        XCTAssertTrue(FileDurability.unlockedOnly.contains(.atomic))
    }

    func testTheWritersFilesAreListedEachFolderOutOfBackups() throws {
        FaceShelf(folder: root.appendingPathComponent(DisplayCaches.faces, isDirectory: true))
            .keep("sha256:" + String(repeating: "ab", count: 32), Data("face".utf8))
        var recent = SearchHistory(file: root.appendingPathComponent(DisplayCaches.search).appendingPathComponent("recent.json"))
        recent.add("synthetic query")

        let listed = DisplayCaches.listed(root: root)
        XCTAssertEqual(Set(listed.map { $0.deletingLastPathComponent().lastPathComponent }), [DisplayCaches.faces, DisplayCaches.search])
        for name in [DisplayCaches.faces, DisplayCaches.search] {
            let folder = root.appendingPathComponent(name, isDirectory: true)
            XCTAssertEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, name)
        }
        try onAPhone()
        XCTAssertEqual(DisplayCaches.weaker(root: root), [])
    }

    func testTheStartPutsEveryDisplayCacheFolderOutOfBackups() throws {
        for path in ["places/places.json", "people/people.json", "faces/kept"] { try write(path, .completeFileProtection) }
        DisplayCaches.assert(root: root)
        for name in [DisplayCaches.places, DisplayCaches.people, DisplayCaches.faces] {
            let folder = root.appendingPathComponent(name, isDirectory: true)
            XCTAssertEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true, name)
        }
    }

    func testAFileInAWeakerClassIsNamedAndTheStartMakesItCompleteLeavingTheOutboxAlone() throws {
        try onAPhone()
        let copy = try write("places/places.json", .completeFileProtectionUntilFirstUserAuthentication)
        let people = try write("people/people.json", .noFileProtection)
        let edit = try write("places/outbox/edit.json", .completeFileProtectionUntilFirstUserAuthentication)
        try write("faces/kept", .completeFileProtection)

        XCTAssertEqual(Set(DisplayCaches.weaker(root: root).map { $0.resolvingSymlinksInPath().path }),
                       Set([copy, people].map { $0.resolvingSymlinksInPath().path }), "every weaker display-cache file, and no outbox")

        DisplayCaches.assert(root: root)
        XCTAssertEqual(DisplayCaches.weaker(root: root), [])
        let outbox = try FileManager.default.attributesOfItem(atPath: edit.path)[.protectionKey] as? FileProtectionType
        XCTAssertEqual(outbox, .completeUntilFirstUserAuthentication, "the outbox keeps the class a locked phone sends in")
    }

    func testTheAppsContainerHoldsNoDisplayCacheInAWeakerClass() throws {
        try onAPhone()
        XCTAssertEqual(DisplayCaches.weaker(root: AppRuntime.supportRoot), [])
    }

    private func onAPhone() throws {
        #if targetEnvironment(simulator)
            throw XCTSkip("the simulator keeps no protection class: run on a phone")
        #endif
    }

    @discardableResult
    private func write(_ path: String, _ options: Data.WritingOptions) throws -> URL {
        let file = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("synthetic".utf8).write(to: file, options: options.union(.atomic))
        return file
    }
}
