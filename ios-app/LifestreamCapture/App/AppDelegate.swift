import Cockpit
import LifestreamCaptureCore
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        if AppRuntime.runsStill { UIView.setAnimationsEnabled(false) }
        UIWindow.appearance().tintColor = UIColor(Cockpit.Color.text)
        AppRuntime.shared.bootstrap(launchOptions: launchOptions)
        AppRuntime.shared.wakeCheckIns()
        return true
    }

    func applicationProtectedDataDidBecomeAvailable(_ application: UIApplication) {
        AppRuntime.shared.protectedDataDidBecomeAvailable()
        AppRuntime.shared.refreshUsage(.background)
        EnergyLedger.shared.count("unlocks")
        AppRuntime.shared.shipping.shipper.ask(.wake)
    }
}
