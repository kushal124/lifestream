import AppKit
import Foundation

enum AppPlacement {
    struct Folders: Equatable {
        let system: URL
        let user: URL

        static var conventional: Folders {
            Folders(system: URL(fileURLWithPath: "/Applications", isDirectory: true),
                    user: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true))
        }
    }

    enum Plan: Equatable {
        case move(from: URL, to: URL, replacing: Bool)
        case open(URL)
    }

    static let name = "Lifestream.app"

    static func plan(original: URL, folders: Folders, writable: (URL) -> Bool, exists: (URL) -> Bool,
                     usable: (URL) -> Bool, generation: (URL) -> Int?) -> Plan {
        let ours = generation(original) ?? 0
        let copies = [folders.system, folders.user].map { $0.appendingPathComponent(name, isDirectory: true) }
        for copy in copies where exists(copy) && usable(copy) && (generation(copy) ?? 0) >= ours {
            return .open(copy)
        }
        let system = copies[0]
        let target = writable(folders.system) && (!exists(system) || usable(system)) ? system : copies[1]
        return .move(from: original, to: target, replacing: exists(target))
    }

    static func original(_ bundle: URL = Bundle.main.bundleURL) -> URL {
        typealias IsTranslocated = @convention(c) (CFURL, UnsafeMutablePointer<DarwinBoolean>, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> DarwinBoolean
        typealias Original = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
        guard let security = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_NOW),
              let isSymbol = dlsym(security, "SecTranslocateIsTranslocatedURL"),
              let originalSymbol = dlsym(security, "SecTranslocateCreateOriginalPathForURL") else { return bundle }
        var translocated: DarwinBoolean = false
        guard unsafeBitCast(isSymbol, to: IsTranslocated.self)(bundle as CFURL, &translocated, nil).boolValue, translocated.boolValue,
              let url = unsafeBitCast(originalSymbol, to: Original.self)(bundle as CFURL, nil)?.takeRetainedValue() else { return bundle }
        return url as URL
    }

    static func generation(of app: URL) -> Int? {
        if let stamp = ReleaseStamp(manifest: app.appendingPathComponent("Contents/Resources/release/RELEASE.json")),
           let generation = stamp.generation { return generation }
        let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        return (info?["CFBundleShortVersionString"] as? String).flatMap { Int($0) }
    }

    static func plan(bundle: URL = Bundle.main.bundleURL, folders: Folders = .conventional, systemWritable: Bool = true) -> Plan {
        plan(original: original(bundle), folders: folders,
             writable: { (systemWritable || $0 != folders.system) && FileManager.default.isWritableFile(atPath: $0.path) },
             exists: { FileManager.default.fileExists(atPath: $0.path) },
             usable: { HomeAgents.placeRefusal($0) == nil },
             generation: generation(of:))
    }

    static func carry(_ plan: Plan) throws -> URL {
        switch plan {
        case .open(let copy):
            try? unquarantine(copy)
            return copy
        case .move(let from, let to, let replacing):
            let files = FileManager.default
            try files.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
            let staged = to.deletingLastPathComponent().appendingPathComponent(".Lifestream-\(UUID().uuidString).app", isDirectory: true)
            do {
                try files.copyItem(at: from, to: staged)
                try unquarantine(staged)
                if replacing {
                    _ = try files.replaceItemAt(to, withItemAt: staged)
                } else {
                    try files.moveItem(at: staged, to: to)
                }
            } catch {
                try? files.removeItem(at: staged)
                throw error
            }
            return to
        }
    }

    struct Placed: Equatable, Sendable {
        let app: URL
        let volume: URL?
    }

    static func place(bundle: URL = Bundle.main.bundleURL, folders: Folders = .conventional,
                      trash: (URL) -> Void = { try? FileManager.default.trashItem(at: $0, resultingItemURL: nil) }) throws -> Placed {
        let original = original(bundle)
        let first = plan(bundle: bundle, folders: folders)
        let app: URL
        do {
            app = try carry(first)
        } catch {
            guard case .move(_, let to, _) = first, to.deletingLastPathComponent() == folders.system else { throw error }
            app = try carry(plan(bundle: bundle, folders: folders, systemWritable: false))
        }
        let volume = diskImage(of: original)
        if case .move = first, volume == nil { trash(original) }
        return Placed(app: app, volume: volume)
    }

    static func whole(_ copy: URL, original: URL = original()) -> Bool {
        let busy = Date(timeIntervalSince1970: 473_385_600)
        guard let created = (try? copy.resourceValues(forKeys: [.creationDateKey]))?.creationDate, created > busy else { return false }
        func program(_ app: URL) -> Int? {
            guard let name = Bundle(url: app)?.executableURL?.lastPathComponent else { return nil }
            let path = app.appendingPathComponent("Contents/MacOS/\(name)").path
            return (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? nil
        }
        guard let ours = program(original), let theirs = program(copy) else { return false }
        return ours == theirs
    }

    static let quarantine = "com.apple.quarantine"

    static func unquarantine(_ bundle: URL) throws {
        var kept: Error?
        func clear(_ path: String) {
            guard removexattr(path, quarantine, XATTR_NOFOLLOW) != 0, errno != ENOATTR, kept == nil else { return }
            kept = CocoaError(.fileWriteNoPermission, userInfo: [NSFilePathErrorKey: path,
                                                                 NSUnderlyingErrorKey: POSIXError(POSIXErrorCode(rawValue: errno) ?? .EPERM)])
        }
        clear(bundle.path)
        if let walk = FileManager.default.enumerator(atPath: bundle.path) {
            while let relative = walk.nextObject() as? String { clear(bundle.appendingPathComponent(relative).path) }
        }
        if let kept { throw kept }
    }

    static func leftImages(running bundle: URL = Bundle.main.bundleURL, id: String? = Bundle.main.bundleIdentifier) -> [URL] {
        guard let id, diskImage(of: original(bundle)) == nil else { return [] }
        let volumes = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: [.volumeIsReadOnlyKey], options: [.skipHiddenVolumes]) ?? []
        return volumes.filter { volume in
            guard let image = diskImage(of: volume.appendingPathComponent(name)), image.standardizedFileURL == volume.standardizedFileURL else { return false }
            return Bundle(url: volume.appendingPathComponent(name))?.bundleIdentifier == id
        }
    }

    static func ejectLeftImages() {
        for volume in leftImages() { try? NSWorkspace.shared.unmountAndEjectDevice(at: volume) }
    }

    static func diskImage(of original: URL) -> URL? {
        let parts = original.standardizedFileURL.pathComponents
        guard parts.count > 2, parts[1] == "Volumes" else { return nil }
        let volume = URL(fileURLWithPath: "/Volumes/\(parts[2])", isDirectory: true)
        return (try? volume.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?.volumeIsReadOnly == true ? volume : nil
    }
}
