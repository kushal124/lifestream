import Combine
import Foundation
import XCTest

@testable import Lifestream

@MainActor
final class NotePlayerTests: XCTestCase {
    private var folder: URL!
    private let session = Session()

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("note-player-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testEachFixtureIsKeptUnderTheNameOfItsContainerAndPlays() async throws {
        let fixtures = ["whatsapp.ogg": "ogg", "imessage-opus.caf": "caf", "imessage-aac.caf": "caf", "iphone.m4a": "m4a"]
        for (name, container) in fixtures.sorted(by: { $0.key < $1.key }) {
            let bytes = try fixture(name)
            XCTAssertEqual(NotePlayer.container(of: bytes), container, name)
            let player = made { _ in bytes }
            let sound = NotePlayer.Sound.held("sha256:" + name)
            let started = try XCTUnwrap(player.toggle(sound, of: self), name)
            await started.value
            guard case let .playing(_, of) = player.state(of: sound) else {
                return XCTFail("\(name) plays: \(player.state(of: sound))")
            }
            XCTAssertGreaterThan(of, 2, "\(name): its length, read from its own bytes")
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["note.\(container)"],
                           "\(name): one cache file, named by its sniffed container")
            player.stop()
            XCTAssertEqual(player.state(of: sound), .idle)
            XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path), "\(name): the cache goes with the note")
        }
        XCTAssertEqual(session.activations, fixtures.count, "the session is set to play before each")
        XCTAssertEqual(session.given, fixtures.count, "and given back after each")
    }

    func testTheContainersAreTheMessagesFamilysMagicNumbers() {
        let cases: [([UInt8], String?)] = [
            (Array("OggS".utf8) + [0, 2], "ogg"),
            (Array("caff".utf8) + [0, 1], "caf"),
            ([0, 0, 0, 0x20] + Array("ftypM4A ".utf8), "m4a"),
            (Array("RIFF".utf8) + [0, 0, 0, 0] + Array("WAVE".utf8), "wav"),
            (Array("ID3".utf8) + [4, 0], "mp3"),
            ([0xFF, 0xFB, 0x90], "mp3"),
            ([0xFF, 0xF1, 0x50], "aac"),
            (Array("not-audio".utf8), nil),
            ([], nil),
        ]
        for (bytes, container) in cases {
            XCTAssertEqual(NotePlayer.container(of: Data(bytes)), container, "\(bytes.prefix(4))")
        }
    }

    func testBytesOfNoKnownContainerFailAndNeverTakeTheSession() async throws {
        let player = made { _ in Data("not-audio".utf8) }
        let sound = NotePlayer.Sound.held("sha256:" + String(repeating: "ab", count: 32))
        await player.toggle(sound, of: self)?.value
        XCTAssertEqual(player.state(of: sound), .failed(.unplayable))
        XCTAssertEqual(session.activations, 0, "nothing to play: the session is never set")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path), "nothing kept")
    }

    func testAReadThatFailsKeepsItsCause() async throws {
        let sound = NotePlayer.Sound.held("sha256:" + String(repeating: "ab", count: 32))
        for cause in [NotePlayer.Unplayed.missing, .reach(begun: 3), .unplayable] {
            let player = made { _ throws(NotePlayer.Unplayed) in throw cause }
            await player.toggle(sound, of: self)?.value
            XCTAssertEqual(player.state(of: sound), .failed(cause), "the viewer says why: \(cause)")
        }
        XCTAssertEqual(NotePlayer.unplayed(LifeReader.Failure.missing), .missing, "the home does not hold it")
        XCTAssertEqual(NotePlayer.unplayed(LifeReader.Failure.reach(begun: 4)), .reach(begun: 4), "the home out of reach, with when")
        XCTAssertEqual(NotePlayer.unplayed(LifeReader.Failure.refused("no")), .unplayable)
        XCTAssertEqual(NotePlayer.unplayed(URLError(.badURL)), .unplayable)
    }

    func testEveryPlayIsAnnouncedAtItsTapAndEachFailureAndFirstSoundWhoeverStartedIt() async throws {
        let heard = Heard()
        let gate = ReadGate()
        let player = made { _ throws(NotePlayer.Unplayed) in
            if heard.gated { return try await gate.read() }
            guard let bytes = heard.bytes else { throw .unplayable }
            return bytes
        }
        let hearing = player.heard.sink { event in MainActor.assumeIsolated { heard.all.append(event) } }
        defer { hearing.cancel() }
        let sound = NotePlayer.Sound.held("sha256:note")

        await player.toggle(sound, of: NSObject())?.value
        await player.toggle(sound, of: self)?.value
        XCTAssertEqual(heard.all, [NotePlayer.Heard(sound: sound, play: 1, outcome: .began),
                                   NotePlayer.Heard(sound: sound, play: 1, outcome: .failed(.unplayable)),
                                   NotePlayer.Heard(sound: sound, play: 2, outcome: .began),
                                   NotePlayer.Heard(sound: sound, play: 2, outcome: .failed(.unplayable))],
                       "a play started by any surface fails aloud, each play its own number")

        heard.gated = true
        let loading = try XCTUnwrap(player.toggle(sound, of: self))
        XCTAssertEqual(heard.all.last, NotePlayer.Heard(sound: sound, play: 3, outcome: .began), "a play is announced at its tap, before any byte")
        try await until("the read waits") { gate.waiting }
        XCTAssertEqual(player.state(of: sound), .loading)
        gate.answer(try fixture("iphone.m4a"))
        await loading.value
        XCTAssertEqual(heard.all.last, NotePlayer.Heard(sound: sound, play: 3, outcome: .sounded), "its first sound is heard")
        XCTAssertNil(player.toggle(sound, of: self), "a pause")
        XCTAssertNil(player.toggle(sound, of: self), "and a resume")
        XCTAssertEqual(heard.all.count, 6, "are no new play")
        player.stop()
    }

    func testLoadingThenPlayingThenPausedAndPlayedThroughBackToReady() async throws {
        let bytes = try fixture("iphone.m4a")
        let gate = ReadGate()
        let player = made { _ throws(NotePlayer.Unplayed) in try await gate.read() }
        let sound = NotePlayer.Sound.held("sha256:note")
        let seen = States()
        let watching = player.$phase.sink { phase in
            let name = switch phase {
            case .idle: "idle"
            case .loading: "loading"
            case .playing: "playing"
            case .paused: "paused"
            case .failed: "failed"
            }
            if seen.names.last != name { seen.names.append(name) }
        }
        defer { watching.cancel() }

        let started = try XCTUnwrap(player.toggle(sound, of: self))
        XCTAssertEqual(player.state(of: sound), .loading, "at once, before any byte")
        try await until("the read waits") { gate.waiting }
        gate.answer(bytes)
        await started.value
        XCTAssertNil(player.toggle(sound, of: self), "a tap while playing pauses")
        guard case .paused = player.state(of: sound) else { return XCTFail("paused: \(player.state(of: sound))") }
        XCTAssertNil(player.toggle(sound, of: self), "and resumes")
        try await until("played through, back to Ready") { player.state(of: sound) == .idle }
        XCTAssertEqual(seen.names, ["idle", "loading", "playing", "paused", "playing", "idle"])
        XCTAssertEqual(session.given, 1, "the session given back once it ended")
    }

    func testASecondTapWhileLoadingCancelsAndARecordingRefusesAPlay() async throws {
        let gate = ReadGate()
        let player = made { _ throws(NotePlayer.Unplayed) in try await gate.read() }
        let sound = NotePlayer.Sound.held("sha256:note")
        let started = try XCTUnwrap(player.toggle(sound, of: self))
        try await until("the read waits") { gate.waiting }
        XCTAssertNil(player.toggle(sound, of: self), "a second tap cancels")
        XCTAssertEqual(player.state(of: sound), .idle, "back to Ready, no failure")
        gate.answer(try fixture("iphone.m4a"))
        await started.value
        XCTAssertEqual(player.state(of: sound), .idle, "the late bytes play nothing")
        XCTAssertEqual(session.activations, 0)

        session.recording = true
        XCTAssertNil(player.toggle(sound, of: self), "refused while a question records")
        XCTAssertEqual(player.state(of: sound), .idle, "Ready, no failure")
        XCTAssertFalse(gate.waiting, "nothing read")
    }

    func testOneNoteAtATimeAndTwoSurfacesOfOneSoundShareIt() async throws {
        let bytes = try fixture("iphone.m4a")
        let player = made { _ in bytes }
        let first = NotePlayer.Sound.held("sha256:first")
        let second = NotePlayer.Sound.own("note-b")
        let answer = NSObject()
        let thread = NSObject()

        await player.toggle(first, of: answer)?.value
        guard case .playing = player.state(of: first) else { return XCTFail("the first plays") }
        XCTAssertNil(player.toggle(first, of: thread), "a tap on its other bar pauses it, never restarts it")
        guard case .paused = player.state(of: first) else { return XCTFail("paused: \(player.state(of: first))") }
        player.stop(thread)
        guard case .paused = player.state(of: first) else { return XCTFail("a pause leaves the owner: the thread owns nothing") }
        XCTAssertNil(player.toggle(first, of: thread), "resumed from the thread")
        guard case .playing = player.state(of: first) else { return XCTFail("resumed: \(player.state(of: first))") }
        player.stop(answer)
        guard case .playing = player.state(of: first) else { return XCTFail("the resume moved it to the thread: the answer leaving stops nothing") }
        player.stop(thread)
        XCTAssertEqual(player.state(of: first), .idle, "the thread leaving stops what it owns")

        await player.toggle(first, of: answer)?.value
        await player.toggle(second, of: answer)?.value
        XCTAssertEqual(player.state(of: first), .idle, "starting one stops the other")
        guard case .playing = player.state(of: second) else { return XCTFail("the second plays") }
        player.stop()
        XCTAssertEqual(player.state(of: second), .idle)
    }

    func testAReadInFlightIsDroppedWhenItsOwnerLeavesAllStopOrARecordingBegins() async throws {
        let gate = ReadGate()
        let player = made { _ throws(NotePlayer.Unplayed) in try await gate.read() }
        let sound = NotePlayer.Sound.held("sha256:" + String(repeating: "ef", count: 32))
        let bytes = try fixture("iphone.m4a")

        let erased = NSObject()
        let other = NSObject()
        let purged = try XCTUnwrap(player.toggle(sound, of: erased))
        try await until("the read waits") { gate.waiting }
        player.stop(other)
        XCTAssertEqual(player.state(of: sound), .loading, "another owner leaving stops nothing")
        player.stop(erased)
        gate.answer(bytes)
        await purged.value
        XCTAssertEqual(session.activations, 0, "nothing plays for an erased conversation")

        let late = try XCTUnwrap(player.toggle(sound, of: other))
        try await until("the read waits") { gate.waiting }
        player.stop()
        gate.answer(bytes)
        await late.value
        XCTAssertEqual(session.activations, 0, "nor after Unpair")

        let recorded = try XCTUnwrap(player.toggle(sound, of: other))
        try await until("the read waits") { gate.waiting }
        session.recording = true
        gate.answer(bytes)
        await recorded.value
        XCTAssertEqual(session.activations, 0, "nor while a note records")
        XCTAssertEqual(player.state(of: sound), .idle, "and it is no failure")
        session.recording = false

        let replaced = try XCTUnwrap(player.toggle(sound, of: other))
        try await until("the read waits") { gate.waiting }
        let newer = try XCTUnwrap(player.toggle(.own("note-b"), of: other))
        gate.answer(bytes)
        await replaced.value
        XCTAssertEqual(session.activations, 0, "nor a press another replaced")
        try await until("the newer read waits") { gate.waiting }
        gate.answer(bytes)
        await newer.value
        XCTAssertEqual(session.activations, 1, "the newest plays")
        player.stop()
    }

    private func made(read: @escaping NotePlayer.Read) -> NotePlayer {
        let session = session
        return NotePlayer(folder: folder, read: read, recording: { session.recording }, activate: { session.activations += 1 },
                          giveBack: { MainActor.assumeIsolated { session.given += 1 } }, muted: true)
    }

    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: nil, subdirectory: "audio"), "audio/\(name)")
        return try Data(contentsOf: url)
    }
}

@MainActor
private final class States {
    var names: [String] = []
}

@MainActor
private final class Heard {
    var all: [NotePlayer.Heard] = []
    var bytes: Data?
    var gated = false
}

@MainActor
private final class Session {
    var recording = false
    var activations = 0
    var given = 0
}

@MainActor
private final class ReadGate {
    private var held: CheckedContinuation<Data?, Never>?
    var waiting: Bool { held != nil }

    func read() async throws(NotePlayer.Unplayed) -> Data {
        guard let data = await withCheckedContinuation({ held = $0 }) else { throw .unplayable }
        return data
    }

    func answer(_ data: Data?) {
        let held = held
        self.held = nil
        held?.resume(returning: data)
    }
}
