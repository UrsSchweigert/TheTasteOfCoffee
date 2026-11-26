import Foundation
import XCTest
@testable import Cupmark

/// Label photo upload fixtures (M2-T24): a fake API, a stub S3 transport, presigned POSTs that
/// match the contract, a temporary file store and a multipart parser. Every presigned value
/// here is a made-up placeholder, not a credential.
enum LabelPhotoFixtures {
    static let beanID = "01JDQ6Y8Z5W4V3T2S1R0P9N8M0"
    /// The signed-in account of the tests, and another one.
    static let account = AccountID(subject: "label-photo-tests-account")
    static let otherAccount = AccountID(subject: "label-photo-tests-other-account")
    static let bucket = "cupmark-dev-photos-123456789012"
    static let url = "https://cupmark-dev-photos-123456789012.s3.eu-central-1.amazonaws.com/"
    static let policy = "eyJleHBpcmF0aW9uIjoiMjAyNi0xMS0yNVQxMDoxMDowMC4wMDBaIn0="
    static let credential = "ASIAEXAMPLEEXAMPLE00/20261125/eu-central-1/s3/aws4_request"
    static let amzDate = "20261125T100000Z"
    static let securityToken = "UGxhY2Vob2xkZXJTZXNzaW9uVG9rZW4="
    static let signature = String(repeating: "0123456789abcdef", count: 4)
    /// The fixed "now" of the tests.
    static let now = Date(timeIntervalSince1970: 1_795_000_000)
    /// A few bytes that start like a JPEG and hold a CR LF and a `--`, as a real file can.
    static let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x0D, 0x0A, 0x2D, 0x2D, 0x00, 0x7F, 0xFF, 0xD9])

    /// Photo id `n`, 0 to 9.
    static func photoID(_ n: Int) -> String {
        "01JDQ6Y8Z5W4V3T2S1R0P9N8P\(n)"
    }

    static func bean() throws -> ResourceID {
        try XCTUnwrap(ResourceID(beanID))
    }

    /// A presigned POST for photo `n` that passes every check, unless a value is overridden.
    static func upload(
        _ n: Int,
        expiresIn: TimeInterval = 600,
        url: String = LabelPhotoFixtures.url,
        key: String? = nil,
        bucket: String = LabelPhotoFixtures.bucket,
        contentType: String = "image/jpeg",
        credential: String = LabelPhotoFixtures.credential,
        securityToken: String? = LabelPhotoFixtures.securityToken,
        signature: String = LabelPhotoFixtures.signature
    ) throws -> API.LabelPhotoUpload {
        let id = photoID(n)
        return API.LabelPhotoUpload(
            photoId: id,
            upload: API.LabelPhotoUploadForm(
                url: url,
                fields: API.LabelPhotoUploadFields(
                    key: key ?? "uploads/\(id).jpg",
                    bucket: bucket,
                    contentType: contentType,
                    policy: policy,
                    xAmzAlgorithm: "AWS4-HMAC-SHA256",
                    xAmzCredential: credential,
                    xAmzDate: amzDate,
                    xAmzSecurityToken: securityToken,
                    xAmzSignature: signature
                )
            ),
            expiresAt: try XCTUnwrap(API.Timestamp(now.addingTimeInterval(expiresIn))),
            maxBytes: 8_388_608
        )
    }

    /// A store in a new temporary directory.
    static func fileStore() -> LabelPhotoFileStore {
        LabelPhotoFileStore(directory: temporaryDirectory())
    }

    /// A new temporary directory (not created yet).
    static func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(
            path: "LabelPhotoTests-\(UUID().uuidString)",
            directoryHint: .isDirectory
        )
    }

    /// `account`, with its photos in `files`, checked against `session`.
    static func photoAccount(
        files: LabelPhotoFileStore,
        session: FakeLabelPhotoSession = FakeLabelPhotoSession()
    ) -> LabelPhotoAccount {
        LabelPhotoAccount(account: account, files: files) { candidate in
            session.isSignedIn(as: candidate)
        }
    }

    static func fileExists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }
}

/// Who is signed in, for the account check before each upload step (ADR 0025). Records the
/// accounts asked about. With `signedInChecks`, only that many checks answer for the
/// signed-in account; later ones find nobody (a sign-out during the run).
final class FakeLabelPhotoSession: @unchecked Sendable {
    private let lock = NSLock()
    private let signedIn: AccountID
    private let signedInChecks: Int?
    private var asked: [AccountID] = []

