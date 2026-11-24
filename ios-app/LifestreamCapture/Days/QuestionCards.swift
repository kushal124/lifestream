import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct QuestionCards: View {
    var body: some View {
        CheckInDueCard(model: AppRuntime.shared.checkInModel)
    }
}

private struct CheckInDueCard: View {
    @ObservedObject var model: CheckInModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TimelineView(.animation(minimumInterval: 15, paused: scenePhase != .active)) { context in
            let rows = [false, true].filter { due(ready: $0, now: AppClock.now) }
            if !rows.isEmpty {
                Card(flush: true) {
                    ForEach(rows, id: \.self) { ready in
                        CheckInDueRow(model: model, ready: ready, now: AppClock.now, last: ready == rows.last)
                    }
                }
                .padding(.top, Cockpit.Space.s4)
                .padding(.bottom, Cockpit.Space.s4)
            }
        }
        .repeatWhileActive(every: .seconds(60)) { await model.readStatus() }
    }

    private func due(ready: Bool, now: Date) -> Bool {
        model.activePrompt(ready: ready, now: now) != nil || (ready && model.status.history.runningBlock != nil)
    }
}

private struct CheckInDueRow: View {
    @ObservedObject var model: CheckInModel
    let ready: Bool
    let now: Date
    let last: Bool

    var body: some View {
        ListRow(ready ? "Ready to focus?" : "How am I?",
                meta: stateLine(pending: model.activePrompt(ready: ready, now: now)),
                leading: .icon(.checkIn), chevron: true, separator: !last,
                action: { AppNavigation.shared.checkInRoute = CheckInRoute(destination: ready ? .ready : .moment) })
        .accessibilityIdentifier(ready ? "checkin.ready" : "checkin.moment")
    }

    private func stateLine(pending: CheckInPrompt?) -> String {
        if ready, let block = model.status.history.runningBlock, let start = CaptureTime.date(rfc3339: block.observedAt) {
            return "Block running " + Words.duration(now.timeIntervalSince(start)) + Words.dot + "tap to stop"
        }
        guard let pending else { return "" }
        let left = Words.duration(max(60, pending.expires.timeIntervalSince(now)))
        return "Asked " + Words.ago(pending.scheduledFor, now: now) + Words.dot + left + " left"
    }
}
