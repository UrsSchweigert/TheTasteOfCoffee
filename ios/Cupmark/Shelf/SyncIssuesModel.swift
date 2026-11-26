import Foundation
import Observation

/// What a sync issue is about, for its row.
enum SyncIssueSubject: Equatable, Sendable {
    case bean(ShelfBeanSummary)
    case shelfEntry(ShelfBeanSummary, purchaseDate: API.CalendarDate?)
    /// A brew: its method id (shown through the vocabulary labels) and when it was brewed.
    case brew(methodID: String, brewedAt: Date)
    case recipe(methodID: String)
    case profile
}

/// One row of the sync issues screen.
struct SyncIssueRow: Identifiable, Equatable, Sendable {
    let item: SyncIssueItem
    let subject: SyncIssueSubject

    var id: UUID { item.id }
}

/// The parked and flagged items (M2-T18, ADR 0025) with redo and discard
/// (`AccountStore.redo(_:)`, `AccountStore.discard(_:)`).
@MainActor
@Observable
final class SyncIssuesModel {
    enum Failure: Equatable, Sendable {
        /// The store could not be read.
        case loadFailed
        /// Discard was refused: brews or shelf entries still depend on the item.
        case discardBlocked(SyncIssueDiscardBlock)
        /// The store could not save; nothing changed.
        case saveFailed
    }

    private(set) var rows: [SyncIssueRow] = []
    private(set) var failure: Failure?

    let store: AccountStore

    init(store: AccountStore) {
        self.store = store
    }

    func reload() {
        do {
            rows = try store.syncIssues().compactMap { item in
                try subject(of: item).map { found in SyncIssueRow(item: item, subject: found) }
            }
            if failure == .loadFailed {
                failure = nil
            }
        } catch {
            failure = .loadFailed
        }
    }

    /// Sends a parked operation again, or clears a flag. True when it was saved.
    @discardableResult
    func redo(_ item: SyncIssueItem) -> Bool {
        do {
            try store.redo(item)
            failure = nil
            reload()
            return true
        } catch {
            // `redo` and `discard` already put back what they changed (`AccountStore.write`).
            failure = .saveFailed
            return false
        }
    }

    /// Drops the refused local change. True when it was saved; the caller then asks for a
    /// pull, so the server's values come back.
    @discardableResult
    func discard(_ item: SyncIssueItem) -> Bool {
        do {
            try store.discard(item)
            failure = nil
            reload()
            return true
        } catch LocalStoreError.shelfEntryHasBrews {
            failure = .discardBlocked(.shelfEntryHasBrews)
            return false
        } catch LocalStoreError.beanHasShelfEntries {
            failure = .discardBlocked(.beanHasShelfEntries)
            return false
        } catch {
            // `redo` and `discard` already put back what they changed (`AccountStore.write`).
            failure = .saveFailed
            return false
        }
    }

    private func subject(of item: SyncIssueItem) throws -> SyncIssueSubject? {
        switch item.resource {
        case .bean:
            return try store.bean(localID: item.localID).map { bean in SyncIssueSubject.bean(ShelfBeanSummary(bean)) }
        case .shelfEntry:
            return try store.shelfEntry(localID: item.localID).map { entry in
                SyncIssueSubject.shelfEntry(ShelfBeanSummary(entry.bean), purchaseDate: entry.purchaseDate)
            }
        case .brew:
            return try store.brew(localID: item.localID).map { brew in SyncIssueSubject.brew(methodID: brew.methodID, brewedAt: brew.brewedAt) }
        case .recipe:
            return try store.recipe(localID: item.localID).map { recipe in SyncIssueSubject.recipe(methodID: recipe.methodID) }
        case .profile:
            return .profile
        }
    }
}
