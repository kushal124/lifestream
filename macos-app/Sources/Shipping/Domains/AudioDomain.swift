import Audio
import Evidence
import Foundation
import HomeLink

public final class AudioDomain: ShippingDomain {
    static let feeder = "audio-recording"
    static let retention: TimeInterval = 7 * 24 * 60 * 60
    static let maximumSidecarBytes = 1 << 20

    public let sourceId: String
    public let name = "audio"
    let root: URL
    let ledgers: Ledgers
    let clock: @Sendable () -> Date
    private let stated = SealNote<Through?>(nil)

    public init(sourceId: String, root: URL, ledgers: Ledgers, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.sourceId = sourceId
        self.root = root
        self.ledgers = ledgers
        self.clock = clock
    }

    public func seal(_ request: SealRequest) throws -> [SealedBundle] {
        let custody = custody(pass: request.custody.pass)
        let (stems, lost) = try custody.owed(try sealedRecordings(), received: request.custody.received)
        stated.value = nil
        guard !stems.isEmpty else {
            if request.owesThrough {
                stated.value = request.through(readThrough: AudioSpool.oldestOpenRecording(in: root) ?? request.fetchedAt)
            }
            return []
        }

        let sidecars = try stems.map(read)
        let newest = sidecars.map(\.at).max { UTCInstant.date(rfc3339: $0)! < UTCInstant.date(rfc3339: $1)! }!
        let files = stems.flatMap { stem in
            [AudioSpool.sidecarName(stem), AudioSpool.audioName(stem)].map {
                BundleWriter.File(name: $0, content: .kept(root.appendingPathComponent($0)))
            }
        }
        let written = try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: Self.feeder, fetchedAt: request.fetchedAt,
            files: files,
            facts: [("recordings", .int(stems.count)),
                    ("audio_ms", .int(sidecars.reduce(0) { $0 + $1.audio.durationMs })),
                    ("newest_recording_at", JSONText.string(newest)),
                    ("snapshot_taken_at", .string(UTCInstant.rfc3339(request.fetchedAt)))],
            custody: (request.custody, lost), through: ledgers.files)
        try custody.record(stems, at: request.custody.seal, lost: lost)
        return [SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId, custody: request.custody, write: .new))]
    }

    public var through: Through? { stated.value }

    public func applied(_ answer: FreshAnswer) {
        guard let imported = answer.sources[sourceId]?.imported else { return }
        let cutoff = clock().addingTimeInterval(-Self.retention)
        custody(pass: answer.pass).reclaim(imported: imported) { stem in
            guard let began = AudioSpool.instant(ofStem: stem), began < cutoff else { return false }
            for name in [AudioSpool.audioName(stem), AudioSpool.sidecarName(stem)] {
                try? FileManager.default.removeItem(at: root.appendingPathComponent(name))
            }
            return !FileManager.default.fileExists(atPath: root.appendingPathComponent(AudioSpool.sidecarName(stem)).path)
        }
    }


    private func sealedRecordings() throws -> [String] {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else { return [] }
        guard isDirectory.boolValue else { throw AudioDomainError.root(root.path) }
        return AudioSpool.shippableRecordings(in: root).sorted(by: JSONText.javaScriptOrder)
    }

    private func read(_ stem: String) throws -> Shipped {
        let url = root.appendingPathComponent(AudioSpool.sidecarName(stem))
        guard let data = try? ledgers.files.read(url, maximumBytes: Self.maximumSidecarBytes), let sidecar = try? JSONDecoder().decode(Shipped.self, from: data),
              UTCInstant.date(rfc3339: sidecar.at) != nil else {
            throw AudioDomainError.sidecar(stem)
        }
        return sidecar
    }

    private struct Shipped: Decodable {
        let at: String
        let audio: Audio

        struct Audio: Decodable {
            let durationMs: Int

            enum CodingKeys: String, CodingKey {
                case durationMs = "duration_ms"
            }
        }
    }

    private func custody(pass: String) -> SpoolCustody {
        SpoolCustody(ledgers: ledgers, pass: pass, source: sourceId, word: "recordings")
    }
}

enum AudioDomainError: Error, Equatable, CustomStringConvertible {
    case root(String)
    case sidecar(String)

    var description: String {
        switch self {
        case .root(let path): return "\(path) is not a directory of recordings"
        case .sidecar(let stem): return "the recording \(stem) states no readable sidecar"
        }
    }
}
