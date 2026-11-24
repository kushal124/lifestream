import Foundation

extension HomeLink {
    public enum Outbox {
        public enum Judgement: Sendable, Equatable {
            case covered
            case next
            case stale
        }

        public static func judge(pass: String, seals: [String: Int], answer: FreshAnswer) -> Judgement {
            guard pass == answer.pass else { return .stale }
            let received = seals.map { source, seal in (seal, answer.sources[source]?.received) }
            if received.allSatisfy({ seal, received in received.map { $0 >= seal } ?? false }) { return .covered }
            if received.allSatisfy({ seal, received in received.map { $0 + 1 == seal } ?? false }) { return .next }
            return .stale
        }

        public enum Wait: Sendable, CaseIterable {
            case clockAhead
            case refused
            case busy

            public var seconds: TimeInterval {
                switch self {
                case .clockAhead: 15 * 60
                case .refused: 60 * 60
                case .busy: 60
                }
            }

            public func until(_ now: Date, retryAfter: TimeInterval? = nil) -> Date {
                now.addingTimeInterval(retryAfter ?? seconds)
            }
        }
    }
}
