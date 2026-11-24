import Spool
import Evidence
import Foundation
@main private enum Benchmark {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("indexed-query-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let day = root.appendingPathComponent("2023-11-14")
        try FileManager.default.createDirectory(at: day, withIntermediateDirectories: false)
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        let start = 1_700_000_000.0
        for index in 0...5000 {
            let seconds = start + Double(index)
            let name = String(format: "%020.0f", seconds * 1_000_000) + "-" + UUID().uuidString.lowercased()
            let bundle = day.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: false)
            let observation = CaptureObservation(capturedAt: Date(timeIntervalSince1970: seconds), displayID: 1, width: 1, height: 1)
            try encoder.encode(observation).write(to: bundle.appendingPathComponent("observation.json"))
        }
        let store = try CaptureStore(directory: root, readOnly: true)
        let since = Date(timeIntervalSince1970: start + 5000)
        var time = ProcessInfo.processInfo.systemUptime
        let indexed = try store.read(limit: 10, since: since)
        let indexedMS = (ProcessInfo.processInfo.systemUptime - time) * 1000
        time = ProcessInfo.processInfo.systemUptime
        let scanned = try store.read(limit: 6000).filter { $0.capturedAt >= since }
        let fullMS = (ProcessInfo.processInfo.systemUptime - time) * 1000
        precondition(indexed == scanned && indexed.count == 1)
        print("{\"oldBundles\":5000,\"matchingBundles\":1,\"indexedMilliseconds\":\(indexedMS),\"fullScanMilliseconds\":\(fullMS)}")
    }
}
