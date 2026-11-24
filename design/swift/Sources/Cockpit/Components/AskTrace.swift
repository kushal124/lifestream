import Foundation

public struct AskTrace: Sendable, Equatable {
    public struct Step: Sendable, Equatable, Identifiable {
        public let call: Int
        let going: String
        var done: String?
        public internal(set) var failed: Bool

        public init(_ done: String, failed: Bool = false, call: Int = 0) {
            self.call = call
            going = done
            self.done = done
            self.failed = failed
        }

        init(call: Int, going: String) {
            self.call = call
            self.going = going
            failed = false
        }

        public var id: Int { call }

        public var words: String { done ?? going }
    }

    public enum Event: Sendable, Equatable {
        case named
        case began(call: Int, words: String, said: String? = nil)
        case ended(call: Int, words: String, failed: Bool)
        case text(String)
        case done(String, thoughtMs: Int? = nil)
        case cut(thoughtMs: Int? = nil)
    }

    public enum Line: Sendable, Equatable {
        case working(String)
        case thought(ms: Int)
    }

    public struct Fresh: Sendable, Equatable {
        public let visible: Int
        public let shown: Double
    }

    public struct Frame: Sendable, Equatable {
        public let line: Line?
        public let markdown: String
        public let fresh: [Fresh]
        public let answering: Bool
        public let settled: Bool
    }

    public static var now: TimeInterval { Date.timeIntervalSinceReferenceDate }
    static let sending = "Sending"
    static let thinking = "Thinking"

    struct Cut: Sendable, Equatable {
        let end: Int
        let size: Double
        let visible: Int
    }

    private enum Waiting: Sendable, Equatable {
        case thinking
        case said(String)
        case step(Int)
    }

    public private(set) var steps: [Step] = []
    private let asked: TimeInterval
    private let followed: Bool
    private var line: Line?
    private var phraseAt: TimeInterval
    private var queue: [Waiting] = []
    private var named = false
    private var stillSince: TimeInterval
    private var released = ""
    private var arrived: TimeInterval?
    private var cuts: [Cut] = []
    private var revealed: [TimeInterval] = []
    private var turnLeft = 0.0
    private var paceAt: TimeInterval
    private var deadline: TimeInterval
    private var clock: TimeInterval
    private var runFrom = 0
    private var answering = false
    private var ended = false
    private var given: Int?
    private var settledAt: TimeInterval?

    public init(asked: TimeInterval, followed: Bool = false) {
        self.asked = asked
        self.followed = followed
        line = .working(Self.sending)
        phraseAt = asked
        stillSince = asked
        paceAt = asked
        deadline = asked
        clock = asked
    }

    public init(_ text: String, steps: [Step] = [], thoughtMs: Int? = nil) {
        asked = -.infinity
        followed = false
        self.steps = steps.enumerated().map { index, step in Step(step.words, failed: step.failed, call: index + 1) }
        line = thoughtMs.map { .thought(ms: $0) }
        phraseAt = asked
        stillSince = asked
        paceAt = asked
        deadline = asked
        clock = asked
        released = text
        named = true
        ended = true
        settledAt = asked
    }

    public var text: String { released }
    public var isSettled: Bool { settledAt != nil }

    public var settles: TimeInterval? {
        guard ended else { return nil }
        if let settledAt { return settledAt }
        var drained = self
        drained.advance(to: .greatestFiniteMagnitude)
        return drained.settledAt
    }

