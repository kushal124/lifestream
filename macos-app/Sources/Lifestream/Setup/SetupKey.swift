import AppKit
import Foundation

@MainActor final class SetupKey {
    struct Shown: Encodable, Equatable {
        let number: Int
        let madeMs: Int64
        let used: RecoveryKey.Used?
        let said: String?

        private enum CodingKeys: String, CodingKey {
            case number, used, said
            case madeMs = "made_ms"
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(number, forKey: .number)
            try container.encode(madeMs, forKey: .madeMs)
            try container.encode(used.map { $0 == .saved ? "saved" : "copied" }, forKey: .used)
            try container.encode(said, forKey: .said)
        }
    }

    enum Act: String, Equatable {
        case show, copy, save, saved, back
    }

    static let noKey = "No recovery key is waiting to be saved."

    var changed: () -> Void = {}
    var board = NSPasteboard.general
    var later = SecretCopy.wallClock
    var choose: (_ name: String, _ over: NSWindow?) async -> URL? = { name, window in await RecoveryKeyFile.choose(name, over: window) }

    private var waiting: (drafted: Drafted, folder: URL, kept: CheckedContinuation<Bool, Never>)?
    private var used: RecoveryKey.Used?
    private var said: String?

    var shown: Shown? {
        waiting.map { Shown(number: $0.drafted.number, madeMs: $0.drafted.made_ms, used: used, said: said) }
    }

    func show(_ drafted: Drafted, folder: URL) async -> Bool {
        end(false)
        return await withCheckedContinuation { continuation in
            waiting = (drafted, folder, continuation)
            changed()
        }
    }

    func perform(_ act: Act, over window: NSWindow?) async throws -> String? {
        guard let asked = waiting else { throw HostRefusal(Self.noKey) }
        switch act {
        case .show:
            return RecoveryKeyFile.grouped(asked.drafted.recovery)
        case .copy:
            SecretCopy.put(asked.drafted.recovery, on: board, later: later)
            if used == nil { used = .copied }
            said = RecoveryKey.copied
        case .save:
            let name = KeyName(number: asked.drafted.number, madeMs: asked.drafted.made_ms)
            guard let file = await choose(RecoveryKeyFile.name(name), window), waiting?.drafted.recovery == asked.drafted.recovery else { return nil }
            switch RecoveryKeyFile.save(asked.drafted.recovery, name: name, keyed: true, to: file, folder: asked.folder) {
            case .saved(let named):
                used = .saved
                said = "Saved to \(named)."
            case .refused(let words):
                said = words
            }
        case .saved:
            guard used != nil else { throw HostRefusal(RecoveryKey.toGoOn) }
            end(true)
            return nil
        case .back:
            end(false)
            return nil
        }
        changed()
        return nil
    }

    private func end(_ kept: Bool) {
        guard let ending = waiting else { return }
        waiting = nil
        used = nil
        said = nil
        ending.kept.resume(returning: kept)
        changed()
    }
}
