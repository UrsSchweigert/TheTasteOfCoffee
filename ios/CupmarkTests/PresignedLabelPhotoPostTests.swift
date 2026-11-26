import XCTest
@testable import Cupmark

/// `PresignedLabelPhotoPost` and `MultipartFormBody` (M2-T24): only a presigned POST that
/// matches the contract is sent to, and the body lays out every S3 field under its S3 name
/// with `file` last.
final class PresignedLabelPhotoPostTests: XCTestCase {
    private let boundary = "CupmarkFormBoundaryTEST0123456789"

    private func post(_ upload: API.LabelPhotoUpload) throws -> PresignedLabelPhotoPost {
        try PresignedLabelPhotoPost(validating: upload)
    }

    private func assertRefused(
        _ upload: API.LabelPhotoUpload,
        _ expected: PresignedLabelPhotoPost.ValidationError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try PresignedLabelPhotoPost(validating: upload), file: file, line: line) { error in
            XCTAssertEqual(error as? PresignedLabelPhotoPost.ValidationError, expected, file: file, line: line)
        }
    }

    // MARK: - Validation

    func testAPresignedPostOfTheContractIsAccepted() throws {
        let checked = try post(try LabelPhotoFixtures.upload(1))

        XCTAssertEqual(checked.url.absoluteString, LabelPhotoFixtures.url)
        XCTAssertEqual(checked.photoID.rawValue, LabelPhotoFixtures.photoID(1))
        XCTAssertEqual(checked.maxBytes, 8_388_608)
        XCTAssertEqual(checked.expiresAt, LabelPhotoFixtures.now.addingTimeInterval(600))
    }

    func testTheFieldsKeepTheirS3NamesAndValues() throws {
        let checked = try post(try LabelPhotoFixtures.upload(1))

        XCTAssertEqual(checked.fields, [
            MultipartFormField(name: "key", value: "uploads/\(LabelPhotoFixtures.photoID(1)).jpg"),
            MultipartFormField(name: "bucket", value: LabelPhotoFixtures.bucket),
            MultipartFormField(name: "Content-Type", value: "image/jpeg"),
            MultipartFormField(name: "Policy", value: LabelPhotoFixtures.policy),
            MultipartFormField(name: "X-Amz-Algorithm", value: "AWS4-HMAC-SHA256"),
            MultipartFormField(name: "X-Amz-Credential", value: LabelPhotoFixtures.credential),
            MultipartFormField(name: "X-Amz-Date", value: LabelPhotoFixtures.amzDate),
            MultipartFormField(name: "X-Amz-Security-Token", value: LabelPhotoFixtures.securityToken),
            MultipartFormField(name: "X-Amz-Signature", value: LabelPhotoFixtures.signature),
        ])
    }

    func testTheSecurityTokenIsLeftOutWhenTheServerSendsNone() throws {
        let checked = try post(try LabelPhotoFixtures.upload(1, securityToken: nil))

        XCTAssertFalse(checked.fields.contains { $0.name == "X-Amz-Security-Token" })
        XCTAssertEqual(checked.fields.count, 8)
    }

    func testOnlyACupmarkBucketInEuCentral1IsAnUploadURL() throws {
        let refused = [
            "https://other-photos.s3.eu-central-1.amazonaws.com/",
            "https://cupmark-dev-photos.s3.us-east-1.amazonaws.com/",
            "https://cupmark-dev-photos.s3.amazonaws.com/",
            "http://cupmark-dev-photos.s3.eu-central-1.amazonaws.com/",
            "https://cupmark-dev-photos.s3.eu-central-1.amazonaws.com",
            "https://cupmark-dev-photos.s3.eu-central-1.amazonaws.com/uploads/",
            "https://cupmark-dev-photos.s3.eu-central-1.amazonaws.com.example.com/",
            "https://cupmark-dev-photos.s3.eu-central-1.amazonaws.com/\n",
            "https://CUPMARK-dev.s3.eu-central-1.amazonaws.com/",
            "https://user@cupmark-dev.s3.eu-central-1.amazonaws.com/",
            "https://s3.eu-central-1.amazonaws.com/cupmark-dev-photos/",
        ]
        for url in refused {
            assertRefused(try LabelPhotoFixtures.upload(1, url: url), .invalidURL)
        }
    }

    func testTheBucketFieldMustNameTheBucketOfTheURL() throws {
        assertRefused(try LabelPhotoFixtures.upload(1, bucket: "cupmark-prod-photos-123456789012"), .bucketMismatch)
    }

    func testTheKeyMustBeTheStagingKeyOfThePhotoID() throws {
        let otherID = LabelPhotoFixtures.photoID(2)
        assertRefused(try LabelPhotoFixtures.upload(1, key: "uploads/\(otherID).jpg"), .keyMismatch)
        assertRefused(try LabelPhotoFixtures.upload(1, key: "labels/\(LabelPhotoFixtures.photoID(1)).jpg"), .invalidField("key"))
    }

    func testEveryFieldIsCheckedAgainstItsPattern() throws {
        assertRefused(try LabelPhotoFixtures.upload(1, bucket: "other-bucket"), .invalidField("bucket"))
        assertRefused(try LabelPhotoFixtures.upload(1, contentType: "image/png"), .invalidField("Content-Type"))
        assertRefused(
            try LabelPhotoFixtures.upload(1, credential: "ASIAEXAMPLEEXAMPLE00/20261125/us-east-1/s3/aws4_request"),
            .invalidField("X-Amz-Credential")
        )
        assertRefused(try LabelPhotoFixtures.upload(1, securityToken: "token\r\nX-Injected: 1"), .invalidField("X-Amz-Security-Token"))
        assertRefused(try LabelPhotoFixtures.upload(1, signature: "ABC"), .invalidField("X-Amz-Signature"))
    }

    func testAMalformedPhotoIDIsRefused() throws {
        var upload = try LabelPhotoFixtures.upload(1)
        upload.photoId = "not-an-id"
        assertRefused(upload, .invalidPhotoID)
    }

    func testWholeMatchDoesNotAcceptATrailingLineBreak() {
        XCTAssertTrue(LabelPhotoUploadPatterns.wholeMatch("image/jpeg", LabelPhotoUploadPatterns.contentType))
        XCTAssertFalse(LabelPhotoUploadPatterns.wholeMatch("image/jpeg\n", LabelPhotoUploadPatterns.contentType))
        XCTAssertFalse(LabelPhotoUploadPatterns.wholeMatch("ximage/jpeg", LabelPhotoUploadPatterns.contentType))
    }

    // MARK: - Request

    func testTheRequestIsAMultipartPostWithoutToken() throws {
        let checked = try post(try LabelPhotoFixtures.upload(1))
        let body = try MultipartFormBody(
            fields: checked.fields,
            fileFieldName: "file",
            fileName: "label.jpg",
            fileContentType: "image/jpeg",
            file: LabelPhotoFixtures.jpeg,
            boundary: boundary
        )
        let request = checked.request(for: body)

        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, LabelPhotoFixtures.url)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=\(boundary)")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
        XCTAssertFalse(request.httpShouldHandleCookies)
    }

    // MARK: - Multipart body

    func testTheBodyHasEveryFieldInOrderAndTheFileLast() throws {
        let checked = try post(try LabelPhotoFixtures.upload(1))
        let body = try MultipartFormBody(
            fields: checked.fields,
            fileFieldName: "file",
            fileName: "label.jpg",
            fileContentType: "image/jpeg",
            file: LabelPhotoFixtures.jpeg,
            boundary: boundary
        )
        let parts = try MultipartParser.parse(body.data, boundary: boundary)

        XCTAssertEqual(parts.map(\.name), [
            "key", "bucket", "Content-Type", "Policy", "X-Amz-Algorithm", "X-Amz-Credential",
            "X-Amz-Date", "X-Amz-Security-Token", "X-Amz-Signature", "file",
        ])
        for (part, field) in zip(parts, checked.fields) {
            XCTAssertEqual(part.headers, ["Content-Disposition: form-data; name=\"\(field.name)\""])
            XCTAssertEqual(String(decoding: part.content, as: UTF8.self), field.value)
        }
        let file = try XCTUnwrap(parts.last)
        XCTAssertEqual(file.headers, [
            "Content-Disposition: form-data; name=\"file\"; filename=\"label.jpg\"",
            "Content-Type: image/jpeg",
        ])
        XCTAssertEqual(file.fileName, "label.jpg")
        XCTAssertEqual(file.content, LabelPhotoFixtures.jpeg)
    }

    func testTheBodyIsExactlyTheRFC7578Layout() throws {
        let body = try MultipartFormBody(
            fields: [MultipartFormField(name: "key", value: "uploads/x.jpg")],
            fileFieldName: "file",
            fileName: "label.jpg",
            fileContentType: "image/jpeg",
            file: Data([0xFF, 0xD8, 0xFF, 0xD9]),
            boundary: "B"
        )
        var expected = Data("--B\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\nuploads/x.jpg\r\n".utf8)
        expected.append(Data("--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"label.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
        expected.append(Data([0xFF, 0xD8, 0xFF, 0xD9]))
        expected.append(Data("\r\n--B--\r\n".utf8))

        XCTAssertEqual(body.data, expected)
        XCTAssertEqual(body.contentType, "multipart/form-data; boundary=B")
    }

    func testABoundaryThatOccursInTheFileIsRefused() {
        let file = Data([0xFF, 0xD8]) + Data("--\(boundary)".utf8) + Data([0xFF, 0xD9])

        XCTAssertThrowsError(
            try MultipartFormBody(fields: [], fileFieldName: "file", fileName: "label.jpg", fileContentType: "image/jpeg", file: file, boundary: boundary)
        ) { error in
            XCTAssertEqual(error as? MultipartFormBody.BuildError, .boundaryInContent)
        }
    }

    func testAMalformedBoundaryOrFieldIsRefused() {
        XCTAssertThrowsError(
            try MultipartFormBody(fields: [], fileFieldName: "file", fileName: "label.jpg", fileContentType: "image/jpeg", file: LabelPhotoFixtures.jpeg, boundary: "has space")
        ) { error in
            XCTAssertEqual(error as? MultipartFormBody.BuildError, .invalidBoundary)
        }
        XCTAssertThrowsError(
            try MultipartFormBody(
                fields: [MultipartFormField(name: "key\"", value: "x")],
                fileFieldName: "file",
                fileName: "label.jpg",
                fileContentType: "image/jpeg",
                file: LabelPhotoFixtures.jpeg,
                boundary: boundary
            )
        ) { error in
            XCTAssertEqual(error as? MultipartFormBody.BuildError, .invalidField)
        }
    }

    func testAFreshBoundaryIsValidAndDiffersEachTime() throws {
        let first = MultipartFormBody.makeBoundary()
        let second = MultipartFormBody.makeBoundary()

        XCTAssertNotEqual(first, second)
        XCTAssertLessThanOrEqual(first.utf8.count, 70)
        XCTAssertNoThrow(
            try MultipartFormBody(fields: [], fileFieldName: "file", fileName: "label.jpg", fileContentType: "image/jpeg", file: LabelPhotoFixtures.jpeg, boundary: first)
        )
    }
}
