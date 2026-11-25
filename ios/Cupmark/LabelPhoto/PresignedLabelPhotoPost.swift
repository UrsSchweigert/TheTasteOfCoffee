import Foundation

/// The patterns of contracts/openapi.yaml that a presigned label photo POST must match before
/// anything is sent to it (`LabelPhotoUploadForm.url` and `LabelPhotoUploadFields`).
/// `scripts/ios-scripts.test.mjs` checks that each one equals the contract's pattern.
enum LabelPhotoUploadPatterns {
    /// `LabelPhotoUploadForm.url`: a `cupmark-` bucket, virtual-hosted, in eu-central-1.
    static let url = #"^https://cupmark-[a-z0-9-]{1,55}\.s3\.eu-central-1\.amazonaws\.com/$"#
    /// `key`.
    static let key = #"^uploads/[0-9A-HJKMNP-TV-Z]{26}\.jpg$"#
    /// `bucket`.
    static let bucket = #"^cupmark-[a-z0-9-]{1,55}$"#
    /// `content_type`.
    static let contentType = #"^image/jpeg$"#
    /// `policy`.
    static let policy = #"^[A-Za-z0-9+/=]{1,8192}$"#
    /// `x_amz_algorithm`.
    static let xAmzAlgorithm = #"^AWS4-HMAC-SHA256$"#
    /// `x_amz_credential`.
    static let xAmzCredential = #"^[A-Z0-9]{16,128}/[0-9]{8}/eu-central-1/s3/aws4_request$"#
    /// `x_amz_date`.
    static let xAmzDate = #"^[0-9]{8}T[0-9]{6}Z$"#
    /// `x_amz_security_token`.
    static let xAmzSecurityToken = #"^[A-Za-z0-9+/=]{1,4096}$"#
    /// `x_amz_signature`.
    static let xAmzSignature = #"^[0-9a-f]{64}$"#

    /// True if the whole of `text` matches `pattern`. A match that stops before a trailing
    /// line break does not count, so `$` cannot be satisfied by "value\n".
    static func wholeMatch(_ text: String, _ pattern: String) -> Bool {
        guard let range = text.range(of: pattern, options: .regularExpression) else {
            return false
        }
        return range.lowerBound == text.startIndex && range.upperBound == text.endIndex
    }
}

/// One form field of a multipart body: its exact name and its value.
struct MultipartFormField: Sendable, Equatable {
    let name: String
    let value: String
}

/// A presigned S3 POST that passed every check of the contract (ADR 0016, M2-T24). Only a
/// value of this type is ever sent to, so the app uploads only to our own bucket in
/// eu-central-1.
struct PresignedLabelPhotoPost: Sendable, Equatable {
    enum ValidationError: Error, Equatable, Sendable {
        /// `photo_id` is not an `Id`.
        case invalidPhotoID
        /// `upload.url` does not match the contract's pattern.
        case invalidURL
        /// A field does not match its pattern. Carries the S3 field name, never the value.
        case invalidField(String)
        /// `key` is not `uploads/<photo_id>.jpg`.
        case keyMismatch
        /// `bucket` is not the bucket of `url`.
        case bucketMismatch
    }

    /// The S3 form field names, as written in the contract's descriptions.
    enum FieldName {
        static let key = "key"
        static let bucket = "bucket"
        static let contentType = "Content-Type"
        static let policy = "Policy"
        static let xAmzAlgorithm = "X-Amz-Algorithm"
        static let xAmzCredential = "X-Amz-Credential"
        static let xAmzDate = "X-Amz-Date"
        static let xAmzSecurityToken = "X-Amz-Security-Token"
        static let xAmzSignature = "X-Amz-Signature"
        /// The JPEG, always the last part.
        static let file = "file"
    }

    let photoID: ResourceID
    let url: URL
    /// Every presigned field under its S3 name, in a fixed order. `file` is not among them.
    let fields: [MultipartFormField]
    /// `expires_at`.
    let expiresAt: Date
    /// `max_bytes`.
    let maxBytes: Int

