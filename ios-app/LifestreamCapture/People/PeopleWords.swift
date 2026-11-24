import Foundation
import HomeLink
import LifestreamCaptureCore

enum PeopleWords {

    @MainActor static func network(_ id: String) -> String {
        ProductsBook.shared.names.name(of: id)
    }

    static func isNamed(_ person: HomeLink.Person) -> Bool {
        person.by != "none"
    }

    static func nobodyCalled(_ typed: String) -> String {
        "No one called \u{201C}\(typed)\u{201D}."
    }

    static func dialled(_ number: String) -> String {
        let digits = number.filter(\.isNumber)
        guard number.hasPrefix("+"), digits.count == number.count - 1 else { return number }
        func grouped(_ code: Int, _ sizes: [Int]) -> String {
            var rest = Substring(digits.dropFirst(code))
            var parts = ["+" + digits.prefix(code)]
            for size in sizes {
                parts.append(String(rest.prefix(size)))
                rest = rest.dropFirst(size)
            }
            return parts.joined(separator: " ")
        }
        switch (digits.prefix(1), digits.prefix(2), digits.count) {
        case ("1", _, 11): return grouped(1, [3, 3, 4])
        case (_, "91", 12): return grouped(2, [5, 5])
        case (_, "44", 12): return grouped(2, [4, 6])
        default: return number
        }
    }

    static func photo(_ photo: HomeLink.People.Photos.Photo, now: Date = AppClock.now) -> String {
        guard let ms = photo.atMs else { return "Photo" }
        return "Photo, " + Words.stamp(Words.date(ms: ms), now: now)
    }

    static func talkDay(_ day: String, now: Date) -> String {
        Words.rowDay(day, today: HomeClock.current.dayAt(now).day)
    }

    static func failure(_ failure: LifeReader.Failure) -> String? {
        switch failure {
        case .unpaired, .reach: nil
        case .busy(let words, _, _, _): words
        case .missing: "Lifestream doesn't have this."
        case .refused(let words), .failed(let words), .unknown(let words): "Lifestream could not answer: \(words)"
        }
    }
}
