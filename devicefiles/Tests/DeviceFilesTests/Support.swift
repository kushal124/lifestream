import CryptoKit
import Foundation
import XCTest
@testable import DeviceFiles

let testKey = SymmetricKey(data: Data(0..<32))

let repository = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func vectorPlain(_ count: Int) -> Data {
    Data((0..<count).map { UInt8(truncatingIfNeeded: ($0 * 7) + (($0 >> 8) * 13) + 1) })
}

func bytes(from: Int, count: Int) -> Data {
    Data((0..<count).map { UInt8(truncatingIfNeeded: from + $0) })
}

func hex(_ text: String) -> Data {
    var data = Data()
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        data.append(UInt8(text[index..<next], radix: 16)!)
        index = next
    }
    return data
}

func raw(_ url: URL) throws -> Data {
    try Data(contentsOf: url)
}

class FilesTestCase: XCTestCase {
    var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("device-files-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        DeviceFiles.writeLimit = nil
        DeviceFiles.failStep = nil
        DeviceFiles.flushObserver = nil
        DeviceFiles.meter = nil
        try FileManager.default.removeItem(at: directory)
    }

    func forms() -> [(name: String, files: DeviceFiles)] {
        [("plain", DeviceFiles(.plain)), ("keyed", DeviceFiles(.keyed(testKey)))]
    }

    func file(_ name: String, _ form: String = "") -> URL {
        directory.appendingPathComponent(form.isEmpty ? name : "\(form)-\(name)")
    }
}
