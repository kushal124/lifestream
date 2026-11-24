import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct DayScreen: View {
    private let start: String?
    private let root: Bool
    @ObservedObject private var days = DaysModel.shared
    @State private var current: String
    @State private var focusing: String?
    @State private var opened: Opened?
    @State private var photos: PhotoViewer.Opening?
    @State private var listing: Bool
    @State private var listMonth: String?
    @State private var pages: [String]
    @State private var shown: ScrollPosition
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(day: String? = nil, focus: String? = nil, month: String? = nil) {
        start = day
        root = day == nil && month == nil
        let opening = DaysModel.shared.opening
        _current = State(initialValue: day ?? opening)
        _focusing = State(initialValue: focus)
        _listing = State(initialValue: month != nil)
        _listMonth = State(initialValue: month)
        _pages = State(initialValue: Self.window(DaysModel.shared, start: day, current: day ?? opening))
        _shown = State(initialValue: ScrollPosition(id: day ?? opening))
    }

    private struct Opened: Identifiable {
        let id = UUID()
        let day: String
        let row: String
        let focus: String?
    }

    var body: some View {
        let today = days.today
        titled(today: today)
            .task { await days.readList() }
            .readsAgain(failed: { days.unlisted }) { await days.readList() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await days.readList() } }
            }
            .onChange(of: days.opening) { was, now in
                if current == was { current = now }
            }
            .onChange(of: days.pages) { jump(to: current) }
            .onChange(of: current) { jump(to: current, unlessInside: true) }
            .sheet(item: $opened) { opened in InspectorSheet(day: opened.day, focus: opened.focus ?? opened.row, marks: opened.focus == nil ? nil : []) }
            .photoViewer($photos) { AppNavigation.shared.push($0) }
    }

    private func titled(today: String) -> some View {
        let back = {
            jump(to: days.opening)
            turn(listing: false)
        }
        return faces(today: today).environment(\.dayHeadIndent, root ? 0 : 56).rootBar("Timeline", small: listing ? "Timeline" : Words.shortDay(current, today: today),
                presses: listing ? nil : SmallTitlePress(hint: DayRootTitle.hint, action: choose),
                pinsFoot: false) {
            HStack(spacing: Cockpit.Space.s4) {
                if !root {
                    IconButton(.back, label: "Back", style: .glass) { dismiss() }
                        .accessibilityIdentifier("day.back")
                        .padding(.leading, Cockpit.Space.s4 - Cockpit.Gap.edge)
                }
                if listing {
                    RootTitle("Timeline")
                } else {
                    DayRootTitle(day: current, word: days.relative(current),
                                 today: today, open: choose)
                }
            }
        } controls: {
            SearchControl()
            StreamsControl(slot: true)
            if listing {
                Button(action: back) {
                    Text("Today")
                        .cockpit(Cockpit.Style.iosHeadline)
                        .foregroundStyle(Cockpit.Color.text)
                        .padding(.trailing, Cockpit.Space.s4)
                        .frame(height: Cockpit.Size.target)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("days.today")
            } else {
                CaptureMenu(slot: true)
            }
        }
        .swipesBack(!root)
    }

    private func faces(today: String) -> some View {
        ZStack {
            days(today: today)
                .opacity(listing ? 0 : 1)
                .allowsHitTesting(!listing)
                .accessibilityHidden(listing)
            if listing {
                DaysList(month: listMonth, shown: current) { day in
                    jump(to: day)
                    turn(listing: false)
                }
                .transition(.opacity)
            }
        }
        .groundColor(Cockpit.Color.canvas)
        .safeAreaBar(edge: .bottom, spacing: 0) { Color.clear.frame(height: 0) }
    }

    private func days(today: String) -> some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                ForEach(pages, id: \.self) { day in
                    DayPage(
                        model: days.model(day), isToday: day == today, current: day == current && !listing,
                        near: !listing && abs((pages.firstIndex(of: day) ?? 0) - (pages.firstIndex(of: current) ?? 0)) == 1,
                        selected: opened?.day == day ? opened?.row : nil,
                        focus: day == start ? focusing : nil,
                        openRow: { opened = Opened(day: day, row: $0, focus: $1) },
                        focused: { focusing = nil },
                        photos: { hashes, at in photos = PhotoViewer.Opening(photos: hashes, at: at) },
                        first: days.first,
                        go: { jump(to: $0) },
                        choose: choose)
                    .containerRelativeFrame(.horizontal)
                    .accessibilityHidden(day != current)
                    .id(day)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollIndicators(.hidden)
        .scrollPosition($shown)
        .defaultScrollAnchor(opening, for: .initialOffset)
        .onChange(of: shown.viewID(type: String.self)) { _, day in
            if let day, day != current { current = day }
        }
    }

    private var opening: UnitPoint {
        let at = pages.firstIndex(of: current) ?? pages.count - 1
        return UnitPoint(x: pages.count > 1 ? Double(at) / Double(pages.count - 1) : 0, y: 0)
    }

    private func choose() {
        listMonth = nil
        turn(listing: true)
    }

    private func turn(listing: Bool) {
        withAnimation(reduceMotion ? nil : Cockpit.Ease.out(Cockpit.Duration.base)) { self.listing = listing }
    }

    private static let reach = 7
    private static let edge = 2

    private static func window(_ days: DaysModel, start: String?, current: String) -> [String] {
        let all = days.pages
        var at = 0, end = all.count
        while at < end {
            let mid = (at + end) / 2
            if all[mid] < current { at = mid + 1 } else { end = mid }
        }
        let from = max(0, at - reach), to = min(all.count, at + reach + 1)
        var pages = Array(all[from..<to])
        let unwritten = Set([start, current].compactMap { $0 }.filter { !days.written.contains($0) })
        for day in unwritten where (from == 0 || day > all[from - 1]) && (to == all.count || day < all[to]) {
            pages.insert(day, at: pages.firstIndex { $0 > day } ?? pages.endIndex)
        }
        return pages
    }

    private func jump(to day: String, unlessInside: Bool = false) {
        let inside = unlessInside && pages.firstIndex(of: day).map { $0 >= Self.edge && $0 < pages.count - Self.edge } == true
        let placed = inside ? pages : Self.window(days, start: start, current: day)
        let moved = placed != pages
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) {
            if moved { pages = placed }
            if day != current { current = day }
            if moved || shown.viewID(type: String.self) != day { shown.scrollTo(id: day) }
        }
    }
}
