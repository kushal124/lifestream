import AVFoundation
import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

@MainActor
final class PairModel: ObservableObject {
    enum Step: Equatable {
        case cold(scanning: Bool)
        case link(PairingLink)
        case match(code: String, found: [FoundHome], at: Int)
        case which([PhoneChoice], ShippingService.PairingTarget)
        case unreachable(HomeLink.Cause, again: Retry)
        case nothingFound
        case notThisMac
        case codeRefused
        case paired(pressed: Pressed?)
    }

    enum Retry: Equatable { case link(PairingLink), code(String) }

    enum Pressed: Equatable { case pair, yes, which }

    static let stands: Duration = .seconds(1.2)

    @Published private(set) var step: Step {
        didSet { if step != oldValue { moving = Self.moves(step) } }
    }
    @Published var entered = "" {
        didSet {
            if let pasted = PairingLink(entered) {
                take(pasted)
                entered = ""
                return
            }
            let digits = String(entered.filter(\.isNumber).prefix(8))
            if digits != entered { entered = digits }
        }
    }
    @Published var name = PhoneLink.name()
    @Published var renaming = false
    @Published var account = ""
    @Published var changingAccount = false
    @Published private(set) var message: String?
    @Published private(set) var busy = false
    @Published private(set) var starting: HomeStarting.NotNow?
    @Published private(set) var cameraAllowed: Bool?
    var done: () -> Void = {}
    @Published private(set) var moving = false
    private var proved: HomeMove.Proof?
    private var waiting: Task<Void, any Error>?
    private var left = false

    init(link: PairingLink? = nil) {
        step = link.map(Step.link) ?? .cold(scanning: false)
        account = link?.account ?? ""
        moving = Self.moves(step)
    }

    private static func moves(_ step: Step) -> Bool {
        switch step {
        case .link(let link): HomeMove.moves(held: held(), to: link.fingerprint)
        case .match(_, let found, let at): HomeMove.moves(held: held(), to: found[at].fingerprint)
        default: false
        }
    }

    private static func held() -> HomeMove.Held? {
        let link = AppRuntime.shared.shipping.link
        do { return try link.name() == nil ? .unpaired : .paired(pin: try link.pin()) } catch { return nil }
    }

    var code: String? { entered.count == 8 ? entered : nil }

    var match: String? {
        guard case .match(let code, let found, let at) = step else { return nil }
        return found[at].match(code: code)
    }

    var macAccount: String? {
        if case .link(let link) = step { link.account } else { nil }
    }

    var scanning: Bool { step == .cold(scanning: true) }

    var standing: Bool {
        if case .paired(_?) = step { true } else { false }
    }

    var stated: String? {
        let typed = account.trimmingCharacters(in: .whitespacesAndNewlines)
        return typed.isEmpty ? nil : typed
    }

    func standsPaired() {
        guard case .cold = step else { return }
        step = .paired(pressed: nil)
    }

    func look() async {
        guard case .link(let link) = step else { return }
        let failure = await AppRuntime.shared.shipping.link.look(for: link)
        guard step == .link(link), !busy, failure == .notTheHome else { return }
        step = .notThisMac
    }

    func scan() async {
        if AVCaptureDevice.authorizationStatus(for: .video) == .authorized {
            cameraAllowed = true
        } else {
            cameraAllowed = await AVCaptureDevice.requestAccess(for: .video)
        }
        if cameraAllowed == true, case .cold = step { step = .cold(scanning: true) }
    }

    func scanned(_ text: String) {
        guard let link = PairingLink(text) else {
            message = "That is not a Lifestream pairing code."
            return
        }
        take(link)
    }

    private func take(_ link: PairingLink) {
        guard case .cold = step else { return }
        step = .link(link)
        account = link.account ?? ""
        message = nil
        Task { await look() }
    }

    func find(_ again: String? = nil) async {
        guard !busy, let code = again ?? code else { return }
        busy = true
        defer { busy = false }
        message = nil
        let homes = await AppRuntime.shared.shipping.link.find()
        if homes.isEmpty {
            let cause = Self.cause(at: [])
            step = cause == .silent ? .nothingFound : .unreachable(cause, again: .code(code))
        } else {
            step = .match(code: code, found: homes, at: 0)
        }
    }

    func pair() async {
        switch step {
        case .link(let link): await pair(.link(link), pressed: .pair)
        case .match(let code, let found, let at): await pair(.found(code: code, home: found[at]), pressed: .yes)
        default: break
        }
    }

