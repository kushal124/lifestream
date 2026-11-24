import Foundation
import XCTest

struct NeverHeld: Error {}

let waitLimit: TimeInterval = 30

extension XCTestCase {
    func until(_ what: String, file: StaticString = #filePath, line: UInt = #line, _ ready: () -> Bool) throws {
        let ends = Date().addingTimeInterval(waitLimit)
        while !ready() {
            guard Date() < ends else {
                XCTFail("never came in 30 s: \(what)", file: file, line: line)
                throw NeverHeld()
            }
            Thread.sleep(forTimeInterval: 0.01)
        }
    }
}
