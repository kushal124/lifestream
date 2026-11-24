import Combine
import DeviceFiles
import Evidence
import Foundation
import HomeLink
import os
import Passwords
import PhoneBackup
import Shipping
import UserNotifications

@MainActor final class Imports: ObservableObject {
    nonisolated static let reportEvery: TimeInterval = 60
    nonisolated static let reportAfterRun: TimeInterval = 15

    struct World {
        let carried: URL
        let files: DeviceFiles
        let clock: () -> Date
        let ship: @MainActor () -> Void
        let report: @MainActor () async -> HomeLink.StreamsReport?
        let notify: @MainActor (_ title: String, _ body: String) -> Void
        let homeFree: HomeFree
        let tell: @MainActor ([MacImport]) -> Void
        let looked: @MainActor (Set<HomeLink.ImportDigest>) async -> [HomeLink.ImportDigest: HomeLink.ImportLook]?
        let mark: @MainActor () async -> Void
        var backups: BackupWorld? = nil
    }

    struct BackupWorld {
        let root: URL
        let scratch: URL
        let held: @Sendable ([String]) async throws -> Set<String>
        let disk: Volume
        let pause: @Sendable () async throws -> Void
    }

    nonisolated static let backupKind = "iphone-backup"

    private let world: World
    private let ledger: ImportLedger
    private var kinds: [String: HomeLink.Import] = [:]
    private var watched: [String: Set<String>] = [:]
    private var notified: Set<String> = []
    private var underCheck: Set<String> = []
    private var sentBytes: [String: Int64] = [:]
    private var lastRead: Date?
    private var marked = false
    private var reading: Task<Void, Never>?
    private var stopped = false
    private var timer: Timer?
    private static let log = Logger(subsystem: "org.lifestreamprotocol.screen-capture", category: "imports")

    @Published private(set) var backups: BackupList?
    private var listed: [BackupFolder] = []
    private var listedAccess = BackupList.State.none
    private var brought: [String: ImportLedger.Backup]?
    private var reads: [String: BackupReading] = [:]
    private var pulls: [String: Task<Void, Never>] = [:]
    private var listing: Task<Void, Never>?

    init(world: World) {
        self.world = world
        ledger = .in(world.carried, files: world.files)
    }

