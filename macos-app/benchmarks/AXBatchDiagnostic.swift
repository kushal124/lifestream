import Foundation
import AppKit
import ApplicationServices

private struct AttributeResult {
    let code: Int32
    let value: CFTypeRef?
    let kind: String
    let length: Int?
    var report: [String:Any] { ["errorCode":code,"kind":kind,"utf8Length":length.map { $0 as Any } ?? NSNull()] }
}
@main struct AXBatchDiagnostic {
    private static func inspect(_ value: CFTypeRef?, code: AXError) -> AttributeResult {
        guard code == .success,let value else { return AttributeResult(code:code.rawValue,value:nil,kind:"absent",length:nil) }
        if CFGetTypeID(value) == AXValueGetTypeID() {
            let ax = unsafeBitCast(value,to:AXValue.self)
            if AXValueGetType(ax) == .axError {
                var error = AXError.failure
                if AXValueGetValue(ax,.axError,&error) { return AttributeResult(code:error.rawValue,value:nil,kind:"attribute-error",length:nil) }
                return AttributeResult(code:AXError.failure.rawValue,value:nil,kind:"undecodable-error",length:nil)
            }
            return AttributeResult(code:0,value:value,kind:"ax-value",length:nil)
        }
        if value is NSNull { return AttributeResult(code:AXError.noValue.rawValue,value:nil,kind:"null",length:nil) }
        if let text = value as? String { return AttributeResult(code:0,value:value,kind:"string",length:text.utf8.count) }
        if let text = value as? NSAttributedString { return AttributeResult(code:0,value:value,kind:"attributed-string",length:text.string.utf8.count) }
        return AttributeResult(code:0,value:value,kind:"other",length:nil)
    }
    private static func individual(_ node: AXUIElement,_ name: String) -> AttributeResult {
        var value: CFTypeRef?
        let code = AXUIElementCopyAttributeValue(node,name as CFString,&value)
        return inspect(value,code:code)
    }
    private static func batch(_ node: AXUIElement,_ names: [String]) -> (AXError,[String:AttributeResult]) {
        var array: CFArray?
        let code = AXUIElementCopyMultipleAttributeValues(node,names as CFArray,[],&array)
        guard code == .success,let values = array as? [Any],values.count == names.count else { return (code,[:]) }
        return (code,Dictionary(uniqueKeysWithValues:zip(names,values).map { ($0.0,inspect($0.1 as CFTypeRef,code:.success)) }))
    }
    private static func rejects(_ result: (AXError,[String:AttributeResult]),expectedCount: Int) -> Bool {
        result.0 != .success || result.1.count != expectedCount || result.1.values.contains {
            $0.code != 0 && $0.code != AXError.attributeUnsupported.rawValue && $0.code != AXError.noValue.rawValue
        }
    }
    static func emit(_ object: [String:Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject:object,options:[.prettyPrinted,.sortedKeys]) else { print("{\"error\":\"encoding-failed\"}"); return }
        print(String(decoding:data,as:UTF8.self))
    }
    static func main() {
        guard AXIsProcessTrusted() else { emit(["error":"accessibility-not-authorized-no-prompt-issued"]); return }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier:"com.apple.TextEdit")
        guard apps.count == 1,let app = apps.first else { emit(["error":"one-running-textedit-required"]); return }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        _ = AXUIElementSetMessagingTimeout(element,0.05)
        let focused = individual(element,kAXFocusedWindowAttribute)
        guard let value = focused.value,CFGetTypeID(value) == AXUIElementGetTypeID() else {
            emit(["error":"focused-window-unavailable","attribute":focused.report]); return
        }
        let root = unsafeBitCast(value,to:AXUIElement.self)
        let identityNames = [kAXRoleAttribute,kAXSubroleAttribute]
        let detailNames = [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute,kAXPositionAttribute,kAXSizeAttribute]
        let deadline = ProcessInfo.processInfo.systemUptime+8
        var stack: [(AXUIElement,Int,Bool)] = [(root,0,false)]
        var visited: [AXUIElement] = [], rows: [[String:Any]] = [], roleCounts: [String:Int] = [:]
        var areas = 0, skippedAreas = 0, limitReached = false
        let safeRoles = Set(["AXWindow","AXGroup","AXScrollArea","AXTextArea","AXTextField","AXButton","AXCheckBox","AXRadioButton","AXStaticText","AXToolbar","AXMenuButton","AXSplitGroup","AXImage","AXRuler","AXRulerMarker","AXTabGroup","AXUnknown","AXSlider","AXScrollBar"])
        while let (node,depth,ancestorSkipped) = stack.popLast() {
            guard rows.count<128,depth<=24,ProcessInfo.processInfo.systemUptime<deadline else { limitReached = true; break }
            if visited.contains(where:{ CFEqual($0,node) }) { continue }
            visited.append(node)
            let timeout = AXUIElementSetMessagingTimeout(node,0.05)
            guard timeout == .success else { rows.append(["index":rows.count,"depth":depth,"timeoutError":timeout.rawValue]); continue }
            let identityBatch = batch(node,identityNames)
            let role = individual(node,kAXRoleAttribute), subrole = individual(node,kAXSubroleAttribute)
            guard role.code == 0,
                  [Int32(0),AXError.attributeUnsupported.rawValue,AXError.noValue.rawValue].contains(subrole.code) else {
                rows.append(["index":rows.count,"depth":depth,"error":"identity-unavailable-details-not-read",
                    "roleIndividual":role.report,"subroleIndividual":subrole.report]); continue
            }
            let rawRole = role.value as? String ?? "absent"
            let safeRole = safeRoles.contains(rawRole) ? rawRole : "other-role"
            roleCounts[safeRole,default:0] += 1
            if subrole.value as? String == kAXSecureTextFieldSubrole as String {
                rows.append(["index":rows.count,"depth":depth,"role":"secure-field-skipped"]); continue
            }
            guard ProcessInfo.processInfo.systemUptime<deadline else { limitReached = true; break }
            let detailBatch = batch(node,detailNames)
            var individualDetails: [String:AttributeResult] = [:]
            for name in detailNames {
                guard ProcessInfo.processInfo.systemUptime<deadline else { limitReached = true; break }
                individualDetails[name] = individual(node,name)
            }
            let wouldSkip = rejects(identityBatch,expectedCount:identityNames.count) || identityBatch.1[kAXRoleAttribute]?.value as? String == nil || rejects(detailBatch,expectedCount:detailNames.count)
            if rawRole == "AXTextArea" { areas += 1; if wouldSkip || ancestorSkipped { skippedAreas += 1 } }
            var childCount: CFIndex = 0
            let countCode = AXUIElementGetAttributeValueCount(node,kAXChildrenAttribute as CFString,&childCount)
            var childCode = AXError.success
            if countCode == .success,childCount>0 {
                let limit = min(childCount,128-rows.count-stack.count)
                if limit<childCount { limitReached = true }
                if limit>0,ProcessInfo.processInfo.systemUptime<deadline {
                    var children: CFArray?
                    childCode = AXUIElementCopyAttributeValues(node,kAXChildrenAttribute as CFString,0,limit,&children)
                    if childCode == .success,let children = children as? [AXUIElement] {
                        for child in children.reversed() { stack.append((child,depth+1,ancestorSkipped || wouldSkip)) }
                    }
                }
            }
            rows.append(["index":rows.count,"depth":depth,"role":safeRole,
                "identityBatchCallError":identityBatch.0.rawValue,"identityBatch":identityBatch.1.mapValues(\.report),
                "roleIndividual":role.report,"subroleIndividual":subrole.report,
                "detailsBatchCallError":detailBatch.0.rawValue,"detailsBatch":detailBatch.1.mapValues(\.report),
                "detailsIndividual":individualDetails.mapValues(\.report),"originalBatchPolicyWouldSkipNode":wouldSkip,
                "originalBatchPolicySkippedAncestor":ancestorSkipped,"childCount":childCount,
                "childCountError":countCode.rawValue,"childSliceError":childCode.rawValue])
        }
        emit(["nodes":rows,"roleCounts":roleCounts,"textAreaCount":areas,"textAreasLostByOriginalBatchPolicy":skippedAreas,
            "boundedOrIncomplete":limitReached || !stack.isEmpty,"limitations":[
            "Manual synthetic TextEdit diagnostic; no content strings, geometry, paths, process IDs or window IDs emitted.",
            "Batch versus individual reads are sequential and not atomic; timing-dependent application changes can differ.",
            "At most128 nodes/depth24/eight-second soft budget, each node messaging timeout50ms; one pending call may exceed the soft deadline.",
            "Diagnostic traverses children even when batch optional attributes fail, unlike original all-or-nothing node policy.",
            "No app activation, edits or permission prompts. AX may be app-reported rather than visible content."]])
    }
}
