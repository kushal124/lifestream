import DeviceFiles
import Foundation
import InputEvents
import Audio
import Evidence
import PhotoLibrary

public enum ShippingDomains {
    public struct Paths: Sendable {
        public let home: URL
        public let machineEventsRoot: URL
        public let inputEventsRoot: URL
        public let screenSpoolRoot: URL?
        public let audioRoot: URL
        public let hashCacheDirectory: URL
        public let ledgers: Ledgers
        public let sessionDirectory: URL
        public let uploadFolder: URL?
        public let appleAccounts: URL?
        private let fullDiskAccessWitness: URL?
        public let photosRoot: URL?
        public let photosAllowed: @Sendable () -> Bool
        public let carriedDirectory: URL?
        public let importRoom: ImportRoom
        public let importTold: ImportTold

        public init(home: URL, machineEventsRoot: URL, inputEventsRoot: URL, audioRoot: URL, hashCacheDirectory: URL, ledgers: Ledgers,
                    sessionDirectory: URL, screenSpoolRoot: URL? = nil, uploadFolder: URL? = nil, appleAccounts: URL? = nil,
                    fullDiskAccessWitness: URL? = nil, photosRoot: URL? = nil,
                    photosAllowed: @escaping @Sendable () -> Bool = { false }, carriedDirectory: URL? = nil,
                    importRoom: ImportRoom, importTold: ImportTold = .nobody) {
            self.home = home
            self.machineEventsRoot = machineEventsRoot
            self.inputEventsRoot = inputEventsRoot
            self.screenSpoolRoot = screenSpoolRoot
            self.audioRoot = audioRoot
            self.hashCacheDirectory = hashCacheDirectory
            self.ledgers = ledgers
            self.sessionDirectory = sessionDirectory
            self.uploadFolder = uploadFolder
            self.appleAccounts = appleAccounts
            self.fullDiskAccessWitness = fullDiskAccessWitness
            self.photosRoot = photosRoot
            self.photosAllowed = photosAllowed
            self.carriedDirectory = carriedDirectory
            self.importRoom = importRoom
            self.importTold = importTold
        }

        public var fullDiskAccess: Bool { fullDiskAccessWitness.map(ShippingDomains.fullDiskAccess(witness:)) ?? false }

        public func stores(applications: [URL] = ShippingDomains.applicationFolders, lifestream: @escaping @Sendable () -> [URL],
                           wake: @escaping @Sendable (String) -> Void = StoreWake.launchHidden) -> DeclaredStores.Mac {
            let witness = fullDiskAccessWitness
            return DeclaredStores.Mac(home: home, lifestream: lifestream, applications: applications,
                                      fullDiskAccess: { witness.map(ShippingDomains.fullDiskAccess(witness:)) ?? false }, wake: wake,
                                      ledgers: ledgers, hashCacheDirectory: hashCacheDirectory, sessionDirectory: sessionDirectory)
        }
    }

    public static func conventional(spool: URL, importRoom: ImportRoom, importTold: ImportTold = .nobody,
                                    files: DeviceFiles) -> Paths {
        conventional(home: FileManager.default.homeDirectoryForCurrentUser, spool: spool,
                     fullDiskAccessWitness: fullDiskAccessWitness, photosAllowed: { PhotoLibrary().access.reads }, importRoom: importRoom,
                     importTold: importTold, files: files)
    }

    public static func conventional(home: URL, spool: URL, fullDiskAccessWitness: URL,
                                    photosAllowed: @escaping @Sendable () -> Bool, importRoom: ImportRoom,
                                    importTold: ImportTold = .nobody, files: DeviceFiles) -> Paths {
        let state = ShippingState(root: ShippingState.root(home: home), files: files)
        return Paths(home: home,
                     machineEventsRoot: spool.appendingPathComponent("machine-events", isDirectory: true),
                     inputEventsRoot: spool.appendingPathComponent(InputEventBatch.directoryName, isDirectory: true),
                     audioRoot: spool.appendingPathComponent(AudioSpool.directoryName, isDirectory: true),
                     hashCacheDirectory: state.hashCacheDirectory,
                     ledgers: state.ledgers,
                     sessionDirectory: state.sessionDirectory,
                     screenSpoolRoot: spool,
                     uploadFolder: UploadDomain.folder(home: home),
                     appleAccounts: home.appendingPathComponent("Library/Preferences/MobileMeAccounts.plist"),
                     fullDiskAccessWitness: fullDiskAccessWitness,
                     photosRoot: state.photosDirectory,
                     photosAllowed: photosAllowed,
                     carriedDirectory: state.carriedDirectory,
                     importRoom: importRoom, importTold: importTold)
    }