    public mutating func take(_ event: Event, at time: TimeInterval = AskTrace.now) {
        advance(to: time)
        guard !ended else { return }
        switch event {
        case .named:
            guard !named else { return }
            named = true
            stillSince = time
            queue.append(.thinking)
        case let .began(call, words, said):
            named = true
            if let said, !said.isEmpty { queue.append(.said(said)) }
            answering = false
            runFrom = cuts.count
            arrived = nil
            steps.append(Step(call: call, going: words))
            queue.append(.step(call))
        case let .ended(call, words, failed):
            if let index = steps.lastIndex(where: { $0.call == call }) {
                steps[index].done = words
                steps[index].failed = failed
            } else {
                steps.append(Step(words, failed: failed, call: call))
            }
            if !steps.contains(where: { $0.done == nil }) { stillSince = time }
        case let .text(delta):
            guard !delta.isEmpty else { break }
            if arrived == nil { arrived = time }
            released += delta
            recut(final: false, at: time)
        case let .done(kept, thoughtMs):
            given = thoughtMs
            if kept != released {
                released = kept
                cuts = Self.cuts(of: kept, final: true)
                revealed = Array(revealed.prefix(cuts.count))
            }
            end(at: time)
        case let .cut(thoughtMs):
            given = thoughtMs
            end(at: time)
            while revealed.count < cuts.count { reveal(at: time) }
            if settledAt == nil { settle(at: time) }
        }
        advance(to: time)
    }

    public func frame(at time: TimeInterval) -> Frame {
        var seen = self
        seen.advance(to: time)
        return seen.drawn(at: time)
    }

    private mutating func end(at time: TimeInterval) {
        ended = true
        recut(final: true, at: time)
        if revealed.count == cuts.count { settle(at: time) }
    }

    private mutating func recut(final: Bool, at time: TimeInterval) {
        let shownEnd = revealed.isEmpty ? 0 : cuts[revealed.count - 1].end
        let known = cuts.last?.end ?? 0
        cuts = Array(cuts.prefix(revealed.count)) + Self.cuts(of: released, final: final).filter { $0.end > shownEnd }
        if (cuts.last?.end ?? 0) > known { deadline = time + Cockpit.Duration.quiet }
    }

    private enum Due { case roll, quiet, reveal }

    private mutating func advance(to time: TimeInterval) {
        while settledAt == nil, let (due, kind) = next(), max(due, clock) <= time {
            let at = max(due, clock)
            clock = at
            pace(to: at)
            switch kind {
            case .roll: roll(at: at)
            case .quiet: say(Self.thinking, at: at)
            case .reveal: reveal(at: at)
            }
        }
        if settledAt == nil { pace(to: time) }
        clock = max(clock, time)
    }

    private func next() -> (TimeInterval, Due)? {
        var soonest: (TimeInterval, Due)?
        func consider(_ at: TimeInterval, _ due: Due) {
            if soonest.map({ at < $0.0 }) ?? true { soonest = (at, due) }
        }
        if !answering, !ended {
            if !queue.isEmpty {
                consider(phraseAt + Cockpit.Duration.dwell, .roll)
            } else if named, arrived == nil, line != .working(Self.thinking), !steps.contains(where: { $0.done == nil }) {
                consider(max(phraseAt + Cockpit.Duration.dwell, stillSince + Cockpit.Duration.quiet), .quiet)
            }
        }
        if revealed.count < cuts.count { consider(paceAt + turnLeft / rate, .reveal) }
        return soonest
    }

    private var rate: Double {
        let backlog = cuts[revealed.count...].reduce(0) { $0 + $1.size } + turnLeft
        return max(1 / Cockpit.Duration.word, backlog / max(deadline - paceAt, Cockpit.Duration.word))
    }

    private mutating func pace(to time: TimeInterval) {
        guard time > paceAt else { return }
        if turnLeft > 0 { turnLeft = max(0, turnLeft - (time - paceAt) * rate) }
        paceAt = time
    }

    private mutating func roll(at time: TimeInterval) {
        let steps = steps
        let open = { (call: Int) in steps.last(where: { $0.call == call })?.done == nil }
        var waiting = queue
        queue = []
        while waiting.count > 1 {
            switch waiting[0] {
            case .said: break
            case .thinking:
                waiting.removeFirst()
                continue
            case let .step(call):
                let laterOpen = waiting.dropFirst().contains { if case let .step(later) = $0 { open(later) } else { false } }
                if !open(call) || laterOpen {
                    waiting.removeFirst()
                    continue
                }
            }
            break
        }
        guard let first = waiting.first else { return }
        queue = Array(waiting.dropFirst())
        switch first {
        case .thinking: say(Self.thinking, at: time)
        case let .said(words): say(words, at: time)
        case let .step(call): say(self.steps.last(where: { $0.call == call })?.going ?? Self.thinking, at: time)
        }
    }

