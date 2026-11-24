import Foundation
import HomeLink

public struct MacNetwork: Sendable {
    public static let system = MacNetwork(SystemNetwork.shared)

    private let watch: any NetworkWatch

    public init(_ watch: any NetworkWatch) {
        self.watch = watch
    }

    public var metered: Metered? {
        guard let facts = watch.facts else { return .expensive }
        return facts.metered
    }

    public func metered(to link: HomeLink) -> Metered? {
        guard let home = (try? link.name()) ?? nil, HomeLink.isLoopback(host: home.host ?? "") else { return metered }
        return nil
    }

    public func tell(_ link: HomeLink) async {
        for await facts in watch.changes() { link.tell(network: NetworkCost(facts)) }
    }
}