    public static func build(_ sources: [String], paths: Paths, stores: DeclaredStores) -> [any ShippingDomain] {
        let photos = photosAccounts(paths: paths)
        return sources.compactMap { source -> (any ShippingDomain)? in
            let product = String(product(of: source))
            if product == "apple-photos", !photos.contains(account(of: source)) { return nil }
            if let recorder = recorders[product] { return recorder(source, paths) }
            return stores.domain(for: source)
        }
    }

    static let recorders: [String: @Sendable (String, Paths) -> (any ShippingDomain)?] = [
        "machine": { source, paths in MachineEventsDomain(sourceId: source, batchRoot: paths.machineEventsRoot, ledgers: paths.ledgers) },
        "screen": { source, paths in
            guard let spool = paths.screenSpoolRoot else { return nil }
            return ScreenSpoolDomain(sourceId: source, spoolRoot: spool, ledgers: paths.ledgers)
        },
        "input": { source, paths in InputEventsDomain(sourceId: source, batchRoot: paths.inputEventsRoot, ledgers: paths.ledgers) },
        "audio": { source, paths in AudioDomain(sourceId: source, root: paths.audioRoot, ledgers: paths.ledgers) },
        "apple-photos": { source, paths in
            guard let root = paths.photosRoot else { return nil }
            return PhotosDomain(sourceId: source, root: root, ledgers: paths.ledgers)
        },
        "upload": { source, paths in
            let room = paths.importRoom
            let folder = paths.uploadFolder.map {
                UploadDomain(sourceId: source, folder: $0, hashCache: hashCacheFile(source, in: paths), ledgers: paths.ledgers,
                             disk: room.disk)
            }
            let imports = paths.carriedDirectory.map {
                ImportShipping(sourceId: source, ledger: .in($0, files: paths.ledgers.files, written: paths.importTold.changed), ledgers: paths.ledgers, room: room,
                               told: paths.importTold)
            }
            guard folder != nil || imports != nil else { return nil }
            return UploadLane(sourceId: source, folder: folder, imports: imports)
        },
    ]

    public static func photos(in sources: [String], paths: Paths) -> PhotosDomain? {
        let accounts = photosAccounts(paths: paths)
        guard let library = sources.filter({ product(of: $0) == "apple-photos" && accounts.contains(account(of: $0)) }).sorted().first,
              let root = paths.photosRoot else { return nil }
        return PhotosDomain(sourceId: library, root: root, ledgers: paths.ledgers)
    }

    public static func product(of source: String) -> Substring {
        source.prefix { $0 != ":" }
    }

    public static func connector(of source: String, stores: DeclaredStores?) -> String {
        stores?.connector(of: source) ?? String(product(of: source))
    }

    static func account(of source: String) -> String {
        let parts = source.split(separator: ":", omittingEmptySubsequences: false)
        return parts.count >= 3 ? parts[1...(parts.count - 2)].joined(separator: ":") : ""
    }

    public static func offers(unit: String, paths: Paths, stores: DeclaredStores) -> [String] {
        guard !unit.isEmpty else { return [] }
        return (stores.offers(unit: unit) + photosAccounts(paths: paths).map { "apple-photos:\($0):\(unit)" }).sorted()
    }

    static func photosAccounts(paths: Paths) -> [String] {
        guard paths.photosRoot != nil, paths.photosAllowed() else { return [] }
        switch paths.appleAccounts.map(MacAccounts.appleID) ?? .none {
        case .none: return ["local"]
        case .account(let account): return [account]
        case .unknown: return []
        }
    }

    public static func found(stores: DeclaredStores) -> [String] {
        (Array(recorders.keys) + stores.found()).sorted()
    }

    public static func appleID(list: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Preferences/MobileMeAccounts.plist")) -> String? {
        if case .account(let id) = MacAccounts.appleID(list) { return id }
        return nil
    }

    public static let applicationFolders: [URL] = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [URL(fileURLWithPath: "/Applications"), home.appendingPathComponent("Applications"),
                URL(fileURLWithPath: "/System/Applications"),
                URL(fileURLWithPath: "/System/Volumes/Preboot/Cryptexes/App/System/Applications"),
                URL(fileURLWithPath: "/System/Library/CoreServices/Applications")]
    }()

    public static let fullDiskAccessWitness = URL(fileURLWithPath: "/Library/Application Support/com.apple.TCC/TCC.db")

    public static func fullDiskAccess(witness: URL) -> Bool {
        let descriptor = open(witness.path, O_RDONLY)
        if descriptor >= 0 { close(descriptor) }
        return descriptor >= 0
    }

    static func hashCacheFile(_ sourceId: String, in paths: Paths) -> URL {
        paths.hashCacheDirectory.appendingPathComponent(paths.ledgers.fileName(forSource: sourceId) + ".json")
    }
}