    func start(after ready: LaunchReady) {
        do { try ledger.launch() } catch { Self.log.error("imports: the ledger at launch: \(String(describing: error), privacy: .public)") }
        prune()
        Task { [weak self] in
            guard await ready.wait() != .stopped, let self, !self.stopped else { return }
            tell()
            timer = Timer.scheduledTimer(withTimeInterval: Self.reportEvery, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.holdsAny else { return }
                    _ = self.read()
                }
            }
            _ = read()
        }
    }

    func stop() async {
        stopped = true
        timer?.invalidate()
        timer = nil
        await reading?.value
        let under = Array(pulls.values)
        under.forEach { $0.cancel() }
        for pull in under { await pull.value }
    }


    func handOver(_ urls: [URL], kind: String) async throws {
        guard !urls.isEmpty else { return }
        await retire(urls, kind: kind)
        let records: [ImportLedger.Record]
        do {
            records = try ledger.handOver(urls, kind: kind)
        } catch {
            throw HostRefusal("Lifestream couldn't save its list of your files.", said: .notSent)
        }
        tell()
        if !marked {
            marked = true
            await world.mark()
        }
        await check(records)
    }

    private func retire(_ urls: [URL], kind: String) async {
        let paths = Set(urls.map(\.path))
        let sent = ((try? ledger.read())?.files ?? []).filter { $0.kind == kind && $0.state == .sent && paths.contains($0.path) }
        let digests = Dictionary(sent.compactMap { record in record.sha256.map { (record.id, HomeLink.ImportDigest(kind: kind, digest: $0)) } },
                                 uniquingKeysWith: { first, _ in first })
        guard !digests.isEmpty, let looked = await world.looked(Set(digests.values)) else { return }
        let ended = Set(digests.filter { [.refused, .letGo].contains(looked[$0.value]) }.keys)
        guard !ended.isEmpty else { return }
        let changed = (try? ledger.change { contents -> Bool in
            let before = contents.files.count
            contents.files.removeAll { ended.contains($0.id) && $0.state == .sent }
            return contents.files.count < before
        }) ?? false
        if changed { tell() }
    }

    func again(_ id: String, at url: URL) async throws {
        let record: ImportLedger.Record?
        do {
            record = try ledger.again(id, at: url)
        } catch {
            throw HostRefusal("Lifestream couldn't save its list of your files.", said: .notSent)
        }
        guard let record else { throw HostRefusal("That file is no longer missing.") }
        tell()
        await check([record])
    }

    func missing(_ id: String, of kind: String) -> Bool {
        ((try? ledger.read())?.files ?? []).contains { $0.id == id && $0.kind == kind && $0.state == .missing }
    }

    func forget(_ id: String, of kind: String) throws {
        let forgotten: Bool
        do {
            guard try ledger.read().files.contains(where: { $0.id == id && $0.kind == kind }) else { return }
            forgotten = try ledger.forget(id)
        } catch {
            throw HostRefusal("Lifestream couldn't save its list of your files.", said: .notSent)
        }
        guard forgotten else { throw HostRefusal("That file is on its way to Lifestream.") }
        tell()
    }

    func refresh() {
        tell()
        guard holdsAny, lastRead.map({ world.clock().timeIntervalSince($0) >= Self.reportAfterRun }) ?? true else { return }
        _ = read()
    }


    private func check(_ records: [ImportLedger.Record]) async {
        guard !records.isEmpty else { return }
        if records.contains(where: { kinds[$0.kind] == nil }) { await read().value }
        let checking = Set(((try? ledger.read())?.files ?? []).filter { $0.state == .checking }.map(\.id))
        let due = records.filter { checking.contains($0.id) && !underCheck.contains($0.id) }
        guard !due.isEmpty else { return }
        let most = world.homeFree.most() ?? ImportFiles.doorMost
        var checked = false
        for record in due {
            guard let kind = kinds[record.kind] else { continue }
            underCheck.insert(record.id)
            let against = ImportCheck(recognise: kind.recognise, leaves: kind.leaves, root: kind.root)
            let ledger = ledger
            do {
                try await Task.detached(priority: .userInitiated) { try ledger.check(record, against: against, most: most) }.value
                checked = true
            } catch {
                Self.log.error("imports: a check's write: \(String(describing: error), privacy: .public)")
            }
            underCheck.remove(record.id)
        }
        guard checked else { return }
        tell()
        world.ship()
    }


    @discardableResult
    func read() -> Task<Void, Never> {
        if let reading { return reading }
        let task = Task {
            await readReport()
            reading = nil
        }
        reading = task
        return task
    }

    private func readReport() async {
        let sent = Set(((try? ledger.read())?.files ?? []).filter { $0.state == .sent }.compactMap { record in
            record.sha256.map { HomeLink.ImportDigest(kind: record.kind, digest: $0) }
        })
        let looked = sent.isEmpty ? [:] : await world.looked(sent) ?? [:]
        guard let report = await world.report() else { return }
        lastRead = world.clock()
        world.homeFree.set(free: report.disk.freeBytes, most: report.disk.maxBundleBytes)
        kinds = Dictionary(report.imports.map { ($0.kind, $0) }, uniquingKeysWith: { first, _ in first })
        guard let contents = try? ledger.read() else { return }
        await follow(contents, looked: looked)
        let pending = ((try? ledger.read())?.files ?? []).filter { $0.state == .checking && kinds[$0.kind] != nil }
        if !pending.isEmpty { await check(pending) }
    }

    private func follow(_ contents: ImportLedger.Contents, looked: [HomeLink.ImportDigest: HomeLink.ImportLook]) async {
        func look(_ record: ImportLedger.Record) -> HomeLink.ImportLook? {
            record.sha256.flatMap { looked[HomeLink.ImportDigest(kind: record.kind, digest: $0)] }
        }
        var notices: [HomeLink.Import.Held.Notice] = []
        let already = Set(kinds.values.flatMap { $0.coming.filter { $0.state == "already" }.map(\.id) })
        var gone: Set<String> = []
        for (kindId, records) in Dictionary(grouping: contents.files, by: \.kind) {
            guard let kind = kinds[kindId] else { continue }
            let ended = records.filter { $0.state == .sent && [.refused, .letGo].contains(look($0)) }
            gone.formUnion(ended.map(\.id))
            let sent = records.filter { $0.state == .sent && !already.contains($0.id) && !ended.contains($0) }
            guard !sent.isEmpty else {
                watched[kindId] = nil
                continue
            }
            var seen = watched[kindId] ?? []
            let unsettled = kind.held.filter { !Self.settled($0) }
            var told = false
            for held in kind.held where seen.contains(held.id) {
                guard let notice = held.notice else { continue }
                seen.remove(held.id)
                told = true
                if notified.insert(held.id).inserted { notices.append(notice) }
            }
            let taken = sent.allSatisfy { look($0) == .admitted }
            if taken && unsettled.isEmpty {
                gone.formUnion(sent.map(\.id))
                if !told, seen.isEmpty, let newest = kind.held.first, let notice = newest.notice, notified.insert(newest.id).inserted {
                    notices.append(notice)
                }
                watched[kindId] = nil
            } else {
                watched[kindId] = seen.union(unsettled.map(\.id))
            }
        }
        let changed = (try? ledger.change { contents -> Bool in
            var changed = false
            for index in contents.files.indices where already.contains(contents.files[index].id) && contents.files[index].state != .already {
                contents.files[index].state = .already
                contents.files[index].why = nil
                changed = true
            }
            let before = contents.files.count
            contents.files.removeAll { gone.contains($0.id) && $0.state == .sent }
            return changed || contents.files.count < before
        }) ?? false
        if changed { tell() }
        for notice in notices { world.notify(notice.title, notice.body) }
    }

    nonisolated static func settled(_ held: HomeLink.Import.Held) -> Bool {
        held.ask == nil && held.health.reason != .choose && (held.health.state == .ok || held.health.state == .needsYou)
    }


    private var holdsAny: Bool { ((try? ledger.read())?.files ?? []).isEmpty == false }

    func tell() {
        guard let contents = try? ledger.read() else { return }
        let sending = Set(contents.files.filter { $0.state == .sending }.map(\.id))
        sentBytes = sentBytes.filter { sending.contains($0.key) }
        world.tell(Self.facts(contents, sent: sentBytes))
        publishBackups(contents.backups ?? [:])
    }

    func moved(_ id: String, bytes: Int64) {
        sentBytes[id] = bytes
        tell()
    }

    nonisolated static func facts(_ contents: ImportLedger.Contents, sent: [String: Int64] = [:]) -> [MacImport] {
        var order: [String] = []
        var files: [String: [MacImport.File]] = [:]
        for record in contents.files {
            if files[record.kind] == nil { order.append(record.kind) }
            files[record.kind, default: []].append(MacImport.File(
                id: record.id, name: record.backup == nil ? record.name : BackupReading.words(record.name), bytes: record.waitBytes,
                state: MacImport.File.State(rawValue: record.state.rawValue) ?? .checking,
                why: record.why.flatMap { MacImport.File.Why(rawValue: $0.rawValue) }, sha256: record.sha256, seal: record.seal,
                pass: record.seal == nil ? nil : record.pass, sentBytes: record.state == .sending ? sent[record.id] : nil))
        }
        return order.map { MacImport(kind: $0, files: files[$0] ?? []) }
    }
}