    func notThisOne() {
        guard case .match(let code, let found, let at) = step else { return }
        step = at + 1 < found.count ? .match(code: code, found: found, at: at + 1) : .notThisMac
    }

    func pair(as phone: WhichPhone) async {
        guard case .which(_, let target) = step else { return }
        await pair(target, phone: phone, pressed: .which)
    }

    private func pair(_ target: ShippingService.PairingTarget, phone: WhichPhone = .unsaid, pressed: Pressed) async {
        guard !busy else { return }
        busy = true
        left = false
        defer {
            busy = false
            starting = nil
        }
        message = nil
        renaming = false
        let mac = target.fingerprint
        if HomeMove.moves(held: Self.held(), to: mac), proved?.covers(mac, turn: LifeLock.shared.turn) != true {
            guard await LifeLock.shared.prove("Move this iPhone to another Mac.") else {
                message = "Not moved. This iPhone still sends to the Mac it's paired with."
                return
            }
            proved = HomeMove.Proof(mac: mac, turn: LifeLock.shared.turn)
        }
        do {
            let waiting = Task {
                try await HomeStarting.again(heard: { self.starting = $0 }) { try await self.pairing(target, as: phone) }
            }
            self.waiting = waiting
            if left { waiting.cancel() }
            defer { self.waiting = nil }
            try await withTaskCancellationHandler { try await waiting.value } onCancel: { waiting.cancel() }
            guard !left else {
                step = .paired(pressed: nil)
                return
            }
            step = .paired(pressed: pressed)
            try? await Task.sleep(for: Self.stands)
            step = .paired(pressed: nil)
            done()
        } catch _ where left {
        } catch LinkFailure.whichPhone(let phones) {
            step = .which(phones, target)
        } catch LinkFailure.noAnswer {
            switch target {
            case .link(let link): unreachable(at: link.addresses, again: .link(link))
            case .found(let code, _): unreachable(at: [], again: .code(code))
            }
        } catch LinkFailure.notTheHome {
            step = .notThisMac
        } catch LinkFailure.refused(_, "PAIR_CODE", _) {
            step = .codeRefused
        } catch {
            message = Self.said(error)
        }
    }

    private func pairing(_ target: ShippingService.PairingTarget, as phone: WhichPhone) async throws {
        let shipping = AppRuntime.shared.shipping
        do {
            try await shipping.pair(target, account: stated, name: PhoneLink.name(name), phone: phone)
        } catch LinkFailure.whichPhone(let phones) where phone == .unsaid {
            guard let unit = shipping.shipper.unit, phones.contains(where: { $0.unit == unit }) else {
                throw LinkFailure.whichPhone(phones)
            }
            try await shipping.pair(target, account: stated, name: PhoneLink.name(name), phone: .continuing(unit))
        }
    }

    func leave() {
        left = true
        waiting?.cancel()
    }

    private func unreachable(at addresses: [URL], again: Retry) {
        step = .unreachable(Self.cause(at: addresses), again: again)
    }

    private static func cause(at addresses: [URL]) -> HomeLink.Cause {
        guard let facts = AppRuntime.shared.shipping.link.network?.facts else { return .silent }
        return HomeLink.Cause.of(facts, homeListsTailscale: HomeLink.listsTailscale(addresses)) ?? .silent
    }

    func retry() async {
        guard case .unreachable(_, let again) = step else { return }
        switch again {
        case .link(let link):
            step = .link(link)
            await pair()
        case .code(let code):
            await find(code)
        }
    }

    func again() {
        step = .cold(scanning: false)
        entered = ""
        account = ""
        changingAccount = false
        message = nil
    }

    private static func said(_ error: any Error) -> String {
        switch error as? LinkFailure {
        case .tooOld?: "Your Mac needs a newer Lifestream on this iPhone. Update the app, then pair."
        case .account?: LinkFailure.account.description
        case .credentials?: "This iPhone couldn't keep its pairing. Unlock it and try again."
        case .unavailable(HomeStarting.code, _, _, _)?: HomeStarting.said(HomeStarting.notNow(error)!)
        case .unavailable?: "Your Mac can't pair now. Try again in a moment."
        default: "Your Mac didn't pair this iPhone. Try again."
        }
    }
}

struct PairColumn: View {
    @ObservedObject var model: PairModel
    @Environment(\.openURL) private var openURL
    @FocusState private var typing: Bool

