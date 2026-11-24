import Evidence
import Foundation

extension CaptureStore {
    struct PendingEntry {
        let bytes: Int
        let segment: String
    }

    struct CompactionFrame {
        let observation: CaptureObservation
        let metadataSHA256: Data
    }

    public func compactPendingVideo(flush: Bool = false) async throws -> VideoCompactionReport {
        let task = Task.detached(priority: .utility) {
            try CompactionPermit.withPermit {
                let report = try ResourceMeter.shared.measure(.videoCompaction, units: 0) {
                    try VideoCompaction.compact(store: self, flush: flush)
                }
                if report.imageCount > 0 { ResourceMeter.shared.count(.videoCompaction, units: 1) }
                return report
            }
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    func admit(_ paths: [String]) -> [CompactionFrame] {
        var frames: [CompactionFrame] = []
        for path in paths {
            guard let frame = try? admit(path) else {
                skipCompaction(of: [path])
                continue
            }
            frames.append(frame)
        }
        return frames
    }

    private func admit(_ path: String) throws -> CompactionFrame {
        let bundle = try safeImageURL(path).deletingLastPathComponent()
        let metadata = try metadataFile(bundle)
        let observation = try decode(bundle, metadata: metadata)
        guard observation.imageFile == path else {
            throw VideoArchiveError.invalidReference
        }
        return CompactionFrame(observation: observation, metadataSHA256: metadata.checksum)
    }

    func skipCompaction(of paths: [String]) {
        mutex.lock()
        defer { mutex.unlock() }
        skippedImages.formUnion(paths)
    }

    func validateArchiveEntry(_ entry: ArchiveSidecar) throws {
        do {
            let image = try safeImageURL(entry.imagePath)
            let bundle = image.deletingLastPathComponent()
            let sidecar = bundle.appendingPathComponent(SpoolLayout.archiveSidecar)
            let metadata = try metadataFile(bundle)
            guard metadata.checksum == entry.metadataSHA256,
                  entry.describes(try observationDecoder(metadata.json())),
                  try SpoolFiles.exists(image) || SpoolFiles.exists(sidecar) else {
                throw VideoArchiveError.invalidReference
            }
        } catch where VideoCompaction.isTerminal(error) {
            throw VideoArchiveError.invalidReference
        }
    }

    var compactionNeedsRecovery: Bool {
        get {
            mutex.lock()
            defer { mutex.unlock() }
            return recoveryRequired
        }
        set {
            mutex.lock()
            defer { mutex.unlock() }
            recoveryRequired = newValue
        }
    }

    func didCompactVideo(_ paths: [String]) {
        mutex.lock()
        defer { mutex.unlock() }
        for path in paths {
            pendingImages.removeValue(forKey: path)
        }
    }

    func pendingVideoReport(images: Int = 0) -> VideoCompactionReport {
        mutex.lock()
        defer { mutex.unlock() }
        return VideoCompactionReport(
            imageCount: images,
            pendingImageCount: pendingImages.count,
            pendingBytes: pendingBytes,
            skippedImageCount: skippedImages.count
        )
    }
}
