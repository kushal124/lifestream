import CryptoKit
import Foundation
import SQLite3

public struct BackupFile: Sendable, Equatable {
    public let domain: String
    public let relativePath: String
    public let fileID: String
    public let flags: Int
    public let size: Int64
    let encryptionKey: Data?

    public var isFile: Bool { flags == 1 }
    public var name: String { (relativePath as NSString).lastPathComponent }
}

public struct BackupDigest: Sendable, Equatable, Hashable {
    public let sha256: String
    public let bytes: Int64

    public init(sha256: String, bytes: Int64) {
        self.sha256 = sha256
        self.bytes = bytes
    }
}

public struct BackupFileProblem: Sendable, Equatable {
    public let domain: String
    public let relativePath: String
    public let why: String
}

public final class OpenBackup {
    public let folder: BackupFolder
    public private(set) var problems: [BackupFileProblem] = []
    private let keybag: Keybag?
    private let manifest: URL
    private let removesManifest: Bool
    private var db: OpaquePointer?

    public static func scratch(in work: URL) -> URL { work.appendingPathComponent("phone-backup", isDirectory: true) }

    public init(_ folder: BackupFolder, password: String?, work: URL) throws {
        guard folder.finished else { throw BackupError.notFinished }
        self.folder = folder
        let stored = folder.url.appendingPathComponent("Manifest.db")
        if folder.encrypted {
            guard let password, !password.isEmpty else { throw BackupError.passwordNeeded }
            let plist = try BackupFolder.plist(folder.url.appendingPathComponent("Manifest.plist"))
            guard let keybagData = plist["BackupKeyBag"] as? Data, let manifestKey = plist["ManifestKey"] as? Data else {
                throw BackupError.unreadable("Manifest.plist holds no keybag or manifest key")
            }
            let keybag = try Keybag(keybagData, password: password)
            guard var key = keybag.unwrap(classed: manifestKey) else { throw BackupError.unreadable("the manifest key did not unwrap") }
            defer { Keybag.zero(&key) }
            let scratch = Self.scratch(in: work)
            try? FileManager.default.removeItem(at: scratch)
            do { try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true) } catch {
                throw BackupError.unreadable("the work folder could not be made")
            }
            let decrypted = scratch.appendingPathComponent("Manifest.db")
            try Self.write(to: decrypted) { sink in try BackupCipher.decrypt(file: stored, key: key, recorded: nil, into: sink) }
            self.keybag = keybag
            self.manifest = decrypted
            self.removesManifest = true
        } else {
            self.keybag = nil
            self.manifest = stored
            self.removesManifest = false
        }
        var components = URLComponents()
        components.scheme = "file"
        components.path = manifest.path
        components.queryItems = [URLQueryItem(name: "mode", value: "ro"), URLQueryItem(name: "immutable", value: "1")]
        var db: OpaquePointer?
        guard let uri = components.string,
              sqlite3_open_v2(uri, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let db else {
            sqlite3_close(db)
            if removesManifest { try? FileManager.default.removeItem(at: manifest.deletingLastPathComponent()) }
            throw BackupError.unreadable("Manifest.db is no file list")
        }
        self.db = db
    }

    deinit {
        if let db { sqlite3_close(db) }
        if removesManifest { try? FileManager.default.removeItem(at: manifest.deletingLastPathComponent()) }
    }

    public func files(domain: String, under prefix: String = "") throws -> [BackupFile] {
        try query("SELECT fileID, domain, relativePath, flags, file FROM Files WHERE domain = ? AND relativePath LIKE ? ESCAPE '\\' ORDER BY relativePath",
                  domain, Self.likePrefix(prefix) + "%")
    }

    public func file(domain: String, path: String) throws -> BackupFile? {
        try query("SELECT fileID, domain, relativePath, flags, file FROM Files WHERE domain = ? AND relativePath = ?", domain, path).first
    }

    @discardableResult
    public func extract(_ file: BackupFile, to destination: URL) throws -> BackupDigest {
        let parent = destination.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let partial = parent.appendingPathComponent(".\(destination.lastPathComponent).partial")
        try? FileManager.default.removeItem(at: partial)
        defer { try? FileManager.default.removeItem(at: partial) }
        var digest: BackupDigest?
        try Self.write(to: partial) { write in digest = try self.read(file) { try write($0) } }
        _ = try FileManager.default.replaceItemAt(destination, withItemAt: partial)
        return digest!
    }

    public func digest(_ file: BackupFile) throws -> BackupDigest {
        try read(file) { _ in }
    }

    public func contents(_ file: BackupFile) throws -> Data {
        var data = Data()
        _ = try read(file) { data.append($0) }
        return data
    }

