import Evidence
import DeviceFiles
import Foundation
import CryptoKit
import Darwin

enum TextCompaction {
    struct Journal: Codable {
        let segment: String
        let segmentSHA256: Data
        let manifestSHA256: Data
        let frames: [Entry]

        struct Entry: Codable {
            let bundle: String
            let metadataSHA256: Data
        }
    }

    enum Stage: CaseIterable {
        case prepared
        case segmentPublished
        case manifestPublished
    }

    static let grace: TimeInterval = 30
    static let maximumWindowsPerPass = 12

    static func compact(
        store: CaptureStore,
        now: Date,
        maximumRawBytes: Int = ScreenText.maximumRawBytes,
        prove: (Data, ScreenText.Window, [Frame]) -> Bool = prove,
        interrupt: ((Stage) throws -> Void)? = nil
    ) throws -> TextCompactionReport {
        guard store.videoQuality != nil else {
            throw CaptureStoreError.readOnly
        }
        try Task.checkCancellation()
        let eligibleEnd = Int((now.timeIntervalSince1970 - grace) * 1_000_000)
        if !store.textNeedsRecovery, let cursor = store.textCursor, ScreenText.Window.containing(cursor).end > eligibleEnd {
            return TextCompactionReport()
        }
        let textDirectory = try openTextDirectory(of: store)
        var moved = false
        if store.textNeedsRecovery {
            try recoverPreparations(in: textDirectory, store: store, interrupt: interrupt)
            let position = try readPosition(in: textDirectory, files: store.files)
            let published = try newestWindowEnd(in: textDirectory, files: store.files)
            let cursor = [position, published].compactMap { $0 }.max()
            if let cursor, cursor % ScreenText.windowMicroseconds == 0, cursor > position ?? Int.min {
                try advancePosition(to: cursor, in: textDirectory, files: store.files)
                moved = true
            }
            store.textCursor = cursor
            store.textNeedsRecovery = false
        }
        let cursor = store.textCursor
        var report = TextCompactionReport()
        if cursor.map({ ScreenText.Window.containing($0).end <= eligibleEnd }) ?? true {
            for group in try windows(of: store, from: cursor, endingBy: eligibleEnd) {
                try Task.checkCancellation()
                try compactWindow(group, store: store, in: textDirectory, maximumRawBytes: maximumRawBytes,
                                  prove: prove, report: &report, interrupt: interrupt)
                try advancePosition(to: group.window.end, in: textDirectory, files: store.files)
                moved = true
                store.textCursor = group.window.end
                report.windowCount += 1
            }
        }
        if moved {
            try DeviceFiles.syncDirectory(textDirectory, flush: .full)
        }
        return report
    }


    struct WindowGroup {
        let window: ScreenText.Window
        let start: Int
        var bundles: [(path: String, url: URL, microseconds: Int)]
    }

    private static func windows(of store: CaptureStore, from cursor: Int?, endingBy eligibleEnd: Int) throws -> [WindowGroup] {
        let since = cursor.map { Date(timeIntervalSince1970: Double($0) / 1_000_000) }
        var groups: [WindowGroup] = []
        for day in try store.days(since: since) {
            let names = try FileManager.default.contentsOfDirectory(atPath: day.path)
                .filter { !$0.hasPrefix(SpoolLayout.hiddenPrefix) }
                .sorted()
            for name in names {
                guard let microseconds = SpoolLayout.indexedMicroseconds(ofBundle: name) else {
                    continue
                }
                if let cursor, microseconds < cursor {
                    continue
                }
                let window = ScreenText.Window.containing(microseconds)
                guard window.end <= eligibleEnd else {
                    return groups
                }
                if groups.last?.window != window {
                    guard groups.count < maximumWindowsPerPass else {
                        return groups
                    }
                    groups.append(WindowGroup(window: window, start: max(window.start, cursor ?? window.start), bundles: []))
                }
                let path = day.lastPathComponent + "/" + name
                groups[groups.count - 1].bundles.append((path, day.appendingPathComponent(name, isDirectory: true), microseconds))
            }
        }
        return groups
    }


    struct Frame {
        let bundle: String
        let microseconds: Int
        let reduction: ScreenText.Reduction
        let observationSHA256: String
        let metadataSHA256: Data
        let arrayDigests: [Data]
    }

