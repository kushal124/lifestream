import BackgroundTasks
import Foundation
import LifestreamCaptureCore
import os

@MainActor
final class BackgroundSync {
    enum Kind: Sendable { case refresh, processing }

    nonisolated static let refreshIdentifier = "org.lifestreamprotocol.phone.refresh"
    nonisolated static let processingIdentifier = "org.lifestreamprotocol.phone.processing"
    nonisolated static let continuedIdentifier = continued(under: Bundle.main.bundleIdentifier)
    nonisolated static func continued(under bundle: String?) -> String {
        (bundle ?? "org.lifestreamprotocol.phone") + ".continued"
    }
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "background")
    static let refreshInterval: TimeInterval = 15 * 60
    static let processingInterval: TimeInterval = 60 * 60

    private let run: @MainActor (Kind) async -> Void
    private var registered = false

    init(run: @escaping @MainActor (Kind) async -> Void) {
        self.run = run
    }

    func register() {
        guard !registered else { return }
        registered = true
        for (identifier, kind) in [(Self.refreshIdentifier, Kind.refresh), (Self.processingIdentifier, Kind.processing)] {
            BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { [weak self] task in
                let run = BackgroundRun(task)
                guard let self else { run.complete(success: false); return }
                self.handle(run, kind: kind)
            }
        }
        schedule()
    }

    func continued(title: String, subtitle: String, work: @escaping @MainActor (Progress) async -> Void) -> Task<Void, Never> {
        let progress = Progress(totalUnitCount: 1)
        let work = Task { @MainActor in await work(progress) }
        let identifier = Self.continuedIdentifier + "." + UUID().uuidString
        guard registered, BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main, launchHandler: { task in
            let run = BackgroundRun(task)
            guard let task = task as? BGContinuedProcessingTask else { return run.complete(success: false) }
            task.progress.totalUnitCount = 1
            task.progress.addChild(progress, withPendingUnitCount: 1)
            run.expire {
                work.cancel()
                run.complete(success: false)
            }
            Task {
                await work.value
                run.complete(success: !work.isCancelled)
            }
        }) else { return work }
        let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: subtitle)
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            Self.log.error("continued task \(identifier, privacy: .public) not submitted: \(error.localizedDescription, privacy: .public)")
        }
        return work
    }

    func schedule() {
        let refresh = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        refresh.earliestBeginDate = AppClock.now.addingTimeInterval(Self.refreshInterval)
        let processing = BGProcessingTaskRequest(identifier: Self.processingIdentifier)
        processing.requiresNetworkConnectivity = true
        processing.requiresExternalPower = true
        processing.earliestBeginDate = AppClock.now.addingTimeInterval(Self.processingInterval)
        for request in [refresh, processing] as [BGTaskRequest] {
            try? BGTaskScheduler.shared.submit(request)
        }
    }

    func cancel() {
        BGTaskScheduler.shared.cancelAllTaskRequests()
    }

    private func handle(_ task: BackgroundRun, kind: Kind) {
        schedule()
        let work = Task { [run] in
            await run(kind)
            task.complete(success: true)
        }
        task.expire {
            work.cancel()
            task.complete(success: false)
        }
    }
}

private final class BackgroundRun: @unchecked Sendable {
    private let task: BGTask
    private let lock = NSLock()
    private var completed = false

    init(_ task: BGTask) { self.task = task }

    func expire(_ handler: @escaping @Sendable () -> Void) {
        task.expirationHandler = handler
    }

    func complete(success: Bool) {
        lock.lock()
        let first = !completed
        completed = true
        lock.unlock()
        if first { task.setTaskCompleted(success: success) }
    }
}
