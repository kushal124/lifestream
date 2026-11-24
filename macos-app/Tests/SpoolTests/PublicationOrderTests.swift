import Foundation
import CoreGraphics
import XCTest
import Evidence
import DeviceFiles
@testable import Spool

class PublicationOrderTests: SpoolFormCase {
    private var seen: [Seen] = []

    private struct Seen {
        let path: String
        let level: DeviceFiles.Flush
        let visible: Set<String>
    }

    override func tearDownWithError() throws {
        DeviceFiles.flushObserver = nil
        try super.tearDownWithError()
    }

    private func observe(under prefix: String, visible: @escaping () -> Set<String>) {
        seen = []
        let note = { [unowned self] (url: URL, level: DeviceFiles.Flush) in
            guard url.path.hasPrefix(prefix) else { return }
            let path = String(url.path.dropFirst(prefix.count).drop { $0 == "/" })
            seen.append(Seen(path: path, level: level, visible: visible()))
        }
        DeviceFiles.flushObserver = note
    }

    private func record(_ store: CaptureStore) {
        let prefix = store.directory.path
        observe(under: prefix) { [unowned self] in visible(prefix) }
    }

    private func visible(_ prefix: String) -> Set<String> {
        Set((FileManager.default.subpaths(atPath: prefix) ?? []).filter {
            $0 != SpoolLayout.writerLock && !$0.hasPrefix(SpoolLayout.textDirectory)
        })
    }

    private func frame(_ value: UInt8) -> RawFrame {
        let width = 128, height = 96
        var bytes = Data(repeating: value, count: width * height * 4)
        for i in stride(from: 3, to: bytes.count, by: 4) { bytes[i] = 255 }
        return RawFrame(layout: FrameLayout(width: width, height: height, bytesPerRow: width * 4,
            bitmapInfo: SegmentCodec.bitmap, renderingIntent: 0,
            ICCData: CGColorSpace(name: CGColorSpace.sRGB)!.copyICCData()! as Data), data: bytes)
    }

