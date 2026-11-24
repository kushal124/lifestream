import CryptoKit
import Foundation

public struct BackupFolder: Sendable, Equatable {
    public let url: URL
    public let udid: String
    public let device: String
    public let serial4: String?
    public let productType: String
    public let productVersion: String
    public var modelName: String { BackupModels.name(of: productType) }
    public let deviceName: String?
    public var name: String { deviceName ?? modelName }
    public let lastBackup: Date
    public let encrypted: Bool
    public let finished: Bool
    public let applications: Set<String>

    public var archiveId: String { "\(udid):\(Self.stamp.string(from: lastBackup))" }

    static let stamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    public static func list(in root: URL) throws -> [BackupFolder] {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory), isDirectory.boolValue else { return [] }
        let names: [URL]
        do { names = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) } catch {
            throw BackupError.unreadable("\(root.lastPathComponent) cannot be listed: \(error.localizedDescription)")
        }
        var folders: [BackupFolder] = []
        for url in names where (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            guard FileManager.default.fileExists(atPath: url.appendingPathComponent("Manifest.plist").path) else { continue }
            folders.append(try BackupFolder(at: url))
        }
        return folders.sorted { $0.lastBackup > $1.lastBackup }
    }

    public init(at url: URL) throws {
        self.url = url
        let manifest = try Self.plist(url.appendingPathComponent("Manifest.plist"))
        guard let lockdown = manifest["Lockdown"] as? [String: Any],
              let udid = lockdown["UniqueDeviceID"] as? String, !udid.isEmpty,
              let productType = lockdown["ProductType"] as? String else {
            throw BackupError.unreadable("Manifest.plist names no phone")
        }
        self.udid = udid
        self.device = String(Self.sha256(udid).prefix(16))
        self.productType = productType
        self.productVersion = lockdown["ProductVersion"] as? String ?? ""
        self.encrypted = manifest["IsEncrypted"] as? Bool ?? false
        self.applications = Set((manifest["Applications"] as? [String: Any])?.keys ?? [String: Any]().keys)
        let info = (try? Self.plist(url.appendingPathComponent("Info.plist"))) ?? [:]
        guard let last = (info["Last Backup Date"] as? Date) ?? (manifest["Date"] as? Date) else {
            throw BackupError.unreadable("Info.plist says no Last Backup Date")
        }
        self.lastBackup = last
        let serial = (info["Serial Number"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.serial4 = serial.isEmpty ? nil : String(Self.sha256(serial).prefix(4))
        let deviceName = (info["Device Name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.deviceName = deviceName.isEmpty ? nil : deviceName
        let status = (try? Self.plist(url.appendingPathComponent("Status.plist"))) ?? [:]
        self.finished = (status["SnapshotState"] as? String) == "finished"
    }

    static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func plist(_ url: URL) throws -> [String: Any] {
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw BackupError.unreadable("\(url.lastPathComponent) does not read") }
        guard let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
            throw BackupError.unreadable("\(url.lastPathComponent) is no property list")
        }
        return plist
    }
}

public enum BackupError: Error, Equatable, Sendable {
    case notFinished
    case passwordNeeded
    case wrongPassword
    case unreadable(String)
    case remade
}
