import Foundation
import HomeLink

public enum HomeStarting {
    public static let code = "NOT_NOW"
    public static let within: TimeInterval = 120
    public static let every: TimeInterval = 5

    public struct NotNow: Equatable, Sendable {
        public let words: String
        public let retryAfter: TimeInterval?
        public let starting: Bool

        public init(words: String, retryAfter: TimeInterval?, starting: Bool) {
            self.words = words
            self.retryAfter = retryAfter
            self.starting = starting
        }
    }

    public static func notNow(_ error: any Error) -> NotNow? {
        guard case .unavailable(code, let message, let retryAfter, let kind)? = error as? LinkFailure else { return nil }
        let starting = if case .starting = kind { true } else { false }
        return NotNow(words: message ?? "", retryAfter: retryAfter, starting: starting)
    }

    public static func shown(_ notNow: NotNow) -> String {
        notNow.starting ? "Lifestream is starting on your Mac: it answers in a moment." : notNow.words
    }

    public static func said(_ notNow: NotNow) -> String {
        notNow.starting ? "Lifestream didn't finish starting on your Mac. Try again in a moment."
            : "Lifestream did not answer in time. \(notNow.words)"
    }

    public static func again(within: TimeInterval = within, now: () -> Date = Date.init,
                             pause: (Duration) async -> Bool = { (try? await Task.sleep(for: $0)) != nil },
                             bound: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) },
                             heard: (NotNow) -> Void, isolation: isolated (any Actor)? = #isolation,
                             _ attempt: @escaping @Sendable () async throws -> Void) async throws {
        let deadline = now().addingTimeInterval(within)
        var last: (any Error)?
        while true {
            let left = deadline.timeIntervalSince(now())
            guard left > 0 else { throw last ?? LinkFailure.noAnswer(sent: true) }
            let answered: Bool
            do {
                answered = try await bounded(.seconds(left), bound, attempt)
            } catch {
                guard let notNow = notNow(error) else { throw error }
                last = error
                let left = deadline.timeIntervalSince(now())
                guard left > 0 else { throw error }
                heard(notNow)
                guard await pause(.seconds(min(max(0, notNow.retryAfter ?? every), left))) else { throw CancellationError() }
                continue
            }
            guard answered else {
                try Task.checkCancellation()
                throw last ?? LinkFailure.noAnswer(sent: true)
            }
            return
        }
    }

    private static func bounded(_ left: Duration, _ bound: @escaping @Sendable (Duration) async -> Void,
                                _ attempt: @escaping @Sendable () async throws -> Void) async throws -> Bool {
        try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask {
                try await attempt()
                return true
            }
            group.addTask {
                await bound(left)
                return false
            }
            defer { group.cancelAll() }
            return try await group.next() ?? false
        }
    }
}
