import Foundation

public struct Sending: Codable, Sendable, Equatable {
    public struct Failure: Codable, Sendable, Equatable {
        public var sinceMs: Int64
        public var code: String
        public var message: String

        public init(sinceMs: Int64, code: String, message: String) {
            self.sinceMs = sinceMs
            self.code = code
            self.message = message
        }

        enum CodingKeys: String, CodingKey {
            case sinceMs = "since_ms"
            case code, message
        }

        static func after(_ previous: Failure?, code: String, message: String, at: Date) -> Failure {
            Failure(sinceMs: previous?.sinceMs ?? Sending.ms(at), code: code, message: message)
        }
    }

    public var sources: [String: Failure]
    public var send: Failure?

    public init(sources: [String: Failure] = [:], send: Failure? = nil) {
        self.sources = sources
        self.send = send
    }

    enum CodingKeys: String, CodingKey {
        case sources, send
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sources = try c.decodeIfPresent([String: Failure].self, forKey: .sources) ?? [:]
        send = try c.decodeIfPresent(Failure.self, forKey: .send)
    }

    public mutating func failed(_ source: String, code: String, message: String, at: Date) {
        sources[source] = .after(sources[source], code: code, message: message, at: at)
    }

    public mutating func sendFailed(code: String, message: String, at: Date) {
        send = .after(send, code: code, message: message, at: at)
    }

    static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }
}
