import Foundation

extension HomeLink {
    public struct Phrase: Codable, Sendable, Equatable, Hashable {
        public enum When: Codable, Sendable, Equatable, Hashable {
            case day(String)
            case month(String)
            case at(Int64)
            case clock(Int64)

            private enum Keys: String, CodingKey {
                case kind, day, month
                case atMs = "at_ms"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                let kind = try container.decode(String.self, forKey: .kind)
                switch kind {
                case "day": self = .day(try container.decode(String.self, forKey: .day))
                case "month": self = .month(try container.decode(String.self, forKey: .month))
                case "at": self = .at(try container.decode(Int64.self, forKey: .atMs))
                case "clock": self = .clock(try container.decode(Int64.self, forKey: .atMs))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "no when of kind \(kind)")
                }
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: Keys.self)
                switch self {
                case .day(let day):
                    try container.encode("day", forKey: .kind)
                    try container.encode(day, forKey: .day)
                case .month(let month):
                    try container.encode("month", forKey: .kind)
                    try container.encode(month, forKey: .month)
                case .at(let ms):
                    try container.encode("at", forKey: .kind)
                    try container.encode(ms, forKey: .atMs)
                case .clock(let ms):
                    try container.encode("clock", forKey: .kind)
                    try container.encode(ms, forKey: .atMs)
                }
            }
        }

        public enum Part: Codable, Sendable, Equatable, Hashable {
            case words(String)
            case time(When)

            private enum Keys: String, CodingKey { case kind, words, time }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                let kind = try container.decode(String.self, forKey: .kind)
                switch kind {
                case "words": self = .words(try container.decode(String.self, forKey: .words))
                case "time": self = .time(try container.decode(When.self, forKey: .time))
                default:
                    throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "no phrase part of kind \(kind)")
                }
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: Keys.self)
                switch self {
                case .words(let words):
                    try container.encode("words", forKey: .kind)
                    try container.encode(words, forKey: .words)
                case .time(let time):
                    try container.encode("time", forKey: .kind)
                    try container.encode(time, forKey: .time)
                }
            }
        }

        public var parts: [Part]

        public init(_ parts: [Part]) {
            self.parts = parts
        }

        public init(from decoder: Decoder) throws {
            let parts = try decoder.singleValueContainer().decode([Part].self)
            guard !parts.isEmpty else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "a phrase holds one part or more"))
            }
            self.parts = parts
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(parts)
        }

        public func replacing(_ words: String, with other: String) -> Phrase {
            Phrase(parts.map { part in
                if case .words(let said) = part { .words(said.replacingOccurrences(of: words, with: other)) } else { part }
            })
        }
    }

    public struct SignIn: Codable, Sendable, Equatable, Hashable, Identifiable {
        public var id: String
        public var name: String
        public var checked: Bool
        @Nullable public var host: String?
        public var atMs: Int64
        public var untilMs: Int64
        public var head: String
        public var overLine: Phrase
        public var sentence: String
        public var access: Access
        public var view: AccessView
        public var pick: String
        public var pickLine: String
        public var over: String
        @Nullable public var app: String?
        public var notice: String

        enum CodingKeys: String, CodingKey {
            case id, name, checked, host, head, sentence, access, view, pick, over, app, notice
            case atMs = "at_ms"
            case untilMs = "until_ms"
            case overLine = "over_line"
            case pickLine = "pick_line"
        }
    }

    public enum AskAnswer: String, Codable, Sendable, Equatable, Hashable { case once, always, no }

    public enum AskState: String, Codable, Sendable, Equatable, Hashable { case open, allowed, declined, replaced, dropped, lapsed }

    public struct AgentAsk: Codable, Sendable, Equatable, Hashable, Identifiable {
        public var id: String
        public var reader: String
        public var name: String
        public var by: By
        public var head: String
        public var line: String
        public var askedLine: Phrase
        public var underLine: Phrase
        public var saysTitle: String
        public var wants: String
        public var today: Bolded
        @Nullable public var under: String?
        @Nullable public var reason: String?
        @Nullable public var screen: String?
        public var adds: [String]
        @Nullable public var keeps: String?
        public var choices: [Choice]
        public var `default`: AskAnswer
        public var version: Version
        public var proposed: DraftAccess
        public var atMs: Int64
        public var untilMs: Int64
        public var state: AskState
        @Nullable public var outcome: Phrase?
        public var editable: Bool

        public enum By: String, Codable, Sendable, Equatable, Hashable { case agent, chat }

        public struct Choice: Codable, Sendable, Equatable, Hashable {
            public var answer: AskAnswer
            public var words: String
        }

        public var stacked: [Choice] {
            choices.filter { $0.answer == `default` } + choices.filter { $0.answer != `default` }
        }

        enum CodingKeys: String, CodingKey {
            case id, reader, name, by, head, line, wants, today, under, reason, screen, adds, keeps, choices, `default`, version,
                 proposed, state, outcome, editable
            case askedLine = "asked_line"
            case underLine = "under_line"
            case saysTitle = "says_title"
            case atMs = "at_ms"
            case untilMs = "until_ms"
        }
    }

    public struct SignInRead: Codable, Sendable, Equatable, Hashable {
        public enum State: String, Codable, Sendable, Equatable, Hashable { case waiting, approved, wrong, denied, gone }

        public var id: String
        public var state: State
        @Nullable public var outcome: Phrase?
        @Nullable public var reader: String?
        @Nullable public var connected: Connected?
    }

    public struct Connected: Codable, Sendable, Equatable, Hashable {
        public var reader: String
        public var line: String
    }

    public struct AgentsWaiting: Codable, Sendable, Equatable, Hashable {
        public var position: String
        public var today: String
        public var requests: [SignIn]
        public var asks: [AgentAsk]

        public init(position: String = "", today: String = "", requests: [SignIn] = [], asks: [AgentAsk] = []) {
            self.position = position
            self.today = today
            self.requests = requests
            self.asks = asks
        }
    }

    public struct AgentRow: Codable, Sendable, Equatable, Hashable, Identifiable {
        public enum Kind: String, Codable, Sendable, Equatable, Hashable { case chat, agent }

        public var id: String
        public var name: String
        public var kind: Kind
        public var state: AgentState
        public var summary: String
        public var place: String
        public var reads: AgentReads
        public var hasAsk: Bool
        public var mark: String

        enum CodingKeys: String, CodingKey {
            case id, name, kind, state, summary, place, reads, mark
            case hasAsk = "has_ask"
        }
    }

    public enum AgentState: String, Codable, Sendable, Equatable, Hashable { case connected, disconnected }

    public struct AgentReads: Codable, Sendable, Equatable, Hashable {
        @Nullable public var lastMs: Int64?
        @Nullable public var last: String?
        public var line: String
        public var short: String
        public var today: Int
        public var total: Int
        @Nullable public var since: String?
        public var days: [Day]

        public struct Day: Codable, Sendable, Equatable, Hashable, Identifiable {
            public var day: String
            public var words: String
            public var n: Int

            public var id: String { day }
        }

        enum CodingKeys: String, CodingKey {
            case last, line, short, today, total, since, days
            case lastMs = "last_ms"
        }
    }

    public struct AgentList: Codable, Sendable, Equatable, Hashable {
        public var readers: [AgentRow]
    }

    public enum KeyApp: String, Codable, Sendable, Equatable, Hashable { case grokBot = "grok-bot", instinct, another }

    public enum AgentAddress: Codable, Sendable, Equatable, Hashable {
        case on(url: String, line: String)
        case off(url: String?)
        case fix(words: String, act: Fix?)

        public struct Fix: Codable, Sendable, Equatable, Hashable {
            public enum To: String, Codable, Sendable, Equatable, Hashable { case web, tailscale, turnOn = "turn-on" }

            public var label: String
            public var to: To
            @Nullable public var url: String?
        }

        public var url: String? {
            switch self {
            case .on(let url, _): url
            case .off(let url): url
            case .fix: nil
            }
        }

        private enum Keys: String, CodingKey { case state, url, line, words, act }

        public init(from decoder: Decoder) throws {
            let address = try decoder.container(keyedBy: Keys.self)
            let url = try address.decodeNil(forKey: .url) ? nil : try address.decode(String.self, forKey: .url)
            switch try address.decode(String.self, forKey: .state) {
            case "on":
                guard let url else { throw DecodingError.dataCorruptedError(forKey: .url, in: address, debugDescription: "an address on has its url") }
                self = .on(url: url, line: try address.decode(String.self, forKey: .line))
            case "off":
                self = .off(url: url)
            case "fix":
                guard url == nil else { throw DecodingError.dataCorruptedError(forKey: .url, in: address, debugDescription: "an address to fix has no url") }
                self = .fix(words: try address.decode(String.self, forKey: .words),
                            act: try address.decodeNil(forKey: .act) ? nil : try address.decode(Fix.self, forKey: .act))
            default:
                throw DecodingError.dataCorruptedError(forKey: .state, in: address, debugDescription: "an address is on, off or to fix")
            }
        }

        public func encode(to encoder: Encoder) throws {
            var address = encoder.container(keyedBy: Keys.self)
            switch self {
            case .on(let url, let line):
                try address.encode("on", forKey: .state)
                try address.encode(url, forKey: .url)
                try address.encode(line, forKey: .line)
            case .off(let url):
                try address.encode("off", forKey: .state)
                if let url { try address.encode(url, forKey: .url) } else { try address.encodeNil(forKey: .url) }
            case .fix(let words, let act):
                try address.encode("fix", forKey: .state)
                try address.encodeNil(forKey: .url)
                try address.encode(words, forKey: .words)
                if let act { try address.encode(act, forKey: .act) } else { try address.encodeNil(forKey: .act) }
            }
        }
    }

    struct AddressWrite: Codable, Equatable {
        var reader: String?

        private enum Keys: String, CodingKey { case on, reader }

        init(reader: String?) {
            self.reader = reader
        }

        init(from decoder: Decoder) throws {
            let write = try decoder.container(keyedBy: Keys.self)
            guard try write.decode(Bool.self, forKey: .on) else {
                throw DecodingError.dataCorruptedError(forKey: .on, in: write, debugDescription: "an address is turned on: on is true")
            }
            reader = try write.decodeIfPresent(String.self, forKey: .reader)
        }

        func encode(to encoder: Encoder) throws {
            var write = encoder.container(keyedBy: Keys.self)
            try write.encode(true, forKey: .on)
            try write.encodeIfPresent(reader, forKey: .reader)
        }
    }

    struct KeyRequest: Codable, Equatable {
        var app: KeyApp
        var name: String?
        var access: DraftAccess

        private enum Keys: String, CodingKey { case app, name, access }

        init(app: KeyApp, name: String?, access: DraftAccess) {
            self.app = app
            self.name = name
            self.access = access
        }

        init(from decoder: Decoder) throws {
            let request = try decoder.container(keyedBy: Keys.self)
            app = try request.decode(KeyApp.self, forKey: .app)
            name = try request.decodeIfPresent(String.self, forKey: .name)
            access = try request.decode(DraftAccess.self, forKey: .access)
        }

        func encode(to encoder: Encoder) throws {
            var request = encoder.container(keyedBy: Keys.self)
            try request.encode(app, forKey: .app)
            try request.encodeIfPresent(name, forKey: .name)
            try request.encode(access, forKey: .access)
        }
    }

    public struct ReaderConnected: Codable, Sendable, Equatable, Hashable {
        public var reader: String
        public var line: String
    }

    public struct MadeKey: Codable, Sendable, Equatable, Hashable {
        public var reader: String
        public var name: String
        public var rows: [Row]
        public var connected: ReaderConnected

        public struct Row: Codable, Sendable, Equatable, Hashable {
            public var label: String
            public var text: String
        }
    }

    public struct GuideSees: Codable, Sendable, Equatable, Hashable {
        public var access: DraftAccess
        public var view: AccessView
    }

    public struct AgentGuides: Decodable, Sendable, Equatable {
        public let page: Pages.AgentGuides
        public let sees: [Pages.Guide.App: GuideSees]

        public var apps: [Pages.Guide] { page.apps }

        public init(from decoder: Decoder) throws {
            page = try Pages.AgentGuides(from: decoder)
            let kept = try Kept(from: decoder)
            sees = Dictionary(kept.apps.compactMap { app in app.steps.lazy.compactMap(\.sees).first.map { (app.app, $0) } },
                              uniquingKeysWith: { first, _ in first })
        }

        private struct Kept: Decodable {
            let apps: [App]

            struct App: Decodable {
                let app: Pages.Guide.App
                let steps: [Step]
            }

            struct Step: Decodable {
                let sees: GuideSees?

                private enum Keys: String, CodingKey { case kind }

                init(from decoder: Decoder) throws {
                    let step = try decoder.container(keyedBy: Keys.self)
                    sees = try step.decode(String.self, forKey: .kind) == "sees" ? try GuideSees(from: decoder) : nil
                }
            }
        }
    }

    public struct AgentRead: Codable, Sendable, Equatable, Hashable, Identifiable {
        public var id: String
        public var name: String
        public var kind: AgentRow.Kind
        public var state: AgentState
        public var how: String
        public var place: String
        @Nullable public var disconnected: String?
        public var reads: AgentReads
        public var figure: ReadsFigure
        public var mark: String
        public var access: Access
        public var version: Version
        public var view: AccessView
        @Nullable public var ask: AgentAsk?
        @Nullable public var disconnect: Disconnecting?
        @Nullable public var unlist: Unlisting?
        public var recent: Recent
    }

    public struct Recent: Codable, Sendable, Equatable, Hashable {
        public var lines: [HistoryRead]
        @Nullable public var all: String?
    }

    public struct ReadsFigure: Codable, Sendable, Equatable, Hashable {
        public var today: Int
        public var words: String
        public var days: [AgentReads.Day]
        public var said: Bolded
    }

    public struct Disconnecting: Codable, Sendable, Equatable, Hashable {
        public var head: String
        public var line: String
        public var stops: [Ended]
        public var stays: [Ended]
        public var confirm: String

        public struct Ended: Codable, Sendable, Equatable, Hashable {
            public var icon: String
            public var name: String
            public var line: String
        }
    }

    public struct Unlisting: Codable, Sendable, Equatable, Hashable {
        public var ask: String
        public var line: String
    }

    public struct HistoryRead: Codable, Sendable, Equatable, Hashable, Identifiable {
        public enum Kind: String, Codable, Sendable, Equatable, Hashable { case call }
        public enum Tone: String, Codable, Sendable, Equatable, Hashable { case plain, refused }

        public var kind: Kind
        public var id: String
        public var atMs: Int64
        public var icon: String
        public var tone: Tone
        public var words: String
        @Nullable public var line: String?
        @Nullable public var kept: String?
        public var opens: Bool
        public var more: Int
        @Nullable public var tookMs: Int64?
        @Nullable public var told: String?

        enum CodingKeys: String, CodingKey {
            case kind, id, icon, tone, words, line, kept, opens, more, told
            case atMs = "at_ms"
            case tookMs = "took_ms"
        }
    }

    public struct CameKind: Codable, Sendable, Equatable, Hashable, Identifiable {
        public var kind: String
        public var name: String
        public var icon: String
        public var n: Int
        public var words: String

        public var id: String { kind }
    }

    public struct Chip: Codable, Sendable, Equatable, Hashable, Identifiable {
        public var kind: String
        public var name: String
        public var icon: String
        public var n: Int

        public var id: String { kind }
    }

    public struct HistoryFold: Codable, Sendable, Equatable, Hashable {
        public var atMs: Int64
        public var n: Int
        public var icon: String
        public var words: String
        public var line: String
        public var lines: [HistoryRead]
        public var continues: Bool

        enum CodingKeys: String, CodingKey {
            case n, icon, words, line, lines, continues
            case atMs = "at_ms"
        }
    }

    public struct HistoryChange: Codable, Sendable, Equatable, Hashable {
        public enum Tone: String, Codable, Sendable, Equatable, Hashable { case plain, waiting }

        public var atMs: Int64
        public var icon: String
        public var words: String
        @Nullable public var line: String?
        @Nullable public var ask: String?
        public var tone: Tone

        enum CodingKeys: String, CodingKey {
            case icon, words, line, ask, tone
            case atMs = "at_ms"
        }
    }

    public enum HistoryLine: Codable, Sendable, Equatable, Hashable {
        case read(HistoryRead)
        case fold(HistoryFold)
        case change(HistoryChange)

        public var atMs: Int64 {
            switch self {
            case .read(let read): read.atMs
            case .fold(let fold): fold.atMs
            case .change(let change): change.atMs
            }
        }

        public var words: String {
            switch self {
            case .read(let read): read.words
            case .fold(let fold): fold.words
            case .change(let change): change.words
            }
        }

        private enum Keys: String, CodingKey { case kind }

        public init(from decoder: Decoder) throws {
            switch try decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .kind) {
            case "call": self = .read(try HistoryRead(from: decoder))
            case "fold": self = .fold(try HistoryFold(from: decoder))
            case "change": self = .change(try HistoryChange(from: decoder))
            default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "a line is a call, a fold or a change"))
            }
        }

        public func encode(to encoder: Encoder) throws {
            switch self {
            case .read(let read):
                try read.encode(to: encoder)
            case .fold(let fold):
                var line = encoder.container(keyedBy: Keys.self)
                try line.encode("fold", forKey: .kind)
                try fold.encode(to: encoder)
            case .change(let change):
                var line = encoder.container(keyedBy: Keys.self)
                try line.encode("change", forKey: .kind)
                try change.encode(to: encoder)
            }
        }
    }

    public struct HistoryPage: Codable, Sendable, Equatable, Hashable {
        @Nullable public var figure: ReadsFigure?
        public var chips: [Chip]
        @Nullable public var kind: String?
        @Nullable public var empty: Empty?
        public var sessions: [Session]
        @Nullable public var next: Next?

        public struct Empty: Codable, Sendable, Equatable, Hashable {
            public var title: String
            public var line: String
        }

        public func joined(_ earlier: HistoryPage) -> HistoryPage {
            var page = self
            var more = earlier.sessions
            if let last = page.sessions.last, let first = more.first, first.key == last.key {
                var joined = last
                joined.fromMs = min(last.fromMs, first.fromMs)
                var lines = first.lines
                if case .fold(let held)? = joined.lines.last, case .fold(var goesOn)? = lines.first, goesOn.continues {
                    goesOn.atMs = held.atMs
                    goesOn.lines = held.lines + goesOn.lines
                    joined.lines.removeLast()
                    lines[0] = .fold(goesOn)
                }
                joined.lines += lines
                page.sessions[page.sessions.count - 1] = joined
                more.removeFirst()
            }
            page.sessions += more
            page.next = earlier.next
            return page
        }

        public struct Session: Codable, Sendable, Equatable, Hashable {
            public var key: String
            public var fromMs: Int64
            public var toMs: Int64
            public var calls: Int
            public var day: Day
            @Nullable public var reads: String?
            public var lines: [HistoryLine]

            public struct Day: Codable, Sendable, Equatable, Hashable {
                public var day: String
                public var words: String
                @Nullable public var reads: String?
            }

            enum CodingKeys: String, CodingKey {
                case key, calls, day, reads, lines
                case fromMs = "from_ms"
                case toMs = "to_ms"
            }
        }

        public struct Next: Codable, Sendable, Equatable, Hashable {
            public var before: String
            public var words: String
        }
    }

    public struct KeptRow: Codable, Sendable, Equatable, Hashable, Identifiable {
        public var type: String
        public var name: String
        public var value: String

        public var id: String { type }
    }

    public struct ReadPage: Codable, Sendable, Equatable, Hashable, Identifiable {
        public var id: String
        public var reader: String
        public var name: String
        public var title: String
        public var line: String
        @Nullable public var figure: Figure?
        public var kinds: [CameKind]
        @Nullable public var kept: Kept?
        @Nullable public var why: Bolded?
        @Nullable public var refused: String?
        @Nullable public var show: Show?

        public struct Figure: Codable, Sendable, Equatable, Hashable {
            public var n: Int
            public var words: String
        }

        public struct Kept: Codable, Sendable, Equatable, Hashable {
            public var about: String
            public var rows: [KeptRow]
            @Nullable public var held: String?
        }

        public struct Show: Codable, Sendable, Equatable, Hashable {
            public var words: String
            public var n: Int
        }
    }

    public struct Thing: Codable, Sendable, Equatable, Hashable, Identifiable {
        public var ref: String
        public var title: String
        @Nullable public var line: String?
        @Nullable public var when: String?
        @Nullable public var day: String?
        @Nullable public var atMs: Int64?
        public var opens: Opens

        public var id: String { ref }

        enum CodingKeys: String, CodingKey {
            case ref, title, line, when, day, opens
            case atMs = "at_ms"
        }
    }

    public struct ThingsPage: Codable, Sendable, Equatable, Hashable {
        public var title: String
        @Nullable public var gone: String?
        public var groups: [Group]
        @Nullable public var next: String?

        public struct Group: Codable, Sendable, Equatable, Hashable, Identifiable {
            public var kind: String
            public var name: String
            public var icon: String
            public var n: Int
            public var things: [Thing]

            public var id: String { kind }
        }
    }

    public enum AnswerRequest: Codable, Sendable, Equatable, Hashable {
        case code(String, String, access: Access? = nil)
        case deny(String)
        case allow(String, Grant, expect: Version, access: DraftAccess? = nil)
        case no(String)

        public enum Grant: String, Codable, Sendable, Equatable, Hashable { case once, always }

        public var id: String {
            switch self {
            case .code(let id, _, _), .deny(let id), .allow(let id, _, _, _), .no(let id): id
            }
        }

        public var allows: Bool {
            switch self {
            case .code, .allow: true
            case .deny, .no: false
            }
        }

        private enum Keys: String, CodingKey { case id, answer, expect, access }

        public static func isCode(_ word: String) -> Bool {
            word.utf8.count == 6 && word.utf8.allSatisfy { (0x30...0x39).contains($0) }
        }

        public init(from decoder: Decoder) throws {
            let answer = try decoder.container(keyedBy: Keys.self)
            let id = try answer.decode(String.self, forKey: .id)
            let keys = Set(answer.allKeys)
            let access = keys.contains(.access) ? try answer.decode(Access.self, forKey: .access) : nil
            let word = try answer.decode(String.self, forKey: .answer)
            if Self.isCode(word), !keys.contains(.expect) {
                self = .code(id, word, access: access)
            } else if word == "deny", keys == [.id, .answer] {
                self = .deny(id)
            } else if word == "no", keys == [.id, .answer] {
                self = .no(id)
            } else if let grant = Grant(rawValue: word), keys.contains(.expect) {
                self = .allow(id, grant, expect: try answer.decode(Version.self, forKey: .expect), access: access)
            } else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "no answer has these members"))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var answer = encoder.container(keyedBy: Keys.self)
            try answer.encode(id, forKey: .id)
            switch self {
            case .code(_, let code, let access):
                try answer.encode(code, forKey: .answer)
                if let access { try answer.encode(access, forKey: .access) }
            case .deny: try answer.encode("deny", forKey: .answer)
            case .allow(_, let grant, let expect, let access):
                try answer.encode(grant, forKey: .answer)
                try answer.encode(expect, forKey: .expect)
                if let access { try answer.encode(access, forKey: .access) }
            case .no: try answer.encode("no", forKey: .answer)
            }
        }
    }

    public struct AnswerReply: Codable, Sendable, Equatable, Hashable {
        public enum State: String, Codable, Sendable, Equatable, Hashable {
            case approved, wrong, denied, open, allowed, declined, replaced, dropped, lapsed
        }

        public var state: State
        @Nullable public var version: Version?
        @Nullable public var outcome: Phrase?
        @Nullable public var reader: String?
        @Nullable public var connected: Connected?
    }

    public enum AccessChange: Codable, Sendable, Equatable, Hashable, Identifiable {
        case narrowed(id: String, reader: String, Narrowed)
        case unchanged(id: String, reader: String, words: String)
        case asked(id: String, snapshot: AgentAsk)

        public var id: String {
            switch self {
            case .narrowed(let id, _, _), .unchanged(let id, _, _), .asked(let id, _): id
            }
        }

        private enum Keys: String, CodingKey { case id, kind, reader, words, undo, snapshot }

        public init(from decoder: Decoder) throws {
            let change = try decoder.container(keyedBy: Keys.self)
            let id = try change.decode(String.self, forKey: .id)
            switch try change.decode(String.self, forKey: .kind) {
            case "narrowed":
                self = .narrowed(id: id, reader: try change.decode(String.self, forKey: .reader), try Narrowed(from: decoder))
            case "unchanged":
                self = .unchanged(id: id, reader: try change.decode(String.self, forKey: .reader), words: try change.decode(String.self, forKey: .words))
            case "asked":
                self = .asked(id: id, snapshot: try change.decode(AgentAsk.self, forKey: .snapshot))
            default:
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "a change is narrowed, unchanged or asked"))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var change = encoder.container(keyedBy: Keys.self)
            switch self {
            case .narrowed(let id, let reader, let narrowed):
                try change.encode(id, forKey: .id)
                try change.encode("narrowed", forKey: .kind)
                try change.encode(reader, forKey: .reader)
                try narrowed.encode(to: encoder)
            case .unchanged(let id, let reader, let words):
                try change.encode(id, forKey: .id)
                try change.encode("unchanged", forKey: .kind)
                try change.encode(reader, forKey: .reader)
                try change.encode(words, forKey: .words)
            case .asked(let id, let snapshot):
                try change.encode(id, forKey: .id)
                try change.encode("asked", forKey: .kind)
                try change.encode(snapshot, forKey: .snapshot)
            }
        }
    }

    public struct AccessEvent: Codable, Sendable, Equatable, Hashable {
        public var type: String
        public var change: AccessChange
    }

    struct Empty: Codable, Equatable {}

    struct AccessWrite: Codable, Equatable {
        var access: Access
        var expect: Version
    }


    public func agents() async throws -> AgentList {
        try await fetched("/v1/agents")
    }

    public func signIn(_ id: String) async throws -> SignInRead {
        try await fetched("/v1/agents/signins/" + Self.segment(id))
    }

    public func agent(_ id: String) async throws -> AgentRead {
        try await fetched("/v1/agents/" + Self.segment(id))
    }

    public func agentHistory(_ id: String, before: String? = nil, kind: String? = nil) async throws -> HistoryPage {
        try await fetched("/v1/agents/" + Self.segment(id) + "/history", [("before", before), ("kind", kind)])
    }

    public func agentRead(_ id: String, call: String) async throws -> ReadPage {
        try await fetched("/v1/agents/" + Self.segment(id) + "/reads/" + Self.segment(call))
    }

    public func agentThings(_ id: String, call: String, before: String? = nil) async throws -> ThingsPage {
        try await fetched("/v1/agents/" + Self.segment(id) + "/reads/" + Self.segment(call) + "/things", [("before", before)])
    }

    public func agentAsk(_ id: String) async throws -> AgentAsk {
        try await fetched("/v1/agents/asks/" + Self.segment(id))
    }

    public func editAccess(_ request: EditRequest) async throws -> AccessDraft {
        try await post("/v1/agents/edit", request)
    }

    public func setAccess(_ reader: String, _ access: DraftAccess, expect: Version) async throws -> AccessDraft {
        try await post("/v1/agents/" + Self.segment(reader) + "/access", AccessWrite(access: access, expect: expect))
    }

    public func propose(_ reader: String, _ access: Access, expect: Version) async throws -> AccessChange {
        try await post("/v1/agents/" + Self.segment(reader) + "/propose", AccessWrite(access: access, expect: expect))
    }

    public func answer(_ answer: AnswerRequest) async throws -> AnswerReply {
        try await post("/v1/agents/answer", answer)
    }

    public func disconnect(_ reader: String) async throws -> AgentRead {
        try await post("/v1/agents/" + Self.segment(reader) + "/disconnect", Empty())
    }

    public func unlist(_ reader: String) async throws -> AgentList {
        try await post("/v1/agents/" + Self.segment(reader) + "/unlist", Empty())
    }

    public func guides() async throws -> AgentGuides {
        try await fetched(Pages.AgentGuides.route)
    }

    public func address() async throws -> AgentAddress {
        try await fetched("/v1/agents/address")
    }

    public func turnAddressOn(reader: String? = nil) async throws -> AgentAddress {
        try await post("/v1/agents/address", AddressWrite(reader: reader))
    }

    public func makeKey(_ app: KeyApp, name: String? = nil, access: DraftAccess) async throws -> MadeKey {
        try await post("/v1/agents/keys", KeyRequest(app: app, name: name, access: access))
    }

    private func fetched<Value: Decodable>(_ path: String, _ query: [(String, String?)] = []) async throws -> Value {
        guard let response = try await get(path, query) else { throw LinkFailure.unreadable(304) }
        return try Self.decoded(Value.self, response)
    }

    private func post<Body: Encodable, Value: Decodable>(_ path: String, _ body: Body) async throws -> Value {
        let response = try await contact("POST", path, ["Content-Type": "application/json"], .json(try Self.wire(body)))
        guard response.status == 200 else { throw failure(response) }
        return try Self.decoded(Value.self, response)
    }

    static func wire<Body: Encodable>(_ body: Body) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(body)
    }

    static func segment(_ id: String) throws -> String {
        guard !id.contains("/"), let encoded = encoded(id) else { throw LinkFailure.unusableID }
        return encoded
    }
}