    var body: some View {
        switch model.step {
        case .cold(let scanning):
            FirstRunColumn("Set it up on your Mac first", pictureShown: !typing || scanning) {
                if scanning {
                    QRScanner { model.scanned($0) }
                        .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
                        .accessibilityLabel("Camera view for the pairing code")
                } else {
                    MacStepPicture()
                }
            } line: {
                FirstRunLine("Lifestream lives on your Mac. Open it there, go to its iPhone step, and scan the code it shows. No Lifestream on your Mac yet? Get it at trylifestream.com.")
            } below: {
                VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                    Field("The eight digits", text: $model.entered, placeholder: "Or type the eight digits", focus: $typing, spaces: false)
                        .keyboardType(.numberPad)
                        .accessibilityIdentifier("pairing.code.field")
                    if model.cameraAllowed == false {
                        Text("The camera is off for Lifestream. Type the code instead, or allow the camera in Settings.")
                            .cockpit(.footnote)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("pairing.camera-off")
                    }
                    failure
                }
            }
            .firstRunScreen("pairing.cold")
        case .link:
            FirstRunColumn(model.moving ? HomeMove.title : "Pair with your Mac") { PairPicture(joined: false) } line: {
                FirstRunLine(model.moving ? HomeMove.line : "This iPhone will send what it records to Lifestream on your Mac.")
            } below: {
                VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                    PhonePanel(model: model)
                    failure
                }
            }
            .firstRunScreen("pairing.link")
        case .match:
            FirstRunColumn("Does your Mac show \(model.match ?? "")?") { PairPicture(joined: false) } line: {
                if model.moving { FirstRunLine(HomeMove.line) }
            } below: {
                VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                    PhonePanel(model: model)
                    failure
                }
            }
            .firstRunScreen("pairing.match")
        case .which(let phones, _):
            FirstRunColumn("Is this iPhone replacing one of these?") { EmptyView() } line: {
                FirstRunLine("Your Mac already has these phones.")
            } below: {
                VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                    Card(group: true) {
                        ForEach(Array(phones.enumerated()), id: \.element.unit) { index, phone in
                            ListRow(phone.model,
                                    meta: phone.lastShipped.map { "Last synced \(Words.ago($0))" } ?? "Never synced",
                                    leading: .symbol(.phoneScreen), chevron: true, separator: index < phones.count - 1,
                                    action: { Task { await model.pair(as: .continuing(phone.unit)) } })
                            .accessibilityIdentifier("pairing.phone.\(phone.unit)")
                        }
                    }
                    .disabled(model.busy)
                    failure
                }
            }
            .firstRunScreen("pairing.which")
        case .unreachable(let cause, _):
            let said = ReachWords.pairing(cause)
            FirstRunColumn(said.title) { PairPicture(joined: false) } line: {
                FirstRunLine(said.fix)
            } below: {
                Card(group: true) {
                    ListRow("Local network", meta: "Lifestream needs it to find your Mac", leading: .symbol(.online),
                            separator: false, control: .act("Open Settings", busy: false, perform: {
                                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                            })) { EmptyView() }
                        .accessibilityIdentifier("pairing.local-network")
                }
            }
            .firstRunScreen("pairing.unreachable")
        case .nothingFound:
            FirstRunColumn("Pair with your Mac") { PairPicture(joined: false) } line: {
                FirstRunLine(HomeLink.nothingFound)
            }
            .firstRunScreen("pairing.nothing-found")
        case .notThisMac:
            FirstRunColumn("This isn't your Mac") { PairPicture(joined: false) } line: {
                FirstRunLine("What answered shows a different code. Scan again, on the same Wi-Fi as your Mac or on Tailscale.")
            }
            .firstRunScreen("pairing.not-this-mac")
        case .codeRefused:
            FirstRunColumn("This code no longer pairs") { PairPicture(joined: false) } line: {
                FirstRunLine("Your Mac shows a new one in its iPhone step. Scan it, or type its eight digits.")
            }
            .firstRunScreen("pairing.code-refused")
        case .paired:
            FirstRunColumn("Paired") { PairPicture(joined: true) } line: {
                EmptyView()
            }
            .firstRunScreen("pairing.paired")
        }
    }

    @ViewBuilder private var failure: some View {
        if let starting = model.starting {
            Text(HomeStarting.shown(starting))
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("pairing.starting")
        } else if let message = model.message {
            InPlaceLine(message)
                .accessibilityIdentifier("pairing.message")
        }
    }
}

struct PairFoot: View {
    @ObservedObject var model: PairModel
    let later: () -> Void

