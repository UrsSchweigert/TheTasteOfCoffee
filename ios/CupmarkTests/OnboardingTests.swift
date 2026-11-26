import SwiftData
import XCTest
@testable import Cupmark

/// Onboarding with consent and the Settings toggle (M2-T29, docs/07 D1, ADR 0017), against
/// `FakeSyncServer` and in-memory stores: a 404 from `GET /profile` leads to onboarding and a
/// 200 skips it, not agreeing is the default and skipping sends false, the locale mapping,
/// an offline completion queued and sent later, the merge with a server profile found before
/// the first `PUT` (consent only if both say yes), no onboarding once a local profile exists, and the toggle sending `PUT /profile`
/// while every personal feature keeps working.
@MainActor
final class OnboardingTests: XCTestCase {
    /// The label photo folders of the hosts here: a temporary root, never the app's own.
    private let labelPhotoRoot = LabelPhotoFixtures.temporaryDirectory()

    override func tearDown() {
        try? FileManager.default.removeItem(at: labelPhotoRoot)
        super.tearDown()
    }

    // MARK: - Fixtures

    private func profileValues(consent: Bool, locale: VocabularyLanguage = .en) -> API.Profile {
        API.Profile(locale: locale, consent: API.Consent(contributeToAggregates: consent))
    }

    /// A profile read from the server: synced, no operation.
    private func syncedProfile(_ store: AccountStore, consent: Bool) throws {
        let profile = try store.setProfile(profileValues(consent: consent))
        try store.write {
            try store.removeOutboxOperations(for: profile.localID)
            profile.syncState = .synced
            try store.save()
        }
    }

    private func makeEngine(_ store: AccountStore, _ server: FakeSyncServer, clock: TestClock = TestClock()) -> SyncEngine {
        SyncEngine(store: store, client: server.client(), now: { clock.now }, jitter: { 1 }, sleep: { _ in })
    }

    private func queue(_ store: AccountStore) throws -> [String] {
        try store.outboxOperations().map { operation in "\(operation.actionRaw) \(operation.resourceRaw)" }
    }

    private func makeHost(_ server: FakeSyncServer) -> SyncHost {
        let client = server.client()
        return SyncHost(
            makeStore: { _ in try AccountStore.inMemory() },
            makeEngine: { _, store in SyncEngine(store: store, client: client) },
            makePuller: { _, store in Puller(store: store, client: client) },
            labelPhotos: LabelPhotoFolders(root: labelPhotoRoot)
        )
    }

