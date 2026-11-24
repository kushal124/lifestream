import Foundation
import DeviceFiles

public final class FailureLines: @unchecked Sendable {
    public static let shared = FailureLines()

    public enum Part: String, Sendable {
        case recorder, spool, recognition
        case machineEvents = "machine_events"
        case inputLog = "input_log"
    }

    public enum Event: String, CaseIterable, Sendable {
        case runStarted = "run_started"
        case runEnded = "run_ended"
        case uncleanEnd = "unclean_end"
        case tenureLost = "tenure_lost"
        case openingFailed = "opening_failed"
        case tenureOpened = "tenure_opened"
        case spanHeld = "span_held"
        case statusUnwritten = "status_unwritten"
        case statusWritten = "status_written"
        case compactionFailing = "compaction_failing"
        case compactionRecovered = "compaction_recovered"
        case segmentSetAside = "segment_set_aside"
        case helperUnavailable = "helper_unavailable"
        case helperBack = "helper_back"
        case lineDropped = "line_dropped"
        case linesWritten = "lines_written"
        case minuteDropped = "minute_dropped"
        case minutesWritten = "minutes_written"

        public var part: Part {
            switch self {
            case .runStarted, .runEnded, .uncleanEnd, .tenureLost, .openingFailed, .tenureOpened, .spanHeld,
                 .statusUnwritten, .statusWritten:
                return .recorder
            case .compactionFailing, .compactionRecovered, .segmentSetAside: return .spool
            case .helperUnavailable, .helperBack: return .recognition
            case .lineDropped, .linesWritten: return .machineEvents
            case .minuteDropped, .minutesWritten: return .inputLog
            }
        }
    }

    public static let prefix = "recorder-"
    static let folderName = "resources"

    private struct Setup {
        let folder: URL
        let plain: DeviceFiles
        let build: String
        let pid: Int32
        let pruner: DayFiles.Pruner
    }

    private let queue = DispatchQueue(label: "org.lifestreamprotocol.screen-capture.failure-lines", qos: .utility)
    private let lock = NSLock()
    private var setup: Setup?

    public init() {}

    public func configure(spool: URL, plain: DeviceFiles, build: String, pid: Int32) {
        let folder = spool.appendingPathComponent(Self.folderName, isDirectory: true)
        let setup = Setup(folder: folder, plain: plain, build: build, pid: pid,
                          pruner: DayFiles.Pruner(in: folder, prefixes: [Self.prefix]))
        lock.withLock { self.setup = setup }
    }

    public func note(_ event: Event, kind: String? = nil, errno: Int32? = nil, since: Date? = nil, at: Date = Date()) {
        guard let setup = lock.withLock({ self.setup }) else { return }
        let line = Self.line(event, at: at, build: setup.build, pid: setup.pid, kind: kind, errno: errno, since: since)
        queue.async {
            setup.pruner.prune(at: at)
            let file = setup.folder.appendingPathComponent(DayFiles.name(Self.prefix, at: at))
            do {
                OwnerOnly.folder(setup.folder)
                let handle = try setup.plain.log(file)
                defer { handle.close() }
                try handle.append(Data(line.utf8), flush: nil)
            } catch {
            }
        }
    }

    public static func errno(of error: Error) -> Int32? {
        switch error {
        case DeviceFileError.io(_, let code), DeviceFileError.notFlushed(_, let code): return code
        case let error as POSIXError: return error.code.rawValue
        default: return nil
        }
    }

    public func drain() {
        queue.sync {}
    }

    static func line(_ event: Event, at: Date, build: String, pid: Int32, kind: String?, errno: Int32?,
                     since: Date?) -> String {
        var line = "{\"at\":\"\(UTCInstant.rfc3339(at))\",\"build\":\(quoted(build)),\"pid\":\(pid)"
        line += ",\"part\":\"\(event.part.rawValue)\",\"event\":\"\(event.rawValue)\""
        if let kind { line += ",\"kind\":\(quoted(kind))" }
        if let errno { line += ",\"errno\":\(errno)" }
        if let since { line += ",\"since\":\"\(UTCInstant.rfc3339(since))\"" }
        return line + "}\n"
    }

    private static func quoted(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    public struct Streak: Sendable {
        public let closing: Event
        public private(set) var since: Date?
        public private(set) var kind: String?
        public private(set) var errno: Int32?

        public init(closing: Event) {
            self.closing = closing
        }

        public var isOpen: Bool { since != nil }

        public mutating func failed(_ opening: Event, kind: String? = nil, errno: Int32? = nil, at: Date = Date(),
                                    lines: FailureLines = .shared) {
            guard since == nil else { return }
            since = at
            self.kind = kind
            self.errno = errno
            lines.note(opening, kind: kind, errno: errno, at: at)
        }

        public mutating func ended(at: Date = Date(), lines: FailureLines = .shared) {
            guard let since else { return }
            lines.note(closing, kind: kind, errno: errno, since: since, at: at)
            self.since = nil
            kind = nil
            errno = nil
        }
    }
}
