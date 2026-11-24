import AVFoundation
import Foundation
import UniformTypeIdentifiers

public final class VideoLoader: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    public static let range: Int64 = 4 << 20
    public static let first: Int64 = 256 << 10
    public static let ahead: TimeInterval = 30
    static let scheme = "lifestream-blob"

    public let asset: AVURLAsset
    private let link: HomeLink
    private let play: HomeLink.Photo.Play
    private let lock = NSLock()
    private var chains: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var total: Int64?
    private var cancelled = false
    private var held: TimeInterval = 0
    private var waiting: [Int: CheckedContinuation<Void, Never>] = [:]
    private var waits = 0

    public init(link: HomeLink, play: HomeLink.Photo.Play) {
        self.link = link
        self.play = play
        asset = AVURLAsset(url: URL(string: Self.scheme + ":" + play.hash)!)
        super.init()
        asset.resourceLoader.setDelegate(self, queue: DispatchQueue(label: "VideoLoader " + play.hash))
    }

    public func cancel() {
        let ended = lock.withLock {
            cancelled = true
            defer { chains.removeAll() }
            return Array(chains.values)
        }
        ended.forEach { $0.cancel() }
    }

    public func buffered(ahead seconds: TimeInterval) {
        let going = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            held = seconds
            guard seconds < Self.ahead else { return [] }
            defer { waiting.removeAll() }
            return Array(waiting.values)
        }
        going.forEach { $0.resume() }
    }

    var pacing: Int { lock.withLock { waiting.count } }

    private func paced() async {
        let number = lock.withLock { () -> Int in
            waits += 1
            return waits
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (going: CheckedContinuation<Void, Never>) in
                let now = lock.withLock { () -> Bool in
                    guard held >= Self.ahead, !Task.isCancelled else { return true }
                    waiting[number] = going
                    return false
                }
                if now { going.resume() }
            }
        } onCancel: {
            lock.withLock { waiting.removeValue(forKey: number) }?.resume()
        }
    }

    public func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                               shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        serve(loadingRequest) != nil
    }

    public func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loadingRequest: AVAssetResourceLoadingRequest) {
        cancel(loadingRequest)
    }


    protocol Loading: AnyObject {
        var asked: (offset: Int64, end: Int64?)? { get }
        var informs: Bool { get }
        func inform(type: String?, length: Int64)
        func respond(with data: Data)
        func finish()
        func fail(_ error: Error)
    }

    @discardableResult
    func serve(_ request: some Loading) -> Task<Void, Never>? {
        let key = ObjectIdentifier(request)
        return lock.withLock {
            guard !cancelled else { return nil }
            let chain = Task { [self] in
                await run(request)
                _ = lock.withLock { chains.removeValue(forKey: key) }
            }
            chains[key] = chain
            return chain
        }
    }

    func cancel(_ request: some Loading) {
        lock.withLock { chains.removeValue(forKey: ObjectIdentifier(request)) }?.cancel()
    }

    private func run(_ request: some Loading) async {
        let type = UTType(mimeType: play.mediaType)?.identifier
        do {
            guard let asked = request.asked, asked.end.map({ $0 > asked.offset }) ?? true else {
                let length: Int64
                if let total = lock.withLock({ total }) { length = total } else { length = try await link.blob(play.hash, range: 0..<1) { _, _ in } }
                try answerable()
                learnt(length)
                request.inform(type: type, length: length)
                request.finish()
                return
            }
            let (offset, end) = asked
            var at = offset
            var size = Self.first
            var told = !request.informs
            let length = { (total: Int64) in
                self.learnt(total)
                if !told { request.inform(type: type, length: total) }
                told = true
            }
            while true {
                if at > offset { await paced() }
                try answerable()
                let from = at
                let total = try await link.blob(play.hash, range: at..<min(at + size, end ?? Int64.max)) { bytes, total in
                    try answerable()
                    length(total)
                    request.respond(with: bytes)
                    at += Int64(bytes.count)
                }
                try answerable()
                length(total)
                if at == from || at >= min(end ?? total, total) {
                    request.finish()
                    return
                }
                size = min(size * 2, Self.range)
            }
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            request.fail(error)
        }
    }

    private func answerable() throws {
        if Task.isCancelled { throw CancellationError() }
    }

    private func learnt(_ length: Int64) {
        lock.withLock { total = length }
    }
}

extension AVAssetResourceLoadingRequest: VideoLoader.Loading {
    var asked: (offset: Int64, end: Int64?)? {
        guard let data = dataRequest else { return nil }
        return (data.requestedOffset, data.requestsAllDataToEndOfResource ? nil : data.requestedOffset + Int64(data.requestedLength))
    }

    var informs: Bool { contentInformationRequest != nil }

    func inform(type: String?, length: Int64) {
        guard let information = contentInformationRequest else { return }
        information.contentType = type
        information.contentLength = length
        information.isByteRangeAccessSupported = true
    }

    private var open: Bool { !isCancelled && !isFinished }

    func respond(with data: Data) {
        if open { dataRequest?.respond(with: data) }
    }

    func finish() {
        if open { finishLoading() }
    }

    func fail(_ error: Error) {
        if open { finishLoading(with: error) }
    }
}
