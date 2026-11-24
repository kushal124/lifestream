import CoreGraphics
import DeviceFiles
import Evidence
import Spool
import XCTest
@testable import Recorder

final class CaptureStoreAdapterTests: XCTestCase {
    func testFinalVideoFlushRunsAfterAcquisitionTaskCancellation() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("cancelled-recorder-flush-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try CaptureStore(directory: directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.65)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let layout = FrameLayout(width: 64, height: 64, bytesPerRow: 256,
            bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue,
            renderingIntent: 0, ICCData: space.copyICCData()! as Data)
        var pixels = Data(repeating: 40, count: 64 * 64 * 4)
        for index in stride(from: 3, to: pixels.count, by: 4) { pixels[index] = 255 }
        let observation = try store.append(observation: CaptureObservation(capturedAt: Date(),
            displayID: 1, width: 64, height: 64), image: .raw(RawFrame(layout: layout, data: pixels)))
        let parent = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            XCTAssertTrue(Task.isCancelled)
            return try await CaptureStoreAdapter(store).flushVideoBeforeRelease()
        }
        let report: VideoCompactionReport
        do { report = try await parent.value }
        catch VideoArchiveError.hardwareUnavailable { throw XCTSkip("Hardware HEVC encoder unavailable") }
        XCTAssertEqual(report.imageCount, 1)
        XCTAssertEqual(report.pendingImageCount, 0)
        XCTAssertNoThrow(try store.readImage(for: observation))
    }

    func testTextCompactsAfterAFailedVideoPassAndNotAfterACancelledOne() async throws {
        for cancelled in [false, true] {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("adapter-text-after-video-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = try CaptureStore(directory: directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.65)
            for index in 0..<3 {
                try store.append(observation: CaptureObservation(
                    capturedAt: Date(timeIntervalSince1970: 1_790_262_600 + Double(index * 2)), displayID: 1, width: 64, height: 48,
                    ocr: [TextObservation(text: "SYNTHETIC TEXT \(index)", confidence: 1,
                                          bounds: CaptureRect(x: 0, y: 0, width: 1, height: 1))]), image: nil)
            }
            try Data("synthetic: not a folder".utf8).write(to: directory.appendingPathComponent(".video"))
            let adapter = CaptureStoreAdapter(store)
            let pass = Task {
                if cancelled { withUnsafeCurrentTask { $0?.cancel() } }
                return try await adapter.compact(flush: true)
            }
            do {
                _ = try await pass.value
                XCTFail("the video pass fails")
            } catch {
                if !cancelled {
                    XCTAssertFalse(error is CancellationError, "the video error is thrown: \(error)")
                }
            }
            let position = directory.appendingPathComponent(".text/position")
            XCTAssertEqual(FileManager.default.fileExists(atPath: position.path), !cancelled,
                           cancelled ? "a cancelled pass compacts no text" : "text compacts after a failed video pass")
        }
    }
}
