import Foundation

/// The signed-in account (M2-T11) keys its local store by its `AccountID`, the SHA-256 hex
/// of the id token's `sub`.
extension AccountID: StoreAccount { var stableID: String { rawValue } }
