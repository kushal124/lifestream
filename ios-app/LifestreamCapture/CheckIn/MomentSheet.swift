import LifestreamCaptureCore
import SwiftUI

struct MomentSheet: View {
    @ObservedObject var model: CheckInModel
    var body: some View {
        CheckInFormView(model: model, title: "How are you, right now?", label: "Right now", detail: left)
    }
    private var left: String? {
        guard let prompt = model.prompt, prompt.expires > AppClock.now else { return nil }
        return Words.duration(max(60, prompt.expires.timeIntervalSinceNow)) + " left"
    }
}
