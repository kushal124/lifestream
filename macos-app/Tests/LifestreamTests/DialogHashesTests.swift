import XCTest
@testable import Lifestream

final class DialogHashesTests: XCTestCase {
    func testEveryDialogHashTheAppSendsIsTheSharedList() throws {
        let list = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../dashboard/test/mac-hashes.json")
        let shared = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: list)) as? [String])
        let knock = HomeReport.knock("arc", "Arc has been asking to connect since 14:02")
        let sent = [
            "dialog=\(AppSection.settings)",
            "dialog=\(AppSection.thisMac)",
            "dialog=\(AppSection.privacy)",
            Need.connect(knock, browser: knock.acts[0]).page,
        ].compactMap { $0 }
        XCTAssertEqual(Set(sent), Set(shared))
        XCTAssertEqual(sent.count, shared.count)
    }
}
