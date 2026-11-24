import ApplicationServices
import Foundation
import XCTest
@testable import InputEvents

final class ElementReadTests: XCTestCase {
    private static let identity = [kAXRoleAttribute, kAXSubroleAttribute, kAXParentAttribute]
    private static let details = [kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute, "AXURL"]
    private static let detailsWithValue = details + [kAXValueAttribute]

    func testAnActionableElementIsReadInTwoCallsWithEveryField() {
        let tree = FakeElements()
        tree.nodes[10] = [kAXRoleAttribute: "AXTextField" as NSString, kAXSubroleAttribute: "AXSearchField" as NSString,
                          kAXParentAttribute: FakeElements.Ref(11), kAXTitleAttribute: "Search" as NSString,
                          kAXDescriptionAttribute: "Find a file" as NSString, kAXIdentifierAttribute: "search-1" as NSString,
                          "AXURL": URL(string: "https://docs.example/find")! as NSURL,
                          kAXValueAttribute: "synthetic query" as NSString]
        tree.nodes[11] = [kAXRoleAttribute: "AXButton" as NSString]
        XCTAssertEqual(ElementRead(calls: tree).lookup(10),
                       .found(InputElementAttributes(role: "AXTextField", subrole: "AXSearchField", title: "Search",
                                                     desc: "Find a file", id: "search-1", url: "https://docs.example/find",
                                                     value: "synthetic query"), action: nil))
        XCTAssertEqual(tree.calls.map { $0.attributes }, [Self.identity, Self.detailsWithValue],
                       "identity and parent in one call, the details and the value in one more, no ancestor")
    }

    func testASecureFieldsValueIsNeverAskedFor() {
        let cannot = FakeElements.error(.cannotComplete)
        let cases: [(role: AnyObject?, subrole: AnyObject?, expected: InputElementAttributes)] = [
            ("AXSecureTextField" as NSString, nil, InputElementAttributes(role: "AXSecureTextField", title: "Password")),
            ("AXTextField" as NSString, "AXSecureTextField" as NSString,
             InputElementAttributes(role: "AXTextField", subrole: "AXSecureTextField", title: "Password")),
            (cannot, nil, InputElementAttributes(title: "Password")),
            ("AXTextField" as NSString, cannot, InputElementAttributes(role: "AXTextField", title: "Password")),
            (nil, nil, InputElementAttributes(title: "Password")),
        ]
        for (index, entry) in cases.enumerated() {
            let tree = FakeElements()
            var node: [String: AnyObject] = [kAXTitleAttribute: "Password" as NSString,
                                             kAXValueAttribute: "synthetic-secret" as NSString]
            node[kAXRoleAttribute] = entry.role
            node[kAXSubroleAttribute] = entry.subrole
            tree.nodes[10] = node
            guard case .found(let attributes, _) = ElementRead(calls: tree).lookup(10) else {
                XCTFail("case \(index) did not read")
                continue
            }
            XCTAssertEqual(attributes, entry.expected, "case \(index)")
            XCTAssertFalse(tree.calls.contains { $0.attributes.contains(kAXValueAttribute) },
                           "case \(index): the value is never asked for")
            XCTAssertEqual(tree.calls.prefix(2).map { $0.attributes }, [Self.identity, Self.details], "case \(index)")
        }
    }

    func testTheNearestActionableAncestorCostsOneCallALevel() {
        let tree = FakeElements()
        tree.nodes[10] = [kAXRoleAttribute: "AXStaticText" as NSString, kAXParentAttribute: FakeElements.Ref(11),
                          kAXValueAttribute: "Send" as NSString]
        tree.nodes[11] = [kAXRoleAttribute: "AXGroup" as NSString, kAXParentAttribute: FakeElements.Ref(12)]
        tree.nodes[12] = [kAXRoleAttribute: "AXButton" as NSString, kAXSubroleAttribute: "AXDefaultButton" as NSString,
                          kAXParentAttribute: FakeElements.Ref(13), kAXTitleAttribute: "Send" as NSString,
                          kAXIdentifierAttribute: "send" as NSString]
        tree.nodes[13] = [kAXRoleAttribute: "AXWindow" as NSString]
        XCTAssertEqual(ElementRead(calls: tree).lookup(10),
                       .found(InputElementAttributes(role: "AXStaticText", value: "Send"),
                              action: InputElementAttributes(role: "AXButton", subrole: "AXDefaultButton", title: "Send",
                                                             id: "send")))
        XCTAssertEqual(tree.calls.map { $0.element }, [10, 10, 11, 12, 12])
        XCTAssertEqual(tree.calls.map { $0.attributes },
                       [Self.identity, Self.detailsWithValue, Self.identity, Self.identity, Self.detailsWithValue],
                       "the matched ancestor keeps its level's identity and reads only its details")
    }

