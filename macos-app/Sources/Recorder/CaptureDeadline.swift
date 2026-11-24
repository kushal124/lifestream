import Foundation

enum CaptureDeadlineError: Error { case timedOut }

@MainActor final class CaptureDeadline<Value> {
    private var continuation: CheckedContinuation<Value, Error>?
    private var acquisition: Task<Void, Never>?
    private var timer: Task<Void, Never>?

    func run(seconds: Double,
             sleep: @escaping @MainActor (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
             operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                acquisition = Task {
                    do {
                        finish(.success(try await operation()))
                    } catch {
                        finish(.failure(error))
                    }
                }
                timer = Task {
                    do {
                        try await sleep(seconds)
                    } catch {
                        return
                    }
                    finish(.failure(CaptureDeadlineError.timedOut))
                }
            }
        } onCancel: {
            Task { @MainActor in self.finish(.failure(CancellationError())) }
        }
    }

    private func finish(_ result: Result<Value, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        timer?.cancel()
        timer = nil
        acquisition?.cancel()
        acquisition = nil
        continuation.resume(with: result)
    }
}
