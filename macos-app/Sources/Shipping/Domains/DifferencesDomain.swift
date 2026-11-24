import Foundation
import HomeLink

final class DifferencesDomain: ShippingDomain {
    let sourceId: String
    let name: String
    private let feeder: String
    private let ledgers: Ledgers
    private let hashCache: URL?
    private let stores: @Sendable () throws -> [Differences.Store]
    private let report: @Sendable (String) -> Void
    private let historyOwed = SealNote(false)
    private let filesUnread = SealNote<Unread?>(nil)
    private let stated = SealNote<Through?>(nil)

    init(sourceId: String, name: String, feeder: String, ledgers: Ledgers, hashCache: URL? = nil,
         report: @escaping @Sendable (String) -> Void = Differences.log,
         stores: @escaping @Sendable () throws -> [Differences.Store]) {
        self.sourceId = sourceId
        self.name = name
        self.feeder = feeder
        self.ledgers = ledgers
        self.hashCache = hashCache
        self.stores = stores
        self.report = report
    }

    func seal(_ request: SealRequest) throws -> [SealedBundle] {
        let memory = ledgers.memory(pass: request.custody.pass, source: sourceId)
        var cache = HashCache(file: hashCache ?? memory.appendingPathComponent("hashes.json"), files: ledgers.files)
        let sealed = try Differences.seal(request, sourceId: sourceId, feeder: feeder, memory: memory,
                                          stores: try stores(), files: ledgers.files, cache: &cache, report: report)
        historyOwed.value = sealed.owesHistory
        stated.value = sealed.through
        filesUnread.value = .files(cache.failing(at: request.fetchedAt))
        try? cache.save()
        return sealed.bundles
    }

    var owesHistory: Bool { historyOwed.value }
    var unread: Unread? { filesUnread.value }
    var through: Through? { stated.value }
}
