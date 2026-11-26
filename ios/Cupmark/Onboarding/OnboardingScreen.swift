import Combine
import SwiftUI

/// Shows onboarding before `content` (the shelf) while the account has no profile
/// (M2-T29, `OnboardingRules.decision`): at once when the server said 404 or could not be
/// reached, after `OnboardingRules.serverWait` when no pull has answered yet, never once a
/// profile exists here or on the server. Made per store (`ShelfRoot` keys it by the store).
struct OnboardingGate<Content: View>: View {
    let sync: SyncHost
    @State private var model: OnboardingGateModel
    private let content: Content

    init(store: AccountStore, sync: SyncHost, @ViewBuilder content: () -> Content) {
        self.sync = sync
        _model = State(initialValue: OnboardingGateModel(store: store))
        self.content = content()
    }

    var body: some View {
        Group {
            switch model.decision(server: sync.serverProfile) {
            case .done:
                content
            case .onboarding:
                OnboardingScreen(model: model.onboarding)
            case .checking:
                ProgressView()
                    .accessibilityLabel(Text(L10n.onboardingChecking))
                    .task {
                        // Never wait for the server forever: offline, onboarding shows anyway.
                        try? await Task.sleep(for: OnboardingRules.serverWait)
                        if !Task.isCancelled {
                            model.waitedLongEnough = true
                        }
                    }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: AccountStore.didSaveNotification, object: model.store)) { _ in
            // Onboarding's own save, or a pull that stored the server's profile.
            model.reload()
        }
    }
}

/// The onboarding pages (M2-T29): two intro pages, then the consent with a plain explanation
/// and an explicit agree control, off by default (D1, ADR 0017). "Skip" on any page finishes
/// with consent false. No control takes typed text.
struct OnboardingScreen: View {
    @Bindable var model: OnboardingModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(L10n.onboardingStep(model.stepNumber.formatted(), of: model.stepCount.formatted()))
                    .font(.footnote)
                    .secondaryText()
                Image(systemName: symbol(for: model.page))
                    .font(.largeTitle)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text(title(for: model.page))
                    .themeTitle(.title2)
                    .accessibilityAddTraits(.isHeader)
                pageBody
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .screenBackground()
        .accessibilityIdentifier("onboarding")
        .safeAreaInset(edge: .bottom) {
            controls
        }
    }

    @ViewBuilder
    private var pageBody: some View {
        switch model.page {
        case .log:
            Text(L10n.onboardingLogMessage)
        case .privateLog:
            Text(L10n.onboardingPrivateMessage)
        case .consent:
            Text(L10n.onboardingConsentMessage)
            Text(L10n.onboardingConsentNotShared)
            Toggle(isOn: $model.agrees) {
                Text(L10n.onboardingConsentAgree)
            }
            .accessibilityIdentifier("onboarding-consent-agree")
            Text(L10n.onboardingConsentChangeLater)
                .font(.footnote)
                .secondaryText()
        }
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if model.saveFailed {
                Label {
                    Text(L10n.onboardingSaveFailed)
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .accessibilityHidden(true)
                }
                .foregroundStyle(.red)
            }
            Button {
                model.next()
            } label: {
                Text(model.page.isLast ? L10n.onboardingFinish : L10n.onboardingNext)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.prominent)
            .controlSize(.large)
            .accessibilityIdentifier(model.page.isLast ? "onboarding-finish" : "onboarding-next")
            Button {
                model.skip()
            } label: {
                // A borderless button: at least 44 points high to tap (M2-T33).
                Text(L10n.onboardingSkip)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                    // The accent colour on the bar's material fails the contrast audit.
                    .foregroundStyle(.primary)
            }
            .accessibilityHint(Text(L10n.onboardingSkipHint))
            .accessibilityIdentifier("onboarding-skip")
        }
        .padding()
        // A solid colour: the contrast audit measures against what shows through a material.
        .background(Theme.listBackground)
    }

    private func title(for page: OnboardingPage) -> LocalizedStringKey {
        switch page {
        case .log: return L10n.onboardingLogTitle
        case .privateLog: return L10n.onboardingPrivateTitle
        case .consent: return L10n.onboardingConsentTitle
        }
    }

    private func symbol(for page: OnboardingPage) -> String {
        switch page {
        case .log: return "cup.and.saucer"
        case .privateLog: return "lock.iphone"
        case .consent: return "person.3"
        }
    }
}
