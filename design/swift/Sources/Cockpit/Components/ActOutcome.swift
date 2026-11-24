import SwiftUI

public enum ActOutcome: Equatable, Sendable {
    case idle
    case running
    case failed(InPlaceLine.Said)

    public var running: Bool { self == .running }

    public var failure: InPlaceLine.Said? {
        if case .failed(let said) = self { said } else { nil }
    }

    public static func refused(_ error: any Error) -> ActOutcome {
        .failed(.refused(error.localizedDescription))
    }

    @MainActor @discardableResult
    public static func run<T>(_ outcome: Binding<ActOutcome>, said: (any Error) -> ActOutcome = ActOutcome.refused,
                              _ work: @MainActor () async throws -> T) async -> T? {
        guard !outcome.wrappedValue.running else { return nil }
        outcome.wrappedValue = .running
        do {
            let answer = try await work()
            outcome.wrappedValue = .idle
            return answer
        } catch {
            outcome.wrappedValue = said(error)
            return nil
        }
    }

    @MainActor @discardableResult
    public static func run<Owner: AnyObject, T>(_ key: ReferenceWritableKeyPath<Owner, ActOutcome>, of owner: Owner,
                                                said: (any Error) -> ActOutcome = ActOutcome.refused,
                                                _ work: @MainActor () async throws -> T) async -> T? {
        guard !owner[keyPath: key].running else { return nil }
        owner[keyPath: key] = .running
        do {
            let answer = try await work()
            owner[keyPath: key] = .idle
            return answer
        } catch {
            owner[keyPath: key] = said(error)
            return nil
        }
    }
}

public extension View {
    func actOutcome(_ outcome: ActOutcome, act: String = "Try again", identifier: String? = nil,
                    retry: (() -> Void)?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            self
            if let failure = outcome.failure {
                InPlaceLine(failure, act: act, retry: retry)
                    .accessibilityIdentifier(identifier ?? "act.failed")
            }
        }
    }
}
