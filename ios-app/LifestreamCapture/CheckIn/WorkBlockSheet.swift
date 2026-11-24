import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct WorkBlockSheet: View {
    @ObservedObject var model: CheckInModel
    var body: some View {
        Group {
            if model.form == .blockAfter && model.status.history.runningBlock == nil {
                Drawer("Work block") {
                    VStack(spacing: Cockpit.Space.s2) {
                        Text("This block ended after three hours.")
                            .cockpit(.title3)
                            .foregroundStyle(Cockpit.Color.text)
                        Text("No answers were filled in.")
                            .cockpit(.body)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                }
            } else if model.form == .blockBefore {
                CheckInFormView(model: model, title: "What is this block for?", label: "Work block", action: "Start the block")
            } else {
                CheckInFormView(model: model, title: "How did the block go?", label: "Work block",
                    quote: model.block?.payload.ciArrayItem("what"),
                    detail: model.block?.payload.ciArrayItem("done_looks_like").map { "Done looks like \u{201C}\($0)\u{201D}" })
            }
        }.repeatWhileActive(every: .seconds(15)) { await model.refresh() }
    }
}

extension JSONValue {
    func ciArrayItem(_ id: String) -> String? {
        ciObject["items"]?.ciArray.first { $0.ciString("id") == id }?.ciString("value")
    }
}
