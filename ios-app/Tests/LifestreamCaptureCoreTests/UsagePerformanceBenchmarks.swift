import Foundation
import XCTest
@testable import LifestreamCaptureCore

final class UsagePerformanceBenchmarks: XCTestCase {
    func testRetainedHistoryAndCallbackBatch() async throws {
        guard let output = ProcessInfo.processInfo.environment["USAGE_BENCHMARK_OUTPUT"] else {
            throw XCTSkip("Explicit Release usage workload")
        }
        let directory = URL(fileURLWithPath: output, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for count in [0, 10_000] {
            let root = directory.appendingPathComponent("usage-\(count)")
            let capture = root.appendingPathComponent("capture")
            let store = try CaptureStore(root: capture)
            if count > 0 {
                let drafts = (0..<count).map { index in
                    ReplayCaptureDraft(replayKey: "synthetic-old-\(index)",
                        draft: .init(kind: "activity_segment", observedAt: "2026-06-01T00:00:00Z",
                        payload: .object(["synthetic_index": .integer(Int64(index)), "duration": .number(20.5)])))
                }
                _ = try await store.appendReplayBatch(domain: .usage, drafts: drafts)
            }
            let started = ContinuousClock.now
            let reopened = try CaptureStore(root: capture)
            let openSeconds = seconds(started)
            let statusStarted = ContinuousClock.now
            for _ in 0..<100 { _ = try await reopened.statusSummary() }
            let statusSeconds = seconds(statusStarted)
            let inbox = UsageInbox(directory: root.appendingPathComponent("inbox"))
            let publishStarted = ContinuousClock.now
            for _ in 0..<64 {
                try inbox.publish(.object(["event": .string("synthetic_callback"),
                    "observed_at": .string("2026-09-01T00:00:00Z")]))
            }
            let publishSeconds = seconds(publishStarted)
            let drainStarted = ContinuousClock.now
            let items = try inbox.pending(limit: 64)
            let drafts = items.map { item in
                ReplayCaptureDraft(replayKey: "synthetic-delivery-\(item.deliveryID.uuidString)",
                    draft: .init(kind: "monitor_callback", observedAt: "2026-09-01T00:00:00Z", payload: item.payload))
            }
            let accepted = try await reopened.appendReplayBatch(domain: .usage, drafts: drafts)
            XCTAssertEqual(accepted.count, 64)
            for item in items { try inbox.acknowledge(item) }
            let drainSeconds = seconds(drainStarted)
            XCTAssertEqual(try inbox.pending(), [])
            let metrics: [String: Any] = ["retained_usage_entries": count, "cold_store_open_seconds": openSeconds,
                "status_100_seconds": statusSeconds, "publish_64_seconds": publishSeconds,
                "drain_append_ack_64_seconds": drainSeconds,
                "database_bytes_after_batch": try FileDurability.regularFileSize(at: reopened.databaseURL),
                "configuration": "Release; synthetic macOS host; single measured sample"]
            try JSONSerialization.data(withJSONObject: metrics, options: [.prettyPrinted, .sortedKeys])
                .write(to: directory.appendingPathComponent("usage-\(count).json"))
            try FileManager.default.removeItem(at: root)
        }
    }

    private func seconds(_ start: ContinuousClock.Instant) -> Double {
        let elapsed = start.duration(to: .now).components
        return Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
    }
}
