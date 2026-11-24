import AppKit
import Foundation
import HomeLink
import SystemConfiguration

struct MachineLook: Decodable, Equatable {
    enum Form: String, Decodable, Equatable, Sendable {
        case empty, plain, keyed
    }

    struct Folder: Decodable, Equatable {
        let path: String
        let refused: String?
        let free_bytes: Double
        let door: String
        var form = Form.empty
        var id: String? = nil
    }

    let folder: Folder?
    var disk: Disk? = nil

    private enum CodingKeys: String, CodingKey {
        case folder
    }

    static func read(_ folder: URL, release: BundledRelease) throws -> MachineLook {
        var look = try JSONDecoder().decode(MachineLook.self, from: release.home(["machine", folder.path]))
        look.disk = look.folder.flatMap { Disk.of(folder, free: $0.free_bytes) }
        return look
    }

    static func bytes(_ count: Double) -> String {
        if count >= 1e12 { return String(format: "%.1f TB", (count / 1e12 * 10).rounded() / 10) }
        if count >= 1e9 { return "\(Int((count / 1e9).rounded())) GB" }
        return ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }
}

enum FolderHome: Equatable, Sendable {
    case new
    case plain
    case encrypted(id: String)

    static func of(_ folder: MachineLook.Folder) -> FolderHome {
        switch folder.form {
        case .empty: .new
        case .plain: .plain
        case .keyed: folder.id.map { .encrypted(id: $0) } ?? .plain
        }
    }

    var word: String {
        switch self {
        case .new: "new"
        case .plain: "plain"
        case .encrypted: "encrypted"
        }
    }
}

struct Disk: Encodable, Equatable {
    let name: String
    let totalBytes: Double
    let usedBytes: Double
    let freeBytes: Double

    static func of(_ folder: URL, free: Double) -> Disk? {
        var at = folder.standardizedFileURL
        while !FileManager.default.fileExists(atPath: at.path), at.pathComponents.count > 1 { at.deleteLastPathComponent() }
        guard let values = try? at.resourceValues(forKeys: [.volumeLocalizedNameKey, .volumeTotalCapacityKey]),
              let total = values.volumeTotalCapacity, total > 0 else { return nil }
        return of(name: values.volumeLocalizedName ?? at.lastPathComponent, total: Double(total), free: free)
    }

    static func of(name: String, total: Double, free: Double) -> Disk {
        Disk(name: name, totalBytes: total, usedBytes: max(0, total - free), freeBytes: free)
    }

    private enum CodingKeys: String, CodingKey {
        case name
        case totalBytes = "total_bytes"
        case usedBytes = "used_bytes"
        case freeBytes = "free_bytes"
    }
}

enum Runway {
    static let macWeekly: Double = 3e9
    static let phoneWeekly: Double = 5e9
    static var daily: Double { (macWeekly + phoneWeekly) / 7 }

    static func days(free: Double) -> Int {
        Int(Double(Room.spare(free: Int64(free))) / daily)
    }

    static func full(free: Double) -> String? {
        Room(free: Int64(free)) == .ok ? nil : "This disk has \(MachineLook.bytes(free)) free. Choose a folder on a disk with more room."
    }
}
