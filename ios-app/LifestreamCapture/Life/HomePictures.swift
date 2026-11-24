import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore
import OSLog
import SwiftUI
import Synchronization
import UIKit

@MainActor
enum HomePictures {
    static let shared = Pictures<UIImage>(budget: 8_000_000, read: { [life = AppRuntime.shared.life, shelf = FaceShelf.shared] hash, size in
        guard size == .tile, shelf.wants(hash) else { return try await life.picture(hash, size: size) }
        if let kept = shelf.bytes(hash) { return kept }
        let data = try await life.picture(hash, size: size)
        shelf.keep(hash, data)
        return data
    }) { data, side in
        PictureDecode.decode(data, side: side).map { (UIImage(cgImage: $0), $0.width * $0.height) }
    }

    struct Want: Hashable {
        let size: HomeLink.PictureSize
        let side: Int
    }

    static func want(_ box: CGSize, scale: CGFloat, fill: Bool) -> Want {
        let width = box.width * scale, height = box.height * scale
        let longest = Int(max(width, height).rounded(.up))
        return Want(size: HomeLink.PictureSize(box: longest), side: max(1, Int((fill ? max(width, height) : min(width, height)).rounded(.up))))
    }

    static func want(_ size: Monogram.Size, scale: CGFloat) -> Want {
        want(CGSize(width: size.side, height: size.side), scale: scale, fill: true)
    }

    static var screen: CGSize {
        (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.size ?? CGSize(width: 390, height: 844)
    }
}

extension Pictures where Picture == UIImage {
    func face(_ hash: String?) -> Image? {
        picture(hash, .tile)?.cgImage.map { Image(decorative: $0, scale: 1) }
    }
}

extension View {
    func readsFace(_ hash: String?, size: Monogram.Size) -> some View {
        modifier(ReadsFace(hash: hash, size: size))
    }

    func facesValue(_ hash: String?, drawn: Image?) -> some View {
        modifier(FacesValue(value: drawn == nil ? "monogram" : hash ?? ""))
    }
}

private struct ReadsFace: ViewModifier {
    let hash: String?
    let size: Monogram.Size
    @Environment(\.displayScale) private var scale

    private struct Wanted: Equatable {
        let hash: String?
        let want: HomePictures.Want
        let held: Bool
    }

    func body(content: Content) -> some View {
        let pictures = HomePictures.shared
        let want = HomePictures.want(size, scale: scale)
        content.task(id: Wanted(hash: hash, want: want, held: hash.map { pictures.holds($0, want.size, side: want.side) } ?? true)) {
            guard let hash else { return }
            FaceShelf.shared.want(hash)
            _ = try? await pictures.read(hash, want.size, side: want.side)
        }
    }
}

private struct FacesValue: ViewModifier {
    let value: String

    func body(content: Content) -> some View {
        if AppRuntime.isUITesting {
            content.accessibilityValue(value)
        } else {
            content
        }
    }
}

final class FaceShelf: Sendable {
    @MainActor static let shared = FaceShelf(folder: AppRuntime.shared.root.appendingPathComponent(DisplayCaches.faces, isDirectory: true))

    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "faces")
    static let budget = 48_000_000

    private let folder: URL
    private let faces = Mutex<Set<String>>([])

    init(folder: URL) {
        self.folder = folder
        Task.detached(priority: .background) { [folder] in Self.trim(folder) }
    }

    func want(_ hash: String) {
        _ = faces.withLock { $0.insert(hash) }
    }

    func wants(_ hash: String) -> Bool {
        faces.withLock { $0.contains(hash) }
    }

    func bytes(_ hash: String) -> Data? {
        let file = self.file(hash)
        guard let data = try? Data(contentsOf: file) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return data
    }

    func keep(_ hash: String, _ data: Data) {
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileDurability.excludeFromBackup(folder)
            try data.write(to: file(hash), options: FileDurability.unlockedOnly)
        } catch {
            Self.log.error("a face was not kept: \(String(describing: error), privacy: .public)")
        }
    }

    func forget() {
        faces.withLock { $0.removeAll() }
        try? FileManager.default.removeItem(at: folder)
    }

    private func file(_ hash: String) -> URL {
        folder.appendingPathComponent(String(hash.dropFirst("sha256:".count)))
    }

    private static func trim(_ folder: URL) {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys) else { return }
        let held = files.compactMap { file -> (URL, Int, Date)? in
            guard let values = try? file.resourceValues(forKeys: Set(keys)) else { return nil }
            return (file, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 > $1.2 }
        var total = 0
        for (file, size, _) in held {
            total += size
            if total > budget { try? FileManager.default.removeItem(at: file) }
        }
    }
}
