import CryptoKit
import Foundation
import HomeLink
import ImageIO
import LifestreamCaptureCore
import UIKit

@MainActor
final class AskOutbox: ObservableObject {
    static let shared = AskOutbox(folder: AskOutbox.home, stage: { try await AppRuntime.shared.life.stage(photo: $0) }, notes: .app,
                                  here: { AppRuntime.shared.life.home })

    struct Photo: Codable, Equatable, Identifiable {
        let id: String
        let digest: String
        let ext: String
        let bytes: Int
        let home: String
        var state: State

        enum State: Codable, Equatable {
            case uploading
            case staged(String)
            case refused(Int, String)
            case tooLarge
        }
    }

    struct Entry: Codable, Equatable, Identifiable {
        let submission: String
        var chat: String?
        let key: String
        let home: String
        let words: String?
        var photos: [String]
        var voice: HomeLink.Ask.Question.Voice? = nil
        var voiceMs: Int? = nil
        let pick: HomeLink.Ask.Pick?
        var level: HomeLink.Ask.Level? = nil
        let atMs: Int64
        var failed: String? = nil
        var again: HomeLink.Ask.Outcome.Again? = nil
        var id: String { submission }
    }

    struct Note: Codable, Equatable {
        let id: String
        let home: String
        var seconds: Int
        var posted: Set<Int>
        var ms: Int?
        var levels: [Double]
    }

    struct NoteRoutes {
        let open: @MainActor (String) async throws -> Void
        let second: @MainActor (String, Int, URL) async throws -> Void
        let cancel: @MainActor (String) async throws -> Void

        static var app: NoteRoutes {
            NoteRoutes(open: { try await AppRuntime.shared.life.openNote($0) },
                       second: { try await AppRuntime.shared.life.sendSecond(note: $0, $1, file: $2) },
                       cancel: { try await AppRuntime.shared.life.cancelNote($0) })
        }
    }

    struct Refused: Error, Equatable {
        let status: Int
        let words: String
        var photo = false
    }

    struct Unkept: Error, Equatable {}

    static let unkept = "Couldn't keep your question on this iPhone, so it wasn't sent. Free some space and send it again."

    private struct Kept: Codable {
        var photos: [Photo]
        var notes: [Note]
        var cancels: [String]
    }

    @Published private(set) var photos: [String: Photo] = [:]
    @Published private(set) var entries: [Entry] = []
    @Published private(set) var notes: [String: Note] = [:]
    @Published private(set) var cancels: Set<String> = []
    @Published private(set) var thumbnails: [String: UIImage] = [:]
    private var posting: Set<String> = []
    private var uploading: [String: Task<Void, Never>] = [:]
    private var sending: [String: Task<Void, Error>] = [:]
    private var cancelling: Set<String> = []
    private var live: String?
    private var started = false
    let folder: URL
    private let stage: @MainActor (URL) async throws -> HomeLink.Ask.Staged
    private let routes: NoteRoutes
    private let here: @MainActor () -> String?

    static func tooLarge(_ limits: HomeLink.Ask.Ready.Limits) -> String {
        "Too large to send: over \(limits.photoBytes / (1024 * 1024)) MB."
    }

    static var home: URL {
        AppRuntime.supportRoot.appendingPathComponent("chat-outbox", isDirectory: true)
    }

    init(folder: URL, stage: @escaping @MainActor (URL) async throws -> HomeLink.Ask.Staged, notes: NoteRoutes,
         here: @escaping @MainActor () -> String?) {
        self.folder = folder
        self.stage = stage
        routes = notes
        self.here = here
        load()
    }

    private var current: String { here() ?? "" }


    func file(_ id: String) -> URL? {
        photos[id].map { folder.appendingPathComponent("photos/\($0.id).\($0.ext)") }
    }

