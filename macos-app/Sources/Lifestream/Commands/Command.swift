import Shipping

enum Command: String, CaseIterable {
    case app
    case help
    case start
    case pause
    case liveStatus = "live-status"
    case shutdown
    case record
    case capture
    case status
    case query
    case ocr
    case image
    case decodeMetadata = "decode-metadata"
    case permissions
    case selfTest = "self-test"
    case inputFocus = "input-focus"
    case ship
    case home
    case modes
    case audioWatch = "audio-watch"
    case audioTest = "audio-test"
    case resourceWatch = "resource-watch"
    case ocrHelper = "ocr-helper"
    case launch
    case agents
    case setup

    static let usage = """
        Lifestream — local macOS screen evidence and the dashboard window
        Commands: app (default), start, pause, live-status, shutdown, record, capture, status, query, ocr, image, \
        decode-metadata, permissions, self-test, input-focus, ship, home, modes, audio-watch, audio-test, \
        resource-watch, ocr-helper, launch, agents, setup
        Options:
          --store PATH                 Local capture folder
          --interval SECONDS           Capture cadence until the home gives one, default 2 (range 1–300)
          --duration SECONDS           Stop a recording after this duration
          --exclude BUNDLE_ID          Exclude an app for this run (repeatable); with modes, set it to exclude
          --activity BUNDLE_ID         With modes, record the app as activity only
          --record BUNDLE_ID           With modes, record the app in full
          --site-activity HOST         With modes, record a site and its subdomains as activity only
          --site-exclude HOST          With modes, never record a site and its subdomains
          --site-record HOST           With modes, record a site in full
          --limit COUNT                Query limit, default 100 (max 10000)
          --since ISO8601              Query captures at or after this instant
          --request-permissions        Request macOS capture permissions
          --no-input-log               Record without the input log
          --displays relevant|all      Relevant display (default), or every display
          --max-height PIXELS          Capture height cap, default 1440; zero is native
          --idle-after SECONDS         Pause after no input until the home gives a timeout; zero disables (default)
          --ocr exact|always           Until the home gives one: reuse text for identical images (default), or OCR every image
          --video-quality NUMBER       Native HEVC quality 0–1, default 0.65
          --output PATH                Destination PNG; with agents, the folder their definitions are written to
          --dashboard-port PORT        Dashboard on 127.0.0.1, default 4317
          --name NAME                  The home's name, for the home command to pair with
          --code CODE                  The eight-digit code the home shows, for the home command
          --app PATH                   The app bundle resource-watch reads, default the one it runs from
          --powerlog PATH              The power log's BatteryLife folder resource-watch copies from
          --job home|door|dashboard|mcp|runner  The job launch runs
          --set on|off                 With agents, reconcile the agents with this app or remove them
        app launches quietly in the menu bar; Open Lifestream shows the dashboard window.
        start/pause/live-status/shutdown control the running app for --store.
        start acknowledges accepted startup; live-status reports starting, recording, or error.
        start --duration 900 records for 15 minutes; start again replaces the timer.
        query writes one JSON observation per line; imageFile is relative to the store.
        modes prints every app and site not recorded in full; with one of its flags it sets that app or site.
        input-focus --limit 20 prints, for the next 20 key presses, the app and element the input log files each under.
        audio-watch prints the microphone, sound, camera and output lines as they happen, and what the \
        audio recorder would do with each track; --duration stops it.
        audio-test records --track mic (the default input device) or sound (the Mac's output) for \
        --duration seconds (default 10) into --output DIR; without --output it measures the recording and keeps none.
        resource-watch writes the app's use read from outside, the Mac's power and the power log's \
        rows into the store's resources folder, until stopped or for --duration.
        ocr-helper reads tile crops on standard input and writes their text to standard output; the app \
        starts it to recognize text and ends it when it stalls.
        launch --job home runs the job on the release the machine's current link names: what each of \
        the app's agents but the resource watcher's runs. agents prints each agent's state and the app's \
        login item; --set on makes each run from this app and the app open at login, as the first run does; \
        --output DIR writes each agent's definition into DIR, as the app's build does.
        setup prints what this Mac holds of its home and the step the first run opens at, null when it does not open.
        This capture spool is not a Lifestream stream. No network or model calls.
        """

    var process: SealWork.Process? {
        switch self {
        case .app: return .app
        case .resourceWatch: return .watch
        case .home, .modes, .status, .query, .image, .ocr, .decodeMetadata, .capture, .record, .audioTest, .inputFocus, .audioWatch,
             .setup:
            return .cli
        case .help, .start, .pause, .liveStatus, .shutdown, .ship, .permissions, .selfTest, .ocrHelper,
             .launch, .agents:
            return nil
        }
    }
}

enum CommandOutcome {
    case succeeded
    case failed
}
