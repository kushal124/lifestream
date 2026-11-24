import Foundation

public enum CaptureGapReason: String, Codable, CaseIterable, Sendable {
    case displayAsleepOrSessionInactive = "display_asleep_or_session_inactive"
    case inputInactiveCapturePaused = "input-inactive-capture-paused"
    case sessionChangedDuringCapture = "session_changed_during_capture"
    case screenRecordingPermissionDenied = "screen-recording-permission-denied"
    case secureInputEnabled = "secure-input-enabled"
    case secureFieldFocused = "secure-field-focused"
    case secureFieldInFrontWindow = "secure-field-in-front-window"
    case foregroundAppExcluded = "foreground-app-excluded"
    case foregroundAppActivityOnly = "foreground-app-activity-only"
    case foregroundSiteRuleExcluded = "foreground-site-rule-excluded"
    case foregroundPrivateWindow = "foreground-private-window"
    case foregroundPageUnreadable = "foreground-page-unreadable"
    case foregroundSiteActivityOnly = "foreground-site-activity-only"
    case siteChangedDuringCapture = "site-changed-during-capture"
    case noFocusedApplication = "no-focused-application"
    case loginWindowActive = "login-window-active"
    case sessionLockedOrUnavailable = "session-locked-or-unavailable"
    case excludedVisibleApplicationNotCoveredBeforeCapture = "excluded-visible-application-not-covered-before-capture"
    case excludedVisibleApplicationNotCoveredDuringCapture = "excluded-visible-application-not-covered-during-capture"
    case contextChangedBeforeCapture = "context-changed-before-capture"
    case contextChangedDuringCapture = "context-changed-during-capture"
    case captureCancelled = "capture-cancelled"
    case captureDeadlineExceeded = "capture_deadline_exceeded"
    case storageBackpressure = "storage_backpressure"
    case storageFailed = "storage-failed"
    case recorderNotRunning = "recorder-not-running"
    case videoEncoderUnavailable = "video-encoder-unavailable"
    case captureDeadlineMissed = "capture-deadline-missed"
    case captureFailed = "capture_failed"
    case screenAcquisitionFailed = "screen-acquisition-failed"
    case captureAlreadyRunning = "capture-already-running"
    case shareableContentUnavailable = "shareable-content-unavailable"
    case noDisplay = "no-display"
    case noValidDisplay = "no-valid-display"
    case invalidCaptureSizeOrDisplayMode = "invalid-capture-size-or-display-mode"
    case captureGenerationInvalidated = "capture-generation-invalidated"

    public var isExpectedWait: Bool {
        switch self {
        case .displayAsleepOrSessionInactive,
             .inputInactiveCapturePaused,
             .sessionChangedDuringCapture,
             .screenRecordingPermissionDenied,
             .secureInputEnabled,
             .secureFieldFocused,
             .secureFieldInFrontWindow,
             .foregroundAppExcluded,
             .foregroundAppActivityOnly,
             .foregroundSiteRuleExcluded,
             .foregroundPrivateWindow,
             .foregroundPageUnreadable,
             .foregroundSiteActivityOnly,
             .siteChangedDuringCapture,
             .noFocusedApplication,
             .loginWindowActive,
             .sessionLockedOrUnavailable,
             .excludedVisibleApplicationNotCoveredBeforeCapture,
             .excludedVisibleApplicationNotCoveredDuringCapture,
             .contextChangedBeforeCapture,
             .contextChangedDuringCapture,
             .captureCancelled,
             .storageBackpressure,
             .recorderNotRunning,
             .captureGenerationInvalidated:
            return true
        case .storageFailed,
             .videoEncoderUnavailable,
             .captureDeadlineMissed,
             .captureDeadlineExceeded,
             .captureFailed,
             .screenAcquisitionFailed,
             .captureAlreadyRunning,
             .shareableContentUnavailable,
             .noDisplay,
             .noValidDisplay,
             .invalidCaptureSizeOrDisplayMode:
            return false
        }
    }
}
