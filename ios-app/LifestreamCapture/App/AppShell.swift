import AVFoundation
import Cockpit
import Combine
import SwiftUI
import UIKit

struct AppShell: View {
    @Bindable private var navigation = AppNavigation.shared
    @ObservedObject private var lock = LifeLock.shared
    @StateObject private var recording: VoiceRecordController
    @StateObject private var places = PlacesModel.live()
    @Environment(\.scenePhase) private var scenePhase
    private let runtime: AppRuntime

    init(runtime: AppRuntime) {
        self.runtime = runtime
        _recording = StateObject(wrappedValue: VoiceRecordController(recorder: runtime.voiceRecorder))
    }

    var body: some View {
        Group {
            if lock.isLocked {
                LockedApp()
            } else {
                tabs
                    .leadingDrawer(isPresented: $navigation.conversationsOpen, fromEdge: navigation.drawerFromEdge) {
                        AskConversations()
                    }
            }
        }
        .task {
            try? await Task.sleep(for: .milliseconds(400))
            navigation.openForDesign()
        }
        .fullScreenCover(isPresented: Binding(get: { navigation.presented == .camera }, set: { if !$0 { navigation.presented = nil } }), onDismiss: {
            let then = navigation.afterSheet
            navigation.afterSheet = nil
            then?()
        }) {
            CameraTabView()
        }
        .fullScreenCover(isPresented: Binding(get: { navigation.shown(locked: lock.isLocked) == .search }, set: { shown in
            if !shown, !lock.isLocked, navigation.presented == .search { navigation.presented = nil }
        }), onDismiss: {
            let then = navigation.afterSheet
            navigation.afterSheet = nil
            then?()
        }) {
            LifeGate(.search) { SearchTab() }
        }
        .environment(\.cockpitBarCovered, sheet != nil)
        .sheet(item: Binding(get: { sheet }, set: { shown in
            if shown == nil, navigation.presented == nil { recording.acknowledge() }
            navigation.presented = shown
        }), onDismiss: {
            let then = navigation.afterSheet
            navigation.afterSheet = nil
            then?()
        }) { presented in
            switch presented {
            case .streams:
                ConnectorsView().reachHead().presentationDragIndicator(.visible).cockpitSheet()
            case .search:
                EmptyView()
            case .reach:
                ReachDetailsSheet(close: { navigation.presented = nil })
            case .stream(let sheet):
                StreamSheetStack(sheet: sheet, close: { navigation.presented = nil }, leave: { navigation.whenClear($0) })
                    .readsStreams(open: sheet)
                    .reachHead()
            case .camera:
                EmptyView()
            case .notes(let opening):
                NotesRootView(opening: opening).presentationDragIndicator(.visible).cockpitSheet()
            case .voiceNote:
                VoiceNotePanel(controller: recording)
            }
        }
        .sheet(item: Binding(get: { lock.isLocked ? nil : navigation.checkInRoute }, set: { navigation.checkInRoute = $0 })) { route in
            CheckInFlowSheet(model: runtime.checkInModel, route: route)
        }
        .tint(Cockpit.Color.text)
        .onAppear { Interaction.firstFrame.mark() }
        .onChange(of: navigation.presented) { _, presented in
            if presented != nil { recording.stop() }
        }
        .onReceive(lock.$isLocked.removeDuplicates().dropFirst()) { locked in
            if !locked {
                Interaction.unlock.begin()
                Interaction.unlock.endAtCommit()
            }
        }
        .modifier(LifeArrivals(covered: sheet != nil))
        .onChange(of: scenePhase) { _, phase in
            PrivacyCover.shared.follow(phase)
            guard phase == .background else { return }
            lock.lock()
            if lock.isLocked {
                navigation.presented = nil
                navigation.checkInRoute = nil
            }
            recording.enteredBackground()
        }
        .onReceive(
            NotificationCenter.default
                .publisher(for: AVAudioSession.interruptionNotification)
                .receive(on: RunLoop.main)
        ) { notification in
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            recording.interrupted()
        }
        .environmentObject(places)
        .environment(\.voiceNotes, recording)
    }

    private var sheet: AppNavigation.Presented? {
        Self.sheet(presented: navigation.presented, shown: navigation.shown(locked: lock.isLocked), voice: recording.phase)
    }

    static func sheet(presented: AppNavigation.Presented?, shown: AppNavigation.Presented?,
                      voice: VoiceRecordController.Phase) -> AppNavigation.Presented? {
        guard presented != .camera, presented != .search else { return nil }
        return shown ?? (voice.showsPanel ? .voiceNote : nil)
    }

    private var tabs: some View {
        TabView(selection: $navigation.selectedTab) {
            Tab(value: AppNavigation.Tab.ask) {
                LifeGate(.ask) { AskTab() }
            } label: { tabLabel(.ask, .chat) }
            Tab(value: AppNavigation.Tab.days) {
                DaysTab()
            } label: { tabLabel(.days, .days) }
            Tab(value: AppNavigation.Tab.people) {
                LifeGate(.people) { PeopleTab() }
            } label: { tabLabel(.people, .people) }
            Tab(value: AppNavigation.Tab.places) {
                LifeGate(.places) { PlacesView(model: places) }
            } label: { tabLabel(.places, .places) }
            Tab(value: AppNavigation.Tab.agents) {
                AgentsTab()
            } label: { tabLabel(.agents, .agents) }
        }
    }
}

private struct LifeArrivals: ViewModifier {
    let covered: Bool
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var lock = LifeLock.shared
    private var navigation: AppNavigation { .shared }

    private var lifeInFront: AppNavigation.Tab? {
        guard scenePhase == .active else { return nil }
        if lock.isLocked, navigation.waitsBehindLock { return navigation.selectedTab }
        guard !covered, navigation.checkInRoute == nil else { return nil }
        return navigation.selectedTab
    }

    func body(content: Content) -> some View {
        content
            .onChange(of: navigation.selectedTab) { _, _ in lock.arrived() }
            .task(id: lifeInFront) {
                if lifeInFront != nil { await lock.askIfDue() }
            }
    }
}

@MainActor
private func tabLabel(_ tab: AppNavigation.Tab, _ meaning: Cockpit.Icon) -> some View {
    Label { Text(tab.title) } icon: { Image(icon: meaning) }
}

@MainActor
final class PrivacyCover {
    static let shared = PrivacyCover()
    private var window: UIWindow?

    nonisolated static func shows(_ phase: ScenePhase) -> Bool { phase != .active }

    func follow(_ phase: ScenePhase) {
        if Self.shows(phase) { draw() } else { remove() }
    }

    private func draw() {
        guard window == nil,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        window.rootViewController = UIHostingController(rootView: Cover())
        window.isHidden = false
        self.window = window
    }

    private func remove() {
        window?.isHidden = true
        window = nil
    }

    private struct Cover: View {
        @ObservedObject private var lock = LifeLock.shared

        var body: some View {
            Group {
                if lock.face == .open {
                    Cockpit.Color.canvas.ignoresSafeArea()
                } else {
                    LockCover(offersUnlock: false) {}
                }
            }
            .accessibilityHidden(true)
        }
    }
}
