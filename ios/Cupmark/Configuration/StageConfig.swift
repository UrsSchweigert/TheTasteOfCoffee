import Foundation

/// A backend stage (infra/src/config.ts). Debug and the M2 TestFlight builds use dev
/// (ADR 0023).
enum Stage: String, CaseIterable, Sendable {
    case dev
    case prod
}

/// Why the stage configuration was rejected. Names the Info.plist key, never its value.
enum StageConfigError: Error, Equatable, Sendable {
    /// The key is absent, not set by the xcconfig, or empty.
    case missing(StageConfig.InfoKey)
    /// The value has the wrong shape, for example a placeholder.
    case malformed(StageConfig.InfoKey)
    /// The value names an AWS region other than eu-central-1 (invariant 6).
    case wrongRegion(StageConfig.InfoKey)
}

/// The backend endpoints of the stage the app was built for (M2-T9).
///
/// The values come from `Config/Dev.xcconfig` or `Config/Prod.xcconfig` through the keys of
/// `Config/Info.plist`. They are not secrets: the Cognito app client is public and has no
/// secret (infra/src/identity.ts). Everything is checked here, so the rest of the app only
/// sees an eu-central-1 configuration of the right shape.
struct StageConfig: Equatable, Sendable {
    /// The Info.plist keys, filled from the `CUPMARK_*` build settings.
    enum InfoKey: String, CaseIterable, Sendable {
        case stage = "CupmarkStage"
        case hostedDomain = "CupmarkHostedDomain"
        case appClientID = "CupmarkAppClientID"
        case apiURL = "CupmarkAPIURL"
        case redirectURL = "CupmarkRedirectURL"
        case signOutURL = "CupmarkSignOutURL"
    }

    /// Invariant 6: the only region the app talks to.
    static let region = "eu-central-1"
    /// The callback and sign-out URLs registered on the app client (infra/src/identity.ts).
    static let redirectURLString = "cupmark://auth"
    static let signOutURLString = "cupmark://signout"
    /// The callback scheme for `ASWebAuthenticationSession` (M2-T11).
    static let callbackScheme = "cupmark"
    /// Longest Cognito app client id the Cognito API allows.
    static let maxAppClientIDLength = 128
    /// Length of an API Gateway API id.
    static let apiIDLength = 10

    let stage: Stage
    /// `https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com`, without a trailing slash.
    let hostedDomain: URL
    let appClientID: String
    /// The stack output `ApiUrl`, `https://<api id>.execute-api.eu-central-1.amazonaws.com`.
    /// Passed to `APIClient(baseURL:)`.
    let apiBaseURL: URL
    let redirectURL: URL
    let signOutURL: URL

    /// Reads the configuration from the bundle's Info.plist.
    static func load(from bundle: Bundle) throws -> StageConfig {
        try StageConfig(info: bundle.infoDictionary ?? [:])
    }

    /// Checks every key in the order of `InfoKey.allCases` and throws the first problem.
    init(info: [String: Any]) throws {
        let stageValue = try Self.string(info, .stage)
        guard let stage = Stage(rawValue: stageValue) else {
            throw StageConfigError.malformed(.stage)
        }
        self.stage = stage
        self.hostedDomain = try Self.checkHostedDomain(Self.string(info, .hostedDomain), stage: stage)
        self.appClientID = try Self.checkAppClientID(Self.string(info, .appClientID))
        self.apiBaseURL = try Self.checkAPIURL(Self.string(info, .apiURL))
        self.redirectURL = try Self.checkFixedURL(Self.string(info, .redirectURL), expected: Self.redirectURLString, key: .redirectURL)
        self.signOutURL = try Self.checkFixedURL(Self.string(info, .signOutURL), expected: Self.signOutURLString, key: .signOutURL)
    }

    // MARK: - Checks

    private static let lowercaseAlphanumerics = Set("abcdefghijklmnopqrstuvwxyz0123456789")
    private static let alphanumerics = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

