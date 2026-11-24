import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class ProofLinesTests: XCTestCase {
    static let products: ProductNames = {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/proof-report.json")
        let report = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        var products: [String: Any] = [:]
        for row in report["connectors"] as? [[String: Any]] ?? [] {
            guard let product = row["product"] as? String, let name = row["name"] as? String else { continue }
            products[product] = [
                "name": name, "row": name, "vendor": "example", "icon": row["icon"] as? String ?? "info",
                "type": (row["type"] as? [String: Any])?["key"] ?? NSNull(), "connector": row["id"] ?? product,
            ]
        }
        let read = ["digest": report["products"] ?? "sha256:", "products": products]
        let decoded = (try? JSONSerialization.data(withJSONObject: read)).flatMap { try? JSONDecoder().decode(HomeLink.Products.self, from: $0) }
        return decoded.map(ProductNames.init) ?? .none
    }()

    func testTheProofReportNamesItsProducts() {
        XCTAssertEqual(Self.products.name(of: "example-chat:person-a@example.com:cloud"), "Example Chat")
        XCTAssertEqual(Self.products.icon(of: "example-log:local:macbook-pro-0001"), "recording")
    }
}