    private mutating func say(_ words: String, at time: TimeInterval) {
        guard line != .working(words) else { return }
        line = .working(words)
        phraseAt = time
    }

    private mutating func reveal(at time: TimeInterval) {
        let index = revealed.count
        revealed.append(time)
        turnLeft = cuts[index].size
        paceAt = time
        if index >= runFrom, !answering {
            answering = true
            queue = []
            line = .thought(ms: Self.ms((arrived ?? time) - asked))
            phraseAt = time
        }
        if ended, revealed.count == cuts.count { settle(at: time) }
    }

    private mutating func settle(at time: TimeInterval) {
        settledAt = time
        queue = []
        if followed, let given {
            line = .thought(ms: given)
        } else if !answering {
            line = named ? .thought(ms: given ?? Self.ms(time - asked)) : nil
        }
    }

    private func drawn(at time: TimeInterval) -> Frame {
        let shownEnd = settledAt != nil ? released.count : revealed.isEmpty ? 0 : cuts[revealed.count - 1].end
        var fresh: [Fresh] = []
        for index in revealed.indices.reversed() {
            let age = time - revealed[index]
            guard age < Cockpit.Duration.fast else { break }
            fresh.insert(Fresh(visible: cuts[index].visible, shown: max(0, age) / Cockpit.Duration.fast), at: 0)
        }
        let shown = String(released.prefix(shownEnd))
        return Frame(line: line, markdown: settledAt != nil ? shown : Self.closed(shown), fresh: fresh,
                     answering: !revealed.isEmpty || (settledAt != nil && !released.isEmpty), settled: settledAt != nil)
    }

    private static func ms(_ seconds: TimeInterval) -> Int { Int((max(0, seconds) * 1000).rounded()) }
}