    /// The value of `key`. An absent or empty value is `missing`, as is one the build left
    /// unexpanded; a value that is not a string or has spaces is `malformed`.
    private static func string(_ info: [String: Any], _ key: InfoKey) throws -> String {
        guard let raw = info[key.rawValue] else {
            throw StageConfigError.missing(key)
        }
        guard let value = raw as? String else {
            throw StageConfigError.malformed(key)
        }
        if value.isEmpty || value.hasPrefix("$(") {
            throw StageConfigError.missing(key)
        }
        if value.contains(where: { $0.isWhitespace }) {
            throw StageConfigError.malformed(key)
        }
        return value
    }

    /// An `https` URL with a lowercase host and nothing else: no user, port, path, query or
    /// fragment. Returns the URL without a trailing slash and the host's labels.
    private static func httpsOrigin(_ value: String, key: InfoKey) throws -> (url: URL, labels: [String]) {
        guard var components = URLComponents(string: value),
              components.scheme == "https",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.query == nil,
              components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              let host = components.host,
              !host.isEmpty,
              host == host.lowercased() else {
            throw StageConfigError.malformed(key)
        }
        components.path = ""
        guard let url = components.url else {
            throw StageConfigError.malformed(key)
        }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        return (url, labels)
    }

    /// `https://cupmark-<stage>.auth.eu-central-1.amazoncognito.com` (infra/src/identity.ts,
    /// `cognitoDomainPrefix`).
    private static func checkHostedDomain(_ value: String, stage: Stage) throws -> URL {
        let origin = try httpsOrigin(value, key: .hostedDomain)
        let labels = origin.labels
        guard labels.count == 5,
              labels[1] == "auth",
              labels[3] == "amazoncognito",
              labels[4] == "com" else {
            throw StageConfigError.malformed(.hostedDomain)
        }
        guard labels[2] == region else {
            throw StageConfigError.wrongRegion(.hostedDomain)
        }
        guard labels[0] == "cupmark-\(stage.rawValue)" else {
            throw StageConfigError.malformed(.hostedDomain)
        }
        return origin.url
    }

    /// A Cognito app client id: letters and digits, at most 128.
    private static func checkAppClientID(_ value: String) throws -> String {
        guard value.count <= maxAppClientIDLength,
              value.allSatisfy({ alphanumerics.contains($0) }) else {
            throw StageConfigError.malformed(.appClientID)
        }
        return value
    }

    /// The HTTP API's default endpoint, `https://<api id>.execute-api.eu-central-1.amazonaws.com`.
    private static func checkAPIURL(_ value: String) throws -> URL {
        let origin = try httpsOrigin(value, key: .apiURL)
        let labels = origin.labels
        guard labels.count == 5,
              labels[1] == "execute-api",
              labels[3] == "amazonaws",
              labels[4] == "com" else {
            throw StageConfigError.malformed(.apiURL)
        }
        guard labels[2] == region else {
            throw StageConfigError.wrongRegion(.apiURL)
        }
        let apiID = labels[0]
        guard apiID.count == apiIDLength,
              apiID.allSatisfy({ lowercaseAlphanumerics.contains($0) }) else {
            throw StageConfigError.malformed(.apiURL)
        }
        return origin.url
    }

    /// A URL that must be exactly the one registered on the app client.
    private static func checkFixedURL(_ value: String, expected: String, key: InfoKey) throws -> URL {
        guard value == expected, let url = URL(string: value) else {
            throw StageConfigError.malformed(key)
        }
        return url
    }
}

/// The result of reading the stage configuration at launch.
enum StageConfigLoadState: Sendable {
    case configured(StageConfig)
    case notConfigured(StageConfigError)

    static func load(from bundle: Bundle) -> StageConfigLoadState {
        load(info: bundle.infoDictionary ?? [:])
    }

    static func load(info: [String: Any]) -> StageConfigLoadState {
        do {
            return .configured(try StageConfig(info: info))
        } catch let error as StageConfigError {
            return .notConfigured(error)
        } catch {
            return .notConfigured(.malformed(.stage))
        }
    }
}
