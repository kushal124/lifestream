import Cockpit
import Foundation
import HomeLink
import SwiftUI

struct RecordSourceFold: View {
    let ref: HomeLink.DayFile.RecordRef
    let unit: String?
    @EnvironmentObject private var reads: InspectorReads
    @State private var record: HomeLink.Record?

    var body: some View {
        Group {
            if let record, record.source == ref.source, record.key == ref.key {
                SourceFold(source: ref.source, kind: ref.kind, key: ref.key,
                           time: StoredTime.span(record.head.startMs ?? record.head.statedMs, record.head.endMs),
                           unit: unit, json: record.body)
            } else {
                Color.clear.frame(height: 0)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inspector.source")
        .task(id: ref) { record = try? await reads.record(ref) }
    }
}

struct ExtractSourceFold: View {
    let family: String
    let unit: String
    @EnvironmentObject private var reads: InspectorReads
    @State private var extract: HomeLink.Extract?

    var body: some View {
        Group {
            if let extract {
                SourceFold(source: family, kind: "extract", key: unit, time: StoredTime.span(extract.startMs, extract.endMs),
                           json: StoredTime.json(extract.content))
            } else {
                Color.clear.frame(height: 0)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inspector.source")
        .task(id: unit) { extract = try? await reads.extracts(family: family, unit: unit).first }
    }
}

private enum StoredTime {
    static func span(_ start: Int64?, _ end: Int64?) -> String {
        [start, end].compactMap { $0.map(instant) }.joined(separator: " → ").nonEmpty ?? "no time"
    }

    static func instant(_ ms: Int64) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = ms % 1000 == 0 ? [.withInternetDateTime] : [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(ms) / 1000))
    }

    static func json(_ value: HomeLink.JSON) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)) ?? Data("null".utf8)
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
