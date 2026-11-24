import Evidence
import Foundation
import CryptoKit

public struct NewestObservation: Equatable, Sendable {
    public let capturedAt: Date
    public let end: Date

    public init(capturedAt: Date, end: Date) {
        self.capturedAt = capturedAt
        self.end = max(capturedAt, end)
    }
}

extension CaptureStore {
    public func read(limit: Int = 100, since: Date? = nil) throws -> [CaptureObservation] {
        readMutex.lock()
        defer { readMutex.unlock() }
        guard limit > 0 else {
            return []
        }
        let since = since.map(UTCInstant.millisecond)
        var result: [CaptureObservation] = []
        for day in try days(since: since?.addingTimeInterval(-0.0005)) {
            let bundles = try SpoolFiles.children(of: day)
                .filter { !$0.lastPathComponent.hasPrefix(SpoolLayout.hiddenPrefix) }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for bundle in bundles {
                if let since, Self.indexedBefore(bundle.lastPathComponent, since: since) {
                    continue
                }
                let observation = try decode(bundle)
                if let since, UTCInstant.millisecond(observation.capturedAt) < since {
                    continue
                }
                result.append(observation)
                if result.count == limit {
                    return result
                }
            }
        }
        return result
    }

    public func status() throws -> CaptureStoreStatus {
        readMutex.lock()
        defer { readMutex.unlock() }
        var count = 0
        var incomplete = 0
        var latest: Date?
        for day in try days(since: nil) {
            for bundle in try SpoolFiles.children(of: day) {
                if bundle.lastPathComponent.hasPrefix(SpoolLayout.stagingPrefix) {
                    incomplete += 1
                    continue
                }
                if bundle.lastPathComponent.hasPrefix(SpoolLayout.hiddenPrefix) {
                    continue
                }
                let observation = try decode(bundle)
                count += 1
                latest = max(latest ?? observation.capturedAt, observation.capturedAt)
            }
        }
        return CaptureStoreStatus(recordCount: count, incompleteCount: incomplete, latestCapture: latest)
    }

    func readNewestObservation() throws -> NewestObservation? {
        for day in try days(since: nil).reversed() {
            let names = try SpoolFiles.children(of: day).map(\.lastPathComponent)
            guard let newest = names.filter({ !$0.hasPrefix(SpoolLayout.hiddenPrefix) }).max() else { continue }
            let metadata = day.appendingPathComponent(newest, isDirectory: true).appendingPathComponent(SpoolLayout.metadata)
            let observation = try observationDecoder(MetadataCodec.decode(readFile(metadata, MetadataCodec.maximumPacketBytes)))
            return NewestObservation(capturedAt: observation.capturedAt, end: observation.capturedUntil ?? observation.capturedAt)
        }
        return nil
    }

    public func readImage(for observation: CaptureObservation) throws -> CaptureImage {
        readMutex.lock()
        defer { readMutex.unlock() }
        guard let path = observation.imageFile else {
            throw CaptureStoreError.invalidObservation
        }
        let current = try decode(try safeImageURL(path).deletingLastPathComponent())
        var comparable = observation
        if comparable.imageEncoding == nil {
            comparable.imageEncoding = current.imageEncoding
        }
        guard current == comparable else {
            throw CaptureStoreError.corruptBundle("observation-mismatch")
        }
        return try loadImage(of: current)
    }

    private func loadImage(of observation: CaptureObservation) throws -> CaptureImage {
        guard let path = observation.imageFile else {
            throw CaptureStoreError.invalidObservation
        }
        let bundle = try safeImageURL(path).deletingLastPathComponent()
        if let reference = try ArchiveSidecar.published(in: bundle, for: observation, files: files) {
            return try readVideo(reference)
        }
        do {
            return .raw(try readOpenFrame(of: observation, in: bundle))
        } catch {
            if let reference = try ArchiveSidecar.published(in: bundle, for: observation, files: files) {
                return try readVideo(reference)
            }
            throw error
        }
    }

