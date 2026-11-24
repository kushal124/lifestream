import XCTest
import DeviceFiles
@testable import Shipping

struct ZipArchiveProbe {
    struct Member: Equatable {
        let name: String
        let bytes: Data
        let localVersion: UInt16
        let localExtraLength: Int
        let localOffset: Int
    }

    let members: [Member]

    init(_ data: Data) throws {
        let archive = Data(data)
        let end = try Self.endRecord(archive)
        let count = Int(Self.u16(archive, end + 10))
        var offset = Int(Self.u32(archive, end + 16))
        var found: [Member] = []
        for _ in 0..<count {
            guard Self.u32(archive, offset) == 0x0201_4b50 else { throw ProbeError.notAZip }
            let nameLength = Int(Self.u16(archive, offset + 28))
            let extraLength = Int(Self.u16(archive, offset + 30))
            let commentLength = Int(Self.u16(archive, offset + 32))
            let size = Int(Self.u32(archive, offset + 24))
            let localOffset = Int(Self.u32(archive, offset + 42))
            let name = String(decoding: archive[(offset + 46)..<(offset + 46 + nameLength)], as: UTF8.self)
            guard Self.u32(archive, localOffset) == 0x0403_4b50 else { throw ProbeError.notAZip }
            let localVersion = Self.u16(archive, localOffset + 4)
            let localNameLength = Int(Self.u16(archive, localOffset + 26))
            let localExtraLength = Int(Self.u16(archive, localOffset + 28))
            let start = localOffset + 30 + localNameLength + localExtraLength
            found.append(Member(name: name, bytes: Data(archive[start..<(start + size)]),
                                localVersion: localVersion, localExtraLength: localExtraLength,
                                localOffset: localOffset))
            offset += 46 + nameLength + extraLength + commentLength
        }
        members = found
    }

    func bytes(_ name: String) -> Data? { members.first { $0.name == name }?.bytes }

    enum ProbeError: Error { case notAZip }

    private static func endRecord(_ archive: Data) throws -> Int {
        var offset = archive.count - 22
        while offset >= 0 {
            if u32(archive, offset) == 0x0605_4b50 { return offset }
            offset -= 1
        }
        throw ProbeError.notAZip
    }

    static func u16(_ data: Data, _ offset: Int) -> UInt16 {
        let base = data.startIndex + offset
        return UInt16(data[base]) | UInt16(data[base + 1]) << 8
    }

    static func u32(_ data: Data, _ offset: Int) -> UInt32 {
        let base = data.startIndex + offset
        return (0..<4).reduce(UInt32(0)) { $0 | UInt32(data[base + $1]) << (8 * UInt32($1)) }
    }

    static func u64(_ data: Data, _ offset: Int) -> UInt64 {
        let base = data.startIndex + offset
        return (0..<8).reduce(UInt64(0)) { $0 | UInt64(data[base + $1]) << (8 * UInt64($1)) }
    }

    static func data(hex: String) -> Data {
        var bytes = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return bytes
    }
}

final class ZipWriterTests: XCTestCase {
    private var root: URL!

    private static let twoMemberHex =
        "504b03042d00000800000000000086a61036ffffffffffffffff05001400612e74787401001000050000000000000005" +
        "0000000000000068656c6c6f504b0304140000080000000000001d80bc55030000000300000007000000622f632e6269" +
        "6e010203504b010214001400000800000000000086a61036050000000500000005000000000000000000000000000000" +
        "0000612e747874504b01021400140000080000000000001d80bc55030000000300000007000000000000000000000000" +
        "003c000000622f632e62696e504b0506000000000200020068000000640000000000"

    private static let firstMemberBytes = 60

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("zip-writer-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func twoMemberArchive() throws -> Data {
        let path = root.appendingPathComponent("two.zip")
        let writer = try ZipWriter(path: path, files: DeviceFiles(.plain))
        _ = try writer.addStream("a.txt") { emit in try emit(Data("hello".utf8)) }
        _ = try writer.addBytes("b/c.bin", Data([1, 2, 3]))
        try writer.close()
        return try Data(contentsOf: path)
    }


