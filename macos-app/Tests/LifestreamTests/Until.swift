import Foundation
import XCTest
@testable import Lifestream

struct NeverHeld: Error {}

let waitLimit: TimeInterval = 30

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

extension GrantAsk.System {
    static let untouched = GrantAsk.System(held: { _ in false }, unanswered: { _ in false },
                                           question: { grant in XCTFail("a test asked macOS's question for \(grant)") },
                                           pane: { grant in XCTFail("a test opened \(grant)'s pane in System Settings") },
                                           settingsOpen: { false }, away: { false })
}
