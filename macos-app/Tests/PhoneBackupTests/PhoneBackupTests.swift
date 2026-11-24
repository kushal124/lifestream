import CommonCrypto
import CryptoKit
import Foundation
import PhoneBackupFixture
import XCTest
@testable import PhoneBackup

final class PhoneBackupTests: XCTestCase {
    private var root: URL!
    private var work: URL!
    private var backups: URL { root.appendingPathComponent("Backup") }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("phone-backup-\(UUID().uuidString)")
        work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: backups, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: backups.path)
        try? FileManager.default.removeItem(at: root)
    }

    func testTheFactsReadWithoutAPassword() throws {
        let made = try SyntheticBackup.write(in: backups, password: "correct horse", files: SyntheticBackup.stores)
        let unfinished = try SyntheticBackup.write(in: backups, password: nil, files: [], udid: "00008150-001100FFEE22401D", finished: false, lastBackup: Date(timeIntervalSince1970: 1_700_000_000))
        let folders = try BackupFolder.list(in: backups)
        XCTAssertEqual(folders.map(\.udid), [made.udid, unfinished.udid], "newest first")
        let folder = folders[0]
        XCTAssertEqual(folder.productType, "iPhone18,1")
        XCTAssertEqual(folder.productVersion, "27.0")
        XCTAssertTrue(folder.encrypted)
        XCTAssertTrue(folder.finished)
        XCTAssertEqual(folder.lastBackup, made.lastBackup)
        XCTAssertEqual(folder.modelName, "iPhone 17 Pro")
        XCTAssertEqual(folder.name, "Test iPhone", "the phone's own name, as Finder lists it")
        XCTAssertEqual(folder.device, String(SHA256.hash(data: Data(made.udid.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16)))
        XCTAssertEqual(folder.serial4, String(SHA256.hash(data: Data(made.serial.utf8)).map { String(format: "%02x", $0) }.joined().prefix(4)), "HomeLink's serial4 rule")
        XCTAssertEqual(BackupModels.name(of: "iPhone99,9"), "iPhone", "a model not in the table")
        XCTAssertEqual(folder.archiveId, "\(made.udid):2026-08-28T11:20:55Z")
        XCTAssertTrue(folder.applications.contains("net.whatsapp.WhatsApp"))
        XCTAssertFalse(folders[1].encrypted)
        let noSerial = try SyntheticBackup.write(in: root.appendingPathComponent("other"), password: nil, files: [], serial: "")
        XCTAssertNil(try BackupFolder(at: noSerial.url).serial4, "a backup that states no serial has none")
        let noName = try SyntheticBackup.write(in: root.appendingPathComponent("unnamed"), password: nil, files: [], deviceName: "")
        XCTAssertEqual(try BackupFolder(at: noName.url).name, "iPhone 17 Pro", "a backup that states no name is named by its model")
        XCTAssertFalse(folders[1].finished)
        XCTAssertThrowsError(try OpenBackup(folders[1], password: nil, work: work)) { XCTAssertEqual($0 as? BackupError, .notFinished) }
        XCTAssertEqual(try BackupFolder.list(in: root.appendingPathComponent("nowhere")), [], "a folder that is not there is no backups")
    }

    func testAnEncryptedBackupRefusesByName() throws {
        let made = try SyntheticBackup.write(in: backups, password: "correct horse", files: SyntheticBackup.stores)
        let folder = try BackupFolder(at: made.url)
        XCTAssertThrowsError(try OpenBackup(folder, password: nil, work: work)) { XCTAssertEqual($0 as? BackupError, .passwordNeeded) }
        XCTAssertThrowsError(try OpenBackup(folder, password: "", work: work)) { XCTAssertEqual($0 as? BackupError, .passwordNeeded) }
        XCTAssertThrowsError(try OpenBackup(folder, password: "wrong horse", work: work)) { XCTAssertEqual($0 as? BackupError, .wrongPassword) }
        XCTAssertNoThrow(try OpenBackup(folder, password: "correct horse", work: work))
        XCTAssertThrowsError(try Keybag(Data([0x53, 0x41, 0x4C, 0x54, 0, 0, 0, 9, 1]), password: "x")) {
            guard case .unreadable = $0 as? BackupError else { return XCTFail("a field that overruns is unreadable, not a wrong password") }
        }
    }

    func testTheKeyWrapAndTheDerivationMatchPublishedVectors() throws {
        let kek = Data(hex: "000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F")
        let key = Data(hex: "00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F")
        let wrapped = Data(hex: "28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21")
        XCTAssertEqual(Keybag.unwrap(wrapped, with: kek), key)
        XCTAssertNil(Keybag.unwrap(Data(hex: "00") + wrapped.dropFirst(), with: kek), "a wrapped key that was touched fails its check")
        let derived = try Keybag.pbkdf2(CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), Data("password".utf8), salt: Data("salt".utf8), rounds: 2)
        XCTAssertEqual(derived.prefix(20), Data(hex: "EA6C014DC72D6F8CCD1ED92ACE1D41F0D8DE8957"))
        let sha256 = try Keybag.pbkdf2(CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), Data("password".utf8), salt: Data("salt".utf8), rounds: 1)
        XCTAssertEqual(sha256, Data(hex: "120FB6CFFCF8B32C43E7225256C4F837A86548C92CCC35480805987CB70BE17B"))
    }

    func testFilesComeOutWholeAndAMissingOneIsAbsent() throws {
        var files = SyntheticBackup.stores
        let media = SyntheticBackup.File(domain: BackupStore.whatsAppDomain, path: "Message/Media/5551/clip.mp4", content: SyntheticBackup.bytes(5 << 20 + 7, seed: 9), protectionClass: 1)
        files.append(media)
        let notes = SyntheticBackup.File(domain: "AppDomainGroup-group.com.apple.notes", path: "NoteStore.sqlite", content: SyntheticBackup.bytes(40_000, seed: 11), stale: 1_089_536)
        files.append(notes)
        files.removeAll { $0.path == BackupStore.messages.path }
        let made = try SyntheticBackup.write(in: backups, password: "correct horse", files: files)
        let backup = try OpenBackup(try BackupFolder(at: made.url), password: "correct horse", work: work)
        XCTAssertNil(try backup.file(domain: BackupStore.messages.domain, path: BackupStore.messages.path), "Messages in iCloud keeps sms.db out")
        let chats = try XCTUnwrap(try backup.file(domain: BackupStore.whatsAppChats.domain, path: BackupStore.whatsAppChats.path))
        XCTAssertEqual(chats.size, Int64(SyntheticBackup.stores[1].content.count))
        XCTAssertTrue(chats.isFile)
        let out = work.appendingPathComponent("out")
        try backup.extract(chats, to: out.appendingPathComponent("chats.sqlite"))
        XCTAssertEqual(try Data(contentsOf: out.appendingPathComponent("chats.sqlite")), SyntheticBackup.stores[1].content)
        let underMedia = try backup.files(domain: BackupStore.whatsAppDomain, under: BackupStore.whatsAppMedia.prefix)
        XCTAssertEqual(underMedia.map(\.relativePath), ["Message/Media/5551/clip.mp4"])
        try backup.extract(underMedia[0], to: out.appendingPathComponent("clip.mp4"))
        XCTAssertEqual(try Data(contentsOf: out.appendingPathComponent("clip.mp4")), media.content, "5 MiB and 7 bytes, across the chunk")
        let stale = try XCTUnwrap(try backup.file(domain: notes.domain, path: notes.path))
        XCTAssertNotEqual(stale.size, Int64(notes.content.count))
        try backup.extract(stale, to: out.appendingPathComponent("notes.sqlite"))
        XCTAssertEqual(try Data(contentsOf: out.appendingPathComponent("notes.sqlite")), notes.content, "the bytes the backup holds, not its record's stale size")
        let calls = try XCTUnwrap(try backup.file(domain: BackupStore.calls.domain, path: BackupStore.calls.path))
        try backup.extract(calls, to: out.appendingPathComponent("callhistory.sqlite"))
        XCTAssertEqual(try Data(contentsOf: out.appendingPathComponent("callhistory.sqlite")), SyntheticBackup.stores[3].content)
        let stored = made.url.appendingPathComponent(String(calls.fileID.prefix(2))).appendingPathComponent(calls.fileID)
        try Data(contentsOf: stored).prefix(0).write(to: stored)
        XCTAssertThrowsError(try backup.extract(calls, to: out.appendingPathComponent("callhistory.sqlite"))) {
            guard case .unreadable(let why) = $0 as? BackupError else { return XCTFail("\($0)") }
            XCTAssertTrue(why.contains("CallHistory.storedata"), why)
        }
        XCTAssertEqual(try Data(contentsOf: out.appendingPathComponent("callhistory.sqlite")), SyntheticBackup.stores[3].content, "the earlier copy stands")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path).filter { $0.hasSuffix(".partial") }, [])
    }

    func testAnUnencryptedBackupNeedsNoPassword() throws {
        let made = try SyntheticBackup.write(in: backups, password: nil, files: SyntheticBackup.stores)
        let folder = try BackupFolder(at: made.url)
        XCTAssertFalse(folder.encrypted)
        let backup = try OpenBackup(folder, password: nil, work: work)
        let sms = try XCTUnwrap(try backup.file(domain: BackupStore.messages.domain, path: BackupStore.messages.path))
        let out = work.appendingPathComponent("sms.db")
        try backup.extract(sms, to: out)
        XCTAssertEqual(try Data(contentsOf: out), SyntheticBackup.stores[0].content)
        XCTAssertNil(sms.encryptionKey)
        let stored = made.url.appendingPathComponent(String(sms.fileID.prefix(2))).appendingPathComponent(sms.fileID)
        try SyntheticBackup.stores[0].content.prefix(100).write(to: stored)
        try backup.extract(sms, to: out)
        XCTAssertEqual(try Data(contentsOf: out), SyntheticBackup.stores[0].content.prefix(100))
    }

    func testTheDecryptedFileListGoesAtClose() throws {
        let made = try SyntheticBackup.write(in: backups, password: "correct horse", files: SyntheticBackup.stores)
        let scratch = OpenBackup.scratch(in: work)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        try Data("left by a crash".utf8).write(to: scratch.appendingPathComponent("Manifest.db"))
        var backup: OpenBackup? = try OpenBackup(try BackupFolder(at: made.url), password: "correct horse", work: work)
        XCTAssertNotNil(backup)
        XCTAssertNotEqual(try Data(contentsOf: scratch.appendingPathComponent("Manifest.db")), Data("left by a crash".utf8), "the leftover was swept")
        backup = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: scratch.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: made.url.appendingPathComponent("Manifest.db").path), "the backup's own file list is untouched")
    }

    func testAMalformedRecordHidesNoOtherFile() throws {
        var files = SyntheticBackup.stores
        files[2].record = Data("not a keyed archive".utf8)
        let made = try SyntheticBackup.write(in: backups, password: "correct horse", files: files)
        let backup = try OpenBackup(try BackupFolder(at: made.url), password: "correct horse", work: work)
        let whatsApp = try backup.files(domain: BackupStore.whatsAppDomain)
        XCTAssertEqual(whatsApp.map(\.relativePath), ["ChatStorage.sqlite"])
        XCTAssertEqual(backup.problems, [BackupFileProblem(domain: BackupStore.whatsAppDomain, relativePath: "CallHistory.sqlite", why: "its record is no keyed archive")])
        XCTAssertNotNil(try backup.file(domain: BackupStore.messages.domain, path: BackupStore.messages.path))
    }

    func testAFolderThatCannotBeListedIsSaid() throws {
        _ = try SyntheticBackup.write(in: backups, password: nil, files: [])
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: backups.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: backups.path) }
        XCTAssertThrowsError(try BackupFolder.list(in: backups)) {
            guard case .unreadable(let why) = $0 as? BackupError else { return XCTFail("\($0)") }
            XCTAssertTrue(why.hasPrefix("Backup cannot be listed"), why)
        }
    }
}

private extension Data {
    init(hex: String) {
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        self.init(bytes)
    }
}
