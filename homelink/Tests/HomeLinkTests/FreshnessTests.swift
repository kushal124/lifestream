import Foundation
import XCTest

final class FreshnessTests: XCTestCase {
    private let prelude = """
        import HomeLink
        func reclaim(_ answer: FreshAnswer) -> Int { answer.sources.count }
        """

    func testTheControlCompiles() throws {
        let result = try typecheck(prelude + """

            func show(_ saved: SavedAnswer?) -> Int { saved?.sources.count ?? 0 }
            func ship(_ link: HomeLink) async throws -> Int { reclaim(try await link.exchange()) }
            """)
        XCTAssertEqual(result.status, 0, result.output)
    }

    func testASavedAnswerCannotBePassedWhereDeletionIsDecided() throws {
        let result = try typecheck(prelude + """

            func ship(_ link: HomeLink) -> Int { reclaim(link.saved!) }
            """)
        XCTAssertNotEqual(result.status, 0)
        XCTAssertTrue(result.output.contains("cannot convert value of type 'SavedAnswer'"), result.output)
    }

    func testNothingOutsideHomeLinkMakesAFreshAnswer() throws {
        for forgery in ["FreshAnswer(link.saved!.answer, at: Date())",
                        "try JSONDecoder().decode(FreshAnswer.self, from: Data())",
                        "link.saved! as! FreshAnswer"] {
            let result = try typecheck(prelude + """

                import Foundation
                func ship(_ link: HomeLink) throws -> Int { reclaim(\(forgery)) }
                """)
            if forgery.contains("as!") {
                XCTAssertTrue(result.output.contains("always fails"), result.output)
            } else {
                XCTAssertNotEqual(result.status, 0, forgery)
            }
        }
    }


    private func typecheck(_ source: String) throws -> (status: Int32, output: String) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("freshness-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("case.swift")
        try source.write(to: file, atomically: true, encoding: .utf8)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["swiftc", "-typecheck", "-I", try modules().path, file.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        return (process.terminationStatus, output)
    }

    private func modules() throws -> URL {
        let products = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
        for folder in [products.appendingPathComponent("Modules"), products]
        where FileManager.default.fileExists(atPath: folder.appendingPathComponent("HomeLink.swiftmodule").path) {
            return folder
        }
        XCTFail("the built HomeLink module is not beside the tests: the proof did not run")
        throw CocoaError(.fileNoSuchFile)
    }
}
