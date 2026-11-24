import Foundation
import CoreGraphics
import CryptoKit
import XCTest
import Evidence
import DeviceFiles
@testable import Spool

enum SpoolFixtures {
    static func frame(width: Int = 128, height: Int = 96, value: UInt8) -> RawFrame {
        var bytes = Data(repeating: value, count: width * height * 4)
        for index in stride(from: 3, to: bytes.count, by: 4) { bytes[index] = 255 }
        return RawFrame(layout: FrameLayout(width: width, height: height, bytesPerRow: width * 4,
            bitmapInfo: SegmentCodec.bitmap, renderingIntent: 0,
            ICCData: CGColorSpace(name: CGColorSpace.sRGB)!.copyICCData()! as Data), data: bytes)
    }

    static func assertPixels(_ image: CaptureImage, near value: Int, tolerance: Int = 5,
                             file: StaticString = #filePath, line: UInt = #line) {
        guard case .raw(let frame) = image else {
            return XCTFail("Expected raw pixels", file: file, line: line)
        }
        XCTAssertLessThanOrEqual(abs(Int(frame.data[0]) - value), tolerance, file: file, line: line)
    }
}

class SpoolFormCase: XCTestCase {
    class var keyed: Bool { false }

    var root: URL!
    private(set) var files: DeviceFiles!
    private(set) var scratch: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let name = "spool-" + (Self.keyed ? "keyed-" : "plain-") + UUID().uuidString
        root = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent(name + "-scratch")
        files = DeviceFiles(Self.keyed ? .keyed(SymmetricKey(size: .bits256)) : .plain)
    }

    override func tearDownWithError() throws {
        for folder in [root, scratch].compactMap({ $0 }) where FileManager.default.fileExists(atPath: folder.path) {
            try FileManager.default.removeItem(at: folder)
        }
        try super.tearDownWithError()
    }

    func kept(_ url: URL) throws -> Data {
        try SpoolFiles.read(files, url, maximumBytes: Int.max)
    }

    func keep(_ data: Data, at url: URL) throws {
        try files.replace(url, with: data, commit: .ordered)
    }

    func assertInForm(_ url: URL, file: StaticString = #filePath, line: UInt = #line) throws {
        let disk = try Data(contentsOf: url)
        if Self.keyed {
            XCTAssertTrue([40, 0x80].contains(disk.first), "\(url.lastPathComponent) is encrypted", file: file, line: line)
            XCTAssertNotEqual(disk, try kept(url), file: file, line: line)
        } else {
            XCTAssertEqual(disk, try kept(url), "\(url.lastPathComponent) is plain", file: file, line: line)
        }
    }

    func scratchIsEmpty() -> Bool {
        ((try? FileManager.default.contentsOfDirectory(atPath: scratch.path)) ?? []).isEmpty
    }
}
