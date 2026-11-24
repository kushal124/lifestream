import Evidence
import Recorder
import Screen
import Shipping

@MainActor protocol ScreenRecording: AnyObject, Sendable {
    var modes: RecordingModes { get }
    var captureInterval: Double { get }
    var modesSet: ((RecordingModes) throws -> Void)? { get set }
    func take(interval: Double, idlePauseAfter: Double?, ocr: OCRMode)
    func setModes(_ next: RecordingModes) throws
}

extension Recorder: ScreenRecording {
    var captureInterval: Double { configuration.interval }
}

@MainActor enum ScreenSettings {
    static func defaults(_ options: Options, modes: RecordingModes) -> MacSettings.Values {
        var screen: [String: MacSettings.JSON] = [
            "refresh": .string(MacSettings.words(options.interval)),
            "ocr": .string(options.ocr.rawValue),
            "apps": AppsField.of(modes),
        ]
        if let idle = options.idleAfter { screen["idle_pause"] = .string(MacSettings.words(idle)) }
        return ["screen": screen]
    }

    static func apply(_ settings: MacSettings, to recorder: some ScreenRecording) {
        let seconds = { (member: String) in settings.value("screen", member)?.string.flatMap(MacSettings.seconds) }
        recorder.take(interval: seconds("refresh") ?? recorder.captureInterval, idlePauseAfter: seconds("idle_pause"),
                      ocr: settings.value("screen", "ocr")?.string.flatMap(OCRMode.init(rawValue:)) ?? .exact)
        guard let field = settings.value("screen", "apps"), let modes = AppsField.modes(field, current: recorder.modes) else { return }
        try? recorder.setModes(modes)
    }

    static func join(_ settings: MacSettings, _ recorder: some ScreenRecording, knock: @escaping @MainActor () -> Void) {
        try? settings.seed("screen", "apps", local: AppsField.of(recorder.modes))
        apply(settings, to: recorder)
        settings.changed = { [weak recorder] connector in
            guard connector == "screen", let recorder else { return }
            await MainActor.run { apply(settings, to: recorder) }
        }
        recorder.modesSet = { modes in
            try settings.set("screen", "apps", to: AppsField.of(modes))
            knock()
        }
    }
}
