import AppKit
import Foundation
import Shipping
import SQLite3

enum Detection {
    struct Places: Sendable {
        let applications: [URL]
        let support: URL

        static let conventional = Places(applications: ShippingDomains.applicationFolders,
                                         support: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support"))
    }

    struct App: Equatable, Sendable {
        let id: String
        let name: String
        let url: URL
        var icon = ""
    }

    static let iconPixels = 64
    private static let icons = IconCache()

    static func iconURL(_ id: String) -> String {
        "\(BundledPage.scheme)://\(BundledPage.iconHost)/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
    }

    static func iconPNG(_ id: String) -> Data? {
        icons.found(id).flatMap(icon(of:))
    }

    static func icon(of app: URL) -> Data? {
        let changed = (try? app.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
        return icons.value(for: app.path, changed: changed) {
            let side = CGFloat(iconPixels)
            let image = NSWorkspace.shared.icon(forFile: app.path)
            guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: iconPixels, pixelsHigh: iconPixels,
                                                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
            image.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .copy, fraction: 1)
            NSGraphicsContext.restoreGraphicsState()
            return bitmap.representation(using: .png, properties: [:])
        }
    }
}

extension Detection {
    struct Family: Equatable, Sendable {
        let id: String
        let name: String
        let bundle: String
        let folder: String
    }

    static let families: [Family] = [
        Family(id: "chrome", name: "Chrome", bundle: "com.google.Chrome", folder: "Google/Chrome"),
        Family(id: "arc", name: "Arc", bundle: "company.thebrowser.Browser", folder: "Arc/User Data"),
        Family(id: "dia", name: "Dia", bundle: "company.thebrowser.dia", folder: "Dia/User Data"),
        Family(id: "brave", name: "Brave", bundle: "com.brave.Browser", folder: "BraveSoftware/Brave-Browser"),
        Family(id: "edge", name: "Microsoft Edge", bundle: "com.microsoft.edgemac", folder: "Microsoft Edge"),
        Family(id: "vivaldi", name: "Vivaldi", bundle: "com.vivaldi.Vivaldi", folder: "Vivaldi"),
        Family(id: "comet", name: "Comet", bundle: "ai.perplexity.comet", folder: "Comet"),
        Family(id: "chromium", name: "Chromium", bundle: "org.chromium.Chromium", folder: "Chromium"),
        Family(id: "chrome-beta", name: "Chrome Beta", bundle: "com.google.Chrome.beta", folder: "Google/Chrome Beta"),
    ]

    static func family(_ id: String) -> Family? {
        families.first { $0.id == id }
    }

    static func apps(_ places: Places = .conventional) -> [App] {
        var seen = Set<String>()
        var found: [App] = []
        for folder in places.applications {
            let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
            for name in names.sorted() where name.hasSuffix(".app") {
                let app = folder.appendingPathComponent(name, isDirectory: true)
                let info = app.appendingPathComponent("Contents/Info.plist")
                guard let plist = NSDictionary(contentsOf: info), let id = plist["CFBundleIdentifier"] as? String,
                      seen.insert(id).inserted else { continue }
                icons.remember(id, at: app)
                found.append(App(id: id, name: shownName(app), url: app, icon: icon(of: app) == nil ? "" : iconURL(id)))
            }
        }
        return found
    }

    static func app(at url: URL) -> App? {
        let info = url.appendingPathComponent("Contents/Info.plist")
        guard let plist = NSDictionary(contentsOf: info), let id = plist["CFBundleIdentifier"] as? String else { return nil }
        icons.remember(id, at: url)
        return App(id: id, name: shownName(url), url: url, icon: icon(of: url) == nil ? "" : iconURL(id))
    }

    static func shownName(_ app: URL) -> String {
        let shown = FileManager.default.displayName(atPath: app.path)
        let name = shown.hasSuffix(".app") ? String(shown.dropLast(4)) : shown
        return name.isEmpty ? app.deletingPathExtension().lastPathComponent : name
    }

    struct Browser: Encodable, Equatable, Sendable {
        struct Profile: Encodable, Equatable, Sendable {
            let id: String
            let name: String
        }

        let id: String
        let name: String
        let profiles: [Profile]
    }

