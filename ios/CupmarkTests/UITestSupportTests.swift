#if DEBUG
import XCTest
@testable import Cupmark

/// The Debug-only start of the UI tests (M2-T33, `UITestSupport/`): the launch argument, the
/// fixture store and the stub API. The UI tests themselves (`CupmarkUITests`) audit the screens.
final class UITestSupportTests: XCTestCase {
    // MARK: - Launch argument

    func testWithoutTheArgumentTheAppStartsAsAlways() {
        XCTAssertNil(UITestLaunch(arguments: ["/path/Cupmark"]))
        XCTAssertNil(UITestLaunch(arguments: []))
        XCTAssertNil(UITestLaunch(arguments: ["/path/Cupmark", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]))
    }

    func testTheArgumentNamesTheScreen() {
        for screen in UITestLaunch.Screen.allCases {
            let launch = UITestLaunch(arguments: ["/path/Cupmark", UITestLaunch.argument, screen.rawValue, "-AppleLanguages", "(en)"])
            XCTAssertEqual(launch?.screen, screen)
        }
    }

    func testAnArgumentWithoutAKnownScreenStartsNothing() {
        XCTAssertNil(UITestLaunch(arguments: ["/path/Cupmark", UITestLaunch.argument]))
        XCTAssertNil(UITestLaunch(arguments: ["/path/Cupmark", UITestLaunch.argument, "nowhere"]))
    }

    func testAnimationsStayOnUnlessTheLaunchTurnsThemOff() {
        let screen = [UITestLaunch.argument, "shelf"]
        XCTAssertEqual(UITestLaunch(arguments: screen)?.animationsDisabled, false)
        XCTAssertEqual(UITestLaunch(arguments: screen + [UITestLaunch.disableAnimationsArgument])?.animationsDisabled, true)
        // The flag alone starts nothing.
        XCTAssertNil(UITestLaunch(arguments: [UITestLaunch.disableAnimationsArgument]))
    }

    func testEveryAuditedScreenOfTheTaskHasAValue() {
        // The twelve screens of the acceptance, plus not configured.
        XCTAssertEqual(UITestLaunch.Screen.allCases.count, 13)
        XCTAssertEqual(Set(UITestLaunch.Screen.allCases.map(\.rawValue)).count, UITestLaunch.Screen.allCases.count)
    }

    // MARK: - Fixtures

    @MainActor
    func testTheFixtureStoreHasEverythingTheScreensShowAndSendsNothing() throws {
        let seeded = try UITestFixtures.seed(withProfile: true)
        let store = seeded.store
        XCTAssertNotNil(try store.profile())
        XCTAssertEqual(try store.shelfEntries().count, 2)
        let brews = try store.brewsNewestFirst()
        XCTAssertEqual(brews.count, 4)
        XCTAssertEqual(Set(brews.compactMap(\.method)).count, min(3, Vocabulary.Method.allCases.count))
        XCTAssertEqual(brews.first?.localID, seeded.unratedBrew)
        XCTAssertNil(brews.first?.rating)
        XCTAssertEqual(brews.dropFirst().filter { $0.rating != nil }.count, 3)
        XCTAssertGreaterThan(try store.recipes().count, BrewStartModel.inlineRecipeLimit)
        XCTAssertNotNil(try store.shelfEntry(localID: seeded.shelfEntry))
        // Everything is synced: the outbox is empty, so the engine never has anything to send.
        XCTAssertEqual(try store.outboxOperations().count, 0)
    }

    @MainActor
    func testWithoutAProfileOnboardingIsDue() throws {
        let seeded = try UITestFixtures.seed(withProfile: false)
        XCTAssertNil(try seeded.store.profile())
        XCTAssertEqual(try seeded.store.outboxOperations().count, 0)
    }

    func testTheFixtureIDsAreContractIDs() {
        // A ULID: 26 characters of Crockford base32, without I, L, O and U.
        let allowed = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        for id in [UITestFixtures.catalogueBeanID, UITestFixtures.describedBeanID, UITestFixtures.shelfEntryID, UITestFixtures.secondShelfEntryID] {
            XCTAssertEqual(id.count, 26, id)
            XCTAssertTrue(id.allSatisfy { allowed.contains($0) }, id)
        }
        XCTAssertNotNil(CanonicalBarcode(UITestFixtures.barcode))
    }

    // MARK: - Stub API

    func testTheStubAnswersTheFixtureBarcodeAndNothingElse() throws {
        let found = UITestAPI.answer(method: "GET", path: "/barcodes/\(UITestFixtures.barcode)")
        XCTAssertEqual(found.status, 200)
        XCTAssertEqual(try JSONDecoder().decode(API.Bean.self, from: found.body), UITestFixtures.catalogueBean())
        XCTAssertEqual(UITestAPI.answer(method: "GET", path: "/shelf").status, 503)
        XCTAssertEqual(UITestAPI.answer(method: "POST", path: "/barcodes/\(UITestFixtures.barcode)").status, 503)
    }

    func testTheStubClientLooksTheBarcodeUpWithoutANetwork() async throws {
        let client = try XCTUnwrap(UITestAPI.makeClient())
        XCTAssertEqual(client.baseURL.host(), "api.cupmark.test")
        let barcode = try XCTUnwrap(CanonicalBarcode(UITestFixtures.barcode)?.lookupBarcode)
        let bean = try await client.lookupBarcode(barcode)
        XCTAssertEqual(bean, UITestFixtures.catalogueBean())
        do {
            _ = try await client.listShelfEntries()
            XCTFail("the stub answers only the barcode")
        } catch let error as APIError {
            XCTAssertEqual(error, .serviceUnavailable)
        }
    }

    // MARK: - Fake sign-in

    @MainActor
    func testTheFakeSignInIsConfiguredAndSignedInWithoutTheKeychain() async throws {
        let config = try XCTUnwrap(UITestAuth.stageConfig())
        let model = UITestAuth.model(config: config, signedInAs: UITestFixtures.account)
        let status = await model.session.restore()
        XCTAssertEqual(status, .signedIn(UITestFixtures.account))
        let signedOut = UITestAuth.model(config: config, signedInAs: nil)
        let none = await signedOut.session.restore()
        XCTAssertEqual(none, .signedOut)
    }
}
#endif
