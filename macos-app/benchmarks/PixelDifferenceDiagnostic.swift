import Spool
import Evidence
import Foundation
private struct Window: Decodable { let start: Double; let end: Double }
private enum Failure: Error { case input, missing }
@main private enum Diagnostic {
    static func main() {
        do { try run() } catch { FileHandle.standardError.write(Data("Pixel difference diagnostic failed.\n".utf8)); exit(1) }
    }
    static func run() throws {
        guard (2...3).contains(CommandLine.arguments.count) else { throw Failure.input }
        let w = try JSONDecoder().decode(Window.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        guard w.start.isFinite, w.end.isFinite, w.end > w.start, w.end - w.start <= 3600 else { throw Failure.input }
        let dir = CommandLine.arguments.count == 3 ? URL(fileURLWithPath: CommandLine.arguments[2]) : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Lifestream Screen")
        let store = try CaptureStore(directory: dir, readOnly: true)
        let observations = try store.read(limit: 500, since: Date(timeIntervalSince1970: w.start)).filter { $0.capturedAt.timeIntervalSince1970 < w.end && $0.imageFile != nil }.prefix(20)
        var previous: RawFrame?, previousTime: Date?
        var reports: [[String: Any]] = []
        for (index, observation) in observations.enumerated() {
            try autoreleasepool {
                guard case .raw(let frame) = try store.readImage(for: observation) else { throw Failure.missing }
                defer { previous = frame; previousTime = observation.capturedAt }
                guard let old = previous, let oldTime = previousTime else { return }
                let l = frame.layout
                guard old.layout == l, old.data.count == frame.data.count, l.bitsPerComponent == 8, l.bitsPerPixel == 32 else {
                    reports.append(["pair": index, "compatible": false]); return
                }
                var rowBands = [Int](repeating: 0, count: 16), columnBands = [Int](repeating: 0, count: 16)
                var changes = 0, paddingChanges = 0, tailChanges = 0
                var minX = l.width, minY = l.height, maxX = -1, maxY = -1
                var differences: [String: Int] = [:]
                old.data.withUnsafeBytes { (a: UnsafeRawBufferPointer) in frame.data.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
                    for y in 0..<l.height {
                        for x in 0..<l.width {
                            let i = y * l.bytesPerRow + x * 4
                            if a[i] == b[i] && a[i + 1] == b[i + 1] && a[i + 2] == b[i + 2] && a[i + 3] == b[i + 3] { continue }
                            changes += 1; minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                            rowBands[min(15, y * 16 / l.height)] += 1
                            columnBands[min(15, x * 16 / l.width)] += 1
                            let delta = (0..<4).map { String(Int(b[i + $0]) - Int(a[i + $0])) }.joined(separator: ",")
                            if differences[delta] != nil || differences.count < 4096 { differences[delta, default: 0] += 1 }
                        }
                        for i in (y * l.bytesPerRow + l.width * 4)..<((y + 1) * l.bytesPerRow) { if a[i] != b[i] { paddingChanges += 1 } }
                    }
                    for i in (l.height * l.bytesPerRow)..<b.count { if a[i] != b[i] { tailChanges += 1 } }
                } }
                let common = differences.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.prefix(8).map { ["signedChannelDelta": $0.key, "pixels": $0.value] as [String: Any] }
                reports.append(["pair": index, "compatible": true, "intervalSeconds": observation.capturedAt.timeIntervalSince(oldTime),
                                "width": l.width, "height": l.height, "bitmapInfo": l.bitmapInfo,
                                "changedPixels": changes, "changedPaddingBytes": paddingChanges, "changedTailBytes": tailChanges,
                                "boundsTopLeftPixels": changes > 0 ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : [],
                                "rowBands16": rowBands, "columnBands16": columnBands, "commonChannelDifferences": common,
                                "differenceSignatureCountsCapped": differences.count == 4096])
            }
        }
        guard !reports.isEmpty else { throw Failure.missing }
        let report: [String: Any] = ["pairs": reports, "scope": "First20 captured images, consecutive exact provider comparisons. Sixteen equal spatial bands, top-left coordinates. Channel deltas in native byte order described by bitmapInfo, not silently labeled RGBA. Difference signature dictionary capped4096; top8 approximate if cap reached. No pixels/images/text persisted; bounds alone do not identify UI source or justify exclusions."]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