    func testTheStreamedMembersBytesAreTheTypeScriptWritersByteForByte() throws {
        let written = try twoMemberArchive()
        let truth = ZipArchiveProbe.data(hex: Self.twoMemberHex)
        XCTAssertEqual(written.prefix(Self.firstMemberBytes), truth.prefix(Self.firstMemberBytes))
    }

    func testAddBytesMatchesTypeScriptLocalHeader() throws {
        let written = try twoMemberArchive()
        let truth = ZipArchiveProbe.data(hex: Self.twoMemberHex)
        XCTAssertEqual(written, truth, "the whole archive is the TypeScript writer's bytes")

        let member = try ZipArchiveProbe(written).members[1]
        XCTAssertEqual(member.name, "b/c.bin")
        XCTAssertEqual(member.localVersion, 20, "bytes in hand need no ZIP64 extra")
        XCTAssertEqual(member.localExtraLength, 0)
        XCTAssertEqual(ZipArchiveProbe.u32(written, member.localOffset + 18), 3, "the real compressed size")
        XCTAssertEqual(ZipArchiveProbe.u32(written, member.localOffset + 22), 3, "the real uncompressed size")
    }

    func testBothMembersParseToTheSameNamesBytesAndOrderAsTheTypeScriptArchive() throws {
        let mine = try ZipArchiveProbe(try twoMemberArchive())
        let theirs = try ZipArchiveProbe(ZipArchiveProbe.data(hex: Self.twoMemberHex))
        XCTAssertEqual(mine.members.map(\.name), ["a.txt", "b/c.bin"])
        XCTAssertEqual(mine.members.map(\.name), theirs.members.map(\.name))
        XCTAssertEqual(mine.members.map(\.bytes), theirs.members.map(\.bytes))
        XCTAssertEqual(mine.bytes("a.txt"), Data("hello".utf8))
        XCTAssertEqual(mine.bytes("b/c.bin"), Data([1, 2, 3]))
    }

    func testAStreamedMemberReservesAZip64ExtraAndPatchesTheSizesIntoIt() throws {
        let path = root.appendingPathComponent("zip64-local.zip")
        let writer = try ZipWriter(path: path, files: DeviceFiles(.plain))
        _ = try writer.addStream("five") { emit in try emit(Data("55555".utf8)) }
        try writer.close()

        let archive = try Data(contentsOf: path)
        XCTAssertEqual(ZipArchiveProbe.u32(archive, 0), 0x0403_4b50)
        XCTAssertEqual(ZipArchiveProbe.u16(archive, 4), 45, "a reserved extra needs version 45")
        XCTAssertEqual(ZipArchiveProbe.u32(archive, 18), 0xffff_ffff)
        XCTAssertEqual(ZipArchiveProbe.u32(archive, 22), 0xffff_ffff)
        XCTAssertEqual(ZipArchiveProbe.u16(archive, 28), 20, "four bytes of header and two 64-bit sizes")
        let extra = 30 + Int(ZipArchiveProbe.u16(archive, 26))
        XCTAssertEqual(ZipArchiveProbe.u16(archive, extra), 0x0001)
        XCTAssertEqual(ZipArchiveProbe.u16(archive, extra + 2), 16)
        XCTAssertEqual(ZipArchiveProbe.u64(archive, extra + 4), 5)
        XCTAssertEqual(ZipArchiveProbe.u64(archive, extra + 12), 5)
        XCTAssertEqual(try ZipArchiveProbe(archive).bytes("five"), Data("55555".utf8))
    }

    func testEveryMemberNameIsFlaggedUTF8AndStored() throws {
        let archive = try twoMemberArchive()
        for member in try ZipArchiveProbe(archive).members {
            XCTAssertEqual(ZipArchiveProbe.u16(archive, member.localOffset + 6), 1 << 11, "the UTF-8 flag")
            XCTAssertEqual(ZipArchiveProbe.u16(archive, member.localOffset + 8), 0, "stored, never deflated")
        }
    }


