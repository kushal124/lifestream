import Foundation
import HomeLink

enum CannedScale {
    static let factor: Double? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let at = arguments.firstIndex(of: "--ui-test-scale"), at + 1 < arguments.count else { return nil }
        return Double(arguments[at + 1]).flatMap { $0 > 0 ? $0 : nil }
    }()

    private static func count(_ live: Int) -> Int { Int((Double(live) * (factor ?? 0)).rounded()) }

    private static func draw(_ index: Int, _ salt: UInt64) -> Double {
        var x = UInt64(truncatingIfNeeded: index) &* 0x9E37_79B9_7F4A_7C15 &+ salt
        x = (x ^ (x >> 30)) &* 0xBF58_476D_1CE4_E5B9
        x = (x ^ (x >> 27)) &* 0x94D0_49BB_1331_11EB
        x ^= x >> 31
        return Double(x >> 11) / Double(1 << 53)
    }

    private static func word(_ index: Int) -> String {
        let consonants = Array("bdfgklmnprstvz"), vowels = Array("aeiou")
        var n = index, letters: [Character] = []
        repeat {
            letters.append(consonants[n % consonants.count])
            n /= consonants.count
            letters.append(vowels[n % vowels.count])
            n /= vowels.count
        } while n > 0
        return String(letters).capitalized
    }

    static func mapped(_ route: String, day: String, _ make: () -> [String: Any]) -> Data {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("speed-\(route)-x\(factor ?? 0)-\(day).json")
        return lock.withLock {
            if let held = try? Data(contentsOf: url, options: .alwaysMapped) { return held }
            try? JSONSerialization.data(withJSONObject: make()).write(to: url, options: .atomic)
            return (try? Data(contentsOf: url, options: .alwaysMapped)) ?? Data()
        }
    }

    private static let lock = NSLock()


    private static let liveAges: [(Double, Double)] = [(0, 0), (0.01, 6), (0.1, 91), (0.5, 702), (0.9, 2456), (1, 4000)]

    private static func age(_ q: Double) -> Double {
        for (lower, upper) in zip(liveAges, liveAges.dropFirst()) where q <= upper.0 {
            return lower.1 + (upper.1 - lower.1) * (q - lower.0) / (upper.0 - lower.0)
        }
        return 4000
    }

    private static func number(_ index: Int) -> String { String(format: "1555%07d", index % 10_000_000) }

    static func people(now: Date) -> (people: [[String: Any]], chats: [[String: Any]]) {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        let groups = count(753), mineGroups = count(581)
        let direct = count(5_106) - groups
        var chats: [[String: Any]] = []
        chats.reserveCapacity(direct + groups)
        for g in 0..<groups {
            let last = nowMs - Int64(age(draw(g, 7)) * 86_400_000)
            chats.append(["key": "whatsapp:120363\(String(format: "%09d", g))@g.us", "network": "whatsapp",
                          "chat": "120363\(String(format: "%09d", g))@g.us", "group": true,
                          "label": "Group " + word(g + 40), "total": 50 + Int(draw(g, 8) * 5000),
                          "mine": g < mineGroups ? 1 + Int(draw(g, 9) * 400) : 0,
                          "first_ms": last - 400 * 86_400_000, "last_ms": last,
                          "quiet": g < mineGroups ? NSNull() as Any : ["why": "silent", "last_day": NSNull()] as Any, "word": NSNull()])
        }
        var people: [[String: Any]] = []
        let total = count(18_311)
        people.reserveCapacity(total)
        for i in 0..<total {
            let kind = draw(i, 1)
            let by = kind < 0.634 ? "none" : kind < 0.911 ? "push-name" : kind < 0.973 ? "contact" : "provider"
            let phone = "+" + number(i + 100)
            let name = by == "none" ? phone : word(i % 9_000 + 200) + " " + word(i / 9_000 + 9_000)
            let network = draw(i, 2) < 0.99 ? "whatsapp" : "imessage"
            let key = network == "whatsapp" ? "whatsapp:\(number(i + 100))@s.whatsapp.net" : "imessage:\(phone)"
            let sent = draw(i, 3) < 0.109 ? 1 + Int(draw(i, 4) * 900) : 0
            let received = sent + Int(draw(i, 5) * 1200)
            let ageDays = age(draw(i, 6))
            let last = nowMs - Int64(ageDays * 86_400_000)
            var theirChats: [[String: Any]] = []
            if i < direct {
                theirChats.append(["key": key, "count": received])
                chats.append(["key": key, "network": network, "chat": String(key.drop { $0 != ":" }.dropFirst()), "group": false,
                              "label": name, "total": received + sent, "mine": sent, "first_ms": last - 300 * 86_400_000, "last_ms": last])
            }
            if groups > 0, draw(i, 10) < 0.67 {
                theirChats.append(["key": "whatsapp:120363\(String(format: "%09d", i % groups))@g.us", "count": 1 + received / 4])
            }
            people.append([
                "id": "person:filler-\(i)", "name": name, "by": by, "person": NSNull(),
                "handles": [["id": "phone:\(phone)", "kind": "phone", "network": NSNull(), "words": phone, "from": NSNull()]], "networks": [network], "chats": theirChats,
                "received": received, "sent": sent, "first_ms": last - 300 * 86_400_000, "last_ms": last,
                "last_30": ageDays < 30 ? 1 + Int(draw(i, 11) * 200) : 0, "days_count": 1 + Int(draw(i, 12) * 300),
                "last_day": ageDays < 1 ? 1 + Int(draw(i, 13) * 20) : 0,
            ])
        }
        return (people, chats)
    }


    static var listed: Int { count(5_305) }

    static func marked(_ file: HomeLink.DayFile) -> HomeLink.DayFile {
        HomeLink.DayFile(day: file.day, window: file.window,
                         renderer: file.renderer, inputs: file.inputs + "-x\(count(1_341))",
                         counts: .init(total: max(file.atoms.count, count(1_341)), perFamily: file.counts.perFamily),
                         coverage: file.coverage, atoms: file.atoms)
    }

    static func padded(_ file: HomeLink.DayFile) -> HomeLink.DayFile {
        let wanted = count(1_341)
        guard !file.atoms.isEmpty, file.atoms.count < wanted else { return file }
        var atoms = file.atoms
        var n = (file.atoms.map(\.n).max() ?? 0) + 1
        var round = 1
        while atoms.count < wanted {
            for atom in file.atoms where atoms.count < wanted {
                let shift = Int64(round) * 60_000
                atoms.append(HomeLink.DayFile.Atom(
                    n: n, family: atom.family, unit: atom.unit + "#\(round)", startMs: atom.startMs.map { $0 + shift },
                    endMs: atom.endMs.map { $0 + shift }, localStart: atom.localStart, localEnd: atom.localEnd, flags: atom.flags,
                    text: atom.text, record: atom.record, item: atom.item, block: atom.block))
                n += 1
            }
            round += 1
        }
        atoms.sort { ($0.startMs ?? 0, $0.n) < ($1.startMs ?? 0, $1.n) }
        return HomeLink.DayFile(day: file.day, window: file.window,
                                renderer: file.renderer, inputs: file.inputs, counts: file.counts, coverage: file.coverage, atoms: atoms)
    }


    static func places(now: Date, town: [String: Any]) -> (places: [[String: Any]], spots: [[String: Any]]) {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        func area(_ index: Int) -> [String: Any] {
            let k = index % 8
            if k == 0 { return town }
            return ["city": "Synthetic City \(word(k))", "city_id": "36.\(k)0000,-121.\(k)0000 Synthetic City \(word(k))",
                    "region": "Other Region", "country": "Synthetic Country", "country_code": "XS"]
        }
        func visits(_ index: Int) -> [String: Any] {
            let days = 1 + Int(draw(index, 21) * 300)
            let last = nowMs - Int64(age(draw(index, 22)) * 86_400_000)
            return ["stays": days + Int(draw(index, 23) * 100), "days": days, "hours": Double(days) * 2.5, "longest_day_hours": 6.0,
                    "first_ms": last - Int64(days) * 86_400_000, "last_ms": last]
        }
        let places = (0..<max(0, count(40) - 2)).map { i -> [String: Any] in
            ["slug": "filler-place-\(i)", "name": "Place " + word(i + 300) + (i % 9 == 4 ? " Synthetic Coffee Roasters | Northern Harbour Branch" : ""),
             "latitude": 37.30 + draw(i, 24) * 0.1,
             "longitude": -122.05 + draw(i, 25) * 0.1, "radius_m": 100, "also": [Any](), "ids": [String](), "area": area(i),
             "today_hours": 0]
                .merging(visits(i)) { _, counted in counted }
        }
        let spots = (0..<max(0, count(2_910) - 3)).map { i -> [String: Any] in
            let counted = visits(i + 50_000)
            return ["latitude": 37.20 + draw(i, 26) * 0.3, "longitude": -122.20 + draw(i, 27) * 0.3, "worth": false, "area": area(i),
                    "ask_home": NSNull()]
                .merging(counted) { _, counted in counted }
        }
        return (places, spots)
    }
}
