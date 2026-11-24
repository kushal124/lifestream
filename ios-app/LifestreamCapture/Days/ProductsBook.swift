import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import os

@MainActor
final class ProductsBook: ObservableObject {
    static let shared = ProductsBook(life: AppRuntime.shared.life,
                                     kept: AppRuntime.shared.root.appendingPathComponent(DisplayCaches.products, isDirectory: true))

    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "shelf")

    @Published private(set) var names: ProductNames

    private let life: LifeReader
    private let folder: URL
    private var read = false
    private var moved: String?
    private var reading: Task<Void, Never>?

    init(life: LifeReader, kept folder: URL) {
        self.life = life
        self.folder = folder
        names = (try? Data(contentsOf: folder.appendingPathComponent("products.json")))
            .flatMap { try? JSONDecoder().decode(ProductNames.self, from: $0) } ?? .none
    }

    func need() async {
        guard !read || moved != nil else { return }
        if let reading { return await reading.value }
        let task = Task { [life] in
            guard let answer = try? await life.products() else { return }
            self.read = true
            self.moved = nil
            self.keep(ProductNames(answer))
        }
        reading = task
        await task.value
        reading = nil
    }

    func saw(digest: String?) {
        guard let digest, digest != names.digest else { return }
        moved = digest
        Task { await need() }
    }

    private func keep(_ named: ProductNames) {
        guard named != names else { return }
        names = named
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileDurability.excludeFromBackup(folder)
            try JSONEncoder().encode(named).write(to: folder.appendingPathComponent("products.json"), options: FileDurability.unlockedOnly)
        } catch {
            Self.log.error("the products were not kept: \(String(describing: error), privacy: .public)")
        }
    }
}
