import Foundation

public struct SealedSource: Sendable, Equatable {
    public let domain: CaptureDomain
    public let source: String
    public let seal: Int
    public let after: UInt64

    public init(domain: CaptureDomain, source: String, seal: Int, after: UInt64) {
        self.domain = domain; self.source = source; self.seal = seal; self.after = after
    }
}

public struct ExportSeal: Sendable, Equatable {
    public let bundles: [BuiltExportBundle]
    public let satOut: [String: String]
    public let toFree: Int64?
}

public struct CaptureExporter: Sendable {
    public let store: CaptureStore
    public let exportsDirectory: URL

    public init(store: CaptureStore, exportsDirectory: URL) {
        self.store = store
        self.exportsDirectory = exportsDirectory
    }

    public static let clearedPhotoCopies = "photo copies this phone cleared once Lifestream had imported them"
    public static let missingFiles = "files this phone no longer holds"
    public static let sharedBytes: UInt64 = 8_000_000
    static let fileOverheadBytes: UInt64 = 1024
    static let bundleOverheadBytes: UInt64 = 64 * 1024

    public func seal(
        _ sources: [SealedSource],
        unspoken: Set<String> = [],
        held: Set<String> = [],
        hardware: DeviceHardware,
        appVersion: String,
        now: Date? = nil
    ) async throws -> ExportSeal {
        try await build(sources.map { Part(domain: $0.domain, after: $0.after, sealed: ($0.source, $0.seal)) },
                        unspoken: unspoken, held: held, hardware: hardware, appVersion: appVersion, now: now)
    }

    public func copy(hardware: DeviceHardware, appVersion: String, now: Date? = nil) async throws -> BuiltExportBundle? {
        try await build(CaptureDomain.allCases.map { Part(domain: $0, after: 0, sealed: nil) }, unspoken: [], held: [],
                        hardware: hardware, appVersion: appVersion, now: now).bundles.first
    }

    private struct Part {
        let domain: CaptureDomain
        let after: UInt64
        let sealed: (source: String, seal: Int)?
    }

    private struct Staged {
        let part: Part
        let slice: StagedCaptureLogSlice
        let blobs: [CaptureStore.VerifiedBlob]
        let lost: [Lost]
        var weight: UInt64 {
            blobs.reduce(slice.bytes + CaptureExporter.fileOverheadBytes) { $0 + $1.bytes + CaptureExporter.fileOverheadBytes }
        }
    }

    private func build(_ parts: [Part], unspoken: Set<String>, held: Set<String>, hardware: DeviceHardware, appVersion: String,
                       now: Date?) async throws -> ExportSeal {
        let points = try await store.readPoints()
        let captured = try await store.capturedThrough()
        var due = parts.filter { (captured[$0.domain] ?? 0) > $0.after }
        guard !due.isEmpty else { return ExportSeal(bundles: [], satOut: [:], toFree: nil) }
        var satOut: [String: String] = [:]
        if let photos = due.first(where: { $0.domain == .photos }) {
            do { try await store.finishPendingPhotoCleanup() } catch let error where !(error is CancellationError) && photos.sealed != nil {
                satOut[photos.sealed!.source] = String(describing: error)
                due.removeAll { $0.domain == .photos }
            }
        }

        let staging = try await store.createExportStagingDirectory()
        defer { try? FileDurability.removePrivateDirectoryIfPresent(at: staging) }
        let slices = try await store.stageExportSlices(due.map { ($0.domain, $0.after) }, in: staging)
        var staged: [Staged] = []
        var checked: [String: CaptureStore.VerifiedBlob] = [:]
        for part in due {
            do {
                guard let result = slices[part.domain] else { throw CaptureError.corruptState("\(part.domain.rawValue) was not staged") }
                let slice = try result.get()
                try Self.checkObserved(slice)
                let cleared = try await store.clearedPhotoCopies(part.domain, after: part.after).subtracting(held)
                let wanted = slice.blobHashes.subtracting(cleared).subtracting(held)
                for blob in try await store.validatedBlobInventory(archiveChecksum: true, hashes: wanted.subtracting(checked.keys)) {
                    checked[blob.hash] = blob
                }
                let carried = wanted.compactMap { checked[$0] }.sorted { $0.hash < $1.hash }
                let missing = wanted.count - carried.count
                let lost = [cleared.isEmpty ? nil : Lost(items: cleared.count, what: Self.clearedPhotoCopies),
                            missing == 0 ? nil : Lost(items: missing, what: Self.missingFiles)].compactMap { $0 }
                staged.append(Staged(part: part, slice: slice, blobs: carried, lost: lost))
            } catch let error where !(error is CancellationError) && part.sealed != nil {
                satOut[part.sealed!.source] = String(describing: error)
            }
        }
        guard !staged.isEmpty else {
            throw CaptureError.corruptState("no source could be sealed: " +
                satOut.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "; "))
        }

