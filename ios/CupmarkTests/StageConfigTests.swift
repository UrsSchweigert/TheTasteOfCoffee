import XCTest
@testable import Cupmark

/// M2-T9: the stage configuration is read from Info.plist into `StageConfig`. Missing or
/// malformed values and any region but eu-central-1 are rejected, and nothing traps.
final class StageConfigTests: XCTestCase {
    /// A valid dev configuration with made-up ids of the right shape.
    private func validInfo() -> [String: Any] {
        [
            "CupmarkStage": "dev",
            "CupmarkHostedDomain": "https://cupmark-dev.auth.eu-central-1.amazoncognito.com",
            "CupmarkAppClientID": "1a2b3c4d5e6f7g8h9i0j1k2l3m",
            "CupmarkAPIURL": "https://abc123defg.execute-api.eu-central-1.amazonaws.com",
            "CupmarkRedirectURL": "cupmark://auth",
            "CupmarkSignOutURL": "cupmark://signout",
        ]
    }

    private func info(_ key: StageConfig.InfoKey, _ value: Any?) -> [String: Any] {
        var info = validInfo()
        info[key.rawValue] = value
        return info
    }

    private func assertRejected(
        _ info: [String: Any],
        _ expected: StageConfigError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try StageConfig(info: info), file: file, line: line) { error in
            XCTAssertEqual(error as? StageConfigError, expected, file: file, line: line)
        }
        guard case .notConfigured(let reported) = StageConfigLoadState.load(info: info) else {
            XCTFail("load state is configured", file: file, line: line)
            return
        }
        XCTAssertEqual(reported, expected, file: file, line: line)
    }

    // MARK: - Valid

    func testValidDevValuesAreRead() throws {
        let config = try StageConfig(info: validInfo())
        XCTAssertEqual(config.stage, .dev)
        XCTAssertEqual(config.hostedDomain.absoluteString, "https://cupmark-dev.auth.eu-central-1.amazoncognito.com")
        XCTAssertEqual(config.appClientID, "1a2b3c4d5e6f7g8h9i0j1k2l3m")
        XCTAssertEqual(config.apiBaseURL.absoluteString, "https://abc123defg.execute-api.eu-central-1.amazonaws.com")
        XCTAssertEqual(config.redirectURL.absoluteString, "cupmark://auth")
        XCTAssertEqual(config.signOutURL.absoluteString, "cupmark://signout")
        XCTAssertEqual(config.redirectURL.scheme, StageConfig.callbackScheme)
        guard case .configured(let loaded) = StageConfigLoadState.load(info: validInfo()) else {
            return XCTFail("valid values are not configured")
        }
        XCTAssertEqual(loaded, config)
    }

    func testValidProdValuesAreRead() throws {
        var values = validInfo()
        values["CupmarkStage"] = "prod"
        values["CupmarkHostedDomain"] = "https://cupmark-prod.auth.eu-central-1.amazoncognito.com"
        let config = try StageConfig(info: values)
        XCTAssertEqual(config.stage, .prod)
        XCTAssertEqual(config.hostedDomain.host, "cupmark-prod.auth.eu-central-1.amazoncognito.com")
    }

    func testATrailingSlashIsDroppedFromTheOrigins() throws {
        var values = validInfo()
        values["CupmarkHostedDomain"] = "https://cupmark-dev.auth.eu-central-1.amazoncognito.com/"
        values["CupmarkAPIURL"] = "https://abc123defg.execute-api.eu-central-1.amazonaws.com/"
        let config = try StageConfig(info: values)
        XCTAssertEqual(config.hostedDomain.absoluteString, "https://cupmark-dev.auth.eu-central-1.amazoncognito.com")
        XCTAssertEqual(config.apiBaseURL.absoluteString, "https://abc123defg.execute-api.eu-central-1.amazonaws.com")
    }

    // MARK: - Missing

    func testEachMissingKeyIsReported() {
        for key in StageConfig.InfoKey.allCases {
            assertRejected(info(key, nil), .missing(key))
        }
    }

    func testAnEmptyOrUnexpandedValueIsMissing() {
        for key in StageConfig.InfoKey.allCases {
            assertRejected(info(key, ""), .missing(key))
            assertRejected(info(key, "$(CUPMARK_UNSET)"), .missing(key))
        }
    }

    func testAnEmptyInfoDictionaryIsNotConfigured() {
        assertRejected([:], .missing(.stage))
    }

    // MARK: - Malformed

    func testANonStringValueIsMalformed() {
        for key in StageConfig.InfoKey.allCases {
            assertRejected(info(key, 42), .malformed(key))
        }
    }

    func testAValueWithWhitespaceIsMalformed() {
        assertRejected(info(.appClientID, " 1a2b3c4d5e6f7g8h9i0j1k2l3m"), .malformed(.appClientID))
        assertRejected(info(.apiURL, "https://abc123defg.execute-api.eu-central-1.amazonaws.com\n"), .malformed(.apiURL))
    }

    func testAnUnknownStageIsMalformed() {
        assertRejected(info(.stage, "staging"), .malformed(.stage))
        assertRejected(info(.stage, "Dev"), .malformed(.stage))
    }

    func testTheCommittedPlaceholdersAreMalformed() {
        assertRejected(info(.appClientID, "PLACEHOLDER-SET-IN-M2-T10"), .malformed(.appClientID))
        assertRejected(
            info(.apiURL, "https://PLACEHOLDER-SET-IN-M2-T10.execute-api.eu-central-1.amazonaws.com"),
            .malformed(.apiURL)
        )
        assertRejected(info(.appClientID, "PLACEHOLDER-SET-IN-M6"), .malformed(.appClientID))
    }

    func testMalformedHostedDomains() {
        let values = [
            "http://cupmark-dev.auth.eu-central-1.amazoncognito.com",
            "cupmark-dev.auth.eu-central-1.amazoncognito.com",
            "https://cupmark-prod.auth.eu-central-1.amazoncognito.com",
            "https://other-dev.auth.eu-central-1.amazoncognito.com",
            "https://cupmark-dev.auth.eu-central-1.amazoncognito.com/oauth2/authorize",
            "https://cupmark-dev.auth.eu-central-1.amazoncognito.com?x=1",
            "https://cupmark-dev.auth.eu-central-1.amazoncognito.com:8443",
            "https://user@cupmark-dev.auth.eu-central-1.amazoncognito.com",
            "https://CUPMARK-DEV.auth.eu-central-1.amazoncognito.com",
            "https://cupmark-dev.auth.eu-central-1.amazoncognito.com.example.com",
            "https://cupmark-dev.example.com",
            "https://",
            "not a url",
        ]
        for value in values {
            assertRejected(info(.hostedDomain, value), .malformed(.hostedDomain))
        }
    }

    func testMalformedAppClientIDs() {
        let values = [
            "client_id",
            "1a2b3c4d-5e6f",
            "<app client id>",
            String(repeating: "a", count: StageConfig.maxAppClientIDLength + 1),
        ]
        for value in values {
            assertRejected(info(.appClientID, value), .malformed(.appClientID))
        }
    }

    func testMalformedAPIURLs() {
        let values = [
            "http://abc123defg.execute-api.eu-central-1.amazonaws.com",
            "https://abc123defg.execute-api.eu-central-1.amazonaws.com/prod",
            "https://abc123defg.execute-api.eu-central-1.amazonaws.com#x",
            "https://abc123def.execute-api.eu-central-1.amazonaws.com",
            "https://abc123defgh.execute-api.eu-central-1.amazonaws.com",
            "https://ABC123DEFG.execute-api.eu-central-1.amazonaws.com",
            "https://abc123defg.lambda-url.eu-central-1.on.aws",
            "https://api.example.com",
            "abc123defg.execute-api.eu-central-1.amazonaws.com",
        ]
        for value in values {
            assertRejected(info(.apiURL, value), .malformed(.apiURL))
        }
    }

    func testRedirectAndSignOutMustBeTheRegisteredURLs() {
        assertRejected(info(.redirectURL, "cupmark://signout"), .malformed(.redirectURL))
        assertRejected(info(.redirectURL, "https://cupmark.app/auth"), .malformed(.redirectURL))
        assertRejected(info(.redirectURL, "cupmark://auth/"), .malformed(.redirectURL))
        assertRejected(info(.signOutURL, "cupmark://auth"), .malformed(.signOutURL))
        assertRejected(info(.signOutURL, "other://signout"), .malformed(.signOutURL))
    }

    // MARK: - Wrong region (invariant 6)

    func testAHostedDomainOutsideEuCentral1IsRejected() {
        for region in ["us-east-1", "eu-west-1", "eu-central-2"] {
            assertRejected(
                info(.hostedDomain, "https://cupmark-dev.auth.\(region).amazoncognito.com"),
                .wrongRegion(.hostedDomain)
            )
        }
    }

    func testAnAPIURLOutsideEuCentral1IsRejected() {
        for region in ["us-east-1", "eu-west-1", "eu-central-2"] {
            assertRejected(
                info(.apiURL, "https://abc123defg.execute-api.\(region).amazonaws.com"),
                .wrongRegion(.apiURL)
            )
        }
    }

    // MARK: - The built app

    /// The xcconfig values reach the app's Info.plist, expanded. Until M2-T10 the app client
    /// id and the API URL are placeholders, so the built app is not configured.
    func testTheAppBundleCarriesEveryKey() throws {
        let bundle = Bundle(for: AppBundleToken.self)
        for key in StageConfig.InfoKey.allCases {
            let value = try XCTUnwrap(bundle.object(forInfoDictionaryKey: key.rawValue) as? String, key.rawValue)
            XCTAssertFalse(value.isEmpty, key.rawValue)
            XCTAssertFalse(value.contains("$("), key.rawValue)
        }
        XCTAssertEqual(bundle.object(forInfoDictionaryKey: "CupmarkStage") as? String, "dev")
        XCTAssertEqual(
            bundle.object(forInfoDictionaryKey: "CupmarkHostedDomain") as? String,
            "https://cupmark-dev.auth.eu-central-1.amazoncognito.com"
        )
        XCTAssertEqual(bundle.object(forInfoDictionaryKey: "CupmarkRedirectURL") as? String, "cupmark://auth")
        XCTAssertEqual(bundle.object(forInfoDictionaryKey: "CupmarkSignOutURL") as? String, "cupmark://signout")
    }

    func testTheBuiltAppIsConfiguredWithTheDevStackValues() {
        // M2-T10: Config/Dev.xcconfig holds the outputs of the first dev deploy of cupmark-dev-core
        // (2026-11-26). They are public identifiers: an app client without a secret and an API id.
        guard case .configured(let config) = StageConfigLoadState.load(from: Bundle(for: AppBundleToken.self)) else {
            return XCTFail("the dev values were not accepted")
        }
        XCTAssertEqual(config.stage, .dev)
        XCTAssertEqual(config.appClientID, "67utjt0aog8iigctl3q0efjn54")
        XCTAssertEqual(config.apiBaseURL.absoluteString, "https://lars2krigg.execute-api.eu-central-1.amazonaws.com")
        XCTAssertEqual(config.hostedDomain.absoluteString, "https://cupmark-dev.auth.eu-central-1.amazoncognito.com")
    }
}
