import Foundation
import Observation

/// The "remove data of other accounts" setting (M2-T30). Reads how many other accounts have a
/// store on the device and removes them on request (`LocalDataRemover`). The signed-in
/// account's store, outbox and photos are never touched.
@MainActor
@Observable
final class LocalDataModel {
    enum Result: Equatable, Sendable {
        case untouched
        /// The other accounts' data is gone.
        case removed
        /// Some of it could not be deleted; what is left is counted again.
        case failed
    }

    private(set) var otherAccountCount = 0
    private(set) var result: Result = .untouched

    private let account: AccountID
    private let remover: LocalDataRemover

    init(account: AccountID, remover: LocalDataRemover = LocalDataRemover()) {
        self.account = account
        self.remover = remover
    }

    /// Counts the stores of other accounts again. An unreadable folder counts as none.
    func reload() {
        otherAccountCount = (try? remover.otherAccountCount(keeping: account)) ?? 0
    }

    /// Deletes the other accounts' stores, outboxes and queued label photos.
    func removeOtherAccounts() {
        do {
            try remover.removeOtherAccounts(keeping: account)
            result = .removed
        } catch {
            result = .failed
        }
        reload()
    }
}