    private static func read(_ bundle: (path: String, url: URL, microseconds: Int), store: CaptureStore) -> Frame? {
        guard (try? SpoolFiles.isRealDirectory(bundle.url)) == true,
              let metadata = try? store.metadataFile(bundle.url),
              let json = try? metadata.json(),
              ObservationBytes.status(of: json) == ObservationBytes.capturedStatus,
              let reduction = ScreenText.reduce(json) else {
            return nil
        }
        return Frame(bundle: bundle.path, microseconds: bundle.microseconds, reduction: reduction,
                     observationSHA256: ScreenText.hex(SHA256.hash(data: json)),
                     metadataSHA256: metadata.checksum,
                     arrayDigests: reduction.moved.map { Data(SHA256.hash(data: $0.array)) })
    }

    struct Builder {
        let start: Int
        var region = Data()
        var arrays: [(offset: Int, length: Int)] = []
        var index: [Data: Int] = [:]
        var frames: [Frame] = []

        func added(by frame: Frame) -> Int {
            var seen: Set<Data> = []
            var bytes = 0
            for (moved, digest) in zip(frame.reduction.moved, frame.arrayDigests)
            where index[digest] == nil && seen.insert(digest).inserted {
                bytes += moved.array.count
            }
            return bytes
        }

        mutating func add(_ frame: Frame) -> [ScreenText.Splice] {
            frames.append(frame)
            return zip(frame.reduction.moved, frame.arrayDigests).map { moved, digest in
                let array: Int
                if let known = index[digest] {
                    array = known
                } else {
                    array = arrays.count
                    index[digest] = array
                    arrays.append((region.count, moved.array.count))
                    region.append(moved.array)
                }
                return ScreenText.Splice(at: moved.at, before: moved.before, array: array, after: moved.after)
            }
        }
    }

    private static func compactWindow(
        _ group: WindowGroup,
        store: CaptureStore,
        in textDirectory: URL,
        maximumRawBytes: Int,
        prove: (Data, ScreenText.Window, [Frame]) -> Bool,
        report: inout TextCompactionReport,
        interrupt: ((Stage) throws -> Void)?
    ) throws {
        var builder = Builder(start: group.start)
        var splices: [[ScreenText.Splice]] = []
        func finish(end: Int) throws {
            guard !builder.frames.isEmpty else {
                return
            }
            let window = ScreenText.Window(start: builder.start, end: end)
            if try publishSegment(builder, splices: splices, window: window, store: store, in: textDirectory,
                                  prove: prove, interrupt: interrupt) {
                report.segmentCount += 1
                report.frameCount += builder.frames.count
            } else {
                report.unprovenSegmentCount += 1
            }
            store.textCursor = end
        }
        for bundle in group.bundles {
            guard let frame = read(bundle, store: store) else {
                continue
            }
            if !builder.frames.isEmpty, builder.region.count + builder.added(by: frame) > maximumRawBytes {
                try finish(end: frame.microseconds)
                builder = Builder(start: frame.microseconds)
                splices = []
            }
            splices.append(builder.add(frame))
        }
        try finish(end: group.window.end)
    }


