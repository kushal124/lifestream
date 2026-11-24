import Foundation
import HomeLink
import Passwords

enum ReachDiagnosis {
    static let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/lifestream/home.log")

    static func explain(_ link: HomeLink, pointer: URL = HomeSocket.pointer, log: URL = ReachDiagnosis.log) -> @Sendable () -> HomeLink.Cause? {
        { cause(home: (try? link.name()) ?? nil, pointer: pointer, log: log) }
    }

    static func cause(home: URL?, pointer: URL, log: URL) -> HomeLink.Cause? {
        guard let host = home?.host, HomeLink.isLoopback(host: host) else { return nil }
        let folder = (try? String(contentsOf: pointer, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        if unplugged(folder) { return .driveAway }
        if let stopped = stopped(lastLine(of: log)) { return .local(stopped) }
        guard let socket = HomeSocket.thisMac(pointer: pointer), socket.listens() else { return .notRunning }
        return nil
    }

    private static func unplugged(_ folder: String?) -> Bool {
        guard let folder, folder.hasPrefix("/Volumes/") else { return false }
        let volume = "/Volumes/" + (folder.dropFirst("/Volumes/".count).split(separator: "/").first.map(String.init) ?? "")
        return !FileManager.default.fileExists(atPath: volume)
    }

    static func stopped(_ line: String?) -> String? {
        guard let data = line?.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let state = object["home"] as? String, state == "stopped" || state == "failed",
              let why = object["why"] as? String else { return nil }
        if why.contains("SQLITE_FULL") { return "The disk holding Lifestream is full. Free some room and it starts again." }
        if why.contains("SQLITE_IOERR") || why.contains("SQLITE_CANTOPEN") {
            return "The drive holding Lifestream could not be read. Lifestream tries again within a minute."
        }
        return "Lifestream on this Mac stopped: \(why.prefix(160))"
    }

    static func lastLine(of log: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: log) else { return nil }
        defer { try? handle.close() }
        guard let end = try? handle.seekToEnd() else { return nil }
        try? handle.seek(toOffset: end > 16_384 ? end - 16_384 : 0)
        guard let tail = try? handle.readToEnd() else { return nil }
        return String(decoding: tail, as: UTF8.self).split(separator: "\n").last.map(String.init)
    }
}
