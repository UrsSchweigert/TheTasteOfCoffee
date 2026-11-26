import Foundation
import Observation

/// The onboarding flow (M2-T29, docs/07 D1, ADR 0017): the intro pages, then the consent.
///
/// - The agree control starts off: not agreeing is the default.
/// - "Skip", on any page, finishes with `contribute_to_aggregates` false, whatever the control
///   says.
/// - Finishing writes the profile with `AccountStore.setProfile`, inside its `write { }`,
///   which queues `PUT /profile` in the same save; the outbox sends it when online.
/// - If a profile reached the store meanwhile (a pull found the server's), nothing is written,
///   so the server's profile is never replaced by onboarding.
@MainActor
@Observable
final class OnboardingModel {
    let store: AccountStore
    private(set) var page: OnboardingPage = .log
    /// The consent page's agree control. Off until the user turns it on.
    var agrees = false
    /// True once the profile is stored (or one existed already).
    private(set) var finished = false
    /// True when the last attempt to store the choice failed; the screen says so.
    private(set) var saveFailed = false

    @ObservationIgnored private let preferredLanguages: () -> [String]

    init(store: AccountStore, preferredLanguages: @escaping () -> [String] = { Locale.preferredLanguages }) {
        self.store = store
        self.preferredLanguages = preferredLanguages
    }

    /// 1-based position, for "Step 1 of 3".
    var stepNumber: Int { page.rawValue + 1 }
    var stepCount: Int { OnboardingPage.allCases.count }

    /// Moves to the next page; on the consent page it finishes with the control's value.
    func next() {
        if let following = page.next {
            page = following
        } else {
            finish(agreed: agrees)
        }
    }

    /// Ends onboarding without agreeing: sends false (D1).
    func skip() {
        finish(agreed: false)
    }

    private func finish(agreed: Bool) {
        saveFailed = false
        do {
            if try store.profile() == nil {
                try store.setProfile(OnboardingRules.profile(agreed: agreed, preferredLanguages: preferredLanguages()))
            }
            finished = true
        } catch {
            saveFailed = true
        }
    }
}

/// Decides between onboarding and the shelf for one account's store (M2-T29), from the local
/// profile and what `SyncHost`'s pulls said (`OnboardingRules.decision`).
@MainActor
@Observable
final class OnboardingGateModel {
    let store: AccountStore
    let onboarding: OnboardingModel
    private(set) var hasLocalProfile = false
    /// The store could not be read: the shelf shows (with its own error), never a flow that
    /// could not save.
    private(set) var readFailed = false
    /// Set once `OnboardingRules.serverWait` passed without an answer from the server.
    var waitedLongEnough = false

    init(store: AccountStore, preferredLanguages: @escaping () -> [String] = { Locale.preferredLanguages }) {
        self.store = store
        self.onboarding = OnboardingModel(store: store, preferredLanguages: preferredLanguages)
        reload()
    }

    /// Reads whether the store has a profile. Called after every save of the store, so a
    /// profile the pull stored, or onboarding's own, ends the flow.
    func reload() {
        do {
            hasLocalProfile = try store.profile() != nil
            readFailed = false
        } catch {
            readFailed = true
        }
    }

    func decision(server: ServerProfileAnswer) -> OnboardingDecision {
        if readFailed {
            return .done
        }
        return OnboardingRules.decision(hasLocalProfile: hasLocalProfile, server: server, waitedLongEnough: waitedLongEnough)
    }
}
