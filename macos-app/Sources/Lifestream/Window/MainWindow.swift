import AppKit
import Cockpit
import SwiftUI

struct MainWindow: View {
    @ObservedObject var web: WebContent
    @ObservedObject var host: MacHost

    var body: some View {
        ZStack {
            WebContentView(web: web, hidden: !web.loaded || web.failing)
            if web.failing {
                DashboardFailure(web: web, needs: host.needs) { need, button in
                    Task { try? await host.press(need, button) }
                }
            }
            LockedCover(needs: host.needs) { web.retry() }
        }
        .ignoresSafeArea()
        .groundColor(Cockpit.Color.canvas)
        .sheet(item: $host.sheet) { HostSheetView(host: host, sheet: $0) }
        .cockpitPlatform(.mac)
    }
}

struct HostSheetView: View {
    let host: MacHost
    let sheet: HostSheet

    var body: some View {
        switch sheet {
        case .vaultAllow: VaultAllowSheet(needs: host.needs)
        case .recoveryKey: RecoveryKeySheet(needs: host.needs) { host.needs.openKey(.lost) }
        case .password(let need, let secret): PasswordSheet(needs: host.needs, need: need, secret: secret)
        case .account(let connector, let route): AccountSheet(host: host, connector: connector, route: route)
        case .device(let connector, let route): DeviceSheet(host: host, connector: connector, route: route)
        case .client(let connector, let route, let client): ClientSheet(host: host, connector: connector, route: route, client: client)
        case .store(let asking, let name): StoreConsentSheet(host: host, asking: asking, name: name)
        }
    }
}

struct WebContentView: NSViewRepresentable {
    let web: WebContent
    let hidden: Bool

    func makeNSView(context: Context) -> NSView { web.container }

    func updateNSView(_ view: NSView, context: Context) {
        view.isHidden = hidden
        if hidden { web.resignFocus(in: view.window) }
    }
}
