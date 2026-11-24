import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct VigilanceResultView: View {
    let record: VigilanceRecord
    let history: CheckInHistory
    @ObservedObject var model: CheckInModel
    private var stored: JSONValue? { history.tests.first { $0.payload.ciString("started_at") == record.startedAt }?.payload }
    private var trials: [JSONValue] { stored?.ciObject["trials"]?.ciArray ?? [] }
    private var responses: [Double] { Self.responses(trials) }
    private static func responses(_ trials: [JSONValue]) -> [Double] {
        trials.filter { $0.ciString("class") == "response" }.compactMap { $0.ciObject["rt_ms"]?.ciNumber }.sorted()
    }
    static func percentile(_ values: [Double], _ fraction: Double) -> Double? {
        guard !values.isEmpty else { return nil }
        let position = Double(values.count - 1) * fraction
        let lower = Int(position), upper = min(values.count - 1, lower + 1)
        return values[lower] + (values[upper] - values[lower]) * (position - Double(lower))
    }
    private func ms(_ number: Double?) -> String { number.map { "\(Int($0.rounded()))\(Words.nbsp)ms" } ?? "—" }
    private var lapses: Int {
        trials.filter {
            $0.ciString("class") == "timeout" || ($0.ciString("class") == "response" && ($0.ciObject["rt_ms"]?.ciNumber ?? 0) > 500)
        }.count
    }
    var body: some View {
        Drawer(record.completed ? "Done. Every tap is kept." : "Stopped. Every tap is kept.") {
            VStack(alignment: .leading, spacing: Cockpit.Space.s8) {
                Text(durationLabel + Words.dot + Words.count(trials.count, "trial"))
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                FigureStrip {
                    Figure(ms(Self.percentile(responses, 0.5)), label: "Median")
                    Figure(ms(slowestTenth), label: "Slowest tenth")
                    Figure(Words.count(lapses), label: "Lapses over 500\(Words.nbsp)ms")
                    Figure(Words.count(trials.filter { $0.ciString("class") == "false_start" }.count), label: "False starts")
                }
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                    Text("Reaction time by trial").cockpit(.headline).foregroundStyle(Cockpit.Color.text)
                    Text("500\(Words.nbsp)ms lapse line").cockpit(.caption).foregroundStyle(Cockpit.Color.textTertiary)
                    chart.frame(height: 150).padding(.top, Cockpit.Space.s2)
                    HStack { Text("0"); Spacer(); Text(Words.duration(VigilanceRules.durationMS / 1000)) }
                        .cockpit(.caption)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .accessibilityHidden(true)
                }
                Text(usual).cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
            }
        } foot: {
            VStack(spacing: Cockpit.Space.s3) {
                Button("Start a work block") { model.startBlock() }
                    .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                Text("Or close. Everything is already saved.").cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
            }
        }
    }
    private var durationLabel: String {
        guard let start = CaptureTime.date(rfc3339: record.startedAt), let end = CaptureTime.date(rfc3339: record.endedAt) else { return "—" }
        return Words.duration(end.timeIntervalSince(start))
    }
    private var slowestTenth: Double? {
        guard !responses.isEmpty else { return nil }
        let tail = responses.suffix(max(1, Int(ceil(Double(responses.count) / 10))))
        return tail.reduce(0, +) / Double(tail.count)
    }
    private var usual: String {
        let morning = history.tests.filter {
            $0.payload.ciObject["completed"] == .bool(true) && isMorning($0)
        }
        guard record.trigger == "prework", record.completed,
              let current = morning.firstIndex(where: { $0.payload.ciString("started_at") == record.startedAt }), current >= 20 else {
            return "Your usual range forms after 20 completed morning sessions."
        }
        let medians = morning[(current - 20)..<current].compactMap {
            Self.percentile(Self.responses($0.payload.ciObject["trials"]?.ciArray ?? []), 0.5)
        }.sorted()
        guard medians.count == 20 else { return "Your usual range needs 20 morning sessions with responses." }
        return "Your usual: \(ms(Self.percentile(medians, 0.5))) · middle half \(ms(Self.percentile(medians, 0.25)))–\(ms(Self.percentile(medians, 0.75)))"
    }
    private func isMorning(_ entry: CaptureEntry) -> Bool {
        guard entry.payload.ciString("trigger") == "prework",
              let instant = CaptureTime.date(rfc3339: entry.observedAt) else { return false }
        let report = history.reports.last {
            $0.payload.ciString("form") == "prework" && $0.observedAt <= entry.observedAt
        }
        var calendar = Calendar(identifier: .gregorian)
        if let zone = report?.payload.ciString("local_zone"), let timeZone = TimeZone(identifier: zone) { calendar.timeZone = timeZone }
        return calendar.component(.hour, from: instant) < 12
    }
    private var chart: some View {
        Canvas { context, size in
            let ceiling = max(650, trials.compactMap { $0.ciObject["rt_ms"]?.ciNumber }.max() ?? 650)
            let lineY = size.height * (1 - 500 / ceiling)
            var line = Path(); line.move(to: .init(x: 0, y: lineY)); line.addLine(to: .init(x: size.width, y: lineY))
            context.stroke(line, with: .color(Cockpit.Color.textTertiary), style: StrokeStyle(lineWidth: Cockpit.Stroke.border, dash: Cockpit.Dash.future))
            for trial in trials {
                let instant = trial.ciObject["stimulus_ms"]?.ciNumber ?? trial.ciObject["response_ms"]?.ciNumber ?? 0
                let rt = trial.ciObject["rt_ms"]?.ciNumber ?? (trial.ciString("class") == "timeout" ? ceiling : 0)
                let height = max(3, min(size.height, size.height * max(0, rt) / ceiling))
                let rect = CGRect(x: size.width * instant / VigilanceRules.durationMS, y: size.height - height, width: 3, height: height)
                context.fill(Path(rect), with: .color(trial.ciString("class") == "response" ? Cockpit.Color.life : Cockpit.Color.data3))
            }
        }.accessibilityLabel("Every trial across three minutes, with the 500 millisecond lapse line")
    }
}