extension Imports {

    nonisolated static func backupId(_ folder: BackupFolder) -> String {
        "\(folder.udid)-\(UTCInstant.basic(folder.lastBackup).replacingOccurrences(of: ".000", with: ""))"
    }

    func prune() {
        do { try ledger.prune() } catch {
            Self.log.error("imports: the backups' prune: \(String(describing: error), privacy: .public)")
        }
    }

    @discardableResult
    func listBackups() -> Task<Void, Never> {
        guard let backups = world.backups else { return Task {} }
        if let listing { return listing }
        let task = Task {
            let found = await Task.detached(priority: .userInitiated) { () -> (BackupList.State, [BackupFolder]) in
                var access = BackupList.State.listed
                var urls: [URL] = []
                var isFolder: ObjCBool = false
                if FileManager.default.fileExists(atPath: backups.root.path, isDirectory: &isFolder), isFolder.boolValue {
                    do {
                        urls = try FileManager.default.contentsOfDirectory(at: backups.root, includingPropertiesForKeys: nil)
                    } catch {
                        access = .noAccess
                    }
                } else {
                    access = .none
                }
                var folders: [BackupFolder] = []
                for url in urls where FileManager.default.fileExists(atPath: url.appendingPathComponent("Manifest.plist").path) {
                    guard let folder = try? BackupFolder(at: url) else { continue }
                    folders.append(folder)
                }
                return (access, folders.sorted { $0.lastBackup > $1.lastBackup })
            }.value
            listedAccess = found.0
            listed = found.1
            listing = nil
            publishBackups()
        }
        listing = task
        return task
    }

