import Cockpit

struct DeclaredStream {
    let id: String
    let name: String
    let icon: Cockpit.Icon
    let gives: String
    let noun: (String, String)?
    let grant: String?
    let misses: String?
    let why: String?
}

extension DeclaredStream {
    static let appleContacts = DeclaredStream(id: "apple-contacts", name: "Contacts", icon: .people,
        gives: "Every contact card, so names show instead of numbers.", noun: ("contact", "contacts"),
        grant: "contacts", misses: "the names of the people in them",
        why: "Every contact card, with its photo. So Lifestream knows who's who in your messages, calls and photos.")
    static let appleHealth = DeclaredStream(id: "apple-health", name: "Health", icon: .health,
        gives: "Sleep, steps, heart, and anything else you allow.", noun: ("sample", "samples"),
        grant: "health", misses: "sleep, steps and heart",
        why: "Sleep, steps, heart and anything else you choose. So your days show how you slept and how you felt.")
    static let applePhotos = DeclaredStream(id: "apple-photos", name: "Photos", icon: .photos,
        gives: "Every photo and video, with time and place.", noun: ("photo", "photos"),
        grant: "photos", misses: "your photos",
        why: "Every photo and video, with when and where you took it. So your days have their pictures.")
    static let camera = DeclaredStream(id: "camera", name: "Camera", icon: .photos,
        gives: "Each photo you take in the app.", noun: ("photo", "photos"),
        grant: nil, misses: nil, why: nil)
    static let checkin = DeclaredStream(id: "checkin", name: "Check-ins", icon: .checkIn,
        gives: "How you feel, asked twice a day.", noun: ("check-in", "check-ins"),
        grant: "notifications", misses: nil, why: nil)
    static let location = DeclaredStream(id: "location", name: "Location", icon: .places,
        gives: "Where you go, point by point.", noun: ("point", "points"),
        grant: "location", misses: "where you were",
        why: "Where you go, point by point. So your days show your places and the way between them.")
    static let motion = DeclaredStream(id: "motion", name: "Motion", icon: .walk,
        gives: "When you walk, run, drive or stay still.", noun: ("activity", "activities"),
        grant: "motion", misses: "how you moved",
        why: "When you walk, run, drive or stay still, and your steps. So your days show how you moved.")
    static let notes = DeclaredStream(id: "notes", name: "Lifestream notes", icon: .note,
        gives: "What you write and snap in Lifestream.", noun: ("note", "notes"),
        grant: nil, misses: nil, why: nil)
    static let screenTime = DeclaredStream(id: "screen-time", name: "Screen Time", icon: .phoneScreen,
        gives: "Which app you were in, on Mac and iPhone.", noun: ("app switch", "app switches"),
        grant: "screen-time", misses: "the apps you used",
        why: "Which app you were in, and when. So your days show how you spent your time on this iPhone.")
    static let upload = DeclaredStream(id: "upload", name: "Files you hand in", icon: .share,
        gives: "Each file you hand in, whole, with its name, path and dates.", noun: ("file", "files"),
        grant: nil, misses: nil, why: nil)
    static let voiceNotes = DeclaredStream(id: "voice-notes", name: "Voice notes", icon: .voiceNote,
        gives: "Each recording you make in Lifestream.", noun: ("voice note", "voice notes"),
        grant: nil, misses: nil, why: nil)
}

enum GrantWords {
    static let all: [String: [PermissionsModel.Stated: String]] = [
        "contacts": [
            .on: "On",
            .limited: "Some contacts",
            .off: "Off",
            .notNow: "Not now",
            .notAsked: "Not asked",
            .asked: "Asked",
            .asking: "Asking",
        ],
        "health": [
            .on: "On",
            .limited: "New data to allow",
            .off: "Off",
            .notNow: "Not now",
            .notAsked: "Not asked",
            .asked: "Asked",
            .asking: "Asking",
        ],
        "location": [
            .on: "On",
            .limited: "While Using only",
            .off: "Off",
            .notNow: "Not now",
            .notAsked: "Not asked",
            .asked: "Asked",
            .asking: "Asking",
        ],
        "motion": [
            .on: "On",
            .limited: "Limited",
            .off: "Off",
            .notNow: "Not now",
            .notAsked: "Not asked",
            .asked: "Asked",
            .asking: "Asking",
        ],
        "notifications": [
            .on: "On",
            .limited: "Limited",
            .off: "Off",
            .notNow: "Not now",
            .notAsked: "Not asked",
            .asked: "Asked",
            .asking: "Asking",
        ],
        "photos": [
            .on: "On",
            .limited: "Selected photos",
            .off: "Off",
            .notNow: "Not now",
            .notAsked: "Not asked",
            .asked: "Asked",
            .asking: "Asking",
        ],
        "screen-time": [
            .on: "On",
            .limited: "Limited",
            .off: "Off",
            .notNow: "Not now",
            .notAsked: "Not asked",
            .asked: "Asked",
            .asking: "Asking",
        ],
    ]
}