    private static func publishSegment(
        _ builder: Builder,
        splices: [[ScreenText.Splice]],
        window: ScreenText.Window,
        store: CaptureStore,
        in textDirectory: URL,
        prove: (Data, ScreenText.Window, [Frame]) -> Bool,
        interrupt: ((Stage) throws -> Void)?
    ) throws -> Bool {
        let id = UUID().uuidString.lowercased()
        let staging = textDirectory.appendingPathComponent(SpoolLayout.stagingPrefix + id, isDirectory: true)
        store.textNeedsRecovery = true
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])

        let frames = zip(builder.frames, splices).map { frame, splices in
            ScreenText.Frame(bundle: frame.bundle, displayID: frame.reduction.displayID,
                             observationSHA256: frame.observationSHA256, splices: splices)
        }
        let header = ScreenText.body(window: window, arrays: builder.arrays, frames: frames, region: Data())
        let staged = staging.appendingPathComponent(SpoolLayout.preparedTextSegment)
        try store.files.writeNew(staged, try ScreenText.compress([header, builder.region]), flush: .data)

        let file = try SpoolFiles.read(store.files, staged, maximumBytes: ScreenText.maximumFileBytes)
        guard prove(file, window, builder.frames) else {
            try FileManager.default.removeItem(at: staging)
            return false
        }
        let manifest = ScreenText.Manifest(
            segment: SpoolLayout.textSegmentName(id: id),
            segmentSHA256: Data(SHA256.hash(data: file)),
            window: window,
            frames: builder.frames.enumerated().map {
                ScreenText.Manifest.Entry(bundle: $1.bundle, ordinal: $0, observationSHA256: $1.observationSHA256)
            }
        ).encoded
        try store.files.writeNew(staging.appendingPathComponent(SpoolLayout.preparedManifest), manifest, flush: .data)
        let journal = Journal(
            segment: SpoolLayout.textSegmentName(id: id),
            segmentSHA256: Data(SHA256.hash(data: file)),
            manifestSHA256: Data(SHA256.hash(data: manifest)),
            frames: builder.frames.map { Journal.Entry(bundle: $0.bundle, metadataSHA256: $0.metadataSHA256) }
        )
        try writeJournal(journal, in: staging, files: store.files)
        try interrupt?(.prepared)
        try publish(journal, staging: staging, store: store, in: textDirectory, interrupt: interrupt)
        return true
    }

    static func prove(_ file: Data, _ window: ScreenText.Window, _ frames: [Frame]) -> Bool {
        guard let body = try? ScreenText.decompress(file),
              let segment = try? ScreenText.Segment(body: body),
              segment.window == window,
              segment.frames.count == frames.count else {
            return false
        }
        for (ordinal, frame) in frames.enumerated() {
            guard segment.frames[ordinal].bundle == frame.bundle,
                  segment.proves(ordinal: ordinal, reduced: frame.reduction.reduced,
                                 observationSHA256: frame.observationSHA256) else {
                return false
            }
        }
        return true
    }

    private static func writeJournal(_ journal: Journal, in staging: URL, files: DeviceFiles) throws {
        let temporary = staging.appendingPathComponent(SpoolLayout.journalStaging)
        try files.writeNew(temporary, SpoolJSON.encode(journal), flush: .barrier)
        let final = staging.appendingPathComponent(SpoolLayout.journal)
        guard rename(temporary.path, final.path) == 0 else {
            throw CaptureStoreError.io("publish text journal", errno)
        }
    }

    private static func publish(
        _ journal: Journal,
        staging: URL,
        store: CaptureStore,
        in textDirectory: URL,
        interrupt: ((Stage) throws -> Void)?
    ) throws {
        guard ScreenText.isSegmentName(journal.segment), !journal.frames.isEmpty else {
            throw TextCompactionError.unverifiable
        }
        let id = String(journal.segment.dropLast(".lstext".count))
        let manifestURL = textDirectory.appendingPathComponent(SpoolLayout.textManifestName(id: id))
        if try !SpoolFiles.exists(manifestURL) {
            for entry in journal.frames {
                let bundle = try bundleURL(entry.bundle, store: store)
                guard try store.metadataFile(bundle).checksum == entry.metadataSHA256 else {
                    throw TextCompactionError.unverifiable
                }
            }
            try publishFile(staging.appendingPathComponent(SpoolLayout.preparedTextSegment),
                            to: textDirectory.appendingPathComponent(journal.segment),
                            sha256: journal.segmentSHA256, maximumBytes: ScreenText.maximumFileBytes, files: store.files)
            try interrupt?(.segmentPublished)
            try publishFile(staging.appendingPathComponent(SpoolLayout.preparedManifest), to: manifestURL,
                            sha256: journal.manifestSHA256, maximumBytes: SpoolLayout.maximumManifestBytes,
                            files: store.files)
            try interrupt?(.manifestPublished)
        }
        try FileManager.default.removeItem(at: staging)
    }

    private static func publishFile(_ staged: URL, to final: URL, sha256: Data, maximumBytes: Int,
                                    files: DeviceFiles) throws {
        let renamed = try SpoolFiles.exists(final)
        let bytes = try SpoolFiles.read(files, renamed ? final : staged, maximumBytes: maximumBytes)
        guard Data(SHA256.hash(data: bytes)) == sha256 else {
            throw TextCompactionError.unverifiable
        }
        if !renamed {
            guard renamex_np(staged.path, final.path, UInt32(RENAME_EXCL)) == 0 else {
                throw CaptureStoreError.io("publish text segment", errno)
            }
        }
    }

    private static func bundleURL(_ path: String, store: CaptureStore) throws -> URL {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2, SpoolLayout.isDayName(parts[0]),
              SpoolLayout.indexedMicroseconds(ofBundle: parts[1]) != nil else {
            throw TextCompactionError.unverifiable
        }
        var url = store.directory
        for part in parts {
            url.appendPathComponent(part, isDirectory: true)
            guard try SpoolFiles.isRealDirectory(url) else {
                throw TextCompactionError.unverifiable
            }
        }
        return url
    }


    private static func openTextDirectory(of store: CaptureStore) throws -> URL {
        let directory = store.directory.appendingPathComponent(SpoolLayout.textDirectory, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        guard try SpoolFiles.isRealDirectory(directory) else {
            throw TextCompactionError.unverifiable
        }
        return directory
    }

    private static func recoverPreparations(in textDirectory: URL, store: CaptureStore,
                                            interrupt: ((Stage) throws -> Void)?) throws {
        let preparations = try FileManager.default.contentsOfDirectory(atPath: textDirectory.path)
            .filter { $0.hasPrefix(SpoolLayout.stagingPrefix) }
            .sorted()
        for name in preparations {
            let staging = textDirectory.appendingPathComponent(name, isDirectory: true)
            guard try SpoolFiles.isRealDirectory(staging) else {
                throw TextCompactionError.unverifiable
            }
            let journalURL = staging.appendingPathComponent(SpoolLayout.journal)
            if try SpoolFiles.exists(journalURL) {
                do {
                    let bytes = try SpoolFiles.read(store.files, journalURL, maximumBytes: SpoolLayout.maximumJournalBytes)
                    let journal = try SpoolJSON.decode(Journal.self, from: bytes)
                    try publish(journal, staging: staging, store: store, in: textDirectory, interrupt: interrupt)
                    continue
                } catch {
                    let id = String(name.dropFirst(SpoolLayout.stagingPrefix.count))
                    let segment = textDirectory.appendingPathComponent(SpoolLayout.textSegmentName(id: id))
                    let manifest = textDirectory.appendingPathComponent(SpoolLayout.textManifestName(id: id))
                    if try !SpoolFiles.exists(manifest), try SpoolFiles.exists(segment) {
                        try FileManager.default.removeItem(at: segment)
                    }
                }
            }
            try FileManager.default.removeItem(at: staging)
        }
    }


    static func readPosition(in textDirectory: URL, files: DeviceFiles) throws -> Int? {
        let url = textDirectory.appendingPathComponent(SpoolLayout.textPosition)
        guard let bytes = try files.read(url, maximumBytes: SpoolLayout.maximumPositionBytes) else {
            return nil
        }
        guard bytes.allSatisfy({ (0x30...0x39).contains($0) }) else {
            return nil
        }
        return Int(String(decoding: bytes, as: UTF8.self))
    }

    static func advancePosition(to end: Int, in textDirectory: URL, files: DeviceFiles) throws {
        if let current = try readPosition(in: textDirectory, files: files), current >= end {
            return
        }
        let temporary = textDirectory.appendingPathComponent(SpoolLayout.textPositionStaging)
        if try SpoolFiles.exists(temporary) {
            try FileManager.default.removeItem(at: temporary)
        }
        try files.writeNew(temporary, Data(String(end).utf8), flush: .barrier)
        guard rename(temporary.path, textDirectory.appendingPathComponent(SpoolLayout.textPosition).path) == 0 else {
            throw CaptureStoreError.io("publish text position", errno)
        }
    }

    static func newestWindowEnd(in textDirectory: URL, files: DeviceFiles) throws -> Int? {
        var newest: Int?
        for name in try FileManager.default.contentsOfDirectory(atPath: textDirectory.path)
        where SpoolLayout.textManifestID(name) != nil {
            let url = textDirectory.appendingPathComponent(name)
            let window = (try? files.read(url, maximumBytes: SpoolLayout.maximumManifestBytes)).flatMap { manifest in
                ScreenText.Manifest.window(prefix: manifest.prefix(ScreenText.Manifest.prefixBytes))
                    ?? ScreenText.Manifest.decode(manifest)?.window
            }
            if let window {
                newest = max(newest ?? window.end, window.end)
            }
        }
        return newest
    }
}

public enum TextCompactionError: Error, CustomStringConvertible {
    case busy
    case unverifiable

    public var description: String {
        switch self {
        case .busy:
            return "Text compaction is already running"
        case .unverifiable:
            return "A text segment preparation no longer matches the spool; it is discarded"
        }
    }
}

public struct TextCompactionReport: Codable, Equatable, Sendable {
    public var windowCount = 0
    public var segmentCount = 0
    public var frameCount = 0
    public var unprovenSegmentCount = 0

    public init() {}
}
