import Evidence
import DeviceFiles
import Foundation
import XCTest
@testable import Audio

final class RecordingFolderOrderTests: XCTestCase {
    private var root: URL!
    private var seen: [(path: String, level: DeviceFiles.Flush, visible: Set<String>)] = []

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("recording-order-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let prefix = root.path
        DeviceFiles.flushObserver = { [unowned self] url, level in
            guard url.path.hasPrefix(prefix) else { return }
            let path = String(url.path.dropFirst(prefix.count).drop { $0 == "/" })
            let names = (try? FileManager.default.contentsOfDirectory(atPath: prefix)) ?? []
            seen.append((path, level, Set(names)))
        }
    }

    override func tearDownWithError() throws {
        DeviceFiles.flushObserver = nil
        try? FileManager.default.removeItem(at: root)
    }

    func testASealFlushesTheAudioThenOrdersTheSidecarThenCommitsTheFolderBeforeTheOpenSidecarGoes() throws {
        let folder = RecordingFolder(url: root, scratch: root, files: DeviceFiles(.plain), report: { XCTFail($0) })
        let stem = "20260930T090000.000Z.mic"
        let sidecar = AudioSidecar(at: "2026-09-30T09:00:00.000Z", until: "2026-09-30T09:00:05.000Z", track: .mic,
                                   detectedAt: "2026-09-30T08:59:59.800Z", latencyMs: 200, part: 1, endedBy: nil,
                                   device: nil, room: [], camera: [], audio: nil, session: stem)
        try Data("synthetic audio bytes".utf8).write(to: root.appendingPathComponent(AudioSpool.audioName(stem)))
        folder.writeOpen(sidecar, stem: stem)
        seen = []

        XCTAssertTrue(folder.seal(sidecar, stem: stem, durationMs: 5_000))

        XCTAssertEqual(seen.map(\.level), [.data, .barrier, .full])
        guard seen.count == 3 else { return }
        XCTAssertEqual(seen[0].path, AudioSpool.audioName(stem))
        let temporary = seen[1].path
        XCTAssertTrue(temporary.hasPrefix(".\(AudioSpool.sidecarName(stem))."), "a hidden name beside the sidecar")
        XCTAssertTrue(temporary.hasSuffix(".tmp"))
        XCTAssertEqual(seen[2].path, "", "the folder")
        XCTAssertFalse(seen[1].visible.contains(AudioSpool.sidecarName(stem)), "the barrier precedes the rename")
        XCTAssertTrue(seen[2].visible.contains(AudioSpool.sidecarName(stem)), "the rename precedes the full flush")
        XCTAssertTrue(seen[2].visible.contains(AudioSpool.openName(stem)), "the open sidecar goes after the commit")
        XCTAssertFalse(seen[2].visible.contains(temporary))

        let after = Set(try FileManager.default.contentsOfDirectory(atPath: root.path))
        XCTAssertEqual(after, [AudioSpool.audioName(stem), AudioSpool.sidecarName(stem)])
        XCTAssertEqual(AudioSpool.sealedRecordings(in: root), [stem])
    }
}
