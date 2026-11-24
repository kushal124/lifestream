import DeviceFiles
import Foundation
import Recorder

enum RecordingSwitches {
    static func off(_ sources: [String]?) -> Set<Producer> {
        guard let sources else { return [] }
        return Set(Producer.allCases.filter { producer in
            !sources.contains { $0.hasPrefix("\(producer.rawValue):local:") }
        })
    }
}

@MainActor final class AudioCarry {
    nonisolated static let fileName = "audio.json"
    private let file: URL
    private let clock: () -> Date
    private(set) var pending: Bool
    private(set) var turning = false
    private(set) var taken: Date?
    private var heard: Date?

    init(directory: URL, files: DeviceFiles, clock: @escaping () -> Date = { Date() }) {
        file = directory.appendingPathComponent(Self.fileName)
        self.clock = clock
        pending = Self.saysOff(file, files: files)
        if !pending { try? FileManager.default.removeItem(at: file) }
    }

    var off: Set<Producer> { pending ? [.audio] : [] }

    @discardableResult
    func answered(at: Date, asked: Date?, audio: String, turn: @escaping @MainActor (String) async throws -> Void,
                  knock: @escaping @MainActor () async -> Void) -> Task<Void, Never>? {
        guard pending else { return nil }
        if let taken, let asked, asked > taken {
            try? FileManager.default.removeItem(at: file)
            pending = FileManager.default.fileExists(atPath: file.path)
            return nil
        }
        guard at != heard else { return nil }
        heard = at
        guard taken == nil, !turning else { return nil }
        turning = true
        return Task { @MainActor [weak self] in
            do {
                try await turn(audio)
                guard let self else { return }
                taken = clock()
                turning = false
                await knock()
            } catch {
                self?.turning = false
            }
        }
    }

    private static func saysOff(_ file: URL, files: DeviceFiles) -> Bool {
        guard let data = try? files.read(file, maximumBytes: 1 << 16),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return object["record"] as? Bool == false
    }
}