    func readBackup(_ id: String, password: BackupPassword) async throws {
        guard let backups = world.backups else { throw HostRefusal("Lifestream on this Mac reads no iPhone backups.") }
        guard pulls[id] == nil, reads[id]?.read != .opening else { throw HostRefusal("Lifestream is reading that backup now.") }
        guard let url = listed.first(where: { Self.backupId($0) == id })?.url, let folder = try? BackupFolder(at: url),
              Self.backupId(folder) == id else {
            listBackups()
            throw HostRefusal("That backup is no longer on this Mac.")
        }
        guard folder.finished else { throw HostRefusal("Your iPhone is still backing up. Read it when it's done.") }
        guard (try? ledger.read())?.backups?[id]?.owed != true else {
            throw HostRefusal("That backup is on its way to Lifestream.")
        }
        let work: URL
        do { work = try SealWork.directory(prefix: "backup-", in: backups.scratch) } catch {
            throw HostRefusal("Lifestream couldn't read that backup.")
        }
        reads[id] = BackupReading(read: .opening)
        publishBackups()
        let destination = ledger.backupFolder(id)
        ledger.pulling([destination])
        let opened: OpenBackup?
        do {
            opened = try await Self.open(folder, password: password, work: work)
        } catch {
            try? FileManager.default.removeItem(at: work)
            ledger.pulled([destination])
            reads[id] = nil
            publishBackups()
            switch error {
            case BackupError.notFinished: throw HostRefusal("Your iPhone is still backing up. Read it when it's done.")
            default: throw HostRefusal("Lifestream couldn't read that backup.")
            }
        }
        guard let opened, !stopped else {
            try? FileManager.default.removeItem(at: work)
            ledger.pulled([destination])
            reads[id] = nil
            publishBackups()
            return
        }
        reads[id] = BackupReading(read: .reading)
        publishBackups()
        pulls[id] = Task { await pull(opened, id: id, world: backups, work: work, into: destination) }
    }

    func backupRead(_ id: String) async {
        await pulls[id]?.value
    }

    nonisolated private static func open(_ folder: BackupFolder, password: BackupPassword, work: URL) async throws -> OpenBackup? {
        @Sendable func attempt(_ typed: String?) async throws -> OpenBackup {
            try await Task.detached(priority: .userInitiated) { try OpenBackup(folder, password: typed, work: work) }.value
        }
        guard folder.encrypted else { return try await attempt(nil) }
        if let saved = await password.saved(folder.udid) {
            do { return try await attempt(saved) } catch BackupError.wrongPassword {}
        }
        var wrong = false
        while let typed = await password.ask(wrong) {
            do { return try await attempt(typed) } catch BackupError.wrongPassword, BackupError.passwordNeeded { wrong = true }
        }
        return nil
    }

    private func pull(_ backup: OpenBackup, id: String, world backups: BackupWorld, work: URL, into destination: URL) async {
        defer {
            try? FileManager.default.removeItem(at: work)
            ledger.pulled([destination])
            pulls[id] = nil
        }
        let homeFree = world.homeFree
        let asks = BackupPull.Asks(
            held: { [weak self] hexes in
                var waited = false
                while true {
                    do {
                        let held = try await backups.held(hexes)
                        if waited { await self?.waiting(id, why: nil) }
                        return held
                    } catch where !(error is CancellationError) {
                        if !waited {
                            waited = true
                            await self?.waiting(id, why: "home")
                        }
                        try await backups.pause()
                        try Task.checkCancellation()
                    }
                }
            },
            room: { [weak self] ask in
                let bytes: Int64 = switch ask {
                case .stores(let bytes), .media(let bytes): bytes
                }
                var waited = false
                while !backups.disk.fits(.later, bytes: bytes) {
                    if !waited {
                        waited = true
                        await self?.waiting(id, why: "room", needs: bytes + Room.keepBytes)
                    }
                    try await backups.pause()
                    try Task.checkCancellation()
                }
                if waited { await self?.waiting(id, why: nil) }
            },
            most: { homeFree.most() ?? ImportFiles.doorMost },
            progress: { [weak self] progress in Task { @MainActor in self?.progressed(id, progress) } })
        let outcome: Result<BackupPull.Result, Error>
        do {
            outcome = .success(try await BackupPull(backup, into: destination, scratch: work, files: ledger.files, asks: asks).run())
        } catch {
            outcome = .failure(error)
        }
        switch outcome {
        case .success(let result) where !result.pulled.isEmpty || !result.unreadable.isEmpty || !result.tooLarge.isEmpty:
            handOver(result, id: id)
        case .success:
            reads[id] = BackupReading(read: .stopped)
        case .failure(BackupError.remade):
            reads[id] = BackupReading(read: .stopped, why: "remade")
        case .failure(let error) where error is CancellationError:
            reads[id] = nil
        case .failure(let error):
            Self.log.error("imports: a backup's read: \(String(describing: error), privacy: .public)")
            reads[id] = BackupReading(read: .stopped)
        }
        publishBackups()
    }

