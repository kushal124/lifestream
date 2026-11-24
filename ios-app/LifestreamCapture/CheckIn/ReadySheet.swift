import LifestreamCaptureCore
import SwiftUI

struct ReadySheet: View {
    @ObservedObject var model: CheckInModel
    var body: some View {
        if model.form == .blockRework {
            CheckInFormView(model: model, title: "Looking back at yesterday", label: "Before work",
                action: "Save and continue", quote: model.block?.payload.ciArrayItem("what"))
        } else {
            CheckInFormView(model: model, title: "Ready to focus?", label: "Before work", action: "Start the test", detail: awake)
        }
    }
    private var awake: String? {
        model.wakeSchedule.map { "Awake " + Words.duration(max(60, AppClock.now.timeIntervalSince($0.wake))) }
    }
}
