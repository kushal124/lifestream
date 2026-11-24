import Cockpit
import Foundation
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

final class CameraTests: XCTestCase {
  @MainActor
  func testCameraLookupNeverScansUnrelatedMedia() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try CaptureStore(root: root.appendingPathComponent("capture"))
    let location = LocationRecorderCoordinator(store: store,
      intentStore: TrackingIntentStore(url: root.appendingPathComponent("intent.json")),
      bootID: UUID(), platformServicesEnabled: false)
    let recorder = CameraRecorder(store: store, locationRecorder: location, authorizeWrite: {})
    try Data([9]).write(to: root.appendingPathComponent("capture/blobs/unrelated-media"))
    let empty = try await recorder.latestShot()
    XCTAssertNil(empty)
    _ = try await recorder.record(CapturedPhoto(bytes: Data([1, 2, 3]), mimeType: "image/jpeg",
      pixelWidth: 1, pixelHeight: 1, orientation: 1, devicePosition: "back", flash: "off",
      captureTime: Date(timeIntervalSince1970: 1_700_000_000)))
    let latest = try await recorder.latestShot()
    XCTAssertNotNil(latest?.blobURL)
    let shots = try await recorder.shots()
    XCTAssertEqual(shots.count, 1)
    XCTAssertEqual(shots.first?.bytes, 3)
    XCTAssertEqual(shots.first?.observedDate, Date(timeIntervalSince1970: 1_700_000_000))
    let entries = try await store.entries(domain: .camera)
    let entry = try XCTUnwrap(entries.first)
    XCTAssertEqual(entry.kind, "photo")
    XCTAssertEqual(entry.observedAt, "2023-11-14T22:13:20.000000000Z")
    let hash = SHA256Digest.tagged(Data([1, 2, 3]))
    XCTAssertEqual(
      String(decoding: try JSONEncoder.lifestream().encode(entry.payload), as: UTF8.self),
      #"{"blob":{"bytes":3,"hash":"\#(hash)","role":"photo","type":"image/jpeg"},"device_position":"back","flash":"off","location":null,"orientation":1,"pixel_height":1,"pixel_width":1}"#
    )
  }

  @MainActor
  func testFailedWriteGateLeavesNoBlobOrCameraEntry() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try CaptureStore(root: root.appendingPathComponent("capture"))
    let location = LocationRecorderCoordinator(
      store: store, intentStore: TrackingIntentStore(url: root.appendingPathComponent("intent.json")),
      bootID: UUID(), platformServicesEnabled: false)
    let recorder = CameraRecorder(store: store, locationRecorder: location, authorizeWrite: {
      throw CaptureError.corruptState("synthetic bootstrap failure")
    })
    let snapshot = CapturedPhoto(
      bytes: Data([1, 2, 3]), mimeType: "image/jpeg", pixelWidth: 640,
      pixelHeight: 480, orientation: 1, devicePosition: "back", flash: "off",
      captureTime: Date())
    do {
      _ = try await recorder.record(snapshot)
      XCTFail("Expected gate failure")
    } catch {
      XCTAssertTrue(error.localizedDescription.contains("synthetic bootstrap failure"))
    }
    let blobs = try await store.validatedBlobInventory().map(\.url)
    let entries = try await store.entries(domain: .camera)
    XCTAssertTrue(blobs.isEmpty)
    XCTAssertTrue(entries.isEmpty)
  }
}

@MainActor
final class ActOutcomeTests: XCTestCase {
  private final class Owner { var outcome: ActOutcome = .idle }
  private struct Refused: LocalizedError { var errorDescription: String? { "The store refused it." } }

  func testAFailureStandsUntilTheActRunsAgainAndLandingClearsIt() async {
    let owner = Owner()
    let failed: Int? = await ActOutcome.run(\.outcome, of: owner) { throw Refused() }
    XCTAssertNil(failed)
    XCTAssertEqual(owner.outcome, .failed(.refused("The store refused it.")))

    var seenWhileRunning: ActOutcome?
    let landed = await ActOutcome.run(\.outcome, of: owner) { () -> Int in
      seenWhileRunning = owner.outcome
      let second = await ActOutcome.run(\.outcome, of: owner) { 2 }
      XCTAssertNil(second)
      return 1
    }
    XCTAssertEqual(seenWhileRunning, .running, "running again drops the failure at once")
    XCTAssertNil(seenWhileRunning?.failure)
    XCTAssertEqual(landed, 1)
    XCTAssertEqual(owner.outcome, .idle, "landing clears it")
  }

  func testAnActsOwnWordsForWhatItMet() async {
    let owner = Owner()
    await ActOutcome.run(\.outcome, of: owner, said: { _ in .failed(.notSent) }) { () throws -> Void in throw Refused() }
    XCTAssertEqual(owner.outcome.failure, .notSent)
  }

  func testAShotThatFailsIsSaidUntilTheNextShotLands() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try CaptureStore(root: root.appendingPathComponent("capture"))
    let location = LocationRecorderCoordinator(store: store,
      intentStore: TrackingIntentStore(url: root.appendingPathComponent("intent.json")),
      bootID: UUID(), platformServicesEnabled: false)
    let recorder = CameraRecorder(store: store, locationRecorder: location, authorizeWrite: {})
    var tries = 0
    let camera = CameraViewModel(recorder: recorder) {
      tries += 1
      if tries == 1 { throw CameraCaptureError.noPhotoBytes }
      return try await recorder.recordSampleImage()
    }
    camera.recordSample()
    try await until("the shot failed") { camera.taking.failure != nil }
    XCTAssertEqual(camera.taking, .failed(.refused(CameraCaptureError.noPhotoBytes.localizedDescription)))
    XCTAssertNil(camera.lastShot)

    camera.recordSample()
    XCTAssertEqual(camera.taking, .running, "taking it again drops the failure at once")
    try await until("the shot landed") { camera.lastShot != nil }
    XCTAssertEqual(camera.taking, .idle)
  }

  func testANotesActsFailureIsItsOwnAndTryAgainRunsTheSameAct() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let notes = NotesController(store: try NotesStore.inMemory(attachmentsRoot: root))
    let note = UUID(), other = UUID()
    var tries = 0
    XCTAssertFalse(notes.perform(.note(note)) { _ in
      tries += 1
      if tries == 1 { throw Refused() }
    })
    XCTAssertEqual(notes.outcome(.note(note)), .failed(.refused("The store refused it.")))
    XCTAssertEqual(notes.outcome(.note(other)), .idle, "said at its own place alone")
    XCTAssertEqual(notes.outcome(.newNote(page: nil)), .idle)

    notes.again(.note(note))
    XCTAssertEqual(tries, 2, "Try again runs the same act")
    XCTAssertEqual(notes.outcome(.note(note)), .idle, "and the failure is gone once it lands")
  }
}