    init(signedIn: AccountID = LabelPhotoFixtures.account, signedInChecks: Int? = nil) {
        self.signedIn = signedIn
        self.signedInChecks = signedInChecks
    }

    var checks: [AccountID] {
        lock.withLock { asked }
    }

    func isSignedIn(as account: AccountID) -> Bool {
        lock.withLock {
            asked.append(account)
            if let signedInChecks, asked.count > signedInChecks {
                return false
            }
            return account == signedIn
        }
    }
}

/// The two label photo API calls, answered from scripts. An empty script answers 500.
actor FakeLabelPhotoAPI: LabelPhotoAPI {
    private var createScript: [Result<API.LabelPhotoUpload, APIError>]
    private var completeScript: [Result<Void, APIError>]
    private(set) var createCalls: [ResourceID] = []
    private(set) var completeCalls: [ResourceID] = []

    init(create: [Result<API.LabelPhotoUpload, APIError>] = [], complete: [Result<Void, APIError>] = []) {
        createScript = create
        completeScript = complete
    }

    func setComplete(_ script: [Result<Void, APIError>]) {
        completeScript = script
    }

    func createLabelPhotoUpload(beanID: ResourceID) async throws -> API.LabelPhotoUpload {
        createCalls.append(beanID)
        guard !createScript.isEmpty else {
            throw APIError.server(status: 500)
        }
        return try createScript.removeFirst().get()
    }

    func completeLabelPhoto(photoID: ResourceID) async throws {
        completeCalls.append(photoID)
        guard !completeScript.isEmpty else {
            throw APIError.server(status: 500)
        }
        try completeScript.removeFirst().get()
    }
}

/// The S3 side: records each request and body and answers from a script (204 when empty).
actor StubPresignedPostTransport: PresignedPostTransport {
    struct Sent: Sendable {
        let request: URLRequest
        let body: Data
    }

    private var script: [Result<Int, APIError>]
    private(set) var sent: [Sent] = []

    init(_ script: [Result<Int, APIError>] = []) {
        self.script = script
    }

    func setScript(_ script: [Result<Int, APIError>]) {
        self.script = script
    }

    func send(_ request: URLRequest, body: Data) async throws -> Int {
        sent.append(Sent(request: request, body: body))
        guard !script.isEmpty else {
            return 204
        }
        return try script.removeFirst().get()
    }
}

/// One part of a parsed `multipart/form-data` body.
struct ParsedFormPart: Equatable {
    let headers: [String]
    let content: Data

    /// `name` of the part's `Content-Disposition`.
    var name: String? {
        value(of: "name")
    }

    /// `filename` of the part's `Content-Disposition`.
    var fileName: String? {
        value(of: "filename")
    }

    private func value(of parameter: String) -> String? {
        guard let disposition = headers.first(where: { $0.hasPrefix("Content-Disposition: form-data") }) else {
            return nil
        }
        for item in disposition.components(separatedBy: "; ") where item.hasPrefix("\(parameter)=\"") {
            return String(item.dropFirst(parameter.count + 2).dropLast())
        }
        return nil
    }
}

enum MultipartParser {
    struct Malformed: Error {}

    /// Splits `body` strictly as RFC 7578 lays it out: `--boundary CRLF`, headers, an empty
    /// line, the content, `CRLF --boundary`, ..., and `--boundary-- CRLF` at the very end.
    static func parse(_ body: Data, boundary: String) throws -> [ParsedFormPart] {
        let delimiter = Data("--\(boundary)".utf8)
        let crlf = Data("\r\n".utf8)
        guard body.starts(with: delimiter) else {
            throw Malformed()
        }
        var rest = body.dropFirst(delimiter.count)
        var parts: [ParsedFormPart] = []
        while true {
            if rest.starts(with: Data("--".utf8)) {
                guard rest == Data("--\r\n".utf8) else {
                    throw Malformed()
                }
                return parts
            }
            guard rest.starts(with: crlf) else {
                throw Malformed()
            }
            rest = rest.dropFirst(crlf.count)
            guard let next = rest.range(of: crlf + delimiter) else {
                throw Malformed()
            }
            let part = rest[rest.startIndex..<next.lowerBound]
            guard let separator = part.range(of: Data("\r\n\r\n".utf8)) else {
                throw Malformed()
            }
            let headers = String(decoding: part[part.startIndex..<separator.lowerBound], as: UTF8.self)
                .components(separatedBy: "\r\n")
            parts.append(ParsedFormPart(headers: headers, content: Data(part[separator.upperBound...])))
            rest = rest[next.upperBound...]
        }
    }
}
