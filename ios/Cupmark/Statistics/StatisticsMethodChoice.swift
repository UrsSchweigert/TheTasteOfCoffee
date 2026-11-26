import Foundation

/// Which method the statistics screen shows (M2-T50, ADR 0027 addendum): all methods, or one
/// method of the vocabulary. Nothing is typed: the choice comes from a menu picker, and it is
/// kept as one vocabulary method id or "all".
enum StatisticsMethodChoice: Hashable, Sendable {
    case all
    case method(Vocabulary.Method)

    /// What is kept in `UserDefaults` for "all methods". It is not a vocabulary id, so no
    /// method can collide with it.
    static let allStorageValue = "all"

    /// The method, nil for all methods.
    var method: Vocabulary.Method? {
        switch self {
        case .all: return nil
        case .method(let method): return method
        }
    }

    /// The value kept for this choice: a method id or "all".
    var storageValue: String {
        switch self {
        case .all: return StatisticsMethodChoice.allStorageValue
        case .method(let method): return method.rawValue
        }
    }

    /// The choice kept as `storageValue`, among the methods the picker offers. Nil, an id the
    /// vocabulary does not know and a method without rated brews (no longer offered) all give
    /// "all methods".
    static func resolve(_ storageValue: String?, offering available: [Vocabulary.Method]) -> StatisticsMethodChoice {
        guard let storageValue, let method = available.first(where: { method in method.rawValue == storageValue }) else {
            return .all
        }
        return .method(method)
    }
}

/// The kept choice of the statistics screen. Per device, in `UserDefaults` (the privacy
/// manifest declares the access, `CA92.1`): one method id or "all", never anything typed, and
/// never synced or sent.
struct StatisticsMethodSetting: @unchecked Sendable {
    // `UserDefaults` is thread-safe, and the value is one string.
    static let key = "statisticsMethod"

    /// The device's setting.
    static let standard = StatisticsMethodSetting(defaults: .standard)

    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// The kept value, nil until the user picks.
    var storedValue: String? {
        get { defaults.string(forKey: StatisticsMethodSetting.key) }
        nonmutating set { defaults.set(newValue, forKey: StatisticsMethodSetting.key) }
    }
}
