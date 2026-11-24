import Foundation

extension HomeLink {
    public struct DayFile: Codable, Sendable, Equatable {
        public let day: String
        public let window: Window
        public let renderer: String
        public let inputs: String
        public let counts: Counts
        public let coverage: [Coverage]
        public let atoms: [Atom]

        public init(day: String, window: Window, renderer: String, inputs: String, counts: Counts, coverage: [Coverage],
                    atoms: [Atom]) {
            self.day = day
            self.window = window
            self.renderer = renderer
            self.inputs = inputs
            self.counts = counts
            self.coverage = coverage
            self.atoms = atoms
        }

        enum CodingKeys: String, CodingKey {
            case day, window, renderer, inputs, counts, coverage, atoms
        }

        public struct Window: Codable, Sendable, Equatable {
            public let startMs: Int64
            public let endMs: Int64

            public init(startMs: Int64, endMs: Int64) {
                self.startMs = startMs
                self.endMs = endMs
            }

            enum CodingKeys: String, CodingKey {
                case startMs = "start_ms"
                case endMs = "end_ms"
            }
        }

        public struct Counts: Codable, Sendable, Equatable {
            public let total: Int
            public let perFamily: [String: Int]

            public init(total: Int, perFamily: [String: Int]) {
                self.total = total
                self.perFamily = perFamily
            }

            enum CodingKeys: String, CodingKey {
                case total
                case perFamily = "per_family"
            }
        }

        public struct Coverage: Codable, Sendable, Equatable {
            public let family: String
            public let sources: [Source]

            public init(family: String, sources: [Source]) {
                self.family = family
                self.sources = sources
            }

            public struct Source: Codable, Sendable, Equatable {
                public let source: String
                public let read: Read?

                public init(source: String, read: Read?) {
                    self.source = source
                    self.read = read
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    source = try container.decode(String.self, forKey: .source)
                    read = try container.decodeIfPresent(String.self, forKey: .read).flatMap(Read.init(rawValue:))
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode(source, forKey: .source)
                    try container.encodeIfPresent(read, forKey: .read)
                }

                enum CodingKeys: String, CodingKey {
                    case source, read
                }
            }

            public enum Read: String, Codable, Sendable {
                case notRead = "none"
                case into
                case through
            }
        }

        public struct Atom: Codable, Sendable, Equatable {
            public let n: Int
            public let family: String
            public let unit: String
            public let startMs: Int64?
            public let endMs: Int64?
            public let localStart: String?
            public let localEnd: String?
            public let flags: [String]
            public let text: String
            public let record: RecordRef?
            public let item: String?
            public let block: Block?
            public let type: String?
            public let video: Video?
            public let live: Bool?

            public init(n: Int, family: String, unit: String, startMs: Int64?, endMs: Int64?, localStart: String?,
                        localEnd: String?, flags: [String], text: String, record: RecordRef? = nil, item: String? = nil,
                        block: Block? = nil, type: String? = nil, video: Video? = nil, live: Bool? = nil) {
                self.n = n
                self.family = family
                self.unit = unit
                self.startMs = startMs
                self.endMs = endMs
                self.localStart = localStart
                self.localEnd = localEnd
                self.flags = flags
                self.text = text
                self.record = record
                self.item = item
                self.block = block
                self.type = type
                self.video = video
                self.live = live
            }

            enum CodingKeys: String, CodingKey {
                case n, family, unit, flags, text, record, item, block, type, video, live
                case startMs = "start_ms"
                case endMs = "end_ms"
                case localStart = "local_start"
                case localEnd = "local_end"
            }
        }

        public struct Video: Codable, Sendable, Equatable, Hashable {
            public let durationMs: Int64?

            public init(durationMs: Int64?) {
                self.durationMs = durationMs
            }

            enum CodingKeys: String, CodingKey {
                case durationMs = "duration_ms"
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(durationMs, forKey: .durationMs)
            }
        }

