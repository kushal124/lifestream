import Foundation
import HomeLink
import Shipping

final class MacLimits: @unchecked Sendable {
    static let every: TimeInterval = 60

    let disk: Volume
    private let network: MacNetwork
    private let link: HomeLink
    private var watching: [Task<Void, Never>] = []

    init(disk: Volume, network: MacNetwork = .system, link: HomeLink) {
        self.disk = disk
        self.network = network
        self.link = link
    }

    deinit {
        for task in watching { task.cancel() }
    }

    func start() {
        let link = link
        disk.observe { link.tell(room: $0) }
        link.tell(room: disk.room)
        let disk = disk, network = network
        watching = [
            Task { await network.tell(link) },
            Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(Self.every))
                    _ = disk.room
                }
            },
        ]
    }
}
