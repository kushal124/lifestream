import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import os

@MainActor
final class PhoneSettings: ObservableObject {
    nonisolated static let location = "location"
    nonisolated static let checkin = "checkin"
    nonisolated static let bedtimes: [String] = (42...52).map { clock(($0 * 30) % 1440) }
    nonisolated static let bedtimeDefault = "23:30"

    @Published private(set) var precision: LocationPrecision
    @Published private(set) var prompts = false
    @Published private(set) var bedtime = PhoneSettings.bedtimeDefault
    @Published private(set) var unkept: [String: String] = [:]
    let queue: SettingsQueue
    private let link: @MainActor () -> HomeLink
    private let location: LocationRecorderCoordinator
    private let checkIns: CheckInModel
    private var loaded = false
    private var given: SettingsQueue.Settings?
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "settings")

    init(queue: SettingsQueue, link: @escaping @MainActor () -> HomeLink, location: LocationRecorderCoordinator, checkIns: CheckInModel) {
        self.queue = queue
        self.link = link
        self.location = location
        self.checkIns = checkIns
        precision = location.precision
    }

    var stated: [String: [String: HomeLink.JSON]] {
        [Self.location: ["precision": .string(precision.rawValue)],
         Self.checkin: ["prompts": .bool(prompts), "bedtime": .string(bedtime)]]
    }

    func home(_ connector: String, _ member: String) -> HomeLink.JSON? {
        guard let saved = link().saved else { return nil }
        return (given ?? saved.settings)[connector]?[member]
    }

    static func start(of source: PhoneSource, in settings: SettingsQueue.Settings?) -> Date? {
        settings?[source.stream.id]?["start_ms"]?.number.map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    private func load() async {
        guard !loaded else { return }
        let state = await checkIns.recorder.status().state
        prompts = state.prompting
        bedtime = Self.clock(state.bedtimeMinutes)
        loaded = true
    }

    func exchange(through link: HomeLink) async throws -> FreshAnswer {
        await load()
        return try await queue.exchange(through: link, heard: { [self] sent in await heard(sent) },
                                        stated: { [self] in await stated }, apply: nil)
    }

    func applied(_ answer: FreshAnswer) async -> Bool {
        await load()
        let before = stated
        await apply(answer.settings)
        return stated != before
    }

    private func heard(_ sent: SettingsQueue.Sent) async {
        let change = sent.change
        switch sent.outcome {
        case .taken: hold(change.connector, change.member, change.value)
        case .changed(let home): hold(change.connector, change.member, home)
        case .refused: Self.log.error("The home refused \(change.connector, privacy: .public).\(change.member, privacy: .public)")
        case .unreachable, .saving, .unknown: break
        }
    }

    private func hold(_ connector: String, _ member: String, _ value: HomeLink.JSON) {
        var known = given ?? link().saved?.settings ?? [:]
        known[connector, default: [:]][member] = value
        given = known
    }

    private func apply(_ settings: SettingsQueue.Settings) async {
        given = settings
        for (connector, members) in queue.overlay(settings) {
            for (member, value) in members { _ = await set(connector, member, value) }
        }
    }

    func change(_ connector: String, _ member: String, to value: HomeLink.JSON) async {
        await load()
        let key = "\(connector).\(member)"
        let before = stated[connector]?[member]
        guard await set(connector, member, value) else { return }
        do {
            try queue.enqueue(connector: connector, member: member, value: value, was: home(connector, member))
            unkept[key] = nil
        } catch {
            Self.log.error("A change could not be kept for the home: \(String(describing: error), privacy: .public)")
            if let before { _ = await set(connector, member, before) }
            unkept[key] = "Not changed: this iPhone could not keep it for Lifestream. Try again."
            return
        }
        await sync()
    }

    func sync() async {
        do {
            _ = try await exchange(through: link())
        } catch {
            Self.log.info("Settings wait for the next exchange: \(String(describing: error), privacy: .public)")
        }
    }

    private func set(_ connector: String, _ member: String, _ value: HomeLink.JSON) async -> Bool {
        switch (connector, member) {
        case (Self.location, "precision"):
            guard let chosen = value.string.flatMap(LocationPrecision.init(rawValue:)), chosen != precision else { return false }
            precision = chosen
            location.apply(chosen)
        case (Self.checkin, "prompts"):
            guard let on = value.bool, on != prompts else { return false }
            do { try await checkIns.recorder.setPrompts(on: on) } catch { return refused(error) }
            prompts = on
            await checkIns.refresh(rebuild: true)
        case (Self.checkin, "bedtime"):
            guard let text = value.string, text != bedtime, let minutes = Self.minutes(text) else { return false }
            do { try await checkIns.recorder.setBedtime(minutes: minutes) } catch { return refused(error) }
            bedtime = text
            await checkIns.refresh(rebuild: true)
        default:
            return false
        }
        return true
    }

    private func refused(_ error: Error) -> Bool {
        checkIns.error = error.localizedDescription
        return false
    }

    nonisolated static func clock(_ minutes: Int) -> String {
        String(format: "%02d:%02d", minutes / 60 % 24, minutes % 60)
    }

    nonisolated static func minutes(_ text: String) -> Int? {
        let parts = text.split(separator: ":")
        guard parts.count == 2, parts[1].count == 2, let hours = Int(parts[0]), let minutes = Int(parts[1]),
              (0..<24).contains(hours), (0..<60).contains(minutes) else { return nil }
        return hours * 60 + minutes
    }
}
