import Foundation
import HomeLink

public struct ProductNames: Codable, Sendable, Equatable {
    public struct Named: Codable, Sendable, Equatable {
        public let name: String
        public let row: String
        public let icon: String?
        public let type: String?
        public let connector: String?

        public init(name: String, row: String, icon: String?, type: String?, connector: String?) {
            self.name = name
            self.row = row
            self.icon = icon
            self.type = type
            self.connector = connector
        }
    }

    public let digest: String?
    public let products: [String: Named]

    public init(digest: String?, products: [String: Named]) {
        self.digest = digest
        self.products = products
    }

    public init(_ read: HomeLink.Products) {
        self.init(digest: read.digest, products: read.products.mapValues {
            Named(name: $0.name, row: $0.row, icon: $0.icon, type: $0.type, connector: $0.connector)
        })
    }

    public static let none = ProductNames(digest: nil, products: [:])

    public static func product(of source: String) -> String {
        String(source.prefix { $0 != ":" })
    }

    public func name(of source: String) -> String {
        let product = Self.product(of: source)
        return products[product]?.name ?? product
    }

    public func row(of source: String) -> String {
        let product = Self.product(of: source)
        return products[product]?.row ?? product
    }

    public func icon(of source: String) -> String? {
        products[Self.product(of: source)]?.icon
    }

    public func connectors(of type: String) -> [(product: String, named: Named)] {
        products.filter { $0.value.type == type && $0.value.connector == $0.key }.sorted { $0.key < $1.key }
            .map { (product: $0.key, named: $0.value) }
    }
}
