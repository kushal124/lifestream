import Foundation

extension HomeLink.Ask {
    public enum Phase: String, Sendable {
        case sending, named
    }

    public enum Answer: Sendable, Equatable {
        case chat
        case missing
        case noteGone
        case photo(Int)
        case refused(Int)
        case away
        case error(erased: Bool)
        case lost
        case ended
        case done(failed: Bool)
    }

    public struct Outcome: Sendable, Equatable {
        public enum Copies: String, Sendable {
            case drop, keep, purge
            case noneHeld = "none held"
        }

        public enum Turn: String, Sendable {
            case named, sending, failed, erased, done, follow
        }

        public enum Again: String, Sendable, Codable {
            case none, same, new
            case missing = "send what is missing, then the same body"
            case whenAnswered = "same, when the home answers"
            case photoRemoved = "same, once the photo is removed"
        }

        public let copies: Copies
        public let turn: Turn
        public let again: Again

        public init(_ copies: Copies, _ turn: Turn, _ again: Again) {
            self.copies = copies
            self.turn = turn
            self.again = again
        }

        public static func of(_ answer: Answer, in phase: Phase) -> Outcome {
            switch (phase, answer) {
            case (_, .refused(410)), (_, .error(erased: true)): Outcome(.purge, .erased, .none)
            case (.sending, .chat): Outcome(.drop, .named, .none)
            case (.sending, .missing): Outcome(.keep, .sending, .missing)
            case (.sending, .noteGone): Outcome(.keep, .failed, .none)
            case (.sending, .photo(500...)): Outcome(.keep, .failed, .same)
            case (.sending, .photo): Outcome(.keep, .failed, .photoRemoved)
            case (.sending, .refused(422)): Outcome(.drop, .failed, .none)
            case (.sending, .refused), (.sending, .error), (.sending, .done): Outcome(.keep, .failed, .same)
            case (.sending, .away), (.sending, .lost), (.sending, .ended): Outcome(.keep, .sending, .whenAnswered)
            case (.named, .done(failed: false)): Outcome(.noneHeld, .done, .new)
            case (.named, .away), (.named, .lost), (.named, .ended): Outcome(.noneHeld, .follow, .none)
            case (.named, _): Outcome(.noneHeld, .failed, .new)
            }
        }
    }
}