    private func readVideo(_ reference: SegmentReference) throws -> CaptureImage {
        let videoDirectory = directory.appendingPathComponent(SpoolLayout.videoDirectory, isDirectory: true)
        guard try SpoolFiles.isRealDirectory(videoDirectory) else {
            throw VideoArchiveError.invalidReference
        }
        let segment = directory.appendingPathComponent(reference.segment)
        let bytes = try SpoolFiles.read(files, segment, maximumBytes: SegmentCodec.maximumSegmentBytes)
        guard Data(SHA256.hash(data: bytes)) == reference.segmentSHA256 else {
            throw VideoArchiveError.corruptSegment
        }
        return .raw(try files.readable(segment, in: scratch) {
            try SegmentCodec.decode(url: $0, reference: reference)
        })
    }

    func decode(_ bundle: URL, metadata: MetadataFile? = nil) throws -> CaptureObservation {
        do {
            return try decodeBundle(bundle, metadata: metadata)
        } catch {
            throw CaptureStoreError.bundleFailure(name: bundle.lastPathComponent, cause: error)
        }
    }

    private func decodeBundle(_ bundle: URL, metadata: MetadataFile?) throws -> CaptureObservation {
        let corrupt = CaptureStoreError.corruptBundle(bundle.lastPathComponent)
        guard try SpoolFiles.isRealDirectory(bundle) else {
            throw corrupt
        }
        var observation = try observationDecoder((metadata ?? metadataFile(bundle)).json())
        guard Self.hasStorableTimeAndSize(observation) else {
            throw corrupt
        }
        guard observation.imageEncoding == nil else {
            throw corrupt
        }
        guard let image = observation.imageFile else {
            return observation
        }
        let prefix = bundle.deletingLastPathComponent().lastPathComponent + "/" + bundle.lastPathComponent + "/"
        guard let file = SpoolLayout.ImageFile.allCases.first(where: { image == prefix + $0.rawValue }) else {
            throw corrupt
        }
        if let archived = try ArchiveSidecar.published(in: bundle, for: observation, files: files) {
            observation.imageEncoding = archived.encoding
            return observation
        }
        let imageURL = bundle.appendingPathComponent(file.rawValue)
        do {
            let values = try imageURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                throw corrupt
            }
        } catch {
            guard let archived = try ArchiveSidecar.published(in: bundle, for: observation, files: files) else {
                throw error
            }
            observation.imageEncoding = archived.encoding
        }
        return observation
    }

    struct MetadataFile {
        let bytes: Data

        var checksum: Data {
            Data(SHA256.hash(data: bytes))
        }

        func json() throws -> Data {
            try MetadataCodec.decode(bytes)
        }
    }

    func metadataFile(_ bundle: URL) throws -> MetadataFile {
        let url = bundle.appendingPathComponent(SpoolLayout.metadata)
        return MetadataFile(bytes: try SpoolFiles.read(files, url, maximumBytes: MetadataCodec.maximumPacketBytes))
    }

    func safeImageURL(_ path: String) throws -> URL {
        guard let image = SpoolLayout.ImagePath.parse(path) else {
            throw CaptureStoreError.corruptBundle("image-path")
        }
        var url = directory
        for component in [image.day, image.bundle] {
            url.appendPathComponent(component, isDirectory: true)
            guard try SpoolFiles.isRealDirectory(url) else {
                throw CaptureStoreError.corruptBundle("image-parent")
            }
        }
        return url.appendingPathComponent(image.file.rawValue)
    }

    func days(since: Date?) throws -> [URL] {
        let minimum = since.map(SpoolLayout.dayName(for:))
        let days = try SpoolFiles.children(of: directory).filter { url in
            let name = url.lastPathComponent
            guard SpoolLayout.isDayName(name) else {
                return false
            }
            if let minimum, name < minimum {
                return false
            }
            guard try SpoolFiles.isRealDirectory(url) else {
                throw CaptureStoreError.corruptBundle(name)
            }
            return true
        }
        return days.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private static func indexedBefore(_ name: String, since: Date) -> Bool {
        guard let seconds = SpoolLayout.indexedSeconds(ofBundle: name) else {
            return false
        }
        return since.timeIntervalSince1970.isFinite && seconds + 0.001 < since.timeIntervalSince1970
    }
}