    func testALevelWhoseRoleDidNotReadIsPassedAndOneWhoseParentDidNotReadEndsTheSearch() {
        let tree = FakeElements()
        tree.nodes[10] = [kAXRoleAttribute: "AXImage" as NSString, kAXParentAttribute: FakeElements.Ref(11)]
        tree.nodes[11] = [kAXRoleAttribute: FakeElements.error(.cannotComplete), kAXParentAttribute: FakeElements.Ref(12)]
        tree.nodes[12] = [kAXRoleAttribute: "AXLink" as NSString, kAXParentAttribute: FakeElements.Ref(13)]
        XCTAssertEqual(ElementRead(calls: tree).lookup(10),
                       .found(InputElementAttributes(role: "AXImage"), action: InputElementAttributes(role: "AXLink")))

        tree.calls = []
        tree.nodes[11] = [kAXRoleAttribute: "AXGroup" as NSString, kAXParentAttribute: FakeElements.error(.cannotComplete)]
        XCTAssertEqual(ElementRead(calls: tree).lookup(10), .found(InputElementAttributes(role: "AXImage"), action: nil))
        XCTAssertEqual(tree.calls.map { $0.element }, [10, 10, 11], "a parent that did not read ends the search")

        tree.calls = []
        tree.nodes[11] = nil
        XCTAssertEqual(ElementRead(calls: tree).lookup(10), .found(InputElementAttributes(role: "AXImage"), action: nil),
                       "a level whose call failed whole ends the search")
        XCTAssertEqual(tree.calls.map { $0.element }, [10, 10, 11])
    }

    func testTheSearchClimbsThreeLevelsAndNoMore() {
        let tree = FakeElements()
        for id in 10..<14 {
            tree.nodes[id] = [kAXRoleAttribute: "AXGroup" as NSString, kAXParentAttribute: FakeElements.Ref(id + 1)]
        }
        tree.nodes[14] = [kAXRoleAttribute: "AXButton" as NSString]
        XCTAssertEqual(ElementRead(calls: tree).lookup(10), .found(InputElementAttributes(role: "AXGroup"), action: nil))
        XCTAssertEqual(tree.calls.map { $0.element }, [10, 10, 11, 12, 13])

        tree.calls = []
        tree.nodes[13] = [kAXRoleAttribute: "AXRow" as NSString, kAXParentAttribute: FakeElements.Ref(14)]
        XCTAssertEqual(ElementRead(calls: tree).lookup(10),
                       .found(InputElementAttributes(role: "AXGroup"), action: InputElementAttributes(role: "AXRow")),
                       "the third level is still searched")
    }

    func testACallThatFailedWholeIsTheLookupsError() {
        let tree = FakeElements()
        tree.failure = .timeout
        XCTAssertEqual(ElementRead(calls: tree).lookup(10), .failed(.timeout))
        XCTAssertEqual(tree.calls.count, 1)

        let short = FakeElements()
        short.nodes[10] = [kAXRoleAttribute: "AXButton" as NSString]
        short.shortBatches = true
        XCTAssertEqual(ElementRead(calls: short).lookup(10), .failed(.noElement), "a batch of the wrong length")

        let partial = FakeElements()
        partial.nodes[10] = [kAXRoleAttribute: "AXButton" as NSString, kAXTitleAttribute: "Open" as NSString]
        partial.failAfter = 1
        XCTAssertEqual(ElementRead(calls: partial).lookup(10), .found(InputElementAttributes(role: "AXButton"), action: nil))
    }

    func testANumberValueIsTextAndALongValueIsCut() {
        let tree = FakeElements()
        tree.nodes[10] = [kAXRoleAttribute: "AXCheckBox" as NSString, kAXValueAttribute: NSNumber(value: 1)]
        XCTAssertEqual(ElementRead(calls: tree).lookup(10),
                       .found(InputElementAttributes(role: "AXCheckBox", value: "1"), action: nil))
        let long = FakeElements()
        long.nodes[10] = [kAXRoleAttribute: "AXTextArea" as NSString,
                          kAXValueAttribute: String(repeating: "a", count: 10_000) as NSString]
        XCTAssertEqual(ElementRead(calls: long).lookup(10),
                       .found(InputElementAttributes(role: "AXTextArea", value: String(repeating: "a", count: 256)),
                              action: nil))
    }
}

final class FakeElements: ElementCalls {
    final class Ref: NSObject {
        let id: Int
        init(_ id: Int) { self.id = id }
    }

    var nodes: [Int: [String: AnyObject]] = [:]
    var failure: InputLookupError?
    var failAfter = Int.max
    var shortBatches = false
    var calls: [(element: Int, attributes: [String])] = []

    static func error(_ error: AXError) -> AnyObject {
        var error = error
        return AXValueCreate(.axError, &error)!
    }

    func values(_ element: Int, _ attributes: [String]) -> Result<[AnyObject], InputLookupError> {
        calls.append((element, attributes))
        if let failure { return .failure(failure) }
        guard calls.count <= failAfter else { return .failure(.timeout) }
        guard let node = nodes[element] else { return .failure(.noElement) }
        let values = attributes.map { node[$0] ?? Self.error(.noValue) }
        return .success(shortBatches ? Array(values.dropLast()) : values)
    }

    func element(_ value: AnyObject) -> Int? {
        (value as? Ref)?.id
    }
}