    private func handOver(_ result: BackupPull.Result, id: String) {
        let stores = result.pulled.map { pulled in
            (folder: pulled.folder, blobs: pulled.blobs.map {
                ImportLedger.Blob(path: BackupPull.blob($0.sha256, in: result.blobs, files: ledger.files).path, sha256: $0.sha256, bytes: $0.bytes)
            })
        }
        var left: [String: ImportLedger.Outcome] = [:]
        for store in result.unreadable.keys { left[store.rawValue] = .unreadable }
        for store in result.tooLarge { left[store.rawValue] = .tooLarge }
        let records: [ImportLedger.Record]
        do {
            records = try ledger.handOver(backup: id, stores: stores, left: left, kind: Self.backupKind, at: world.clock())
        } catch {
            try? FileManager.default.removeItem(at: result.blobs.deletingLastPathComponent())
            Self.log.error("imports: a backup's hand-over: \(String(describing: error), privacy: .public)")
            reads[id] = BackupReading(read: .stopped)
            return
        }
        reads[id] = nil
        tell()
        guard !records.isEmpty else { return }
        Task {
            if !marked {
                marked = true
                await world.mark()
            }
            await check(records)
        }
    }

    private func waiting(_ id: String, why: String?, needs: Int64? = nil) {
        guard reads[id]?.read == .reading else { return }
        reads[id]?.why = why
        reads[id]?.needBytes = needs
        publishBackups()
    }

    private func progressed(_ id: String, _ progress: BackupPull.Progress) {
        guard reads[id]?.read == .reading else { return }
        reads[id]?.doing = BackupReading.words(progress.store)
        reads[id]?.done = progress.hashed
        reads[id]?.of = progress.indexed
        publishBackups()
    }

    private func publishBackups(_ brought: [String: ImportLedger.Backup]? = nil) {
        guard world.backups != nil else { return }
        if let brought { self.brought = brought }
        if self.brought == nil { self.brought = (try? ledger.read())?.backups ?? [:] }
        let brought = self.brought ?? [:]
        let rows = listed.map { folder -> BackupList.Row in
            let id = Self.backupId(folder)
            let live = reads[id]
            let entry = live == nil ? brought[id] : nil
            let read: BackupList.Row.Read
            if let live {
                read = live.read
            } else if let entry {
                read = entry.owed ? .sending : entry.stores.values.contains(.sent) ? .in : .stopped
            } else {
                read = .unread
            }
            let left = read == .sending ? [] : BackupPull.Store.allCases.compactMap { store -> BackupList.Row.Left? in
                guard let outcome = entry?.stores[store.rawValue], let why = BackupList.Row.Left.Why(outcome) else { return nil }
                return BackupList.Row.Left(store: BackupReading.words(store), why: why)
            }
            return BackupList.Row(id: id, name: folder.name, madeMs: Self.ms(folder.lastBackup),
                                  encrypted: folder.encrypted, finished: folder.finished, read: read,
                                  inMs: read == .in || read == .sending ? entry.map { Self.ms($0.at) } : nil,
                                  doing: read == .reading ? live?.doing : nil, done: read == .reading ? live?.done : nil,
                                  of: read == .reading ? live?.of : nil, why: live?.why,
                                  needBytes: live?.why == "room" ? live?.needBytes : nil, left: left)
        }
        let state: BackupList.State = listedAccess == .noAccess ? .noAccess : rows.isEmpty ? .none : .listed
        let next = BackupList(state: state, rows: rows)
        if next != backups { backups = next }
    }

    nonisolated private static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }
}

struct BackupList: Encodable, Equatable {
    enum State: String, Encodable {
        case listed, none
        case noAccess = "no-access"
    }

