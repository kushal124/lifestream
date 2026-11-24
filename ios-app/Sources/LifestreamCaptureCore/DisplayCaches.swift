import Foundation

public enum DisplayCaches {
    public static let faces = "faces", people = "people", products = "products", shelf = "shelf", search = "search", pages = "pages"
    public static let folders = [faces, people, products, shelf, search, pages]
    public static let places = "places"
    public static let files = [places + "/places.json"]

    public static func listed(root: URL) -> [URL] {
        let manager = FileManager.default
        var found = files.map { root.appendingPathComponent($0) }.filter { manager.fileExists(atPath: $0.path) }
        for folder in folders.map({ root.appendingPathComponent($0, isDirectory: true) }) {
            guard let walk = manager.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) else { continue }
            for case let file as URL in walk where (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true {
                found.append(file)
            }
        }
        return found
    }

    public static func weaker(root: URL) -> [URL] {
        #if os(iOS)
            listed(root: root).filter { file in
                let protection = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.protectionKey] as? FileProtectionType
                return protection != .complete
            }
        #else
            []
        #endif
    }

    public static func folders(root: URL) -> [URL] {
        (folders + files.map { ($0 as NSString).deletingLastPathComponent })
            .map { root.appendingPathComponent($0, isDirectory: true) }
    }

    public static func assert(root: URL) {
        for folder in folders(root: root) where FileManager.default.fileExists(atPath: folder.path) {
            try? FileDurability.excludeFromBackup(folder)
        }
        #if os(iOS) && !targetEnvironment(simulator)
            for file in weaker(root: root) {
                try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
            }
        #endif
    }
}
