import Foundation

enum AccessibilityStatus: String, Sendable {
    case permissionDenied = "permission-denied"
    case targetWindowUnavailable = "target-window-unavailable"
    case windowCorrelationUnavailable = "window-correlation-unavailable"
    case windowCorrelationMismatchOrAmbiguous = "window-correlation-mismatch-or-ambiguous"
    case windowChangedOrUnverifiable = "window-changed-or-unverifiable"
    case windowChangedDuringCapture = "window-changed-during-capture"
    case completeScopedAppReported = "complete-scoped-app-reported"
    case partialScopedAppReported = "partial-scoped-app-reported"
}

enum AccessibilityLimitReason: Hashable, Sendable {
    case walkDeadline
    case elementBudget
    case textByteBudget
    case frontierBudget
    case messagingTimeoutUnavailable
    case axCallIncomplete
    case attributeBatchIncomplete
    case attributeErrorUnreadable
    case identityBatchIncomplete
    case identityAttributeUnverified
    case windowListBudget
    case candidateWindowGeometryUnavailable
    case windowGeometryNoMatch
    case windowGeometryAmbiguous
    case windowPostflightUnverified
    case pageNotRecorded
    case pageChangedDuringWalk
    case nativeCallError(Int32)

    var rawValue: String {
        switch self {
        case .walkDeadline: return "walk-deadline"
        case .elementBudget: return "element-budget"
        case .textByteBudget: return "text-byte-budget"
        case .frontierBudget: return "frontier-budget"
        case .messagingTimeoutUnavailable: return "messaging-timeout-unavailable"
        case .axCallIncomplete: return "ax-call-incomplete"
        case .attributeBatchIncomplete: return "attribute-batch-incomplete"
        case .attributeErrorUnreadable: return "attribute-error-unreadable"
        case .identityBatchIncomplete: return "identity-batch-incomplete"
        case .identityAttributeUnverified: return "identity-attribute-unverified"
        case .windowListBudget: return "window-list-budget"
        case .candidateWindowGeometryUnavailable: return "candidate-window-geometry-unavailable"
        case .windowGeometryNoMatch: return "window-geometry-no-match"
        case .windowGeometryAmbiguous: return "window-geometry-ambiguous"
        case .windowPostflightUnverified: return "window-postflight-unverified"
        case .pageNotRecorded: return "page-not-recorded"
        case .pageChangedDuringWalk: return "page-changed-during-walk"
        case .nativeCallError(let code): return "ax-call-error-\(code)"
        }
    }
}