    let state: State
    let rows: [Row]

    struct Row: Encodable, Equatable {
        enum Read: String, Encodable {
            case unread, opening, reading, sending, `in`, stopped
        }

        struct Left: Encodable, Equatable {
            enum Why: String, Encodable {
                case unreadable
                case tooLarge = "too-large"
                case lost

                init?(_ outcome: ImportLedger.Outcome) {
                    switch outcome {
                    case .unreadable: self = .unreadable
                    case .tooLarge: self = .tooLarge
                    case .lost: self = .lost
                    case .owed, .sent: return nil
                    }
                }
            }

            let store: String
            let why: Why
        }

        let id: String
        let name: String
        let madeMs: Int64
        let encrypted: Bool
        let finished: Bool
        let read: Read
        let inMs: Int64?
        let doing: String?
        let done: Int?
        let of: Int?
        let why: String?
        var needBytes: Int64? = nil
        var left: [Left] = []

        private enum CodingKeys: String, CodingKey {
            case id, name, encrypted, finished, read, doing, done, of, why, left
            case madeMs = "made_ms"
            case inMs = "in_ms"
            case needBytes = "need_bytes"
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(id, forKey: .id)
            try container.encode(name, forKey: .name)
            try container.encode(madeMs, forKey: .madeMs)
            try container.encode(encrypted, forKey: .encrypted)
            try container.encode(finished, forKey: .finished)
            try container.encode(read, forKey: .read)
            try container.encode(inMs, forKey: .inMs)
            try container.encode(doing, forKey: .doing)
            try container.encode(done, forKey: .done)
            try container.encode(of, forKey: .of)
            try container.encode(why, forKey: .why)
            try container.encode(needBytes, forKey: .needBytes)
            try container.encode(left, forKey: .left)
        }
    }
}

struct BackupReading: Equatable {
    var read: BackupList.Row.Read
    var doing: String?
    var done: Int?
    var of: Int?
    var why: String?
    var needBytes: Int64?

    static func words(_ store: BackupPull.Store) -> String {
        switch store {
        case .imessage: return "iMessage"
        case .whatsapp: return "WhatsApp"
        case .appleCalls: return "Calls"
        }
    }

    static func words(_ folder: String) -> String {
        BackupPull.Store(rawValue: folder).map(words) ?? folder
    }
}

extension Imports.World {
    @MainActor static func live(link: HomeLink, files: DeviceFiles, scratch: URL, ship: @escaping @MainActor () -> Void, homeFree: HomeFree,
                                disk: Volume) -> Imports.World {
        let state = ShippingState(root: ShippingState.defaultRoot, files: files)
        return Imports.World(
            carried: state.carriedDirectory, files: state.files, clock: { Date() }, ship: ship,
            report: { try? await HomeSocket.linked { link }.map(ConnectorsHome.init(socket:))?.report() },
            notify: posting(NotificationGrant.post),
            homeFree: homeFree, tell: { link.tell(imports: $0) },
            looked: { try? await link.held(imports: $0) },
            mark: {
                guard let unit = link.unit, let socket = await HomeSocket.linked({ link }) else { return }
                try? await ConnectorsHome(socket: socket).skip(unit: unit, step: "imports")
            },
            backups: Imports.BackupWorld(
                root: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/MobileSync/Backup", isDirectory: true),
                scratch: scratch,
                held: { hexes in
                    let held = try await link.held(blobs: Set(hexes.map { "sha256:" + $0 }))
                    return Set(held.map { String($0.dropFirst("sha256:".count)) })
                },
                disk: disk, pause: { try await Task.sleep(for: .seconds(60)) }))
    }

    @MainActor static func posting(_ post: @escaping @MainActor (UNNotificationRequest) async -> Void) -> @MainActor (String, String) -> Void {
        var last: Task<Void, Never>?
        return { title, body in
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            let request = UNNotificationRequest(identifier: "import-\(UUID().uuidString)", content: content, trigger: nil)
            let before = last
            last = Task { @MainActor in
                await before?.value
                await post(request)
            }
        }
    }
}

final class ImportsHeard: @unchecked Sendable {
    @MainActor weak var imports: Imports?

    var told: ImportTold {
        ImportTold(changed: { [self] in Task { @MainActor in imports?.tell() } },
                   sent: { [self] id, bytes in Task { @MainActor in imports?.moved(id, bytes: bytes) } })
    }
}
