import Cockpit
import Combine
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: CaptureAppModel
    @ObservedObject private var shipper = AppRuntime.shared.shipping.shipper
    private let permissions = PhoneNeeds.shared.permissions
    @ObservedObject private var opened = OpenedLink.shared
    @ObservedObject private var firstRun = AppRuntime.shared.firstRun

    private enum Step { case handingOver, firstRun, capturing }

    private var step: Step {
        if shipper.handedOver || shipper.saved?.replaced != nil { return .handingOver }
        return firstRun.facts.started ? .capturing : .firstRun
    }

    var body: some View {
        Group {
            switch step {
            case .handingOver: HandOverView(handedOver: shipper.handedOver, replaced: shipper.saved?.replaced)
            case .firstRun: FirstRunView(permissions: permissions) { firstRun.start() }
            case .capturing: AppShell(runtime: model.runtime)
            }
        }
        .sheet(item: step == .firstRun ? .constant(nil) : $opened.pending) { PairingView(link: $0.link) }
    }
}

enum Privacy {
    static let policy = URL(string: "https://trylifestream.com/privacy/phone/")!
}

struct HandOverView: View {
    let handedOver: Bool
    let replaced: Date?

    var body: some View {
        NavigationStack {
            ScrollView {
                Card(handedOver ? "Done" : "Handing over") {
                    Text(handedOver
                         ? "This install was replaced\(replaced.map { " on \(Words.longDate($0))" } ?? ""). Everything it held is in Lifestream. You can delete this app."
                         : "This phone's Lifestream moved to a new install. This one has stopped recording and is sending what it still holds to Lifestream.")
                        .cockpit(.body)
                        .foregroundStyle(Cockpit.Color.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("handover.words")
                }
                .padding(Cockpit.Space.s4)
            }
            .groundColor(Cockpit.Color.canvas)
            .navigationTitle("Lifestream")
        }
        .tint(Cockpit.Color.text)
    }
}
