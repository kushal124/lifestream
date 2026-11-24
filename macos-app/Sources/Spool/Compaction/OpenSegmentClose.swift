import Evidence
import DeviceFiles
import Foundation
import AVFoundation

extension VideoCompaction {
    static func prepareOpenSegment(
        _ id: String,
        in videoDirectory: URL,
        store: CaptureStore,
        readMovie: (URL) throws -> Data,
        interrupt: ((Stage) throws -> Void)?
    ) throws -> Preparation? {
        let folder = store.directory.appendingPathComponent(SpoolLayout.openSegmentPath(id: id), isDirectory: true)
        guard try SpoolFiles.exists(folder) else {
            store.didCloseSegment(id)
            return nil
        }
        guard try hasSamples(in: folder, files: store.files) else {
            try FileManager.default.removeItem(at: folder)
            store.didCloseSegment(id)
            return nil
        }
        let named = store.pendingImages(naming: id)
        let format: OpenSegmentLog.Format
        let description: CMVideoFormatDescription
        let records: [OpenSegmentLog.Record]
        do {
            (format, records) = try store.openSegment(id)
            description = try OpenSegmentLog.formatDescription(format)
            guard !records.isEmpty else {
                throw VideoArchiveError.corruptSegment
            }
        } catch where isTerminal(error) {
            try store.setAside(id, why: .format)
            return nil
        }
        let published = try records.map { try store.publishedBundle(of: $0.imagePath) != nil }
        let run = Array(records.prefix((published.lastIndex(of: true) ?? -1) + 1))
        let candidates = run.indices.filter { published[$0] }
        let admitted = store.admit(candidates.map { run[$0].imagePath })
        let frames: [(ordinal: Int, frame: CaptureStore.CompactionFrame)] = admitted.compactMap { frame in
            guard let ordinal = run.firstIndex(where: { $0.imagePath == frame.observation.imageFile }),
                  frame.observation.imageEncoding == nil,
                  frame.observation.width == format.encoding.originalWidth,
                  frame.observation.height == format.encoding.originalHeight,
                  let bundle = try? store.safeImageURL(run[ordinal].imagePath).deletingLastPathComponent(),
                  (try? store.openImage(in: bundle)) == OpenImage(segment: id, ordinal: ordinal) else {
                return nil
            }
            return (ordinal, frame)
        }
        let closing = Set(frames.compactMap(\.frame.observation.imageFile))
        store.skipCompaction(of: named.filter { !closing.contains($0) })
        guard !frames.isEmpty else {
            try FileManager.default.removeItem(at: folder)
            store.didCloseSegment(id)
            return nil
        }

        let staging = videoDirectory.appendingPathComponent(SpoolLayout.stagingPrefix + id, isDirectory: true)
        store.compactionNeedsRecovery = true
        try FileManager.default.createDirectory(
            at: staging,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700]
        )
        let samples = try run.map { try OpenSegmentLog.sampleBuffer($0, format: description) }
        let made = try MovieMuxer.write(samples: samples, id: id, in: store.scratch)
        try interrupt?(.movieWritten)
        return try journal(frames, frameCount: run.count, id: id, made: made, staging: staging, files: store.files,
                           encoding: format.encoding, readMovie: readMovie)
    }

    private static func hasSamples(in folder: URL, files: DeviceFiles) throws -> Bool {
        do {
            return try files.size(of: folder.appendingPathComponent(SpoolLayout.openSamples)) > 0
        } catch where SpoolFiles.isAbsence(error) {
            return false
        }
    }
}
