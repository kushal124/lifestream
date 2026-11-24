import Cockpit
import SwiftUI

struct DashboardFailure: View {
    @ObservedObject var web: WebContent
    @ObservedObject var needs: NeedsModel
    let press: (Need, Need.Button) -> Void

    var body: some View {
        ViewThatFits(in: .vertical) {
            content.frame(maxWidth: .infinity, maxHeight: .infinity)
            ScrollView { content.frame(maxWidth: .infinity) }
        }
        .groundColor(Cockpit.Color.canvas)
    }

    private var content: some View {
        VStack(spacing: Cockpit.Space.s4) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                SignalShape(.warning, size: 12)
                Text("The dashboard is not answering")
                    .cockpit(.title2)
                    .foregroundStyle(Cockpit.Color.text)
            }
            Text("\(web.address.hostAndPort) · last tried \(DashboardFailure.clock(web.lastAttempt))")
                .cockpit(.monoData)
                .foregroundStyle(Cockpit.Color.textTertiary)
            HStack(spacing: Cockpit.Space.s2) {
                Button("Try again") { web.retry() }
                    .buttonStyle(.cockpit(.primary))
                    .keyboardShortcut(.defaultAction)
                if web.restartAvailable {
                    Button("Restart dashboard") { web.restartDashboard() }
                        .buttonStyle(.cockpit(.secondary))
                }
            }
            if !needs.list.isEmpty {
                NeedsList(needs: needs, press: press)
                    .frame(maxWidth: 560)
                    .padding(.top, Cockpit.Space.s4)
            }
        }
        .padding(Cockpit.Space.s8)
        .padding(.top, Self.clear)
    }

    static let clear: CGFloat = 40

    static func clock(_ date: Date, zone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.hour, .minute, .second], from: date)
        return String(format: "%02d:%02d:%02d", parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
    }
}
