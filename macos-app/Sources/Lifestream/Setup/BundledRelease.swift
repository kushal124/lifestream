import Darwin
import Foundation

struct BundledRelease: Sendable {
    let folder: URL

    static func inApp(_ bundle: Bundle = .main) -> BundledRelease? {
        guard let folder = bundle.resourceURL?.appendingPathComponent("release"),
              FileManager.default.fileExists(atPath: folder.appendingPathComponent("RELEASE.json").path) else { return nil }
        return BundledRelease(folder: folder)
    }

    var stamp: ReleaseStamp? { ReleaseStamp(manifest: folder.appendingPathComponent("RELEASE.json")) }

    private func clearQuarantine() {
        let mark = "com.apple.quarantine"
        guard getxattr(folder.path, mark, nil, 0, 0, XATTR_NOFOLLOW) >= 0,
              let files = FileManager.default.enumerator(atPath: folder.path) else { return }
        for case let path as String in files {
            removexattr(folder.appendingPathComponent(path).path, mark, XATTR_NOFOLLOW)
        }
        removexattr(folder.path, mark, XATTR_NOFOLLOW)
    }

    func command(_ act: General.CommandAct? = nil) throws -> General.Command {
        try JSONDecoder().decode(General.Command.self, from: home(Self.commandArguments(act)))
    }

    static func commandArguments(_ act: General.CommandAct?) -> [String] {
        ["command"] + (act.map { [$0.rawValue] } ?? []) + ["--json"]
    }

    func home(_ arguments: [String]) throws -> Data {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let process = verb(arguments)
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("home-command-\(UUID().uuidString)")
        try Data().write(to: output)
        defer { try? FileManager.default.removeItem(at: output) }
        let handle = try FileHandle(forWritingTo: output)
        defer { try? handle.close() }
        process.standardOutput = handle
        process.standardError = handle
        process.standardInput = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return try answer(arguments, process, try Data(contentsOf: output))
    }

    func draft() throws -> Drafted {
        try JSONDecoder().decode(Drafted.self, from: home(["keys", "draft"], handing: Data()))
    }

    func home(_ arguments: [String], handing input: Data) throws -> Data {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let process = verb(arguments)
        let handed = Pipe()
        let output = Pipe()
        process.standardInput = handed
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let writer = handed.fileHandleForWriting
        DispatchQueue.global(qos: .userInitiated).async {
            try? writer.write(contentsOf: input)
            try? writer.close()
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return try answer(arguments, process, data)
    }

    private func verb(_ arguments: [String]) -> Process {
        clearQuarantine()
        let process = Process()
        process.executableURL = folder.appendingPathComponent("node")
        process.arguments = [folder.appendingPathComponent("dist/home.mjs").path] + arguments
        return process
    }

    private func answer(_ arguments: [String], _ process: Process, _ data: Data) throws -> Data {
        let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let last = text.split(separator: "\n").last.map(String.init) ?? ""
        guard process.terminationStatus == 0 else {
            throw ReleaseError(words: text.isEmpty ? "Lifestream's \(arguments.first ?? "") stopped with status \(process.terminationStatus)" : text)
        }
        guard last.hasPrefix("{") else { throw ReleaseError(words: "Lifestream's \(arguments.first ?? "") answered no result") }
        return Data(last.utf8)
    }
}

struct ReleaseStamp: Equatable, Sendable {
    let commit: String
    let generation: Int?

    func isNewer(than other: ReleaseStamp) -> Bool {
        guard let generation else { return false }
        guard let theirs = other.generation else { return true }
        return generation > theirs
    }
}

extension ReleaseStamp {
    init?(manifest: URL) {
        guard let data = try? Data(contentsOf: manifest),
              let fields = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let commit = fields["commit"] as? String else { return nil }
        self.init(commit: commit, generation: fields["generation"] as? Int)
    }
}

struct ReleaseError: LocalizedError, CustomStringConvertible {
    let words: String

    var description: String { words }
    var errorDescription: String? { words }
}