    /// Waits on the main actor until `condition` holds, at most `timeout` seconds.
    private func waitUntil(timeout: TimeInterval = 10, _ message: String, _ condition: () throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while try !condition() {
            guard Date() < deadline else {
                XCTFail("timed out: \(message)")
                return
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    /// Goes through every page with Next, the last one included.
    private func finishWithNext(_ model: OnboardingModel) {
        for _ in OnboardingPage.allCases {
            model.next()
        }
    }

    // MARK: - 404 starts onboarding, 200 skips it

    func testA404FromGetProfileAfterSignInStartsOnboarding() async throws {
        let server = try FakeSyncServer()
        server.backend.seed(profile: nil)
        let host = makeHost(server)
        defer { host.switchTo(nil) }

        host.switchTo(AccountID(subject: AuthFixtures.subject))
        let store = try XCTUnwrap(host.store)
        let gate = OnboardingGateModel(store: store)
        XCTAssertEqual(gate.decision(server: host.serverProfile), .checking, "before the server answered")

        try await waitUntil("the first pull") { host.lastPull != nil }

        XCTAssertEqual(host.serverProfile, .missing)
        XCTAssertEqual(gate.decision(server: host.serverProfile), .onboarding)
        XCTAssertNil(try store.profile(), "the pull creates no profile")
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log.filter { line in line == "GET /profile" }.count, 1)
            XCTAssertFalse(server.log.contains("PUT /profile"))
        }
    }

    func testA200FromGetProfileSkipsOnboarding() async throws {
        let server = try FakeSyncServer()
        server.backend.seed(profile: profileValues(consent: true))
        let host = makeHost(server)
        defer { host.switchTo(nil) }

        host.switchTo(AccountID(subject: AuthFixtures.subject))
        let store = try XCTUnwrap(host.store)
        let gate = OnboardingGateModel(store: store)
        try await waitUntil("the first pull") { host.lastPull != nil }
        gate.reload()

        XCTAssertEqual(host.serverProfile, .found)
        XCTAssertEqual(gate.decision(server: host.serverProfile), .done)
        XCTAssertEqual(try store.profile()?.contributeToAggregates, true, "the pull stored the server's profile")
        XCTAssertTrue(try store.outboxOperations().isEmpty, "nothing is sent back")
        // A found profile this build cannot read skips onboarding too.
        XCTAssertEqual(OnboardingRules.decision(hasLocalProfile: false, server: .found, waitedLongEnough: false), .done)
        withExtendedLifetime(server) {}
    }

    func testAFailedPullShowsOnboardingInsteadOfWaiting() async throws {
        let server = try FakeSyncServer()
        server.backend.setOverride { _ in throw URLError(.notConnectedToInternet) }
        let host = makeHost(server)
        defer { host.switchTo(nil) }

        host.switchTo(AccountID(subject: AuthFixtures.subject))
        let store = try XCTUnwrap(host.store)
        try await waitUntil("the failed pull") { host.lastPullFailed }

        XCTAssertEqual(host.serverProfile, .unreachable)
        XCTAssertEqual(OnboardingGateModel(store: store).decision(server: host.serverProfile), .onboarding)
        withExtendedLifetime(server) {}
    }

    func testTheDecisionWaitsOnlyBrieflyForTheServer() {
        XCTAssertEqual(OnboardingRules.decision(hasLocalProfile: false, server: .notYet, waitedLongEnough: false), .checking)
        XCTAssertEqual(OnboardingRules.decision(hasLocalProfile: false, server: .notYet, waitedLongEnough: true), .onboarding)
        XCTAssertEqual(OnboardingRules.decision(hasLocalProfile: false, server: .unreachable, waitedLongEnough: false), .onboarding)
        XCTAssertEqual(OnboardingRules.decision(hasLocalProfile: false, server: .missing, waitedLongEnough: false), .onboarding)
        XCTAssertGreaterThan(OnboardingRules.serverWait, .zero)
    }

    // MARK: - Never again once a profile exists

    func testNoOnboardingOnceALocalProfileExists() throws {
        let store = try AccountStore.inMemory()
        try store.setProfile(profileValues(consent: false))

        let gate = OnboardingGateModel(store: store)
        for server in [ServerProfileAnswer.notYet, .found, .missing, .unreachable] {
            XCTAssertEqual(gate.decision(server: server), .done, "\(server)")
        }
        for server in [ServerProfileAnswer.notYet, .found, .missing, .unreachable] {
            XCTAssertEqual(OnboardingRules.decision(hasLocalProfile: true, server: server, waitedLongEnough: true), .done)
        }
    }

    func testFinishingOnboardingEndsItThroughTheStoresSave() throws {
        let store = try AccountStore.inMemory()
        let gate = OnboardingGateModel(store: store)
        XCTAssertEqual(gate.decision(server: .missing), .onboarding)

        gate.onboarding.skip()
        // The screen reloads on `AccountStore.didSaveNotification`.
        gate.reload()

        XCTAssertTrue(gate.onboarding.finished)
        XCTAssertEqual(gate.decision(server: .missing), .done)
    }

    func testFinishingWritesNothingWhenAProfileArrivedMeanwhile() throws {
        let store = try AccountStore.inMemory()
        let model = OnboardingModel(store: store, preferredLanguages: { ["de-DE"] })
        // The pull stored the server's profile while the flow was open.
        try syncedProfile(store, consent: true)

        model.skip()

        XCTAssertTrue(model.finished)
        XCTAssertTrue(try store.outboxOperations().isEmpty, "the server's profile is not replaced")
        XCTAssertEqual(try store.profile()?.contributeToAggregates, true)
    }

    // MARK: - The false default

    func testNotAgreeingIsTheDefault() throws {
        let store = try AccountStore.inMemory()
        let model = OnboardingModel(store: store)
        XCTAssertFalse(model.agrees)
        XCTAssertEqual(model.page, OnboardingPage.allCases.first)
        XCTAssertGreaterThan(OnboardingPage.allCases.count, 1, "intro pages before the consent")
        XCTAssertEqual(OnboardingPage.allCases.last, .consent)

        finishWithNext(model)

        XCTAssertTrue(model.finished)
        let profile = try XCTUnwrap(try store.profile())
        XCTAssertFalse(profile.contributeToAggregates)
        XCTAssertEqual(profile.syncState, .pendingCreate)
        XCTAssertEqual(try queue(store), ["update profile"], "PUT /profile is queued")
    }

    func testSkippingSendsFalseOnAnyPage() throws {
        for page in OnboardingPage.allCases {
            let store = try AccountStore.inMemory()
            let model = OnboardingModel(store: store)
            while model.page != page {
                model.next()
            }
            // Even with the control turned on, skipping is not agreeing.
            model.agrees = true

            model.skip()

            XCTAssertTrue(model.finished)
            XCTAssertEqual(try store.profile()?.contributeToAggregates, false, "\(page)")
            XCTAssertEqual(try queue(store), ["update profile"])
        }
    }

    func testAgreeingOnTheConsentPageSendsTrue() throws {
        let store = try AccountStore.inMemory()
        let model = OnboardingModel(store: store)
        while model.page != .consent {
            model.next()
        }
        XCTAssertNil(try store.profile(), "nothing is stored before the end")

        model.agrees = true
        model.next()

        XCTAssertEqual(try store.profile()?.contributeToAggregates, true)
    }

    func testAFailedSaveSaysSoAndStoresNothing() throws {
        let store = try AccountStore.inMemory()
        let model = OnboardingModel(store: store)
        struct SaveFailed: Error {}
        store.willSave = { throw SaveFailed() }

        model.skip()

        XCTAssertTrue(model.saveFailed)
        XCTAssertFalse(model.finished)
        store.willSave = nil
        XCTAssertNil(try store.profile())
        XCTAssertTrue(try store.outboxOperations().isEmpty)

        model.skip()
        XCTAssertFalse(model.saveFailed)
        XCTAssertTrue(model.finished)
    }

    // MARK: - Locale

    func testTheLocaleIsTheFirstPreferredLanguageThatIsGermanOrEnglish() {
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: ["de-DE"]), .de)
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: ["de"]), .de)
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: ["de-CH", "en-US"]), .de)
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: ["de-AT"]), .de)
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: ["en-US"]), .en)
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: ["en-GB", "de-DE"]), .en, "the first preferred language counts")
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: ["fr-FR"]), .en)
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: ["fr-FR", "de-DE"]), .de, "an unsupported language is skipped")
        XCTAssertEqual(OnboardingRules.profileLocale(preferredLanguages: []), .en)
    }

    func testOnboardingSendsThePreferredLocale() async throws {
        let server = try FakeSyncServer()
        let store = try AccountStore.inMemory()
        let model = OnboardingModel(store: store, preferredLanguages: { ["de-CH"] })
        model.skip()

        let result = await makeEngine(store, server).drain()

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile", "PUT /profile"])
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: false, locale: .de))
        }
        XCTAssertEqual(try store.profile()?.syncState, .synced)
    }

    // MARK: - Offline

    func testOnboardingFinishedOfflineIsQueuedAndSentLater() async throws {
        let server = try FakeSyncServer()
        server.backend.setOverride { _ in throw URLError(.notConnectedToInternet) }
        let store = try AccountStore.inMemory()
        let clock = TestClock()
        let engine = makeEngine(store, server, clock: clock)
        let model = OnboardingModel(store: store, preferredLanguages: { ["en-US"] })
        while model.page != .consent {
            model.next()
        }
        model.agrees = true
        model.next()
        XCTAssertTrue(model.finished, "finishing needs no network")

        let offline = await engine.drain()

        guard case .waiting = offline else {
            return XCTFail("offline, the PUT waits: \(offline)")
        }
        XCTAssertEqual(try queue(store), ["update profile"])
        XCTAssertEqual(try store.profile()?.syncState, .pendingCreate)

        server.backend.setOverride(nil)
        clock.advance(300)
        let online = await engine.drain()

        XCTAssertEqual(online, .idle)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertEqual(try store.profile()?.syncState, .synced)
        withExtendedLifetime(server) {
            XCTAssertEqual(Array(server.log.suffix(2)), ["GET /profile", "PUT /profile"])
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: true))
        }
    }

    // MARK: - A server profile found before the first PUT (ADR 0025, Addendum M2-T29)

    /// Finishes onboarding on `store`, agreeing or not.
    private func onboard(_ store: AccountStore, agreed: Bool) {
        let model = OnboardingModel(store: store, preferredLanguages: { ["en-US"] })
        if agreed {
            while model.page != .consent {
                model.next()
            }
            model.agrees = true
            model.next()
        } else {
            model.skip()
        }
    }

    func testServerYesAndAnOnboardingNoHereSendsNo() async throws {
        let server = try FakeSyncServer()
        // Made on another device.
        server.backend.seed(profile: profileValues(consent: true, locale: .de))
        let store = try AccountStore.inMemory()
        onboard(store, agreed: false)

        let result = await makeEngine(store, server).drain()

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile", "PUT /profile"])
            // The server's locale, and the "no" given here.
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: false, locale: .de))
        }
        let profile = try XCTUnwrap(try store.profile())
        XCTAssertFalse(profile.contributeToAggregates)
        XCTAssertEqual(profile.locale, .de)
        XCTAssertEqual(profile.syncState, .synced)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    func testServerYesAndASettingsNoBeforeTheFirstSyncSendsNo() async throws {
        let server = try FakeSyncServer()
        server.backend.seed(profile: profileValues(consent: true, locale: .de))
        let store = try AccountStore.inMemory()
        onboard(store, agreed: true)
        SettingsModel(store: store).setContributesToAggregates(false)
        XCTAssertEqual(try queue(store), ["update profile"], "one coalesced operation")
        XCTAssertEqual(try store.profile()?.syncState, .pendingCreate)

        let result = await makeEngine(store, server).drain()

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile", "PUT /profile"])
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: false, locale: .de))
        }
        XCTAssertEqual(try store.profile()?.contributeToAggregates, false)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    func testServerNoAndAYesHereStaysNo() async throws {
        let server = try FakeSyncServer()
        server.backend.seed(profile: profileValues(consent: false, locale: .de))
        let store = try AccountStore.inMemory()
        onboard(store, agreed: true)

        let result = await makeEngine(store, server).drain()

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile"], "the merge is the server's profile: nothing is sent")
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: false, locale: .de))
        }
        let profile = try XCTUnwrap(try store.profile())
        XCTAssertFalse(profile.contributeToAggregates)
        XCTAssertEqual(profile.syncState, .synced)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertFalse(SettingsModel(store: store).contributesToAggregates, "Settings shows off")
    }

    func testServerYesAndYesHereIsAdoptedWithoutAPut() async throws {
        let server = try FakeSyncServer()
        server.backend.seed(profile: profileValues(consent: true, locale: .de))
        let store = try AccountStore.inMemory()
        onboard(store, agreed: true)

        let result = await makeEngine(store, server).drain()

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile"])
        }
        let profile = try XCTUnwrap(try store.profile())
        XCTAssertTrue(profile.contributeToAggregates)
        XCTAssertEqual(profile.locale, .de, "the server's locale")
        XCTAssertEqual(profile.syncState, .synced)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    func testAnEditMadeWhileTheReadIsInFlightIsNotLost() async throws {
        let server = try FakeSyncServer()
        let remote = profileValues(consent: true, locale: .de)
        let answer = try JSONEncoder().encode(remote)
        server.backend.setOverride { request in
            request.method == "GET" && request.path == "/profile" ? StubResponse(status: 200, body: answer, delay: 0.5) : nil
        }
        let store = try AccountStore.inMemory()
        onboard(store, agreed: true)
        let engine = makeEngine(store, server)

        let drain = Task { await engine.drain() }
        try await waitUntil("the read is on its way") { server.log.contains("GET /profile") }
        SettingsModel(store: store).setContributesToAggregates(false)
        let result = await drain.value

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile", "PUT /profile"])
            let sent = try? JSONDecoder().decode(API.Profile.self, from: server.requests.last?.body ?? Data())
            XCTAssertEqual(sent, profileValues(consent: false, locale: .de))
        }
        XCTAssertEqual(try store.profile()?.contributeToAggregates, false)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    /// As if an earlier `PUT` had gone out without an answer: its operation no longer carries
    /// a later edit, so an edit queues a second one.
    private func markSentWithoutAnswer(_ store: AccountStore) throws {
        let operation = try XCTUnwrap(try store.outboxOperations().first)
        try store.write {
            operation.sentWithoutAnswer = true
            try store.save()
        }
    }

    /// `GET /profile` answers `remote` after a short delay, so the test can edit meanwhile.
    private func answerTheReadLate(_ server: FakeSyncServer, with remote: API.Profile) throws {
        let answer = try JSONEncoder().encode(remote)
        server.backend.setOverride { request in
            request.method == "GET" && request.path == "/profile" ? StubResponse(status: 200, body: answer, delay: 0.5) : nil
        }
    }

    /// M2-T37 (M2-T29 review): the operation was sent without an answer, so the edit made
    /// during the read is a second operation. The merge keeps one, and the merged values go out
    /// in one `PUT`.
    func testAnEditDuringTheReadAfterAnUnansweredPutIsMergedAndSentOnce() async throws {
        let server = try FakeSyncServer()
        try answerTheReadLate(server, with: profileValues(consent: true, locale: .de))
        let store = try AccountStore.inMemory()
        onboard(store, agreed: true)
        try markSentWithoutAnswer(store)
        let engine = makeEngine(store, server)

        let drain = Task { await engine.drain() }
        try await waitUntil("the read is on its way") { server.log.contains("GET /profile") }
        SettingsModel(store: store).setContributesToAggregates(false)
        XCTAssertEqual(try queue(store), ["update profile", "update profile"], "the first one may already be on the server")
        let result = await drain.value

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile", "PUT /profile"], "one PUT for both operations")
            let sent = try? JSONDecoder().decode(API.Profile.self, from: server.requests.last?.body ?? Data())
            XCTAssertEqual(sent, profileValues(consent: false, locale: .de))
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: false, locale: .de))
        }
        let profile = try XCTUnwrap(try store.profile())
        XCTAssertFalse(profile.contributeToAggregates)
        XCTAssertEqual(profile.syncState, .synced)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    /// The same with a merge that equals the server's profile: both operations go, nothing is
    /// sent, and the "yes" given during the read does not override the server's "no".
    func testAnEditDuringTheReadAfterAnUnansweredPutIsAdoptedWithoutAPut() async throws {
        let server = try FakeSyncServer()
        try answerTheReadLate(server, with: profileValues(consent: false, locale: .de))
        let store = try AccountStore.inMemory()
        onboard(store, agreed: false)
        try markSentWithoutAnswer(store)
        let engine = makeEngine(store, server)

        let drain = Task { await engine.drain() }
        try await waitUntil("the read is on its way") { server.log.contains("GET /profile") }
        SettingsModel(store: store).setContributesToAggregates(true)
        XCTAssertEqual(try queue(store), ["update profile", "update profile"])
        let result = await drain.value

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile"])
        }
        let profile = try XCTUnwrap(try store.profile())
        XCTAssertFalse(profile.contributeToAggregates)
        XCTAssertEqual(profile.locale, .de)
        XCTAssertEqual(profile.syncState, .synced)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    /// Parks the profile's operation (as a refused send would, with its flag) and queues
    /// another, which the engine then sends with the check.
    private func parkTheFirstAndQueueAnother(_ store: AccountStore) throws {
        let profile = try XCTUnwrap(try store.profile())
        let first = try XCTUnwrap(try store.outboxOperations().first)
        try store.write {
            first.parked = true
            first.parkReason = .rejected
            profile.syncIssue = .rejected
            try store.enqueue(.update, .profile, localID: profile.localID)
            try store.save()
        }
        XCTAssertEqual(try store.outboxOperations().map(\.parked), [true, false])
        XCTAssertEqual(profile.syncState, .pendingCreate)
    }

    /// M2-T37 (M2-T29 review): the merge and the adopt branch treat a parked operation of the
    /// profile alike, as ADR 0025 Addendum M2-T29 says: it goes with the others, so the profile
    /// has no operation left once it is synced, and a later edit is queued and sent. The flag
    /// stays for the screen's "OK" (Addendum M2-T18).
    func testAParkedProfileOperationGoesInTheMergeAndTheAdoptBranch() async throws {
        // Merge: the server says yes, here no, so the merged "no" is sent.
        let merged = try FakeSyncServer()
        merged.backend.seed(profile: profileValues(consent: true, locale: .de))
        let mergeStore = try AccountStore.inMemory()
        onboard(mergeStore, agreed: false)
        try parkTheFirstAndQueueAnother(mergeStore)

        let mergeResult = await makeEngine(mergeStore, merged).drain()

        XCTAssertEqual(mergeResult, .idle)
        withExtendedLifetime(merged) {
            XCTAssertEqual(merged.log, ["GET /profile", "PUT /profile"])
        }
        XCTAssertEqual(try queue(mergeStore), [], "the parked operation went too")
        XCTAssertEqual(try mergeStore.profile()?.syncState, .synced)
        XCTAssertEqual(try mergeStore.profile()?.syncIssue, .rejected)
        SettingsModel(store: mergeStore).setContributesToAggregates(true)
        XCTAssertEqual(try queue(mergeStore), ["update profile"], "a later edit is queued")

        // Adopt: both say no, so the server's profile is taken and nothing is sent.
        let adopted = try FakeSyncServer()
        adopted.backend.seed(profile: profileValues(consent: false, locale: .de))
        let adoptStore = try AccountStore.inMemory()
        onboard(adoptStore, agreed: false)
        try parkTheFirstAndQueueAnother(adoptStore)

        let adoptResult = await makeEngine(adoptStore, adopted).drain()

        XCTAssertEqual(adoptResult, .idle)
        withExtendedLifetime(adopted) {
            XCTAssertEqual(adopted.log, ["GET /profile"])
        }
        XCTAssertEqual(try queue(adoptStore), [], "the parked operation went too")
        XCTAssertEqual(try adoptStore.profile()?.syncState, .synced)
        XCTAssertEqual(try adoptStore.profile()?.syncIssue, .rejected)
        SettingsModel(store: adoptStore).setContributesToAggregates(true)
        XCTAssertEqual(try queue(adoptStore), ["update profile"], "a later edit is queued")
    }

    func testAFailingReadBacksOffOneAttemptPerCycleThenSendsOn404() async throws {
        let server = try FakeSyncServer()
        server.backend.setOverride { request in
            request.method == "GET" && request.path == "/profile" ? StubResponse(status: 503) : nil
        }
        let store = try AccountStore.inMemory()
        let clock = TestClock()
        let engine = makeEngine(store, server, clock: clock)
        onboard(store, agreed: false)
        // As if an earlier PUT had gone out without an answer: the read must not clear it.
        let operation = try XCTUnwrap(try store.outboxOperations().first)
        try store.write {
            operation.sentWithoutAnswer = true
            try store.save()
        }

        for cycle in 1...2 {
            let result = await engine.drain()
            guard case .waiting = result else {
                return XCTFail("a failing read waits: \(result)")
            }
            let waiting = try XCTUnwrap(try store.outboxOperations().first)
            XCTAssertEqual(waiting.attemptCount, cycle, "one attempt per cycle")
            XCTAssertTrue(waiting.sentWithoutAnswer, "a read answers nothing about the write")
            XCTAssertFalse(waiting.parked)
            clock.advance(300)
        }

        server.backend.setOverride(nil)
        let result = await engine.drain()

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile", "GET /profile", "GET /profile", "PUT /profile"])
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: false))
        }
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertEqual(try store.profile()?.syncState, .synced)
    }

    func testAnUnreadableServerProfileIsParkedNotOverwritten() async throws {
        let server = try FakeSyncServer()
        // A locale this build does not know, as a newer vocabulary could have.
        let newer = Data(#"{"locale":"zz","consent":{"contribute_to_aggregates":true}}"#.utf8)
        server.backend.setOverride { request in
            request.method == "GET" && request.path == "/profile" ? StubResponse(status: 200, body: newer) : nil
        }
        let store = try AccountStore.inMemory()
        onboard(store, agreed: false)

        let result = await makeEngine(store, server).drain()

        XCTAssertEqual(result, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["GET /profile"], "no PUT over a profile this build cannot read")
        }
        let operation = try XCTUnwrap(try store.outboxOperations().first)
        XCTAssertTrue(operation.parked)
        XCTAssertEqual(operation.parkReason, .unexpectedResponse)
        XCTAssertEqual(try store.profile()?.syncState, .pendingCreate)
    }

    func testTheMergeIsConsentOnlyIfBothSayYes() {
        for server in [true, false] {
            for local in [true, false] {
                let resolved = SyncEngine.resolvedProfile(server: profileValues(consent: server, locale: .de), localConsent: local)
                XCTAssertEqual(resolved, profileValues(consent: server && local, locale: .de), "server \(server), local \(local)")
            }
        }
    }

    // MARK: - Settings

    func testTheSettingsToggleSendsPutProfile() async throws {
        let server = try FakeSyncServer()
        server.backend.seed(profile: profileValues(consent: false, locale: .de))
        let store = try AccountStore.inMemory()
        let profile = try store.setProfile(profileValues(consent: false, locale: .de))
        try store.write {
            try store.removeOutboxOperations(for: profile.localID)
            profile.syncState = .synced
            try store.save()
        }
        let settings = SettingsModel(store: store, preferredLanguages: { ["en-US"] })
        XCTAssertFalse(settings.contributesToAggregates)
        let engine = makeEngine(store, server)

        settings.setContributesToAggregates(true)
        XCTAssertEqual(try queue(store), ["update profile"])
        let on = await engine.drain()

        XCTAssertEqual(on, .idle)
        XCTAssertTrue(settings.contributesToAggregates)
        withExtendedLifetime(server) {
            // A profile the server has is sent at once, with its stored locale.
            XCTAssertEqual(server.log, ["PUT /profile"])
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: true, locale: .de))
        }

        settings.setContributesToAggregates(false)
        let off = await engine.drain()

        XCTAssertEqual(off, .idle)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["PUT /profile", "PUT /profile"])
            XCTAssertEqual(server.backend.storedProfile, profileValues(consent: false, locale: .de))
        }
        XCTAssertEqual(try store.profile()?.syncState, .synced)

        // The same value again writes nothing.
        settings.setContributesToAggregates(false)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    func testTurningConsentOffKeepsThePersonalLogWorking() async throws {
        let server = try FakeSyncServer()
        let store = try AccountStore.inMemory()
        try syncedProfile(store, consent: true)
        let settings = SettingsModel(store: store)
        settings.setContributesToAggregates(false)

        // Shelf, brew and recipe writes queue and go out as before.
        let entry = try StoreFixtures.syncedShelfEntry(in: store)
        server.backend.seed(shelfEntry: StoreFixtures.shelfEntryID, try StoreFixtures.shelfEntryInput())
        try store.addBrew(try StoredBrew(try StoreFixtures.brewInput()), shelfEntry: entry)
        try store.addRecipe(StoredRecipe(API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: try StoreFixtures.parameters())))
        XCTAssertEqual(try queue(store), ["update profile", "create brew", "create recipe"])

        let result = await makeEngine(store, server).drain()

        XCTAssertEqual(result, .idle)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
        XCTAssertEqual(try store.brewsNewestFirst().count, 1)
        XCTAssertEqual(try store.recipes().count, 1)
        withExtendedLifetime(server) {
            XCTAssertEqual(server.log, ["PUT /profile", "POST /brews", "POST /recipes"])
            XCTAssertEqual(server.backend.storedProfile?.consent.contributeToAggregates, false)
        }
    }

    func testAFailedToggleSaveShowsTheStoredValueAgain() throws {
        let store = try AccountStore.inMemory()
        try syncedProfile(store, consent: false)
        let settings = SettingsModel(store: store)
        struct SaveFailed: Error {}
        store.willSave = { throw SaveFailed() }

        settings.setContributesToAggregates(true)

        XCTAssertTrue(settings.saveFailed)
        XCTAssertFalse(settings.contributesToAggregates)
        store.willSave = nil
        XCTAssertEqual(try store.profile()?.contributeToAggregates, false)
        XCTAssertTrue(try store.outboxOperations().isEmpty)
    }

    func testTheToggleWithoutAProfileCreatesOneWithThePreferredLocale() throws {
        let store = try AccountStore.inMemory()
        let settings = SettingsModel(store: store, preferredLanguages: { ["de-DE"] })
        XCTAssertFalse(settings.contributesToAggregates, "false without a profile")

        settings.setContributesToAggregates(true)

        let profile = try XCTUnwrap(try store.profile())
        XCTAssertEqual(profile.locale, .de)
        XCTAssertTrue(profile.contributeToAggregates)
        XCTAssertEqual(try queue(store), ["update profile"])
    }
}
