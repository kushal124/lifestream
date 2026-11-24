import Foundation
import XCTest

struct NeverHeld: Error {}

let waitLimit: TimeInterval = 30

extension XCTestCase {
    func until(_ what: String, isolation: isolated (any Actor)? = #isolation, file: StaticString = #filePath, line: UInt = #line,
               _ ready: () async -> Bool) async throws {
        let ends = Date().addingTimeInterval(waitLimit)
        while !(await ready()) {
            guard Date() < ends else {
                XCTFail("never came in 30 s: \(what)", file: file, line: line)
                throw NeverHeld()
            }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }
}