    private func read(_ file: BackupFile, into sink: (Data) throws -> Void) throws -> BackupDigest {
        guard file.isFile else { throw BackupError.unreadable("\(file.relativePath) is no file") }
        let source = folder.url.appendingPathComponent(String(file.fileID.prefix(2))).appendingPathComponent(file.fileID)
        guard FileManager.default.fileExists(atPath: source.path) else { throw BackupError.unreadable("\(file.relativePath) is missing from the backup") }
        var hash = SHA256()
        var bytes: Int64 = 0
        func take(_ piece: Data) throws { hash.update(data: piece); bytes += Int64(piece.count); try sink(piece) }
        if let keybag {
            guard let wrapped = file.encryptionKey, var key = keybag.unwrap(classed: wrapped) else {
                throw BackupError.unreadable("\(file.relativePath)'s key did not unwrap")
            }
            defer { Keybag.zero(&key) }
            do { try BackupCipher.decrypt(file: source, key: key, recorded: file.size, into: take) } catch BackupError.unreadable(let why) {
                throw BackupError.unreadable("\(file.relativePath): \(why)")
            }
        } else {
            let input: FileHandle
            do { input = try FileHandle(forReadingFrom: source) } catch { throw BackupError.unreadable("\(file.relativePath) does not read") }
            defer { try? input.close() }
            while true {
                let piece = input.readData(ofLength: 4 << 20)
                if piece.isEmpty { break }
                try take(piece)
            }
        }
        return BackupDigest(sha256: hash.finalize().map { String(format: "%02x", $0) }.joined(), bytes: bytes)
    }

    private static func write(to url: URL, _ body: ((Data) throws -> Void) throws -> Void) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw BackupError.unreadable("\(url.lastPathComponent) could not be written")
        }
        let output = try FileHandle(forWritingTo: url)
        defer { try? output.close() }
        try body { try output.write(contentsOf: $0) }
    }


    private func query(_ sql: String, _ bindings: String...) throws -> [BackupFile] {
        guard let db else { throw BackupError.unreadable("the file list is closed") }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw BackupError.unreadable("the file list has no Files table")
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, value) in bindings.enumerated() { sqlite3_bind_text(statement, Int32(index + 1), value, -1, transient) }
        var files: [BackupFile] = []
        var step = sqlite3_step(statement)
        while step == SQLITE_ROW {
            let fileID = String(cString: sqlite3_column_text(statement, 0))
            let domain = String(cString: sqlite3_column_text(statement, 1))
            let relativePath = String(cString: sqlite3_column_text(statement, 2))
            let flags = Int(sqlite3_column_int(statement, 3))
            var record = Data()
            if let bytes = sqlite3_column_blob(statement, 4) { record = Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 4))) }
            switch FileRecord.read(record) {
            case .success(let facts):
                files.append(BackupFile(domain: domain, relativePath: relativePath, fileID: fileID, flags: flags, size: facts.size, encryptionKey: facts.encryptionKey))
            case .failure(let problem):
                let named = BackupFileProblem(domain: domain, relativePath: relativePath, why: problem.why)
                if !problems.contains(named) { problems.append(named) }
            }
            step = sqlite3_step(statement)
        }
        guard step == SQLITE_DONE else { throw BackupError.unreadable("the file list stopped reading (\(step))") }
        return files
    }

    private static func likePrefix(_ prefix: String) -> String {
        prefix.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_")
    }
}

final class FileRecord: NSObject, NSCoding {
    struct Unread: Error { let why: String }

    let size: Int64
    let protectionClass: Int
    let encryptionKey: Data?

    required init?(coder: NSCoder) {
        size = coder.decodeInt64(forKey: "Size")
        protectionClass = coder.decodeInteger(forKey: "ProtectionClass")
        encryptionKey = coder.decodeObject(of: NSData.self, forKey: "EncryptionKey") as Data?
    }

    func encode(with coder: NSCoder) {
        coder.encode(size, forKey: "Size")
        coder.encode(protectionClass, forKey: "ProtectionClass")
        if let encryptionKey { coder.encode(encryptionKey as NSData, forKey: "EncryptionKey") }
    }

    static let className = "MBFile"

    static func read(_ data: Data) -> Result<FileRecord, Unread> {
        guard !data.isEmpty else { return .failure(Unread(why: "no record in the file list")) }
        let unarchiver: NSKeyedUnarchiver
        do { unarchiver = try NSKeyedUnarchiver(forReadingFrom: data) } catch { return .failure(Unread(why: "its record is no keyed archive")) }
        unarchiver.requiresSecureCoding = false
        unarchiver.setClass(FileRecord.self, forClassName: className)
        defer { unarchiver.finishDecoding() }
        guard let record = unarchiver.decodeObject(forKey: NSKeyedArchiveRootObjectKey) as? FileRecord else {
            return .failure(Unread(why: "its record is not a file's"))
        }
        guard record.size >= 0 else { return .failure(Unread(why: "its record states a negative size")) }
        return .success(record)
    }
}

public enum BackupStore {
    public static let messages = (domain: "HomeDomain", path: "Library/SMS/sms.db")
    public static let messageAttachments = (domain: "MediaDomain", prefix: "Library/SMS/Attachments/")
    public static let whatsAppDomain = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared"
    public static let whatsAppChats = (domain: whatsAppDomain, path: "ChatStorage.sqlite")
    public static let whatsAppCalls = (domain: whatsAppDomain, path: "CallHistory.sqlite")
    public static let whatsAppMedia = (domain: whatsAppDomain, prefix: "Message/Media/")
    public static let whatsAppMessage = (domain: whatsAppDomain, prefix: "Message/")
    public static let whatsAppPreferences = (domain: whatsAppDomain, path: "Library/Preferences/group.net.whatsapp.WhatsApp.shared.plist")
    public static let calls = (domain: "HomeDomain", path: "Library/CallHistoryDB/CallHistory.storedata")
    public static func wal(of path: String) -> String { path + "-wal" }
}
