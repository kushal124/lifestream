import Contacts
import Foundation
import HomeLink
import LifestreamCaptureCore

struct ContactsStatus: Sendable {
    var authorization: ContactsAuthorization
    var lastRead: String?
    var contacts: Int?
    var photosKept = 0
    var photoBytesKept: UInt64 = 0
    var error: String?
}

actor ContactsRecorder {
    private let log: ContactsLog
    private let source: any ContactSource
    private let beforeCapture: @Sendable () async throws -> Void
    private var flight: Task<Void, Never>?
    private var lastError: String?
    private(set) var lastStarted: Date?

    init(store: CaptureStore, source: any ContactSource, beforeCapture: @escaping @Sendable () async throws -> Void = {}) {
        log = ContactsLog(store: store)
        self.source = source
        self.beforeCapture = beforeCapture
    }

    func requestAuthorization(at date: Date? = nil) async {
        do {
            try await beforeCapture()
            _ = try await source.requestAuthorization()
            _ = queued(manual: true, at: date, calendar: .current)
        } catch { if case .failed(let words)? = ReadOutcome(ending: error) { lastError = words } }
    }

    @discardableResult
    func pass(manual: Bool = false, at date: Date? = nil, calendar: Calendar = .current) async -> ReadOutcome? {
        await queued(manual: manual, at: date, calendar: calendar).value
    }

    func clearImported(by answer: FreshAnswer, custody: PhoneCustody) async throws {
        let failed = await queued { () -> (any Error)? in
            do { try await custody.clearImportedContacts(answer) } catch { return error }
            return nil
        }.value
        if let failed { throw failed }
    }

    private func queued(manual: Bool, at date: Date?, calendar: Calendar) -> Task<ReadOutcome?, Never> {
        lastStarted = date ?? AppClock.now
        return queued { [self] in
            await EnergyLedger.shared.measure(.contacts) {
                await performPass(manual: manual, at: date, calendar: calendar)
            }
        }
    }

    private func queued<T: Sendable>(_ work: @escaping @Sendable () async -> T) -> Task<T, Never> {
        let previous = flight
        let task = Task { _ = await previous?.value; return await work() }
        flight = Task { _ = await task.value }
        return task
    }

    func authorization() -> ContactsAuthorization { source.authorizationStatus() }

    func status() async -> ContactsStatus {
        var result = ContactsStatus(authorization: source.authorizationStatus(), error: lastError)
        do {
            let table = try await log.table()
            result.lastRead = table.lastRead
            result.contacts = table.lastRead != nil || table.stated > 0 ? table.stated : nil
            (result.photosKept, result.photoBytesKept) = try await log.photosKept()
        } catch { result.error = error.localizedDescription }
        return result
    }

    private func performPass(manual: Bool, at requestedDate: Date?, calendar: Calendar) async -> ReadOutcome? {
        let outcome: ReadOutcome?
        do {
            try await beforeCapture()
            let table = try await log.table()
            let authorization = source.authorizationStatus()
            let date = requestedDate ?? AppClock.now
            let lastDay = table.lastRead.flatMap(CaptureTime.date(rfc3339:)).map { Self.day($0, calendar: calendar) }
            let reads = authorization.canRead
                && (manual || table.authorization != authorization || lastDay != Self.day(date, calendar: calendar))
            try await log.pass(table, authorization: authorization, reader: reads ? source : nil, at: date)
            outcome = .read
        } catch { outcome = ReadOutcome(ending: error) }
        switch outcome {
        case .read?: lastError = nil
        case .failed(let words)?: lastError = words
        case nil: break
        }
        return outcome
    }

    private static func day(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.era, .year, .month, .day], from: date)
        return "\(parts.era ?? 0):\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
    }
}

extension ContactsRecorder {
    nonisolated static let changed = Notification.Name.CNContactStoreDidChange
}
