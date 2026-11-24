import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct CheckInFormView: View {
    @ObservedObject var model: CheckInModel
    let title: String
    let label: String
    var action = "Save"
    var quote: String?
    var detail: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var answers: [String: JSONValue] = [:]
    @State private var note = ""
    @State private var changes = 0
    @State private var missing: String?
    @State private var opened = AppClock.now
    @State private var uptime = ProcessInfo.processInfo.systemUptime
    @FocusState private var focused: String?
    @AccessibilityFocusState private var accessibleFocus: String?

    var body: some View {
        ScrollViewReader { proxy in
            Drawer(title, edit: SheetEdit(keepLabel: action, identifier: "checkin") { try await save(proxy) }) {
                VStack(alignment: .leading, spacing: Cockpit.Space.s8) {
                    if quote != nil || detail != nil { VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                        if let quote {
                            Text("\u{201C}\(quote)\u{201D}").cockpit(.voiceL).foregroundStyle(Cockpit.Color.textSecondary)
                        }
                        if let detail {
                            Text(detail).cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
                        }
                    } }
                    ForEach(model.form.items) { item in
                        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                            if item.format == .text {
                                CheckInField(item.title, text: textBinding(item.id), focused: $focused, id: item.id)
                            } else {
                                CheckInRail(item: item, value: Binding(get: { answers[item.id] }, set: { answers[item.id] = $0 }), onChange: { changes += 1 })
                            }
                            if missing == item.id {
                                HStack(spacing: Cockpit.Space.s2) {
                                    SignalShape(.caution)
                                    Text(item.format == .text ? "Write a few words to save" : "Pick one to save")
                                        .cockpit(.footnote)
                                        .foregroundStyle(Cockpit.Color.caution)
                                        .accessibilityIdentifier("checkin.validation")
                                }
                            }
                        }.id(item.id).accessibilityFocused($accessibleFocus, equals: item.id)
                    }
                    if model.form == .day || model.form == .blockRework {
                        CheckInField("Anything Lifestream would miss?", prompt: "Add a note", text: $note, focused: $focused, id: "note")
                    }
                    if model.form == .prework {
                        Text("Then a three-minute reaction test. Ratings come first so the score cannot colour them.")
                            .cockpit(.footnote)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                    }
                    if let error = model.error { InPlaceLine(error) }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            #if DEBUG
            .onAppear {
                guard ProcessInfo.processInfo.arguments.contains("--ui-test-chosen") else { return }
                for (index, item) in model.form.items.enumerated() { answers[item.id] = .integer(Int64(index == 0 ? 5 : 3)) }
            }
            #endif
        }
        .tint(Cockpit.Color.text)
    }

    private func save(_ proxy: ScrollViewProxy) async throws -> SheetEdit.Kept {
        if let item = model.form.items.first(where: { !$0.accepts(answers[$0.id]) }) {
            missing = item.id
            withAnimation(reduceMotion ? nil : Cockpit.Ease.out(Cockpit.Duration.fast)) { proxy.scrollTo(item.id, anchor: .center) }
            accessibleFocus = item.id
            if item.format == .text { focused = item.id }
            return .stay
        }
        missing = nil; focused = nil
        return try await model.save(answers: answers, note: note, opened: opened, uptime: uptime, changes: changes) ? .close : .stay
    }
    private func textBinding(_ id: String) -> Binding<String> {
        Binding(get: { if case .string(let value) = answers[id] { value } else { "" } }, set: { answers[id] = .string($0) })
    }
}

private struct CheckInField: View {
    let question: String
    let prompt: String?
    @Binding var text: String
    let focused: FocusState<String?>.Binding
    let id: String
    init(_ question: String, prompt: String? = nil, text: Binding<String>, focused: FocusState<String?>.Binding, id: String) {
        self.question = question
        self.prompt = prompt
        self._text = text
        self.focused = focused
        self.id = id
    }
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous)
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            Text(question)
                .cockpit(.headline)
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true)
            TextField(question, text: $text, prompt: Text(prompt ?? "").foregroundStyle(Cockpit.Color.textTertiary), axis: .vertical)
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.text)
                .focused(focused, equals: id)
                .accessibilityIdentifier("checkin.\(id)")
                .padding(.horizontal, Cockpit.Space.s3)
                .padding(.vertical, Cockpit.Space.s3)
                .frame(minHeight: Cockpit.Size.target)
                .background(shape.fill(Cockpit.Color.well))
                .overlay(shape.strokeBorder(focused.wrappedValue == id ? Cockpit.Color.focus : Color.clear,
                                            lineWidth: Cockpit.Stroke.border))
        }
    }
}

struct CheckInFlowSheet: View {
    @ObservedObject var model: CheckInModel
    let route: CheckInRoute
    var body: some View {
        Group {
            if !model.loaded { Loading() }
            else if let session = model.session { VigilanceView(session: session, model: model) }
            else {
                Group {
                    switch model.form {
                    case .moment: MomentSheet(model: model)
                    case .day, .week: DaySheet(model: model)
                    case .prework, .blockRework: ReadySheet(model: model)
                    case .blockBefore, .blockAfter: WorkBlockSheet(model: model)
                    }
                }
                .id(model.form.rawValue + (model.block?.payload.ciString("block_id") ?? ""))
                .drawerRest()
            }
        }
        .task(id: route.id) { await model.prepare(route) }
    }
}
