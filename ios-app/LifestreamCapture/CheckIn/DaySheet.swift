import SwiftUI

struct DaySheet: View {
    @ObservedObject var model: CheckInModel
    var body: some View {
        CheckInFormView(model: model, title: model.form == .week ? "Life as a whole" : "How was today?",
            label: model.form == .week ? "This week" : "Today")
    }
}