    private func observation(_ index: Int) -> CaptureObservation {
        CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000 + Double(index * 2)),
                           displayID: 1, width: 128, height: 96)
    }

    func testAppendLogsTheSampleThenFlushesTheBytesThenRenamesThenFlushesTheDayOnce() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        for index in 0..<2 {
            record(store)
            let saved = try store.append(observation: observation(index), image: .raw(frame(40)))
            let image = try XCTUnwrap(saved.imageFile)
            let bundle = String(image.dropLast("/image.open".count))
            let day = String(bundle.prefix(10)), name = String(bundle.dropFirst(11))
            let staging = day + "/.pending-" + name
            let opened = try SpoolJSON.decode(OpenImage.self, from: kept(root.appendingPathComponent(image)))
            XCTAssertEqual(opened.ordinal, index)
            let segment = SpoolLayout.openSegmentPath(id: opened.segment)
            let first = index == 0 ? [segment + "/format"] : []
            XCTAssertEqual(seen.map(\.path), first + [segment + "/samples", staging + "/image.open",
                                                     staging + "/observation.lsm", day])
            XCTAssertEqual(seen.map(\.level), first.map { _ in .data } + [.data, .data, .barrier, .full])
            let barrier = seen[seen.count - 2], commit = seen[seen.count - 1]
            XCTAssertFalse(barrier.visible.contains(bundle), "the barrier precedes the rename")
            XCTAssertTrue(barrier.visible.contains(segment + "/samples"), "the sample is logged before the rename")
            XCTAssertTrue(commit.visible.isSuperset(of: [bundle, bundle + "/image.open", bundle + "/observation.lsm"]),
                          "the rename precedes the one full flush")
            XCTAssertFalse(commit.visible.contains(staging))
        }

        record(store)
        try store.append(observation: .gap(at: Date(timeIntervalSince1970: 1_700_000_100), reason: "synthetic-gap"),
                         image: nil)
        XCTAssertEqual(seen.map(\.level), [.barrier, .full], "a gap: its metadata, then its day")
        XCTAssertTrue(seen[0].path.hasSuffix("/observation.lsm"))
        XCTAssertEqual(seen[1].path, "2023-11-14")
    }

    func testAPublishedGapIsCountedInTheResourceMeter() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch)
        _ = ResourceMeter.shared.take()
        try store.append(observation: .gap(at: Date(timeIntervalSince1970: 1_700_000_100), reason: "synthetic-gap"), image: nil)
        let counts = ResourceMeter.shared.take().counts
        XCTAssertEqual(counts[.flushBarrier], 1, "the metadata's barrier")
        XCTAssertEqual(counts[.flushFull], 1, "the day's flush")
        XCTAssertGreaterThan(counts[.bytesWritten] ?? 0, 0)
    }

    func testCompactionCommitsTheJournalThenTheSidecarsThenUnlinks() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let saved = try [0, 1].map { try store.append(observation: observation($0), image: .raw(frame(UInt8(40 + $0 * 20)))) }
        let images = try saved.map { try XCTUnwrap($0.imageFile) }
        let bundles = images.map { ($0 as NSString).deletingLastPathComponent }
        record(store)
        let report: VideoCompactionReport
        do {
            report = try VideoCompaction.compact(store: store, flush: true)
        } catch VideoArchiveError.hardwareUnavailable {
            throw XCTSkip("Hardware HEVC encoder unavailable")
        }
        XCTAssertEqual(report.imageCount, 2)

        let staging = try XCTUnwrap(seen.first?.path).components(separatedBy: "/").prefix(2).joined(separator: "/")
        XCTAssertTrue(staging.hasPrefix(SpoolLayout.videoDirectory + "/" + SpoolLayout.stagingPrefix))
        let id = String(staging.dropFirst(SpoolLayout.videoDirectory.count + 1 + SpoolLayout.stagingPrefix.count))
        let movie = SpoolLayout.segmentPath(id: id), open = SpoolLayout.openSegmentPath(id: id)
        XCTAssertTrue(seen[0].visible.contains(open + "/samples"), "the movie is muxed from the open segment")
        XCTAssertEqual(seen.map(\.path), [
            staging + "/" + SpoolLayout.preparedMovie,
            staging + "/" + SpoolLayout.journalStaging,
            staging,
            bundles[0] + "/" + SpoolLayout.archiveSidecarStaging,
            bundles[1] + "/" + SpoolLayout.archiveSidecarStaging,
            "",
        ])
        XCTAssertEqual(seen.map(\.level), [.data, .barrier, .full, .data, .barrier, .full])
        XCTAssertFalse(seen[1].visible.contains(staging + "/" + SpoolLayout.journal), "the barrier precedes the journal's rename")
        XCTAssertTrue(seen[2].visible.contains(staging + "/" + SpoolLayout.journal), "the journal is renamed, then committed")
        XCTAssertTrue(seen[4].visible.contains(movie), "the movie is renamed before the sidecars' barrier")
        let sidecars = bundles.map { $0 + "/" + SpoolLayout.archiveSidecar }
        XCTAssertTrue(seen[4].visible.isDisjoint(with: sidecars), "the barrier precedes every sidecar's rename")
        XCTAssertTrue(seen[5].visible.isSuperset(of: sidecars + images), "sidecars renamed, images still there, then the commit")

        let after = visible(store.directory.path)
        XCTAssertTrue(after.isDisjoint(with: images), "pending images go after the commit")
        XCTAssertTrue(seen[5].visible.contains(open + "/samples"))
        XCTAssertFalse(after.contains(open), "the open segment goes once its sidecars are durable")
        XCTAssertFalse(after.contains(staging))
        XCTAssertTrue(after.isSuperset(of: sidecars + [movie]))
    }

    func testATextPassOrdersTheSegmentManifestJournalAndPositionThenCommitsOnce() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        for index in 0..<2 {
            try store.append(observation: TextCompactionTests.frame(at: TextCompactionTests.base + Double(index * 2), tree: index),
                             image: nil)
        }
        let text = store.directory.appendingPathComponent(SpoolLayout.textDirectory).path
        observe(under: text) { Set(FileManager.default.subpaths(atPath: text) ?? []) }
        let report = try TextCompaction.compact(store: store, now: Date(timeIntervalSince1970: TextCompactionTests.base
                                                                    + TextCompactionTests.window + 31))
        XCTAssertEqual(report.segmentCount, 1)

        let staging = try XCTUnwrap(seen.first?.path.components(separatedBy: "/").first)
        let id = String(staging.dropFirst(SpoolLayout.stagingPrefix.count))
        let segment = SpoolLayout.textSegmentName(id: id), manifest = SpoolLayout.textManifestName(id: id)
        XCTAssertEqual(seen.map(\.path), [staging + "/" + SpoolLayout.preparedTextSegment,
                                          staging + "/" + SpoolLayout.preparedManifest,
                                          staging + "/" + SpoolLayout.journalStaging,
                                          SpoolLayout.textPositionStaging, ""])
        XCTAssertEqual(seen.map(\.level), [.data, .data, .barrier, .barrier, .full])
        guard seen.count == 5 else { return }
        XCTAssertFalse(seen[2].visible.contains(staging + "/" + SpoolLayout.journal), "the barrier precedes the journal's rename")
        XCTAssertTrue(seen[3].visible.isSuperset(of: [segment, manifest]), "published before the position moves")
        XCTAssertFalse(seen[3].visible.contains(staging))
        XCTAssertFalse(seen[3].visible.contains(SpoolLayout.textPosition), "the barrier precedes the position's rename")
        XCTAssertTrue(seen[4].visible.contains(SpoolLayout.textPosition), "the rename precedes the one full flush")
        XCTAssertFalse(seen[4].visible.contains(SpoolLayout.textPositionStaging))

        seen = []
        XCTAssertEqual(try TextCompaction.compact(store: store, now: Date(timeIntervalSince1970: TextCompactionTests.base
                                                                       + 2 * TextCompactionTests.window)).windowCount, 0)
        XCTAssertTrue(seen.isEmpty, "a pass that moves nothing flushes nothing")
    }
}

final class PublicationOrderKeyedTests: PublicationOrderTests {
    override class var keyed: Bool { true }
}
