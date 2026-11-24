import Foundation
import HomeLink
import LifestreamCaptureCore

struct ShipperState: Codable, Sendable, Equatable {
    var shown: [String: String] = [:]
    var expiryWarned: Date?
    var outcome = PhoneShipper.Outcome.nothingSent
    var recordedAt: Date?
    var failures = Failures()
    var sending: Sending { failures.sending }
}

struct Failures: Codable, Sendable, Equatable {
    enum Cause: String, Codable, CodingKeyRepresentable, Sendable { case read, seal, delivery }

    var sources: [String: [Cause: Sending.Failure]] = [:]
    var send: Sending.Failure?

    var sending: Sending {
        Sending(sources: sources.compactMapValues { $0[.read] ?? $0[.seal] ?? $0[.delivery] }, send: send)
    }

    mutating func failed(_ source: String, _ cause: Cause, code: String, message: String, at: Date) {
        sources[source, default: [:]][cause] = Self.after(sources[source]?[cause], code: code, message: message, at: at)
    }

    mutating func ended(_ source: String, _ cause: Cause) {
        sources[source]?[cause] = nil
        if sources[source]?.isEmpty == true { sources[source] = nil }
    }

    mutating func sendFailed(code: String, message: String, at: Date) {
        send = Self.after(send, code: code, message: message, at: at)
    }

    private static func after(_ previous: Sending.Failure?, code: String, message: String, at: Date) -> Sending.Failure {
        Sending.Failure(sinceMs: previous?.sinceMs ?? Int64((at.timeIntervalSince1970 * 1000).rounded(.down)), code: code, message: message)
    }
}

extension PhoneShipper {
    enum Lifecycle: Equatable, Sendable {
        case idle
        case passing
        case unpairing
        case handedOver

        init(_ outcome: Outcome) { self = outcome == .handedOver ? .handedOver : .idle }

        mutating func startPass() -> Bool {
            guard self == .idle else { return false }
            self = .passing
            return true
        }

        mutating func endPass() {
            if self == .passing { self = .idle }
        }

        mutating func startUnpair() -> Bool {
            guard self == .idle || self == .passing else { return false }
            self = .unpairing
            return true
        }

        mutating func endUnpair() {
            if self == .unpairing { self = .idle }
        }

        mutating func handOver() -> Bool {
            guard self == .passing else { return false }
            self = .handedOver
            return true
        }
    }

    enum Outcome: Equatable, Sendable, Codable {
        case nothingSent, shipped, nothingNew, uploading, waiting, noHome, handedOver
        case unreachable
        case held(String)
        case refused(String)
        case storeFailed

        static let passRefused = Outcome.refused("PRINCIPAL_UNKNOWN")

        var word: String {
            switch self {
            case .nothingSent: "Nothing sent yet"
            case .shipped: "shipped"
            case .nothingNew: "nothing_new"
            case .uploading: "uploading"
            case .waiting: "waiting"
            case .unreachable: "unreachable"
            case .noHome: "no_home"
            case .handedOver: "handed_over"
            case .held(let code): "held " + code
            case .refused(let code): "refused " + code
            case .storeFailed: "refused local_storage"
            }
        }

        private static let fixed: [Outcome] = [
            .nothingSent, .shipped, .nothingNew, .uploading, .waiting, .unreachable, .noHome, .handedOver, .storeFailed,
        ]

        init?(word: String) {
            if let outcome = Self.fixed.first(where: { $0.word == word }) {
                self = outcome
            } else if word.hasPrefix("held "), word.count > 5 {
                self = .held(String(word.dropFirst(5)))
            } else if word.hasPrefix("refused "), word.count > 8 {
                self = .refused(String(word.dropFirst(8)))
            } else {
                return nil
            }
        }

        init(from decoder: any Decoder) throws {
            let word = try decoder.singleValueContainer().decode(String.self)
            guard let outcome = Outcome(word: word) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "no outcome: \(word)"))
            }
            self = outcome
        }

        func encode(to encoder: any Encoder) throws {
            var c = encoder.singleValueContainer()
            try c.encode(word)
        }

        var sending: Bool { [.shipped, .nothingNew, .uploading, .waiting].contains(self) }

        var asksAgain: Bool {
            switch self {
            case .refused, .held(LinkFailure.homeTooOld.code): true
            default: false
            }
        }
    }
}
