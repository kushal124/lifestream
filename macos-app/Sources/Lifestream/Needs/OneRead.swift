import Foundation

@MainActor final class OneRead {
    private var running: Task<Void, Never>?
    private var again = false

    func run(_ read: @escaping @MainActor () async -> Void) async {
        if let running {
            again = true
            await running.value
            return
        }
        let task = Task { @MainActor in
            repeat {
                again = false
                await read()
            } while again
            running = nil
        }
        running = task
        await task.value
    }
}
