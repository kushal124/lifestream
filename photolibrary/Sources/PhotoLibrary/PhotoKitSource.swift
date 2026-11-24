#if canImport(Photos)
import Foundation
@preconcurrency import Photos

extension PhotoLibrary {
    public init() { source = PhotoKitSource() }
}

actor PhotoKitSource: PhotoSource {
    nonisolated var access: PhotoAccess {
        let access = Self.access(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        if access.reads { ChangeObserver.shared.register() }
        return access
    }

    func requestAccess() async -> PhotoAccess {
        let access = Self.access(await PHPhotoLibrary.requestAuthorization(for: .readWrite))
        if access.reads { ChangeObserver.shared.register() }
        return access
    }

    func count() async throws -> Int { PHAsset.fetchAssets(with: Self.options()).count }

    nonisolated func observe(_ changed: @escaping @Sendable () -> Void) {
        ChangeObserver.shared.set(changed)
        _ = access
    }

    func token() async throws -> Data { try Self.archive(PHPhotoLibrary.shared().currentChangeToken) }

    func changes(since token: Data, limit: Int) async throws -> [PhotoChange]? {
        guard let token = try? NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: token) else { return nil }
        var changes: [PhotoChange] = []
        var named = 0
        do {
            for change in try PHPhotoLibrary.shared().fetchPersistentChanges(since: token) {
                let details = try change.changeDetails(for: .asset)
                let upserted = Array(details.insertedLocalIdentifiers.union(details.updatedLocalIdentifiers))
                let deleted = Array(details.deletedLocalIdentifiers)
                changes.append(PhotoChange(upserted: upserted, deleted: deleted, token: try Self.archive(change.changeToken)))
                named += upserted.count + deleted.count
                if named >= limit { break }
            }
        } catch let error as PHPhotosError where [.persistentChangeTokenExpired, .persistentChangeDetailsUnavailable].contains(error.code) {
            return nil
        }
        return changes
    }

    func identifiers() async throws -> [String] {
        let dated = Self.options()
        dated.predicate = NSPredicate(format: "creationDate != nil")
        dated.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let undated = Self.options()
        undated.predicate = NSPredicate(format: "creationDate == nil")
        var ids: [String] = []
        for options in [dated, undated] {
            PHAsset.fetchAssets(with: options).enumerateObjects { asset, _, _ in ids.append(asset.localIdentifier) }
        }
        return ids
    }

    func creationDates() async throws -> [Date?] {
        var dates: [Date?] = []
        PHAsset.fetchAssets(with: Self.options()).enumerateObjects { asset, _, _ in dates.append(asset.creationDate) }
        return dates
    }

    func snapshots(of ids: [String]) async throws -> [PhotoSnapshot] {
        guard !ids.isEmpty else { return [] }
        var assets: [String: PHAsset] = [:]
        PHAsset.fetchAssets(withLocalIdentifiers: ids, options: Self.options()).enumerateObjects { asset, _, _ in
            assets[asset.localIdentifier] = asset
        }
        let clouds = PHPhotoLibrary.shared().cloudIdentifierMappings(forLocalIdentifiers: Array(assets.keys))
        return ids.compactMap { id in
            assets[id].map { Self.snapshot($0, cloud: (try? clouds[id]?.get()).flatMap(Self.text)) }
        }
    }

    func file(of id: String, resource: PhotoResource, network: Bool, most: Int64, to url: URL) async -> Fetched {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: Self.options()).firstObject,
              let target = PHAssetResource.assetResources(for: asset).first(where: { Self.resource($0).isSameFile(as: resource) })
        else { return .refused(.notFound) }
        guard let sink = try? ResourceFile(url, most: most) else { return .later }
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = network
        let manager = PHAssetResourceManager.default()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                sink.receive(continuation)
                let request = manager.requestData(for: target, options: options,
                                                  dataReceivedHandler: Self.received(sink), completionHandler: Self.completed(sink))
                sink.onCancel { manager.cancelDataRequest(request) }
            }
        } onCancel: { sink.cancel() }
    }


    nonisolated private static func options() -> PHFetchOptions {
        let options = PHFetchOptions()
        options.includeHiddenAssets = true
        options.includeAllBurstAssets = true
        return options
    }

    nonisolated private static func archive(_ token: PHPersistentChangeToken) throws -> Data {
        try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
    }

    nonisolated private static func text(_ cloud: PHCloudIdentifier) -> String? {
        if #available(macOS 15.2, iOS 18.2, *) { cloud.archivalStringValue } else { nil }
    }

    nonisolated private static func received(_ sink: ResourceFile) -> @Sendable (Data) -> Void {
        { chunk in sink.append(chunk) }
    }

    nonisolated private static func completed(_ sink: ResourceFile) -> @Sendable ((any Error)?) -> Void {
        { error in sink.finish(error.map(Self.outcome)) }
    }

    nonisolated static func outcome(_ error: any Error) -> Fetched {
        let error = error as NSError
        guard error.domain == PHPhotosErrorDomain else { return .later }
        switch PHPhotosError.Code(rawValue: error.code) {
        case .missingResource, .identifierNotFound: return .refused(.notFound)
        default: return .later
        }
    }

    nonisolated static func access(_ status: PHAuthorizationStatus) -> PhotoAccess {
        switch status {
        case .authorized: .full
        case .limited: .limited
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .undecided
        @unknown default: .undecided
        }
    }

    nonisolated private static func resource(_ resource: PHAssetResource) -> PhotoResource {
        PhotoResource(typeRaw: resource.type.rawValue, uti: resource.uniformTypeIdentifier, originalFilename: resource.originalFilename,
                      size: size(of: resource))
    }

    nonisolated private static func size(of resource: PHAssetResource) -> Int64? {
        guard resource.responds(to: NSSelectorFromString("fileSize")),
              let number = resource.value(forKey: "fileSize") as? NSNumber, number.int64Value >= 0 else { return nil }
        return number.int64Value
    }

    nonisolated private static func snapshot(_ asset: PHAsset, cloud: String?) -> PhotoSnapshot {
        PhotoSnapshot(
            localIdentifier: asset.localIdentifier, cloudIdentifier: cloud,
            mediaTypeRaw: asset.mediaType.rawValue, mediaSubtypesRaw: asset.mediaSubtypes.rawValue,
            creationDate: asset.creationDate, modificationDate: asset.modificationDate,
            pixelWidth: asset.pixelWidth, pixelHeight: asset.pixelHeight, duration: asset.duration,
            isFavorite: asset.isFavorite, isHidden: asset.isHidden, sourceTypeRaw: asset.sourceType.rawValue,
            latitude: asset.location?.coordinate.latitude, longitude: asset.location?.coordinate.longitude,
            burstIdentifier: asset.burstIdentifier, representsBurst: asset.representsBurst,
            resources: PHAssetResource.assetResources(for: asset).map(resource))
    }
}