    init(validating upload: API.LabelPhotoUpload) throws {
        guard let photoID = ResourceID(upload.photoId) else {
            throw ValidationError.invalidPhotoID
        }
        let form = upload.upload
        guard form.url.utf8.count <= 120,
              LabelPhotoUploadPatterns.wholeMatch(form.url, LabelPhotoUploadPatterns.url),
              let url = URL(string: form.url),
              url.scheme == "https",
              let host = url.host() else {
            throw ValidationError.invalidURL
        }
        let fields = form.fields
        var checked: [MultipartFormField] = []
        func add(_ name: String, _ value: String, _ pattern: String) throws {
            guard LabelPhotoUploadPatterns.wholeMatch(value, pattern) else {
                throw ValidationError.invalidField(name)
            }
            checked.append(MultipartFormField(name: name, value: value))
        }
        try add(FieldName.key, fields.key, LabelPhotoUploadPatterns.key)
        try add(FieldName.bucket, fields.bucket, LabelPhotoUploadPatterns.bucket)
        try add(FieldName.contentType, fields.contentType, LabelPhotoUploadPatterns.contentType)
        try add(FieldName.policy, fields.policy, LabelPhotoUploadPatterns.policy)
        try add(FieldName.xAmzAlgorithm, fields.xAmzAlgorithm, LabelPhotoUploadPatterns.xAmzAlgorithm)
        try add(FieldName.xAmzCredential, fields.xAmzCredential, LabelPhotoUploadPatterns.xAmzCredential)
        try add(FieldName.xAmzDate, fields.xAmzDate, LabelPhotoUploadPatterns.xAmzDate)
        if let token = fields.xAmzSecurityToken {
            try add(FieldName.xAmzSecurityToken, token, LabelPhotoUploadPatterns.xAmzSecurityToken)
        }
        try add(FieldName.xAmzSignature, fields.xAmzSignature, LabelPhotoUploadPatterns.xAmzSignature)

        guard fields.key == "uploads/\(photoID.rawValue).jpg" else {
            throw ValidationError.keyMismatch
        }
        guard host == "\(fields.bucket).s3.eu-central-1.amazonaws.com" else {
            throw ValidationError.bucketMismatch
        }
        guard (1...LabelPhotoEncoder.Limits.upload.maxBytes).contains(upload.maxBytes) else {
            throw ValidationError.invalidField("max_bytes")
        }
        self.photoID = photoID
        self.url = url
        self.fields = checked
        self.expiresAt = upload.expiresAt.date
        self.maxBytes = upload.maxBytes
    }

    /// The `multipart/form-data` POST to S3: every presigned field, then `file`. It carries no
    /// `Authorization` header and no cookie: the API bearer token never goes to S3.
    func request(for body: MultipartFormBody) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.setValue(body.contentType, forHTTPHeaderField: "Content-Type")
        return request
    }
}

/// A `multipart/form-data` body (RFC 7578): the text fields in order, then one file part.
struct MultipartFormBody: Sendable, Equatable {
    enum BuildError: Error, Equatable, Sendable {
        /// The boundary is not 1 to 70 letters, digits, `-` or `_`.
        case invalidBoundary
        /// The boundary occurs in the file or a value; build again with another one.
        case boundaryInContent
        /// A name or value holds a line break or a quote.
        case invalidField
    }

    let boundary: String
    let data: Data

    /// The `Content-Type` header of the request.
    var contentType: String {
        "multipart/form-data; boundary=\(boundary)"
    }

    /// A fresh random boundary: `CupmarkFormBoundary` and 32 hex digits.
    static func makeBoundary() -> String {
        "CupmarkFormBoundary" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    /// The body: one part per field, in order, then the file part named `fileFieldName`, then
    /// the closing delimiter. Each part is `--boundary CRLF headers CRLF CRLF content CRLF`.
    init(
        fields: [MultipartFormField],
        fileFieldName: String,
        fileName: String,
        fileContentType: String,
        file: Data,
        boundary: String
    ) throws {
        guard (1...70).contains(boundary.utf8.count),
              boundary.utf8.allSatisfy(MultipartFormBody.isBoundaryCharacter) else {
            throw BuildError.invalidBoundary
        }
        let delimiter = Data("--\(boundary)".utf8)
        guard file.range(of: delimiter) == nil else {
            throw BuildError.boundaryInContent
        }
        let texts = fields.flatMap { [$0.name, $0.value] } + [fileFieldName, fileName, fileContentType]
        guard texts.allSatisfy(MultipartFormBody.isSafeText) else {
            throw BuildError.invalidField
        }
        guard !fields.contains(where: { $0.value.contains("--\(boundary)") }) else {
            throw BuildError.boundaryInContent
        }

        var body = Data()
        func append(_ text: String) {
            body.append(Data(text.utf8))
        }
        for field in fields {
            // A bare `name`: the Open Food Facts text check reads `x.name` in an interpolation
            // as a product name.
            let name = field.name
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(name)\"\r\n")
            append("\r\n")
            append(field.value)
            append("\r\n")
        }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"\(fileFieldName)\"; filename=\"\(fileName)\"\r\n")
        append("Content-Type: \(fileContentType)\r\n")
        append("\r\n")
        body.append(file)
        append("\r\n")
        append("--\(boundary)--\r\n")

        self.boundary = boundary
        self.data = body
    }

    private static func isBoundaryCharacter(_ byte: UInt8) -> Bool {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"),
             UInt8(ascii: "a")...UInt8(ascii: "z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"),
             UInt8(ascii: "-"),
             UInt8(ascii: "_"):
            return true
        default:
            return false
        }
    }

    /// No CR, LF or double quote, which would break out of a header or a value.
    private static func isSafeText(_ text: String) -> Bool {
        !text.utf8.contains { byte in
            byte == UInt8(ascii: "\r") || byte == UInt8(ascii: "\n") || byte == UInt8(ascii: "\"")
        }
    }
}