    func testAStreamIsMeasuredChunkByChunkAndNeverHeldWhole() throws {
        let payload = Data("synthetic bytes measured chunk by chunk".utf8)
        let path = root.appendingPathComponent("measured.zip")
        let writer = try ZipWriter(path: path, files: DeviceFiles(.plain))
        let member = try writer.addStream("blob") { emit in
            try emit(payload.prefix(7))
            try emit(payload.dropFirst(7).prefix(13))
            try emit(payload.dropFirst(20))
        }
        let empty = try writer.addStream("nothing") { _ in }
        let written = try writer.close()

        XCTAssertEqual(member, ZipWriter.Member(name: "blob", bytes: payload.count, sha256: Self.sha256(payload)))
        XCTAssertEqual(empty, ZipWriter.Member(name: "nothing", bytes: 0, sha256: Self.sha256(Data())))
        XCTAssertEqual(written, [member, empty])
        XCTAssertEqual(try ZipArchiveProbe(try Data(contentsOf: path)).bytes("blob"), payload)
    }

    func testAFileMemberIsCopiedInAndMeasuredFromDisk() throws {
        let source = root.appendingPathComponent("payload.bin")
        let payload = Data("synthetic file payload\n".utf8)
        try payload.write(to: source)
        let path = root.appendingPathComponent("from-file.zip")
        let writer = try ZipWriter(path: path, files: DeviceFiles(.plain))
        let member = try writer.addFile("data/payload.bin", from: source)
        try writer.close()

        XCTAssertEqual(member.bytes, payload.count)
        XCTAssertEqual(member.sha256, Self.sha256(payload))
        XCTAssertEqual(try ZipArchiveProbe(try Data(contentsOf: path)).bytes("data/payload.bin"), payload)
    }


    func testAnUnsafeAbsoluteOrRepeatedMemberNameIsRefused() throws {
        let writer = try ZipWriter(path: root.appendingPathComponent("names.zip"), files: DeviceFiles(.plain))
        _ = try writer.addBytes("a.txt", Data("a".utf8))
        for name in ["../a.txt", "b/../a.txt", "/a.txt", "", "./a.txt", "b//a.txt", "b\\a.txt", "a.txt"] {
            XCTAssertThrowsError(try writer.addBytes(name, Data("x".utf8)), name) { error in
                guard let error = error as? ZipWriterError else { return XCTFail("\(name): \(error)") }
                XCTAssertTrue(error == .memberName(name) || error == .duplicate(name), "\(name): \(error)")
            }
        }
        writer.abort()
    }

    func testCloseRenamesThePartialIntoPlaceAndRefusesEverythingAfterwards() throws {
        let kept = root.appendingPathComponent("kept.zip")
        let writer = try ZipWriter(path: kept, files: DeviceFiles(.plain))
        _ = try writer.addBytes("a.txt", Data("a".utf8))
        try writer.close()

        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path + ".partial"))
        XCTAssertThrowsError(try writer.close()) { XCTAssertEqual($0 as? ZipWriterError, .closed) }
        XCTAssertThrowsError(try writer.addBytes("b.txt", Data("b".utf8))) {
            XCTAssertEqual($0 as? ZipWriterError, .closed)
        }
    }

    func testAbortLeavesNothingBehindAndIsSafeTwice() throws {
        let dropped = root.appendingPathComponent("dropped.zip")
        let writer = try ZipWriter(path: dropped, files: DeviceFiles(.plain))
        _ = try writer.addBytes("a.txt", Data("a".utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dropped.path + ".partial"))
        writer.abort()
        writer.abort()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }

    private static func sha256(_ data: Data) -> String {
        var digest = StreamDigest()
        digest.update(data)
        return digest.hex()
    }
}