        let groups = Self.grouped(staged)
        let carried = Set(staged.compactMap(\.part.sealed?.source))
        let createdAt = CaptureTime.rfc3339(now ?? AppClock.now)
        var bundles: [BuiltExportBundle] = []
        var toFree: Int64?
        for group in groups {
            let short = store.volume.toFree(.new, bytes: Int64(clamping: Self.weight(group)))
            guard short == 0 else {
                if group.contains(where: { $0.part.sealed == nil }) { throw CaptureError.full }
                toFree = max(toFree ?? 0, short)
                continue
            }
            let mine = Set(group.compactMap(\.part.sealed?.source))
            let left = unspoken.union(satOut.keys).union(carried).subtracting(mine)
            bundles.append(try zip(group, satOut: left.isEmpty || group.contains { $0.part.sealed == nil } ? nil : left.sorted(),
                                   points: points, hardware: hardware, appVersion: appVersion, createdAt: createdAt))
        }
        return ExportSeal(bundles: bundles, satOut: satOut, toFree: toFree)
    }

    private static func weight(_ group: [Staged]) -> UInt64 {
        group.reduce(bundleOverheadBytes) { $0 + $1.weight }
    }

    private static func checkObserved(_ slice: StagedCaptureLogSlice) throws {
        var range = ObservedTimeRange()
        for observed in [slice.firstObservedAt, slice.lastObservedAt].compactMap({ $0 }) { try range.include(observed) }
    }

    private static func grouped(_ staged: [Staged]) -> [[Staged]] {
        if staged.contains(where: { $0.part.sealed == nil }) { return [staged] }
        let bound = sharedBytes - bundleOverheadBytes
        let alone = staged.filter { $0.weight >= bound }
            .sorted { ($0.weight, $0.part.domain.rawValue) < ($1.weight, $1.part.domain.rawValue) }
        let together = staged.filter { $0.weight < bound }.sorted { a, b in
            if (a.part.domain == .location) != (b.part.domain == .location) { return a.part.domain == .location }
            return (a.weight, b.part.domain.rawValue) > (b.weight, a.part.domain.rawValue)
        }
        var shared: [(parts: [Staged], weight: UInt64)] = []
        for part in together {
            if let fits = shared.firstIndex(where: { $0.weight + part.weight < bound }) {
                shared[fits].parts.append(part)
                shared[fits].weight += part.weight
            } else {
                shared.append(([part], part.weight))
            }
        }
        return shared.map(\.parts) + alone.map { [$0] }
    }

    private func zip(_ group: [Staged], satOut: [String]?, points: [CaptureDomain: CaptureStore.ReadPoint], hardware: DeviceHardware,
                     appVersion: String, createdAt: String) throws -> BuiltExportBundle {
        var files: [String: URL] = [:]
        var crc32: [String: UInt32] = [:]
        var manifests: [String: BundleFileManifest] = [:]
        var custody: [String: SourceCustody] = [:]
        var range = ObservedTimeRange()
        var expectedBlobHashes: [String: String] = [:]
        for staged in group {
            let domain = staged.part.domain, slice = staged.slice
            files[domain.filename] = slice.url
            crc32[domain.filename] = slice.archiveCRC32
            manifests[domain.filename] = .init(
                sha256: slice.sha256, bytes: slice.bytes, observations: slice.observations,
                firstSequence: slice.firstSequence, lastSequence: slice.lastSequence)
            for blob in staged.blobs {
                let name = "blobs/\(blob.url.lastPathComponent)"
                files[name] = blob.url
                crc32[name] = blob.crc32
                expectedBlobHashes[name] = blob.hash
                manifests[name] = .init(
                    sha256: blob.hash, bytes: blob.bytes, observations: 0,
                    firstSequence: nil, lastSequence: nil)
            }
            if let sealed = staged.part.sealed {
                custody[sealed.source] = SourceCustody(
                    seal: sealed.seal, lost: staged.lost.isEmpty ? nil : staged.lost,
                    historyThrough: points[domain]?.at, types: points[domain]?.types)
            }
            for observed in [slice.firstObservedAt, slice.lastObservedAt].compactMap({ $0 }) {
                try range.include(observed)
            }
        }

        let encoder = JSONEncoder.lifestream()
        let device = BundleDevice(install: store.install, hardware: hardware)
        let timeRange = BundleTimeRange(start: range.start, end: range.end)
        let bundleID = SHA256Digest.tagged(try encoder.encode(BundleIdentityMaterial(
            schemaVersion: 3, device: device, appVersion: appVersion, createdAt: createdAt,
            timeRangeCovered: timeRange, files: manifests, custody: custody, satOut: satOut)))
        let manifest = ExportBundleManifest(
            schemaVersion: 3, bundleID: bundleID, device: device, appVersion: appVersion,
            createdAt: createdAt, timeRangeCovered: timeRange, files: manifests, custody: custody, satOut: satOut)
        let manifestURL = slices(group).appendingPathComponent("manifest-\(bundleID.dropFirst("sha256:".count).prefix(12)).json")
        try FileDurability.writeNewRegularFileDurably(try encoder.encode(manifest), to: manifestURL)
        files["manifest.json"] = manifestURL

        try FileDurability.createDirectoryDurably(at: exportsDirectory)
        let destination = exportsDirectory.appendingPathComponent(Self.filename(for: bundleID))
        try FileDurability.removeRegularFileIfPresentDurably(at: destination)
        let prepared = try StoredZIPWriter.prepare(
            fileURLs: files, to: destination, precomputedCRC32: crc32, expectedSHA256: expectedBlobHashes)
        defer { try? StoredZIPWriter.removeTemporary(prepared) }
        try StoredZIPWriter.publish(prepared)
        return BuiltExportBundle(url: destination, manifest: manifest)
    }

    private func slices(_ group: [Staged]) -> URL {
        group[0].slice.url.deletingLastPathComponent()
    }

    public static func filename(for bundleID: String) -> String {
        "lifestream-ios-\(bundleID.dropFirst("sha256:".count).prefix(12)).zip"
    }

    public func removeBundles(keeping kept: Set<String>) throws {
        guard try FileDurability.realDirectoryExists(at: exportsDirectory) else { return }
        for name in try FileManager.default.contentsOfDirectory(atPath: exportsDirectory.path)
        where !kept.contains(name) {
            var directory: ObjCBool = false
            let url = exportsDirectory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), !directory.boolValue
            else { continue }
            try FileDurability.removeRegularFileIfPresent(at: url)
        }
        try FileDurability.synchronizeDirectory(at: exportsDirectory)
    }
}