extension AskTrace {
    static func closed(_ shown: String) -> String {
        let rows = shown.split(separator: "\n", omittingEmptySubsequences: false)
        let from = (rows.lastIndex { $0.allSatisfy(\.isWhitespace) }).map { $0 + 1 } ?? 0
        var open: [String] = []
        func toggle(_ mark: String) {
            if open.last == mark { open.removeLast() } else { open.append(mark) }
        }
        for row in rows[from...] {
            var words = Substring(row)
            if let mark = words.prefixMatch(of: /\s*(?:[-*+]\s+|\d{1,9}[.)]\s+|#{1,6}\s+|>\s*)/) { words = words[mark.range.upperBound...] }
            let c = Array(words)
            var index = 0
            while index < c.count {
                let character = c[index]
                if character == "`" {
                    toggle("`")
                } else if open.last == "`" {
                } else if character == "*" || character == "~", index + 1 < c.count, c[index + 1] == character {
                    toggle(String([character, character]))
                    index += 1
                } else if character == "*" {
                    toggle("*")
                }
                index += 1
            }
        }
        return shown + open.reversed().joined()
    }

    static func cuts(of text: String, final: Bool) -> [Cut] {
        let c = Array(text)
        var cuts: [Cut] = []
        var last = 0
        var index = 0
        var lineStart = true
        func cut(_ end: Int, whole: Bool = false) {
            let slice = String(c[last..<end])
            let cited = slice.trimmingCharacters(in: .whitespacesAndNewlines).wholeMatch(of: /\[r\d+(?:\s*,\s*r\d+)*\][.,;:!?]*/) != nil
            let visible = whole || cited ? 0 : Self.visible(slice)
            cuts.append(Cut(end: end, size: cited ? 2 : Double(max(1, whole ? slice.count : visible)), visible: visible))
            last = end
        }
        func lineEnd(from start: Int) -> Int? { c[start...].firstIndex(of: "\n") }
        scan: while index < c.count {
            if lineStart {
                var start = index
                while start < c.count, c[start] == " " || c[start] == "\t" { start += 1 }
                if start < c.count, c[start] == "\n" {
                    index = start + 1
                    continue
                }
                let end = lineEnd(from: start)
                let rest = String(c[start..<(end ?? c.count)])
                if end == nil, !final, !rest.contains(" ") { break }
                if rest.hasPrefix("```") || rest.hasPrefix("~~~") {
                    guard let close = fence(c, after: end, mark: String(rest.prefix(3)), final: final) else {
                        if final { cut(trimmed(c)) }
                        break scan
                    }
                    cut(close, whole: true)
                    index = close
                    lineStart = false
                    continue
                }
                if rest.hasPrefix("|") {
                    guard let close = table(c, from: start, final: final) else {
                        if final { cut(trimmed(c)) }
                        break scan
                    }
                    cut(close, whole: true)
                    index = close
                    lineStart = false
                    continue
                }
                index = start + marks(rest)
                lineStart = false
                continue
            }
            switch c[index] {
            case "\n":
                index += 1
                lineStart = true
                continue
            case " ", "\t":
                index += 1
                continue
            default:
                guard let end = unit(c, from: index, final: final) else { break scan }
                cut(end)
                index = end
            }
        }
        if final, last < trimmed(c) { cut(trimmed(c)) }
        return cuts
    }

    private static func trimmed(_ c: [Character]) -> Int {
        var end = c.count
        while end > 0, c[end - 1].isWhitespace { end -= 1 }
        return end
    }

    private static func marks(_ line: String) -> Int {
        var taken = 0
        var rest = Substring(line)
        while let mark = rest.prefixMatch(of: /(?:#{1,6}|>|[-*+]|\d{1,9}[.)]) +/) {
            taken += mark.output.count
            rest = rest[mark.range.upperBound...]
        }
        return taken
    }

    private static func unit(_ c: [Character], from start: Int, final: Bool) -> Int? {
        var index = start
        while index < c.count {
            switch c[index] {
            case " ", "\t", "\n":
                return index
            case "`":
                guard let close = c[(index + 1)...].firstIndex(of: "`") else { return final ? c.count : nil }
                index = close + 1
            case "[":
                if index > start, c[(index + 1)...].first == "r" { return index }
                let lineEnd = c[index...].firstIndex(of: "\n") ?? c.count
                guard let close = c[index..<lineEnd].firstIndex(of: "]") else {
                    if lineEnd == c.count, !final { return nil }
                    index += 1
                    continue
                }
                index = close + 1
                if index < c.count, c[index] == "(" {
                    guard let target = c[index..<lineEnd].firstIndex(of: ")") else { return final || lineEnd < c.count ? lineEnd : nil }
                    index = target + 1
                }
            default:
                index += 1
            }
        }
        return final ? index : nil
    }

    private static func fence(_ c: [Character], after lineEnd: Int?, mark: String, final: Bool) -> Int? {
        guard var start = lineEnd.map({ $0 + 1 }) else { return nil }
        while start < c.count {
            let end = c[start...].firstIndex(of: "\n")
            let line = String(c[start..<(end ?? c.count)]).trimmingCharacters(in: .whitespaces)
            if line.hasPrefix(mark) { return end ?? (final ? c.count : nil) }
            guard let end else { return nil }
            start = end + 1
        }
        return nil
    }

    private static func table(_ c: [Character], from begin: Int, final: Bool) -> Int? {
        var start = begin
        while start < c.count {
            let line = String(c[start..<(c[start...].firstIndex(of: "\n") ?? c.count)]).trimmingCharacters(in: .whitespaces)
            if !line.hasPrefix("|") { return start - 1 }
            guard let end = c[start...].firstIndex(of: "\n") else { return final ? c.count : nil }
            start = end + 1
        }
        return final ? trimmed(c) : nil
    }

    private static func visible(_ slice: String) -> Int {
        var words = slice
        words.replace(/\[r\d+(?:\s*,\s*r\d+)*\]/, with: "")
        words.replace(/\]\([^)]*\)/, with: "")
        words.replace(/\n[ \t]*(?:(?:#{1,6}|>|[-*+]|\d{1,9}[.)]) +)*/, with: "")
        return words.filter { !"*`[]\n".contains($0) }.count
    }
}
