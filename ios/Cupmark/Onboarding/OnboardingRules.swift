import Foundation

/// What the current account's pulls said about `GET /profile` (M2-T29), read from `SyncHost`.
enum ServerProfileAnswer: Equatable, Sendable {
    /// No pull has answered yet for this account.
    case notYet
    /// The server has a profile (200). The pull stored it, unless this build could not read it.
    case found
    /// The server has no profile (404).
    case missing
    /// The last pull failed (offline, a server error) and none had answered before.
    case unreachable
}

/// What the signed-in root shows (M2-T29).
enum OnboardingDecision: Equatable, Sendable {
    /// Waiting a moment for the first pull to say whether the server has a profile.
    case checking
    /// No profile here and none known on the server: the intro and the consent.
    case onboarding
    /// A profile exists (or the store cannot tell): the shelf.
    case done
}

/// The pages of onboarding, in order: a few intro pages, then the consent (D1, ADR 0017).
enum OnboardingPage: Int, CaseIterable, Sendable {
    case log
    case privateLog
    case consent

    var next: OnboardingPage? { OnboardingPage(rawValue: rawValue + 1) }
    var isLast: Bool { next == nil }
}

/// The rules of onboarding (M2-T29), as pure functions so the tests need no view.
enum OnboardingRules {
    /// How long the root waits for the first pull before onboarding shows anyway, so a slow
    /// or stuck sync (offline with queued writes ahead of the pull) never blocks the user.
    static let serverWait = Duration.seconds(5)

    /// Whether onboarding shows.
    /// - A local profile, also a pending one, ends it for good: it is never shown again.
    /// - Without one: a server 404 or a failed pull shows it at once; a found profile (which
    ///   the pull stored, or could not read) never does; before any answer the root waits
    ///   `serverWait`, then shows it.
    /// A profile made here while the server's state was unknown is checked against the server
    /// before it is sent and merged with the server's (`SyncEngine.resolvedProfile`, ADR 0025
    /// Addendum M2-T29), so showing onboarding offline never overwrites a profile made on
    /// another device, and never turns a "no" into "yes".
    static func decision(hasLocalProfile: Bool, server: ServerProfileAnswer, waitedLongEnough: Bool) -> OnboardingDecision {
        if hasLocalProfile {
            return .done
        }
        switch server {
        case .found:
            return .done
        case .missing, .unreachable:
            return .onboarding
        case .notYet:
            return waitedLongEnough ? .onboarding : .checking
        }
    }

    /// The profile's `locale`: German when the first preferred language is German, else
    /// English (`Locale.preferredLanguages`, for example `de-CH` or `de` give German).
    static func profileLocale(preferredLanguages: [String]) -> VocabularyLanguage {
        guard let first = preferredLanguages.first else {
            return .en
        }
        let code: Locale.LanguageCode? = Locale.Language(identifier: first).languageCode
        return code == Locale.LanguageCode.german ? .de : .en
    }

    /// The profile onboarding sends. Not agreeing is the default (D1): `agreed` is true only
    /// after the user turned the agree control on and finished.
    static func profile(agreed: Bool, preferredLanguages: [String]) -> API.Profile {
        API.Profile(
            locale: profileLocale(preferredLanguages: preferredLanguages),
            consent: API.Consent(contributeToAggregates: agreed)
        )
    }
}
