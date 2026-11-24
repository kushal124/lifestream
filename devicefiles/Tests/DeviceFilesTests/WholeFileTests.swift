import CryptoKit
import Foundation
import XCTest
@testable import DeviceFiles

final class WholeFileTests: FilesTestCase {
    private struct Tink: Decodable {
        let key: String
        let vectors: [Vector]
    }

    private struct Vector: Decodable {
        let segment: Int
        let associatedData: String
        let plainLength: Int
        let sealedLength: Int
        let file: String?
    }

    private struct Mac: Decodable {
        let key: String
        let associatedData: String
        let segment: Int
        let header: String
        let files: [Fixture]
        let log: LogFixture
    }

    private struct Fixture: Decodable {
        let file: String
        let plainLength: Int
    }

    private struct LogFixture: Decodable {
        let file: String
        let salt: String
        let records: [Record]
    }

    private struct Record: Decodable {
        let text: String
        let nonce: String
    }

    private let vectors = repository.appendingPathComponent("packages/core/sealed-vectors")
    private let mac = WholeFile.Keying.mac(testKey)

    func testTinksOwnVectorsOpen() throws {
        let tink = try JSONDecoder().decode(Tink.self, from: Data(contentsOf: vectors.appendingPathComponent("tink.json")))
        XCTAssertEqual(hex(tink.key), Data(0..<32))
        let kept = tink.vectors.filter { $0.file != nil }
        XCTAssertGreaterThan(kept.count, 6)
        for vector in kept {
            let disk = try Data(contentsOf: vectors.appendingPathComponent(vector.file!))
            XCTAssertEqual(disk.count, vector.sealedLength)
            let keying = WholeFile.Keying(key: testKey, associatedData: Data(vector.associatedData.utf8), segment: vector.segment)
            XCTAssertEqual(try WholeFile.decrypt(disk, keying, name: vector.file!), vectorPlain(vector.plainLength), vector.file!)
            XCTAssertEqual(try WholeFile.layout(size: disk.count, segment: vector.segment, name: vector.file!).plainLength, vector.plainLength)
        }
    }

    func testTheFilesItWritesAreTheFixturesSealedTsOpens() throws {
        let folder = vectors.appendingPathComponent("mac")
        let manifest = try JSONDecoder().decode(Mac.self, from: Data(contentsOf: folder.appendingPathComponent("mac.json")))
        XCTAssertEqual(hex(manifest.key), Data(0..<32))
        XCTAssertEqual(manifest.associatedData, "lifestream-mac:1:file")
        XCTAssertEqual(manifest.segment, WholeFile.segment)
        let writing = ProcessInfo.processInfo.environment["LIFESTREAM_WRITE_FIXTURES"] == "1"
        for fixture in manifest.files {
            let written = WholeFile.encrypt(vectorPlain(fixture.plainLength), mac, header: hex(manifest.header))
            let url = folder.appendingPathComponent(fixture.file)
            if writing { try written.write(to: url) }
            XCTAssertEqual(written, try Data(contentsOf: url), fixture.file)
            XCTAssertEqual(try WholeFile.decrypt(written, mac, name: fixture.file), vectorPlain(fixture.plainLength))
        }
        let salt = hex(manifest.log.salt)
        let key = LogLayout.key(testKey, salt: salt)
        var log = LogLayout.header(salt: salt)
        for (index, record) in manifest.log.records.enumerated() {
            log.append(LogLayout.record(Data(record.text.utf8), index: UInt64(index), key: key, nonce: hex(record.nonce)))
        }
        let url = folder.appendingPathComponent(manifest.log.file)
        if writing { try log.write(to: url) }
        XCTAssertEqual(log, try Data(contentsOf: url))
        XCTAssertEqual(try DeviceFiles(.keyed(testKey)).read(url, maximumBytes: 1_000), Data(manifest.log.records.map(\.text).joined().utf8))
    }

