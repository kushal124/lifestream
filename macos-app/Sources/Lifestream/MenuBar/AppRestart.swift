import Foundation

struct Resume: Codable, Equatable {
    var page: String?
    var at: Date

    static let fresh: TimeInterval = 10 * 60
    static let key = "LifestreamResume"

    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(try? JSONEncoder().encode(self), forKey: Self.key)
    }

    static func take(_ defaults: UserDefaults = .standard, now: Date = Date()) -> Resume? {
        defer { defaults.removeObject(forKey: key) }
        guard let data = defaults.data(forKey: key), let resume = try? JSONDecoder().decode(Resume.self, from: data),
              abs(now.timeIntervalSince(resume.at)) <= fresh else { return nil }
        return resume
    }
}

extension Resume {
    init(leaving shown: URL?, at: Date) {
        self.init(page: DashboardAddress.place(hash: shown?.fragment), at: at)
    }
}

enum UpdateRelaunch {
    static let key = "LifestreamUpdateRelaunch"

    static func mark(_ defaults: UserDefaults = .standard, at now: Date = Date()) {
        defaults.set(now.timeIntervalSince1970, forKey: key)
    }

    static func take(_ defaults: UserDefaults = .standard, now: Date = Date()) -> Bool {
        defer { defaults.removeObject(forKey: key) }
        let at = defaults.double(forKey: key)
        return at > 0 && abs(now.timeIntervalSince1970 - at) <= Resume.fresh
    }
}

enum AppRestart {
    static func reopen(_ app: URL = Bundle.main.bundleURL, ejecting volume: URL? = nil,
                       pid: Int32 = ProcessInfo.processInfo.processIdentifier) throws {
        let shell = Process()
        shell.executableURL = URL(fileURLWithPath: "/bin/sh")
        shell.arguments = ["-c", "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.1; done; /usr/bin/open \"$2\"; "
                           + "if [ -n \"$3\" ]; then exec /usr/bin/hdiutil detach -quiet \"$3\"; fi",
                           "reopen", "\(pid)", app.path, volume?.path ?? ""]
        shell.standardInput = FileHandle.nullDevice
        shell.standardOutput = FileHandle.nullDevice
        shell.standardError = FileHandle.nullDevice
        try shell.run()
    }
}