    var body: some View {
        let done = model.standing ? "Paired" : nil
        switch model.step {
        case .which, .paired(pressed: .which):
            FirstRunFoot(done: done) {
                Button("No, this is another iPhone") { Task { await model.pair(as: .another) } }
                    .buttonStyle(.cockpit(.secondary, size: .large, busy: model.busy, fullWidth: true))
                    .accessibilityIdentifier("pairing.another")
            } plain: {
                pairLater
            }
        case .match, .paired(pressed: .yes):
            FirstRunFoot(done: done) {
                Button("Yes") { Task { await model.pair() } }
                    .buttonStyle(.cockpit(.primary, size: .large, busy: model.busy, fullWidth: true))
                    .accessibilityIdentifier("pairing.yes")
            } plain: {
                Button("No") { model.notThisOne() }
                    .buttonStyle(.cockpit(.plain, fullWidth: true))
                    .disabled(model.busy)
                    .accessibilityIdentifier("pairing.no")
            }
        case .paired(pressed: nil):
            FirstRunFoot {
                Button("Continue", action: later)
                    .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                    .accessibilityIdentifier("firstrun.continue")
            }
        default:
            FirstRunFoot(done: done) {
                primary
            } plain: {
                pairLater
            }
        }
    }

    private var pairLater: some View {
        Button("Pair later") {
            model.leave()
            later()
        }
        .buttonStyle(.cockpit(.plain, fullWidth: true))
        .disabled(model.busy && model.starting == nil)
        .accessibilityIdentifier("pairing.later")
    }

    @ViewBuilder private var primary: some View {
        switch model.step {
        case .link, .paired(pressed: .pair):
            Button("Pair") { Task { await model.pair() } }
                .buttonStyle(.cockpit(.primary, size: .large, busy: model.busy, fullWidth: true))
                .accessibilityIdentifier("pairing.confirm")
        case .unreachable:
            Button("Try again") { Task { await model.retry() } }
                .buttonStyle(.cockpit(.primary, size: .large, busy: model.busy, fullWidth: true))
                .accessibilityIdentifier("pairing.retry")
        case .nothingFound:
            Button("Scan the code") {
                model.again()
                Task { await model.scan() }
            }
            .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
            .accessibilityIdentifier("pairing.scan")
        case .notThisMac, .codeRefused:
            Button("Scan again") { model.again() }
                .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                .accessibilityIdentifier("pairing.again")
        default:
            if model.code != nil {
                Button("Find your Mac") { Task { await model.find() } }
                    .buttonStyle(.cockpit(.primary, size: .large, busy: model.busy, fullWidth: true))
                    .accessibilityIdentifier("pairing.find")
            } else if model.cameraAllowed == false {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                .accessibilityIdentifier("pairing.settings")
            } else {
                Button("Scan the code") { Task { await model.scan() } }
                    .buttonStyle(.cockpit(.primary, size: .large, busy: model.scanning, fullWidth: true))
                    .accessibilityIdentifier("pairing.scan")
            }
        }
    }
}

