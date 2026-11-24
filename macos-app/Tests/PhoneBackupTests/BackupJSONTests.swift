import Foundation
import XCTest
@testable import PhoneBackup

final class BackupJSONTests: XCTestCase {
    private static let cases = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/connect/imports/iphone-backup/test/backup-json.json")

    func testEveryValidCaseIsTheWritersBytes() throws {
        let file = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: Self.cases)) as? [String: Any])
        let valid = try XCTUnwrap(file["valid"] as? [[String: Any]])
        XCTAssertFalse(valid.isEmpty, "the shared cases hold valid cases")
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime]
        for each in valid {
            let name = try XCTUnwrap(each["case"] as? String)
            let backup = try XCTUnwrap(each["backup"] as? [String: Any], name)
            let text = try XCTUnwrap(each["text"] as? String, name)
            let store = try XCTUnwrap(BackupPull.Store(rawValue: try XCTUnwrap(backup["store"] as? String, name)), name)
            let accounts = try XCTUnwrap(backup["accounts"] as? [String: [String]], name)
            let facts = BackupPull.Facts(
                store: store,
                accounts: accounts.mapValues { $0.reversed() + $0 },
                device: try XCTUnwrap(backup["device"] as? String, name),
                encrypted: try XCTUnwrap(backup["encrypted"] as? Bool, name),
                ios: try XCTUnwrap(backup["ios"] as? String, name),
                lastBackup: try XCTUnwrap(stamp.date(from: try XCTUnwrap(backup["last_backup"] as? String, name)), name),
                model: try XCTUnwrap(backup["model"] as? String, name),
                modelName: try XCTUnwrap(backup["model_name"] as? String, name),
                serial4: backup["serial4"] as? String)
            let written = try BackupPull.backupJSON(facts)
            XCTAssertEqual(String(decoding: written, as: UTF8.self), text, name)
            XCTAssertEqual(written, Data(text.utf8), name)
        }
    }
}
