import Evidence
import Foundation

@MainActor
final class CapturePipeline {
    struct Ticket: Equatable {
        fileprivate let context: UInt64
        fileprivate let lifetime: UInt64
    }

    enum Phase {
        case beforeAcquisition, afterAcquisition, publication
    }

    enum Failure: Error, Equatable {
        case rejected(CaptureGapReason)
        case excludedPage(ForegroundPageGap)
    }

    private var context: UInt64 = 0
    private var lifetime: UInt64 = 0
    private var closing: [UInt64: () -> Void] = [:]
    private var nextWait: UInt64 = 0

    func ticket() -> Ticket { Ticket(context: context, lifetime: lifetime) }
    func contextChanged() { context &+= 1 }

    func invalidate() {
        lifetime &+= 1
        contextChanged()
        let waits = closing
        closing = [:]
        for answer in waits.values { answer() }
    }

    func isCurrent(_ ticket: Ticket) -> Bool { self.ticket() == ticket }
    func canPublish(_ ticket: Ticket) -> Bool { ticket.lifetime == lifetime }

    func run<Image, Result>(ticket: Ticket, acquire: () async throws -> Image,
        validate: (Phase) -> CaptureGapReason?, enrich: (Image) async throws -> Result) async throws -> Result {
        try Task.checkCancellation()
        try admit(ticket, beforeAcquisition: true)
        if let reason = validate(.beforeAcquisition) { throw Failure.rejected(reason) }
        let image = try await acquire()
        try Task.checkCancellation()
        try admit(ticket, beforeAcquisition: false)
        if let reason = validate(.afterAcquisition) { throw Failure.rejected(reason) }
        let result = try await enrich(image)
        try Task.checkCancellation()
        guard canPublish(ticket) else { throw Failure.rejected(.captureGenerationInvalidated) }
        return result
    }

    func whilePublishable<Value>(_ ticket: Ticket, _ work: Task<Value, Never>) async -> Value? {
        guard canPublish(ticket) else { return nil }
        let id = nextWait
        nextWait &+= 1
        return await withCheckedContinuation { continuation in
            let answer = Answer(continuation) { [weak self] in self?.closing[id] = nil }
            closing[id] = { answer.give(nil) }
            Task { @MainActor in answer.give(await work.value) }
        }
    }

    func scoped<Value>(ticket: Ticket, read: () async -> Value,
        validate: () -> Bool) async -> Value? {
        guard isCurrent(ticket), !Task.isCancelled else { return nil }
        let result = await read()
        guard isCurrent(ticket), !Task.isCancelled, validate() else { return nil }
        return result
    }

    private func admit(_ ticket: Ticket, beforeAcquisition: Bool) throws {
        guard canPublish(ticket) else { throw Failure.rejected(.captureGenerationInvalidated) }
        guard isCurrent(ticket) else {
            throw Failure.rejected(beforeAcquisition ? .contextChangedBeforeCapture : .contextChangedDuringCapture)
        }
    }
}

@MainActor private final class Answer<Value> {
    private var continuation: CheckedContinuation<Value?, Never>?
    private let done: () -> Void

    init(_ continuation: CheckedContinuation<Value?, Never>, done: @escaping () -> Void) {
        self.continuation = continuation
        self.done = done
    }

    func give(_ value: Value?) {
        guard let continuation else { return }
        self.continuation = nil
        done()
        continuation.resume(returning: value)
    }
}