    static func browsers(_ apps: [App], support: URL = Places.conventional.support) -> [Browser] {
        let ids = Set(apps.map(\.id))
        return families.filter { ids.contains($0.bundle) }.map { family in
            Browser(id: family.id, name: family.name, profiles: profiles(support.appendingPathComponent(family.folder)))
        }
    }

    static func profiles(_ folder: URL) -> [Browser.Profile] {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("Local State")),
              let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let cache = (state["profile"] as? [String: Any])?["info_cache"] as? [String: Any] else { return [] }
        return cache.keys.sorted { lhs, rhs in lhs.localizedStandardCompare(rhs) == .orderedAscending }.compactMap { folder in
            guard let id = profileAccount(folder: folder) else { return nil }
            let name = ((cache[folder] as? [String: Any])?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? folder
            return Browser.Profile(id: id, name: name)
        }
    }

    static func profileAccount(folder: String) -> String? {
        let person = folder == "Default" || (folder.hasPrefix("Profile ") && folder.count > 8 && folder.dropFirst(8).allSatisfy { $0.isASCII && $0.isNumber })
        return person ? folder.lowercased().replacingOccurrences(of: " ", with: "-") : nil
    }

    static func sites(of url: URL) -> [String] {
        guard let host = url.host?.lowercased() else { return [] }
        let site = host.split(separator: ".").suffix(2).joined(separator: ".")
        return site == "openai.com" ? [site, "chatgpt.com"] : [site]
    }

    static func browserUsing(_ sites: [String], scratch: URL, places: Places = .conventional,
                             defaultBrowser: String? = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com")!)
                                 .flatMap { Bundle(url: $0)?.bundleIdentifier }) -> URL? {
        let users = families.filter { family in
            let folder = places.support.appendingPathComponent(family.folder, isDirectory: true)
            return historyFolders(folder).contains { profile in
                sites.contains { visited($0, history: profile.appendingPathComponent("History"), scratch: scratch) }
            }
        }
        guard let first = users.first, !users.contains(where: { $0.bundle == defaultBrowser }) else { return nil }
        return browserApp(first.id, places: places)?.1
    }

    private static func historyFolders(_ folder: URL) -> [URL] {
        var names = ["Default"]
        if let data = try? Data(contentsOf: folder.appendingPathComponent("Local State")),
           let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let cache = (state["profile"] as? [String: Any])?["info_cache"] as? [String: Any] {
            names = Array(Set(names + cache.keys)).sorted()
        }
        return names.map { folder.appendingPathComponent($0, isDirectory: true) }
            .filter { FileManager.default.fileExists(atPath: $0.appendingPathComponent("History").path) }
    }

    static func visited(_ site: String, history: URL, scratch: URL) -> Bool {
        let copy = scratch.appendingPathComponent("history-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: copy) }
        guard (try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])) != nil,
              (try? FileManager.default.copyItem(at: history, to: copy)) != nil else { return false }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(copy.path, &handle, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let handle else {
            sqlite3_close(handle)
            return false
        }
        defer { sqlite3_close(handle) }
        var statement: OpaquePointer?
        let sql = "SELECT 1 FROM urls WHERE url LIKE ?1 OR url LIKE ?2 LIMIT 1"
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { return false }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(statement, 1, "https://\(site)/%", -1, transient)
        sqlite3_bind_text(statement, 2, "https://%.\(site)/%", -1, transient)
        return sqlite3_step(statement) == SQLITE_ROW
    }

    static func browserApp(_ id: String, places: Places = .conventional,
                           registered: (String) -> URL? = { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }) -> (Family, URL)? {
        guard let family = family(id) else { return nil }
        guard let app = apps(places).first(where: { $0.id == family.bundle })?.url ?? registered(family.bundle) else { return nil }
        return (family, app)
    }
}

private final class IconCache: @unchecked Sendable {
    private let lock = NSLock()
    private var drawn: [String: (changed: Date?, png: Data?)] = [:]
    private var apps: [String: URL] = [:]

    func value(for path: String, changed: Date?, draw: () -> Data?) -> Data? {
        if let hit = lock.withLock({ drawn[path] }), hit.changed == changed { return hit.png }
        let png = draw()
        lock.withLock { drawn[path] = (changed, png) }
        return png
    }

    func remember(_ id: String, at url: URL) { lock.withLock { apps[id] = url } }

    func found(_ id: String) -> URL? { lock.withLock { apps[id] } }
}
