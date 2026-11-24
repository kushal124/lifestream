import Foundation

public struct MacImport: Encodable, Sendable, Equatable {
    public struct File: Encodable, Sendable, Equatable {
        public enum State: String, Codable, Sendable {
            case checking, refused, waiting, sending, already, sent, missing
        }

        public enum Why: String, Codable, Sendable {
            case damaged
            case notThisKind = "not-this-kind"
            case nothingRead = "nothing-read"
            case tooLarge = "too-large"
            case turn
            case macRoom = "mac-room"
            case homeRoom = "home-room"
            case battery
        }

        public var id: String
        public var name: String
        public var bytes: Int64
        public var state: State
        public var why: Why?
        public var sha256: String?
        public var seal: Int?
        public var pass: String?
        public var sentBytes: Int64?

        public init(id: String, name: String, bytes: Int64, state: State, why: Why? = nil, sha256: String? = nil, seal: Int? = nil,
                    pass: String? = nil, sentBytes: Int64? = nil) {
            self.id = id
            self.name = name
            self.bytes = bytes
            self.state = state
            self.why = why
            self.sha256 = sha256
            self.seal = seal
            self.pass = pass
            self.sentBytes = sentBytes
        }

        enum CodingKeys: String, CodingKey {
            case id, name, bytes, state, why, sha256, seal, pass
            case sentBytes = "sent_bytes"
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(id, forKey: .id)
            try container.encode(name, forKey: .name)
            try container.encode(bytes, forKey: .bytes)
            try container.encode(state, forKey: .state)
            try container.encode(why, forKey: .why)
            try container.encodeIfPresent(sha256, forKey: .sha256)
            try container.encodeIfPresent(seal, forKey: .seal)
            try container.encodeIfPresent(pass, forKey: .pass)
            try container.encodeIfPresent(sentBytes, forKey: .sentBytes)
        }
    }

    public var kind: String
    public var files: [File]

    public init(kind: String, files: [File]) {
        self.kind = kind
        self.files = files
    }
}
