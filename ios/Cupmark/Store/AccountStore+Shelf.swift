import Foundation
import SwiftData

// Reads and writes the shelf screens need (M2-T18). Like every `AccountStore` write, a write
// here changes the models and saves in one step on the caller's actor, so the sync engine,
// which shares the context, never sees half of it (ADR 0025).

extension StoredShelfEntry {
    /// The brews on this device that reference the entry, not counting brews removed on the
    /// device (`pendingDelete`). While it is above 0 the bean cannot change (D14) and the
    /// entry cannot be removed (ADR 0012).
    var liveBrewCount: Int {
        brews.filter { brew in brew.syncState != .pendingDelete }.count
    }

    /// Whole days from the roast date to the day `date` falls on in `calendar`'s time zone
    /// (`BrewDerivedValues.daysSinceRoast`), nil without a roast date or before it.
    func daysSinceRoast(on date: Date, calendar: Calendar = .current) -> Int? {
        BrewDerivedValues.daysSinceRoast(roastDate: roastDate, brewedAt: date, calendar: calendar)
    }
}

extension AccountStore {
    /// Every bean on this device (the catalogue cache and beans made here), for the bean
    /// choice of a shelf entry. Beans with a server id first, then by local id, so the order
    /// is stable.
    func beans() throws -> [StoredBean] {
        try context.fetch(FetchDescriptor<StoredBean>()).sorted { lhs, rhs in
            switch (lhs.serverID, rhs.serverID) {
            case let (left?, right?): return left < right
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return lhs.localID.uuidString < rhs.localID.uuidString
            }
        }
    }

    /// The local copy of a catalogue bean the API returned (lookup, confirmation or pick-list
    /// entry), inserted as `synced` if the device has none. A synced copy takes the server's
    /// values; a copy with local changes keeps them. Does not save: the caller saves it with
    /// the shelf entry that names it, so both are on disk together or not at all.
    func catalogueBean(_ bean: API.Bean) throws -> StoredBean {
        if let local = try self.bean(serverID: bean.beanId) {
            if local.syncState == .synced, try outboxOperations(for: local.localID).isEmpty {
                local.apply(bean)
            }
            return local
        }
        let copy = StoredBean(bean)
        copy.syncState = .synced
        context.insert(copy)
        return copy
    }
}
