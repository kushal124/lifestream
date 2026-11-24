import Foundation

extension HomeLink {
    public struct Access: Codable, Sendable, Equatable, Hashable {
        public let json: JSON

        public init(from decoder: Decoder) throws {
            json = try JSON(from: decoder)
            guard json.object != nil else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "an access is an object"))
            }
        }

        public func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }
    }

    public typealias DraftAccess = Access

    public typealias Version = Int

    public enum Switch: String, Codable, Sendable, Equatable, Hashable { case on, off, some }

    public struct Run: Codable, Sendable, Equatable, Hashable {
        public var text: String
        public var bold: Bool

        public init(_ text: String, bold: Bool = false) {
            self.text = text
            self.bold = bold
        }

        private enum Keys: String, CodingKey { case text, bold }

        public init(from decoder: Decoder) throws {
            let run = try decoder.container(keyedBy: Keys.self)
            text = try run.decode(String.self, forKey: .text)
            bold = try run.decodeIfPresent(Bool.self, forKey: .bold) ?? false
            guard !run.contains(.bold) || bold else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "a run is bold, or names no bold"))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var run = encoder.container(keyedBy: Keys.self)
            try run.encode(text, forKey: .text)
            if bold { try run.encode(true, forKey: .bold) }
        }
    }

    public typealias Bolded = [Run]

    public enum Window: Codable, Sendable, Equatable, Hashable {
        case allTime
        case since(ms: Int64)
        case past(ms: Int64)

        private enum Keys: String, CodingKey {
            case since = "since_ms"
            case past = "past_ms"
        }

        public init(from decoder: Decoder) throws {
            if try decoder.singleValueContainer().decodeNil() {
                self = .allTime
                return
            }
            let window = try decoder.container(keyedBy: Keys.self)
            switch Set(window.allKeys) {
            case [.since]: self = .since(ms: try window.decode(Int64.self, forKey: .since))
            case [.past]: self = .past(ms: try window.decode(Int64.self, forKey: .past))
            default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "a window is since_ms or past_ms"))
            }
        }

        public func encode(to encoder: Encoder) throws {
            switch self {
            case .allTime:
                var window = encoder.singleValueContainer()
                try window.encodeNil()
            case .since(let ms):
                var window = encoder.container(keyedBy: Keys.self)
                try window.encode(ms, forKey: .since)
            case .past(let ms):
                var window = encoder.container(keyedBy: Keys.self)
                try window.encode(ms, forKey: .past)
            }
        }
    }

    public enum EditTarget: Codable, Sendable, Equatable, Hashable {
        case reader(String)
        case request(String)
        case key(KeyApp)

        private enum Keys: String, CodingKey { case reader, request, key }

        public init(from decoder: Decoder) throws {
            let target = try decoder.container(keyedBy: Keys.self)
            switch Set(target.allKeys) {
            case [.reader]: self = .reader(try target.decode(String.self, forKey: .reader))
            case [.request]: self = .request(try target.decode(String.self, forKey: .request))
            case [.key]: self = .key(try target.decode(KeyApp.self, forKey: .key))
            default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "a target is a reader, a request or a key"))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var target = encoder.container(keyedBy: Keys.self)
            switch self {
            case .reader(let id): try target.encode(id, forKey: .reader)
            case .request(let id): try target.encode(id, forKey: .request)
            case .key(let app): try target.encode(app, forKey: .key)
            }
        }
    }

    public enum Mode: String, Codable, Sendable, Equatable, Hashable { case but, only }

    public enum HideChoice: String, Codable, Sendable, Equatable, Hashable { case names, all, none, custom }

    public enum Edit: Codable, Sendable, Equatable, Hashable {
        case window(Window)
        case type(String, on: Bool)
        case typeWindow(String, Window)
        case account(String, on: Bool)
        case accountWindow(String, Window)
        case hide(HideChoice)
        case detail(String, hidden: Bool)
        case mode(Mode)

        private enum Keys: String, CodingKey { case window, type, on, account, hide, detail, hidden, mode }

        public init(from decoder: Decoder) throws {
            let edit = try decoder.container(keyedBy: Keys.self)
            let on = { try edit.decode(Bool.self, forKey: .on) }
            switch Set(edit.allKeys) {
            case [.window]: self = .window(try edit.decode(Window.self, forKey: .window))
            case [.type, .on]: self = .type(try edit.decode(String.self, forKey: .type), on: try on())
            case [.type, .window]: self = .typeWindow(try edit.decode(String.self, forKey: .type), try edit.decode(Window.self, forKey: .window))
            case [.account, .on]: self = .account(try edit.decode(String.self, forKey: .account), on: try on())
            case [.account, .window]:
                self = .accountWindow(try edit.decode(String.self, forKey: .account), try edit.decode(Window.self, forKey: .window))
            case [.hide]: self = .hide(try edit.decode(HideChoice.self, forKey: .hide))
            case [.detail, .hidden]: self = .detail(try edit.decode(String.self, forKey: .detail), hidden: try edit.decode(Bool.self, forKey: .hidden))
            case [.mode]: self = .mode(try edit.decode(Mode.self, forKey: .mode))
            default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "no edit has these members"))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var edit = encoder.container(keyedBy: Keys.self)
            switch self {
            case .window(let window): try edit.encode(window, forKey: .window)
            case .type(let type, let on):
                try edit.encode(type, forKey: .type)
                try edit.encode(on, forKey: .on)
            case .typeWindow(let type, let window):
                try edit.encode(type, forKey: .type)
                try edit.encode(window, forKey: .window)
            case .account(let account, let on):
                try edit.encode(account, forKey: .account)
                try edit.encode(on, forKey: .on)
            case .accountWindow(let account, let window):
                try edit.encode(account, forKey: .account)
                try edit.encode(window, forKey: .window)
            case .hide(let choice): try edit.encode(choice, forKey: .hide)
            case .detail(let type, let hidden):
                try edit.encode(type, forKey: .detail)
                try edit.encode(hidden, forKey: .hidden)
            case .mode(let mode): try edit.encode(mode, forKey: .mode)
            }
        }
    }

    public struct Limit: Codable, Sendable, Equatable, Hashable {
        public var window: Window?
        public var words: String

        private enum Keys: String, CodingKey { case value, words }
        private enum Value: String, CodingKey { case window, mixed }

        public init(from decoder: Decoder) throws {
            let limit = try decoder.container(keyedBy: Keys.self)
            words = try limit.decode(String.self, forKey: .words)
            let value = try limit.nestedContainer(keyedBy: Value.self, forKey: .value)
            if Set(value.allKeys) == [.window] {
                window = try value.decode(Window.self, forKey: .window)
            } else if Set(value.allKeys) == [.mixed], try value.decode(Bool.self, forKey: .mixed) {
                window = nil
            } else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "a limit is a window or mixed"))
            }
        }

        public func encode(to encoder: Encoder) throws {
            var limit = encoder.container(keyedBy: Keys.self)
            try limit.encode(words, forKey: .words)
            var value = limit.nestedContainer(keyedBy: Value.self, forKey: .value)
            if let window { try value.encode(window, forKey: .window) } else { try value.encode(true, forKey: .mixed) }
        }
    }

    public struct AccessView: Codable, Sendable, Equatable, Hashable {
        public var sentence: Bolded
        public var summary: String
        public var reads: String
        public var mode: Mode
        public var modes: [ModeChoice]
        public var modeLine: String
        public var window: Limit
        public var categories: [Category]
        public var times: [TimeChoice]
        @Nullable public var hide: Hiding?
        public var widens: Bool
        @Nullable public var widening: Bolded?
        @Nullable public var screen: String?

        enum CodingKeys: String, CodingKey {
            case sentence, summary, reads, mode, modes, window, categories, times, hide, widens, widening, screen
            case modeLine = "mode_line"
        }

        public struct ModeChoice: Codable, Sendable, Equatable, Hashable, Identifiable {
            public var mode: Mode
            public var words: String

            public var id: Mode { mode }
        }

        public struct Category: Codable, Sendable, Equatable, Hashable, Identifiable {
            public var type: String
            public var name: String
            public var icon: String
            @Nullable public var line: String?
            public var state: Switch
            @Nullable public var limit: Limit?
            public var accounts: [Account]
            @Nullable public var reads: KindReads?
            @Nullable public var differs: String?

            public var id: String { type }
        }

        public struct KindReads: Codable, Sendable, Equatable, Hashable {
            public var n: Int
            public var words: String
        }

        public struct Account: Codable, Sendable, Equatable, Hashable, Identifiable {
            public var account: String
            public var name: String
            @Nullable public var line: String?
            public var state: Switch
            @Nullable public var limit: Limit?

            public var id: String { account }
        }

        public struct TimeChoice: Codable, Sendable, Equatable, Hashable {
            public enum Kind: String, Codable, Sendable, Equatable, Hashable { case all, since, past }

            public var choice: Kind
            @Nullable public var window: Window?
            public var words: String

            public init(choice: Kind, window: Window?, words: String) {
                self.choice = choice
                self.window = window
                self.words = words
            }
        }

        public struct Hiding: Codable, Sendable, Equatable, Hashable {
            public var choice: HideChoice
            public var words: String
            public var choices: [Choice]
            public var types: [Detail]

            public struct Choice: Codable, Sendable, Equatable, Hashable {
                public var level: HideChoice
                public var words: String
                @Nullable public var line: String?
                public var selected: Bool
            }
        }

        public struct Detail: Codable, Sendable, Equatable, Hashable, Identifiable {
            public var type: String
            public var name: String
            public var state: DetailState
            public var subtypes: [Subtype]

            public var id: String { type }
        }

        public struct Subtype: Codable, Sendable, Equatable, Hashable, Identifiable {
            public var type: String
            public var name: String
            public var state: DetailState

            public var id: String { type }
        }

        public enum DetailState: String, Codable, Sendable, Equatable, Hashable { case hidden, shown, fixed }
    }

    public struct AccessDraft: Codable, Sendable, Equatable, Hashable {
        public var access: DraftAccess
        @Nullable public var expect: Version?
        public var view: AccessView
        @Nullable public var narrowed: Narrowed?
        @Nullable public var saved: Saved?

        public struct Saved: Codable, Sendable, Equatable, Hashable {
            public var access: Access
            public var view: AccessView
        }

        public var narrowedTo: AccessDraft? {
            guard let narrowed, let saved else { return nil }
            return AccessDraft(access: saved.access, expect: expect, view: saved.view, narrowed: narrowed, saved: nil)
        }
    }

    public struct Narrowed: Codable, Sendable, Equatable, Hashable {
        public var words: Bolded
        public var undo: Undo

        public struct Undo: Codable, Sendable, Equatable, Hashable {
            public var access: Access
            public var expect: Version
        }
    }

    public struct EditRequest: Codable, Sendable, Equatable, Hashable {
        public var target: EditTarget
        public var access: DraftAccess
        @Nullable public var expect: Version?
        @Nullable public var edit: Edit?

        public init(target: EditTarget, access: DraftAccess, expect: Version?, edit: Edit?) {
            self.target = target
            self.access = access
            self.expect = expect
            self.edit = edit
        }
    }
}

@propertyWrapper
public struct Nullable<Value: Codable & Sendable & Hashable>: Codable, Sendable, Hashable {
    public var wrappedValue: Value?

    public init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        wrappedValue = value.decodeNil() ? nil : try value.decode(Value.self)
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        if let wrappedValue { try value.encode(wrappedValue) } else { try value.encodeNil() }
    }
}