        public struct RecordRef: Codable, Sendable, Equatable, Hashable {
            public let source: String
            public let kind: String
            public let key: String

            public init(source: String, kind: String, key: String) {
                self.source = source
                self.kind = kind
                self.key = key
            }
        }

        public struct Block: Codable, Sendable, Equatable, Hashable {
            public let key: String
            public let title: String

            public init(key: String, title: String) {
                self.key = key
                self.title = title
            }
        }
    }

    public struct ChatDay: Decodable, Sendable, Equatable {
        public let chat: String
        public let day: String
        public let window: DayFile.Window
        public let title: String
        public let atoms: [DayFile.Atom]
        public let messages: [Message]

        enum CodingKeys: String, CodingKey {
            case chat, day, window, title, atoms, messages
        }

        public struct Message: Decodable, Sendable, Equatable {
            public let parts: [Part]

            public init(parts: [Part]) {
                self.parts = parts
            }

            enum CodingKeys: String, CodingKey {
                case parts
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                parts = try container.decodeIfPresent([Part].self, forKey: .parts) ?? []
            }
        }

        public struct Part: Decodable, Sendable, Equatable {
            public let blob: String?
            public let transcribed: Made?

            public init(blob: String?, transcribed: Made?) {
                self.blob = blob
                self.transcribed = transcribed
            }
        }

        public var transcripts: [String: Made] {
            Dictionary(messages.flatMap(\.parts).compactMap { part in part.blob.flatMap { blob in part.transcribed.map { (blob, $0) } } },
                       uniquingKeysWith: { first, _ in first })
        }

        public var file: DayFile {
            DayFile(day: day, window: window, renderer: "", inputs: "",
                    counts: .init(total: atoms.count, perFamily: ["messages": atoms.count]), coverage: [], atoms: atoms)
        }
    }

    public struct Extract: Codable, Sendable, Equatable {
        public let family: String
        public let unit: String
        public let reading: String
        public let content: JSON
        public let startMs: Int64?
        public let endMs: Int64?
        public let days: [String]
        public let items: [String]

        public init(family: String, unit: String, reading: String, content: JSON, startMs: Int64?, endMs: Int64?,
                    days: [String], items: [String]) {
            self.family = family
            self.unit = unit
            self.reading = reading
            self.content = content
            self.startMs = startMs
            self.endMs = endMs
            self.days = days
            self.items = items
        }

        enum CodingKeys: String, CodingKey {
            case family, unit, reading, content, days, items
            case startMs = "start_ms"
            case endMs = "end_ms"
        }
    }

    public enum JSON: Codable, Sendable, Equatable, Hashable {
        case null
        case bool(Bool)
        case number(Double)
        case string(String)
        case array([JSON])
        case object([String: JSON])

        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if container.decodeNil() { self = .null }
            else if let value = try? container.decode(Bool.self) { self = .bool(value) }
            else if let value = try? container.decode(Double.self) { self = .number(value) }
            else if let value = try? container.decode(String.self) { self = .string(value) }
            else if let value = try? container.decode([JSON].self) { self = .array(value) }
            else { self = .object(try container.decode([String: JSON].self)) }
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .null: try container.encodeNil()
            case .bool(let value): try container.encode(value)
            case .number(let value): try container.encode(value)
            case .string(let value): try container.encode(value)
            case .array(let value): try container.encode(value)
            case .object(let value): try container.encode(value)
            }
        }

        public subscript(key: String) -> JSON? {
            if case .object(let members) = self { return members[key] }
            return nil
        }

        public var string: String? { if case .string(let value) = self { return value }; return nil }
        public var number: Double? { if case .number(let value) = self { return value }; return nil }
        public var bool: Bool? { if case .bool(let value) = self { return value }; return nil }
        public var array: [JSON]? { if case .array(let value) = self { return value }; return nil }
        public var object: [String: JSON]? { if case .object(let value) = self { return value }; return nil }
    }
}