    func pick(_ data: Data, ext: String, holding held: [String], limits: HomeLink.Ask.Ready.Limits) -> String? {
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        if held.contains(where: { photos[$0]?.digest == digest }) { return nil }
        let id = HomeLink.Ask.mint()
        let large = data.count > limits.photoBytes
        let photo = Photo(id: id, digest: digest, ext: ext.lowercased(), bytes: data.count, home: current, state: large ? .tooLarge : .uploading)
        thumbnails[id] = Self.thumbnail(data)
        photos[id] = photo
        do {
            if !large {
                try FileManager.default.createDirectory(at: folder.appendingPathComponent("photos"), withIntermediateDirectories: true)
                try data.write(to: folder.appendingPathComponent("photos/\(id).\(photo.ext)"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
            try save()
        } catch {
            if let file = file(id) { try? FileManager.default.removeItem(at: file) }
            photos[id]?.state = .refused(507, "Couldn't keep this picture on your iPhone.")
            return id
        }
        if !large { upload(id) }
        return id
    }

    func remove(_ id: String) {
        guard entries.allSatisfy({ !$0.photos.contains(id) }) else { return }
        forget(photo: id)
        try? save()
    }

    private func forget(photo id: String) {
        uploading.removeValue(forKey: id)?.cancel()
        if let file = file(id) { try? FileManager.default.removeItem(at: file) }
        thumbnails[id] = nil
        photos[id] = nil
    }

    func name(_ id: String) -> String? {
        if case .staged(let name)? = photos[id]?.state { name } else { nil }
    }

    func refusal(_ ids: [String], limits: HomeLink.Ask.Ready.Limits?) -> String? {
        refused(ids, limits: limits, in: photos)?.words
    }

    private func refused(_ ids: [String], limits: HomeLink.Ask.Ready.Limits?, in held: [String: Photo]) -> Refused? {
        for id in ids {
            switch held[id]?.state {
            case .refused(let status, let words)?: return Refused(status: status, words: words, photo: true)
            case .tooLarge?: return Refused(status: 413, words: limits.map(Self.tooLarge) ?? "Too large to send.", photo: true)
            default: continue
            }
        }
        return nil
    }

    private func upload(_ id: String) {
        guard let file = file(id), uploading[id] == nil else { return }
        uploading[id] = Task { [weak self] in
            do {
                let staged = try await self?.stage(file)
                guard !Task.isCancelled, let staged else { return }
                self?.landed(id, .staged(staged.file))
            } catch let refused as Refused {
                if !Task.isCancelled { self?.landed(id, .refused(refused.status, refused.words)) }
            } catch {}
            if !Task.isCancelled { self?.uploading[id] = nil }
        }
    }

    private func landed(_ id: String, _ state: Photo.State) {
        guard var photo = photos[id] else { return }
        photo.state = state
        photos[id] = photo
        try? save()
    }

    func retry() {
        for photo in photos.values where photo.state == .uploading && photo.home == current { upload(photo.id) }
        for note in cancels { letGo(note) }
    }

    func files(_ ids: [String], limits: HomeLink.Ask.Ready.Limits?) async throws -> [String] {
        for await held in $photos.values {
            try Task.checkCancellation()
            if ids.contains(where: { held[$0]?.state == .uploading }) { continue }
            if let refused = refused(ids, limits: limits, in: held) { throw refused }
            return ids.compactMap { id in
                if id.hasPrefix("sha256:") { return id }
                if case .staged(let name)? = held[id]?.state { return name }
                return nil
            }
        }
        throw CancellationError()
    }

    func missing(_ names: [String], of ids: [String]) {
        for id in ids {
            guard case .staged(let name)? = photos[id]?.state, names.contains(name) else { continue }
            landed(id, .uploading)
            upload(id)
        }
    }


    func file(note: String, _ k: Int) -> URL {
        folder.appendingPathComponent("notes/\(note)/\(k).pcm")
    }

    func open(note: String) -> Bool {
        notes[note] = Note(id: note, home: current, seconds: 0, posted: [], ms: nil, levels: [])
        do {
            try FileManager.default.createDirectory(at: folder.appendingPathComponent("notes/\(note)"), withIntermediateDirectories: true)
            try save()
        } catch {
            notes[note] = nil
            return false
        }
        live = note
        let routes = routes
        Task { try? await routes.open(note) }
        return true
    }

    func second(note: String, _ k: Int, _ pcm: Data) -> Bool {
        guard var held = notes[note] else { return false }
        do {
            try pcm.write(to: file(note: note, k), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            let was = held
            held.seconds = max(held.seconds, k + 1)
            notes[note] = held
            do {
                try save()
            } catch {
                notes[note] = was
                throw error
            }
        } catch {
            return false
        }
        _ = post(note, k)
        return true
    }

    func close(note: String, ms: Int, levels: [Double]) -> Bool {
        guard var held = notes[note] else { return false }
        let was = held
        held.ms = ms
        held.levels = levels
        notes[note] = held
        do {
            try save()
        } catch {
            notes[note] = was
            return false
        }
        if live == note { live = nil }
        return true
    }

    func cancel(note: String) {
        if live == note { live = nil }
        cancels.insert(note)
        forget(note: note)
        letGo(note)
    }

    private func letGo(_ note: String) {
        guard cancels.contains(note), cancelling.insert(note).inserted else { return }
        let routes = routes
        Task { [weak self] in
            var answered = true
            do {
                try await routes.cancel(note)
            } catch let failure as LifeReader.Failure {
                switch failure {
                case .refused, .missing: break
                default: answered = false
                }
            } catch {
                answered = false
            }
            guard let self else { return }
            cancelling.remove(note)
            if answered {
                cancels.remove(note)
                try? save()
            }
        }
    }

    func sound(_ note: String) -> Data? {
        notes[note].map(joined)
    }

    func seconds(_ note: String) async throws {
        guard let held = notes[note] else { return }
        for k in 0..<held.seconds where !(notes[note]?.posted.contains(k) ?? true) {
            try await post(note, k).value
        }
    }

    func missing(seconds: [Int], of note: String) {
        guard var held = notes[note] else { return }
        held.posted.subtract(seconds)
        notes[note] = held
        try? save()
    }

    private func post(_ note: String, _ k: Int) -> Task<Void, Error> {
        let key = "\(note)/\(k)"
        if let going = sending[key] { return going }
        let file = file(note: note, k)
        let routes = routes
        let task = Task { @MainActor [weak self] in
            defer { self?.sending[key] = nil }
            do {
                try await routes.second(note, k, file)
            } catch LifeReader.Failure.refused(_) {
            }
            self?.answered(note, k)
        }
        sending[key] = task
        return task
    }

    private func answered(_ note: String, _ k: Int) {
        guard var held = notes[note], !held.posted.contains(k) else { return }
        held.posted.insert(k)
        notes[note] = held
        try? save()
    }

    private func forget(note: String) {
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("notes/\(note)"))
        notes[note] = nil
        try? save()
    }

    private func joined(_ note: Note) -> Data {
        ChatAudio.wav((0..<note.seconds).reduce(into: Data()) { pcm, k in
            if let second = try? Data(contentsOf: file(note: note.id, k)) { pcm.append(second) }
        })
    }


    func keep(words: String?, photos ids: [String], voice: HomeLink.Ask.Question.Voice? = nil, voiceMs: Int? = nil, key: String,
              chat: String?, pick: HomeLink.Ask.Pick?, level: HomeLink.Ask.Level? = nil) throws -> Entry {
        let entry = Entry(submission: HomeLink.Ask.mint(), chat: chat, key: key, home: current, words: words, photos: ids, voice: voice,
                          voiceMs: voiceMs, pick: pick, level: level, atMs: Int64((AppClock.now.timeIntervalSince1970 * 1000).rounded()))
        do {
            try write(entry)
        } catch {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(entry.submission))
            throw Unkept()
        }
        entries.append(entry)
        return entry
    }

    func posting(_ submission: String) -> Bool {
        posting.insert(submission).inserted
    }

    func done(_ submission: String) {
        posting.remove(submission)
    }

    @discardableResult
    func settle(_ submission: String?, _ answer: HomeLink.Ask.Answer, in phase: HomeLink.Ask.Phase, words: String? = nil) -> HomeLink.Ask.Outcome {
        let outcome = HomeLink.Ask.Outcome.of(answer, in: phase)
        guard let submission, let index = entries.firstIndex(where: { $0.submission == submission }) else { return outcome }
        switch outcome.copies {
        case .drop:
            letGo(entries[index])
        case .keep:
            let failed = outcome.turn == .failed ? words ?? "" : nil
            let again = failed == nil ? nil : outcome.again
            if entries[index].failed != failed || entries[index].again != again {
                entries[index].failed = failed
                entries[index].again = again
                try? write(entries[index])
            }
        case .purge, .noneHeld:
            break
        }
        return outcome
    }

    func again(_ submission: String) {
        guard let index = entries.firstIndex(where: { $0.submission == submission }), entries[index].failed != nil,
              entries[index].again == .same else { return }
        entries[index].failed = nil
        entries[index].again = nil
        try? write(entries[index])
        for id in entries[index].photos {
            guard case .refused? = photos[id]?.state else { continue }
            landed(id, .uploading)
            upload(id)
        }
    }

    @discardableResult
    func unrefuse(_ submission: String) -> [String] {
        guard let index = entries.firstIndex(where: { $0.submission == submission }), entries[index].again == .photoRemoved else { return [] }
        let refused = entries[index].photos.filter { id in
            switch photos[id]?.state {
            case .refused(let status, _)?: status < 500
            case .tooLarge?: true
            default: false
            }
        }
        entries[index].photos.removeAll { refused.contains($0) }
        entries[index].again = .same
        try? write(entries[index])
        for id in refused { forget(photo: id) }
        try? save()
        return refused
    }

    func withdraw(_ submission: String) {
        guard let entry = entries.first(where: { $0.submission == submission }) else { return }
        letGo(entry)
    }

    private func letGo(_ entry: Entry) {
        entries.removeAll { $0.submission == entry.submission }
        try? FileManager.default.removeItem(at: folder.appendingPathComponent(entry.submission))
        for id in entry.photos where photos[id] != nil { forget(photo: id) }
        if case .note(let note, _)? = entry.voice { forget(note: note) }
        try? save()
    }

    var waiting: [Entry] { held.filter { $0.failed == nil && !posting.contains($0.submission) } }

    var held: [Entry] { entries.filter { $0.home == current } }

    func purge(chat: String?, key: String) {
        for entry in entries where (entry.chat != nil && entry.chat == chat) || entry.key == key { letGo(entry) }
    }

    func purge() {
        for going in uploading.values { going.cancel() }
        uploading = [:]
        for entry in entries { try? FileManager.default.removeItem(at: folder.appendingPathComponent(entry.submission)) }
        for id in photos.keys { if let file = file(id) { try? FileManager.default.removeItem(at: file) } }
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("notes"))
        entries = []
        photos = [:]
        thumbnails = [:]
        notes = [:]
        cancels = []
        live = nil
        try? save()
    }

    func start() {
        guard !started else { return }
        started = true
        if let home = here() {
            for entry in entries where entry.home != home { letGo(entry) }
            for photo in photos.values where photo.home != home { remove(photo.id) }
            for note in notes.values where note.home != home { forget(note: note.id) }
        }
        let named = Set(entries.flatMap(\.photos))
        for photo in photos.values where !named.contains(photo.id) { remove(photo.id) }
        let voiced = Set(entries.compactMap { entry -> String? in if case .note(let note, _)? = entry.voice { note } else { nil } })
        for note in notes.keys where !voiced.contains(note) && note != live { cancel(note: note) }
        for note in cancels { letGo(note) }
        for photo in photos.values where photo.state == .uploading { upload(photo.id) }
    }


    private func load() {
        let manager = FileManager.default
        if let data = try? Data(contentsOf: folder.appendingPathComponent("outbox.json")),
           let kept = try? JSONDecoder().decode(Kept.self, from: data) {
            photos = Dictionary(kept.photos.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            notes = Dictionary(kept.notes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            cancels = Set(kept.cancels)
        }
        let folders = (try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        entries = folders.compactMap { folder in
            (try? Data(contentsOf: folder.appendingPathComponent("question.json"))).flatMap { try? JSONDecoder().decode(Entry.self, from: $0) }
        }.sorted { $0.atMs < $1.atMs }
        for photo in photos.values {
            if let file = file(photo.id), let data = try? Data(contentsOf: file) { thumbnails[photo.id] = Self.thumbnail(data) }
        }
    }

    private func save() throws {
        try prepare()
        let kept = Kept(photos: Array(photos.values), notes: Array(notes.values), cancels: Array(cancels))
        try JSONEncoder().encode(kept).write(to: folder.appendingPathComponent("outbox.json"),
                                             options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func write(_ entry: Entry) throws {
        try prepare()
        let place = folder.appendingPathComponent(entry.submission, isDirectory: true)
        try FileManager.default.createDirectory(at: place, withIntermediateDirectories: true)
        try JSONEncoder().encode(entry).write(to: place.appendingPathComponent("question.json"),
                                              options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func prepare() throws {
        var place = folder
        try FileManager.default.createDirectory(at: place, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? place.setResourceValues(values)
    }

    static func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: 1024]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

@MainActor
final class Background {
    private var ending: (() -> Void)?

    init(ending: @escaping () -> Void) {
        self.ending = ending
    }

    func end() {
        let ending = ending
        self.ending = nil
        ending?()
    }

    static func app() -> Background {
        let box = Identifier()
        let held = Background { if box.id != .invalid { UIApplication.shared.endBackgroundTask(box.id) } }
        box.id = UIApplication.shared.beginBackgroundTask(withName: "Chat question") { MainActor.assumeIsolated { held.end() } }
        return held
    }

    private final class Identifier {
        var id = UIBackgroundTaskIdentifier.invalid
    }
}