    func testEverySegmentEdgeRoundTripsAndCountsItsPlainBytes() throws {
        let first = WholeFile.segment - WholeFile.headerBytes - WholeFile.tagBytes
        let later = WholeFile.segment - WholeFile.tagBytes
        let header = WholeFile.freshHeader()
        for count in [0, 1, first - 1, first, first + 1, first + later - 1, first + later, first + later + 1, first + 2 * later + 5] {
            let plain = vectorPlain(count)
            let disk = WholeFile.encrypt(plain, mac, header: header)
            let segments = count <= first ? 1 : 1 + (count - first + later - 1) / later
            XCTAssertEqual(disk.count, count + WholeFile.headerBytes + segments * WholeFile.tagBytes, "\(count)")
            XCTAssertEqual(try WholeFile.layout(size: disk.count, segment: WholeFile.segment, name: "edge").plainLength, count)
            XCTAssertEqual(try WholeFile.decrypt(disk, mac, name: "edge"), plain)
            let streamed = WholeFile.Encrypting(mac, header: header)
            var pieces = Data()
            var at = 0
            while at < count {
                let end = min(count, at + 7_919)
                pieces.append(streamed.update(plain.subdata(in: at..<end)))
                at = end
            }
            pieces.append(streamed.finish())
            XCTAssertEqual(pieces, disk, "the same bytes written in pieces, \(count)")
        }
    }

    func testACutFileIsRefused() throws {
        let disk = WholeFile.encrypt(vectorPlain(100_000), mac)
        for cut in [1, 16, 17, 40_000] {
            XCTAssertThrowsError(try WholeFile.decrypt(disk.prefix(disk.count - cut), mac, name: "cut")) {
                guard case .unreadable = $0 as? DeviceFileError else { return XCTFail("\(cut): \($0)") }
            }
        }
    }

    func testASwappedSegmentIsRefused() throws {
        let disk = WholeFile.encrypt(vectorPlain(200_000), mac)
        let segment = WholeFile.segment
        var swapped = disk.prefix(segment)
        swapped.append(disk.subdata(in: (2 * segment)..<(3 * segment)))
        swapped.append(disk.subdata(in: segment..<(2 * segment)))
        swapped.append(disk.subdata(in: (3 * segment)..<disk.count))
        XCTAssertEqual(swapped.count, disk.count)
        XCTAssertThrowsError(try WholeFile.decrypt(swapped, mac, name: "swapped"))
    }

    func testAWrongHeaderIsRefused() throws {
        let disk = WholeFile.encrypt(vectorPlain(1_000), mac)
        var length = disk
        length[0] = 41
        XCTAssertThrowsError(try WholeFile.decrypt(length, mac, name: "length"))
        var salt = disk
        salt[5] ^= 1
        XCTAssertThrowsError(try WholeFile.decrypt(salt, mac, name: "salt"))
        var prefix = disk
        prefix[38] ^= 1
        XCTAssertThrowsError(try WholeFile.decrypt(prefix, mac, name: "prefix"))
        let other = WholeFile.Keying(key: testKey, associatedData: Data("lifestream:1:blob".utf8), segment: WholeFile.segment)
        XCTAssertThrowsError(try WholeFile.decrypt(disk, other, name: "role"))
    }

    func testBytesAfterTheEndAreRefused() throws {
        let short = WholeFile.encrypt(vectorPlain(1_000), mac)
        XCTAssertThrowsError(try WholeFile.decrypt(short + Data([0]), mac, name: "one more"))
        let full = WholeFile.encrypt(vectorPlain(WholeFile.segment - WholeFile.headerBytes - WholeFile.tagBytes), mac)
        XCTAssertEqual(full.count, WholeFile.segment)
        XCTAssertThrowsError(try WholeFile.decrypt(full + Data(count: 16), mac, name: "an empty segment after"))
        XCTAssertThrowsError(try WholeFile.decrypt(full + Data(count: 17), mac, name: "a segment after"))
    }

    func testAnEmptyFileIsRefusedAndAnEmptyPlainIsOneSegment() throws {
        XCTAssertThrowsError(try WholeFile.decrypt(Data(), mac, name: "empty"))
        let empty = WholeFile.encrypt(Data(), mac)
        XCTAssertEqual(empty.count, WholeFile.headerBytes + WholeFile.tagBytes)
        XCTAssertThrowsError(try WholeFile.decrypt(empty.prefix(WholeFile.headerBytes), mac, name: "header only"))
        XCTAssertEqual(try WholeFile.decrypt(empty, mac, name: "empty"), Data())
    }
}