final class ResourceFile: @unchecked Sendable {
    private let lock = NSLock()
    private let url: URL
    private let most: Int64
    private var handle: FileHandle?
    private var written: Int64 = 0
    private var broken = false
    private var result: Fetched?
    private var continuation: CheckedContinuation<Fetched, Never>?
    private var cancelRequest: (@Sendable () -> Void)?

    private struct Ending {
        let outcome: Fetched
        let waiting: CheckedContinuation<Fetched, Never>?
        let cancel: (@Sendable () -> Void)?

        func run() {
            cancel?()
            waiting?.resume(returning: outcome)
        }
    }

    init(_ url: URL, most: Int64) throws {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        self.url = url
        self.most = most
        handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    func receive(_ continuation: CheckedContinuation<Fetched, Never>) {
        let ready: Fetched? = lock.withLock {
            if result == nil { self.continuation = continuation }
            return result
        }
        if let ready { continuation.resume(returning: ready) }
    }

    func onCancel(_ cancel: @escaping @Sendable () -> Void) {
        let ended = lock.withLock {
            if result == nil { cancelRequest = cancel }
            return result != nil
        }
        if ended { cancel() }
    }

    func append(_ chunk: Data) {
        let ending: Ending? = lock.withLock {
            guard result == nil, !broken, let handle else { return nil }
            guard Int64(chunk.count) <= most - written else { return end(.noRoom, cancelling: true) }
            do {
                try handle.write(contentsOf: chunk)
                written += Int64(chunk.count)
            } catch { broken = true }
            return nil
        }
        ending?.run()
    }

    func finish(_ failure: Fetched?) { lock.withLock { end(failure, cancelling: false) }?.run() }

    func cancel() { lock.withLock { end(.later, cancelling: true) }?.run() }

    private func end(_ failure: Fetched?, cancelling: Bool) -> Ending? {
        guard result == nil else { return nil }
        var outcome = Fetched.later
        if let failure {
            outcome = failure
        } else {
            do {
                guard !broken, let handle else { throw POSIXError(.EIO) }
                try handle.synchronize()
                outcome = .file(url)
            } catch { outcome = .later }
        }
        try? handle?.close()
        handle = nil
        if case .file = outcome {} else { try? FileManager.default.removeItem(at: url) }
        result = outcome
        defer { continuation = nil; cancelRequest = nil }
        return Ending(outcome: outcome, waiting: continuation, cancel: cancelling ? cancelRequest : nil)
    }
}
private final class ChangeObserver: NSObject, PHPhotoLibraryChangeObserver, @unchecked Sendable {
    static let shared = ChangeObserver()
    private let lock = NSLock()
    private var changed: (@Sendable () -> Void)?
    private var registered = false

    func set(_ changed: @escaping @Sendable () -> Void) { lock.withLock { self.changed = changed } }

    func register() {
        let first = lock.withLock { () -> Bool in
            defer { registered = true }
            return !registered
        }
        if first { PHPhotoLibrary.shared().register(self) }
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) { lock.withLock { changed }?() }
}
#endif
