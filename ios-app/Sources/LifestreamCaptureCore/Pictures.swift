import CoreGraphics
import Foundation
import HomeLink
import ImageIO
import Observation

extension HomeLink.PersonPhoto {
    public var hash: String? { crop ?? card }
}

public enum PictureDecode {
    public static let largest = 2_560

    public static func decode(_ data: Data, side: Int) -> CGImage? {
        decode(data) { width, height in
            min(Double(largest), max(width, height) * min(1, Double(side) / min(width, height)))
        }
    }

    public static func decode(_ data: Data, fittedIn box: CGSize, zoom: Double) -> CGImage? {
        decode(data) { width, height in
            max(width, height) * min(1, zoom * min(box.width / width, box.height / height))
        }
    }

    private static func decode(_ data: Data, longest: (Double, Double) -> Double) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Double,
              let height = properties[kCGImagePropertyPixelHeight] as? Double, width > 0, height > 0
        else { return nil }
        let turned = (properties[kCGImagePropertyOrientation] as? Int ?? 1) >= 5
        let pixels = turned ? longest(height, width) : longest(width, height)
        guard pixels > 0 else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(pixels.rounded(.up)),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

@MainActor
public final class Pictures<Picture: Sendable> {
    public typealias Read = @Sendable (String, HomeLink.PictureSize) async throws -> Data
    public typealias Decode = @Sendable (Data, Int) -> (picture: Picture, pixels: Int)?

    struct Key: Hashable {
        let hash: String
        let size: HomeLink.PictureSize
    }

    @MainActor @Observable
    final class Slot {
        var picture: Picture?
        var side = 0
        @ObservationIgnored var pixels = 0
        @ObservationIgnored var used = 0
    }

    @MainActor private final class Reading {
        var side: Int
        var waiters = 0
        var task: Task<Picture?, Error>?
        var forgotten = false

        init(side: Int) {
            self.side = side
        }
    }

    private let budget: Int
    private let reader: Read
    private let decode: Decode
    private var slots: [Key: Slot] = [:]
    private var reads: [Key: Reading] = [:]
    private var clock = 0
    public private(set) var pixels = 0

    public init(budget: Int, read: @escaping Read, decode: @escaping Decode) {
        self.budget = budget
        self.reader = read
        self.decode = decode
    }

    public func picture(_ hash: String?, _ size: HomeLink.PictureSize) -> Picture? {
        hash.map { slot(Key(hash: $0, size: size)).picture } ?? nil
    }

    public func holds(_ hash: String, _ size: HomeLink.PictureSize, side: Int) -> Bool {
        holds(Key(hash: hash, size: size), side: side)
    }

    func waiters(_ hash: String, _ size: HomeLink.PictureSize) -> Int {
        reads[Key(hash: hash, size: size)]?.waiters ?? 0
    }

    @discardableResult
    public func read(_ hash: String, _ size: HomeLink.PictureSize, side: Int) async throws -> Picture? {
        let reader = reader
        return try await read(Key(hash: hash, size: size), side: side) { try await reader(hash, size) }
    }

    public func keep(_ hash: String, _ size: HomeLink.PictureSize, side: Int, bytes: Data) async {
        _ = try? await read(Key(hash: hash, size: size), side: side) { bytes }
    }

    public func forget() {
        for read in reads.values {
            read.forgotten = true
            read.task?.cancel()
        }
        reads = [:]
        for slot in slots.values where slot.picture != nil {
            slot.picture = nil
            slot.side = 0
            slot.pixels = 0
        }
        pixels = 0
    }

    private func read(_ key: Key, side: Int, bytes: @escaping @Sendable () async throws -> Data) async throws -> Picture? {
        clock += 1
        slot(key).used = clock
        while !Task.isCancelled {
            if holds(key, side: side) { return slot(key).picture }
            let read = join(key, side: side, bytes: bytes)
            read.waiters += 1
            do {
                let landed = try await withTaskCancellationHandler {
                    try await read.task?.value ?? nil
                } onCancel: {
                    Task { @MainActor [weak self] in self?.leave(key, read) }
                }
                if !read.forgotten { return landed }
            } catch {
                guard read.forgotten else { throw error }
            }
        }
        return nil
    }

    private func holds(_ key: Key, side: Int) -> Bool {
        let slot = slot(key)
        return slot.picture != nil && slot.side >= side
    }

    private func slot(_ key: Key) -> Slot {
        if let slot = slots[key] { return slot }
        let slot = Slot()
        slots[key] = slot
        return slot
    }

    private func join(_ key: Key, side: Int, bytes: @escaping @Sendable () async throws -> Data) -> Reading {
        if let read = reads[key] {
            read.side = max(read.side, side)
            return read
        }
        let read = Reading(side: side)
        reads[key] = read
        let decode = decode
        read.task = Task { [weak self] in
            defer { self?.end(key, read) }
            let data = try await Self.made(bytes)
            try Task.checkCancellation()
            var side = 0
            var landed: Picture?
            while read.side > side {
                side = read.side
                let wanted = side
                let made = await Task.detached(priority: .userInitiated) { decode(data, wanted) }.value
                guard let made else { break }
                try Task.checkCancellation()
                self?.land(key, made.picture, side: side, pixels: made.pixels)
                landed = made.picture
            }
            return landed
        }
        return read
    }

    private static func made(_ bytes: @Sendable () async throws -> Data) async throws -> Data {
        while true {
            do {
                return try await bytes()
            } catch LinkFailure.unavailable(code: "NOT_NOW", _, retryAfter: let after?, _) {
                try await Task.sleep(for: .seconds(after))
            }
        }
    }

    private func leave(_ key: Key, _ read: Reading) {
        read.waiters -= 1
        guard read.waiters <= 0, reads[key] === read else { return }
        read.task?.cancel()
        reads[key] = nil
    }

    private func end(_ key: Key, _ read: Reading) {
        if reads[key] === read { reads[key] = nil }
    }

    private func land(_ key: Key, _ picture: Picture, side: Int, pixels count: Int) {
        let slot = slot(key)
        guard slot.picture == nil || slot.side < side else { return }
        pixels += count - slot.pixels
        slot.picture = picture
        slot.side = side
        slot.pixels = count
        clock += 1
        slot.used = clock
        while pixels > budget {
            guard let oldest = slots.values.filter({ $0.picture != nil && $0 !== slot }).min(by: { $0.used < $1.used }) else { break }
            pixels -= oldest.pixels
            oldest.picture = nil
            oldest.side = 0
            oldest.pixels = 0
        }
    }
}