private struct PhonePanel: View {
    @ObservedObject var model: PairModel
    @FocusState private var naming: Bool
    @FocusState private var typing: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            Card(group: true) {
                VStack(spacing: 0) {
                    nameRow
                    Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border)
                        .padding(.leading, Cockpit.Space.s4 + Cockpit.Size.avatarRow + Cockpit.Space.s3)
                    accountRow
                }
            }
            .disabled(model.busy)
            if model.stated == nil { AppleIDWaits() }
        }
    }

    private var nameRow: some View {
        row(.phoneScreen) {
            if model.renaming {
                TextField("Name", text: $model.name)
                    .cockpit(.rowTitle)
                    .foregroundStyle(Cockpit.Color.text)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($naming)
                    .onAppear { naming = true }
                    .onSubmit {
                        model.name = PhoneLink.name(model.name)
                        model.renaming = false
                    }
                    .accessibilityIdentifier("pairing.name.field")
            } else {
                Text(model.name)
                    .cockpit(.rowTitle)
                    .foregroundStyle(Cockpit.Color.text)
                    .accessibilityIdentifier("pairing.name")
            }
            Text("This iPhone").cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
        } act: {
            if !model.renaming {
                Button("Rename") { model.renaming = true }
                    .buttonStyle(.cockpit(.plain, size: .small))
                    .accessibilityIdentifier("pairing.rename")
            }
        }
    }

    private var accountRow: some View {
        let field = model.changingAccount || model.macAccount == nil
        return row(.person) {
            if field {
                TextField("Apple ID", text: $model.account,
                          prompt: Text("Email or phone number").foregroundStyle(Cockpit.Color.textTertiary))
                    .cockpit(.rowTitle)
                    .foregroundStyle(Cockpit.Color.text)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($typing)
                    .onAppear { if model.changingAccount { typing = true } }
                    .accessibilityIdentifier("pairing.account.field")
                Text("Apple ID").cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
            } else {
                Text(model.account)
                    .cockpit(.rowTitle)
                    .foregroundStyle(Cockpit.Color.text)
                    .accessibilityIdentifier("pairing.account")
                Text("Same Apple ID as your Mac")
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .accessibilityIdentifier("pairing.account.mac")
            }
        } act: {
            if !field {
                Button("Change") { model.changingAccount = true }
                    .buttonStyle(.cockpit(.plain, size: .small))
                    .accessibilityIdentifier("pairing.account.change")
            }
        }
    }

    private func row<Words: View, Act: View>(_ icon: Cockpit.Icon, @ViewBuilder words: () -> Words,
                                             @ViewBuilder act: () -> Act) -> some View {
        HStack(spacing: Cockpit.Space.s3) {
            Icon(icon, size: .md)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(width: Cockpit.Size.avatarRow, height: Cockpit.Size.avatarRow)
            VStack(alignment: .leading, spacing: 2) { words() }
                .frame(maxWidth: .infinity, alignment: .leading)
            act()
        }
        .padding(.horizontal, Cockpit.Space.s4)
        .padding(.vertical, Cockpit.Space.s2)
        .frame(minHeight: 60)
    }
}

struct PairingView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: PairModel

    init(link: PairingLink? = nil) {
        _model = StateObject(wrappedValue: PairModel(link: link))
    }

    var body: some View {
        FirstRunFrame {
            PairColumn(model: model)
        } foot: {
            PairFoot(model: model) { dismiss() }
        }
        .task {
            model.done = { dismiss() }
            await model.look()
        }
        .tint(Cockpit.Color.text)
    }
}

struct AppleIDWaits: View {
    var body: some View {
        Text("Health, Photos and Contacts start once you add your Apple ID.")
            .cockpit(.footnote)
            .foregroundStyle(Cockpit.Color.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("apple-id.waits")
    }
}

enum HomeMove {
    static let title = "Move this iPhone to another Mac?"
    static let line = "This iPhone sends to a Mac already. Pair here, and what it records goes to this Mac instead."

    enum Held: Equatable {
        case unpaired
        case paired(pin: String?)
    }

    static func moves(held: Held?, to fingerprint: String) -> Bool {
        switch held {
        case .unpaired: false
        case .paired(let pin?): pin != fingerprint
        case .paired(nil), nil: true
        }
    }

    struct Proof: Equatable {
        let mac: String
        let turn: Int

        func covers(_ mac: String, turn: Int) -> Bool { self.mac == mac && self.turn == turn }
    }
}

@MainActor
final class OpenedLink: ObservableObject {
    static let shared = OpenedLink()

    struct Pending: Identifiable {
        let id = UUID()
        let link: PairingLink
    }

    @Published var pending: Pending?

    func open(_ link: PairingLink) {
        pending = Pending(link: link)
    }
}

private struct QRScanner: UIViewRepresentable {
    let found: (String) -> Void

    func makeUIView(context: Context) -> ScannerView {
        let view = ScannerView()
        view.found = found
        view.start()
        return view
    }

    func updateUIView(_ view: ScannerView, context: Context) {
        view.found = found
    }

    static func dismantleUIView(_ view: ScannerView, coordinator: ()) {
        view.stop()
    }
}

private final class ScannerSession: @unchecked Sendable {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "org.lifestreamprotocol.pairing-scanner")
}

private final class ScannerView: UIView, AVCaptureMetadataOutputObjectsDelegate {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var found: (String) -> Void = { _ in }
    private let scanner = ScannerSession()

    func start() {
        let session = scanner.session
        guard let camera = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input) else { return }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        if let preview = layer as? AVCaptureVideoPreviewLayer {
            preview.session = session
            preview.videoGravity = .resizeAspectFill
        }
        scanner.queue.async { [scanner] in scanner.session.startRunning() }
    }

    func stop() {
        scanner.queue.async { [scanner] in scanner.session.stopRunning() }
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        guard let text = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
        MainActor.assumeIsolated { found(text) }
    }
}
