import Contacts
import Foundation
import LifestreamCaptureCore

protocol ContactSource: ContactReader {
    func authorizationStatus() -> ContactsAuthorization
    func requestAuthorization() async throws -> ContactsAuthorization
}

actor AppleContactSource: ContactSource {
    private let store = CNContactStore()
    private static var keys: [any CNKeyDescriptor] {
        [CNContactVCardSerialization.descriptorForRequiredKeys(), CNContactImageDataKey as CNKeyDescriptor]
    }

    nonisolated func authorizationStatus() -> ContactsAuthorization {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: .authorized
        case .limited: .limited
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .notDetermined
        }
    }

    func requestAuthorization() async throws -> ContactsAuthorization {
        _ = try await store.requestAccess(for: .contacts)
        return authorizationStatus()
    }

    func read() throws -> ContactsRead {
        let request = CNContactFetchRequest(keysToFetch: Self.keys)
        request.unifyResults = true
        var marks: [String: ContactMark] = [:]
        var bytes: [String: Int] = [:]
        var failure: (any Error)?
        try store.enumerateContacts(with: request) { contact, stop in
            autoreleasepool {
                do {
                    let card = try Self.card(contact)
                    marks[card.id] = card.mark
                    bytes[card.id] = card.bytes
                } catch { failure = error; stop.pointee = true }
            }
        }
        if let failure { throw failure }
        return ContactsRead(marks: marks, bytes: bytes, authorization: authorizationStatus())
    }

    func cards(_ ids: [String]) throws -> [ContactCard] {
        try store.unifiedContacts(matching: CNContact.predicateForContacts(withIdentifiers: ids), keysToFetch: Self.keys)
            .map(Self.card)
    }

    static func card(_ contact: CNContact) throws -> ContactCard {
        try ContactCard(id: contact.identifier, card: try CNContactVCardSerialization.data(with: [contact]), photo: contact.imageData)
    }

    #if DEBUG
    static func syntheticCard(image: Data? = nil) throws -> ContactCard {
        let contact = CNMutableContact()
        contact.givenName = "Synthetic"
        contact.familyName = "Person"
        contact.organizationName = "Example Org"
        contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: "+15550000001"))]
        contact.emailAddresses = [CNLabeledValue(label: CNLabelHome, value: "person-a@example.com" as NSString)]
        contact.birthday = DateComponents(year: 1990, month: 1, day: 2)
        contact.imageData = image
        return try card(contact)
    }
    #endif
}

enum ContactsGlance {
    static func read() async -> (count: Int, initials: [String])? {
        await Task.detached {
            let request = CNContactFetchRequest(keysToFetch: [CNContactGivenNameKey as CNKeyDescriptor, CNContactFamilyNameKey as CNKeyDescriptor])
            var count = 0
            var initials: [String] = []
            do {
                try CNContactStore().enumerateContacts(with: request) { contact, _ in
                    count += 1
                    if initials.count < 5, let letter = (contact.givenName + contact.familyName).first(where: \.isLetter) {
                        initials.append(String(letter).uppercased())
                    }
                }
            } catch {
                return nil
            }
            return (count, initials)
        }.value
    }
}
