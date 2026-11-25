import Foundation

/// Why the bundled vocabulary could not be loaded or a label not resolved.
/// Developer diagnostics only; never shown to the user as text.
enum VocabularyError: Error, Equatable, Sendable {
    /// A file is missing from the app bundle (path relative to the bundle).
    case missingResource(String)
    /// A file exists but could not be read.
    case unreadableResource(String)
    /// A file is not valid JSON, or a language file has the wrong shape.
    case invalidJSON(String)
    /// A vocabulary file breaks a rule of contracts/README.md "File shapes".
    case invalidShape(String)
    /// A file's `version` is not the version the Swift types were generated from.
    case versionMismatch(file: String)
    /// A language file says it is a different language.
    case languageMismatch(expected: String, found: String)
    case unknownNamespace(String)
    case unknownId(namespace: String, id: String)
    case missingLabel(namespace: String, id: String, language: String)
    case emptyLabel(namespace: String, id: String, language: String)
    case missingQuestion(namespace: String, id: String, language: String)
    case emptyQuestion(namespace: String, id: String, language: String)
}

/// The closed vocabulary and its labels, decoded at runtime from the JSON
/// bundled with the app (contracts/vocabulary/v<N>/ and contracts/i18n/,
/// referenced from the Xcode project, never copied by hand).
struct VocabularyStore: Sendable {
    /// Bundle subdirectory of the vocabulary files (an Xcode folder reference).
    static let vocabularyDirectory = "v\(Vocabulary.version)"
    /// Bundle subdirectory of the language files (an Xcode folder reference).
    static let i18nDirectory = "i18n"

    /// Parsed vocabulary files by name without `.json`.
    let files: [String: JSONValue]
    /// Ids of every list by namespace, in file order.
    let ids: [String: [String]]
    /// The file that defines each namespace.
    let namespaceFiles: [String: String]
    /// Every `{ minimum, maximum, multipleOf }` object by JSON path (`brew.ranges.dose_g`).
    let ranges: [String: VocabularyRange]

    private let labels: [VocabularyLanguage: [String: [String: String]]]
    private let questions: [VocabularyLanguage: [String: [String: String]]]

    /// Loads the vocabulary files named in `Vocabulary.files` and one language
    /// file per `VocabularyLanguage` from `bundle`.
    static func load(from bundle: Bundle) throws -> VocabularyStore {
        var files: [String: Data] = [:]
        for name in Vocabulary.files {
            files[name] = try resource(name, in: vocabularyDirectory, bundle: bundle)
        }
        var languages: [VocabularyLanguage: Data] = [:]
        for language in VocabularyLanguage.allCases {
            languages[language] = try resource(language.rawValue, in: i18nDirectory, bundle: bundle)
        }
        return try VocabularyStore(files: files, languages: languages)
    }

    /// Names (without `.json`) of every vocabulary file in the bundle, sorted.
    static func bundledFileNames(in bundle: Bundle) -> [String] {
        let urls = bundle.urls(forResourcesWithExtension: "json", subdirectory: vocabularyDirectory) ?? []
        return urls.map { $0.deletingPathExtension().lastPathComponent }.sorted()
    }

    /// Decodes vocabulary files (`[name: JSON]`) and language files.
    init(files: [String: Data], languages: [VocabularyLanguage: Data]) throws {
        let decoder = JSONDecoder()
        var parsed: [String: JSONValue] = [:]
        var walker = ListWalker()
        for (name, data) in files.sorted(by: { $0.key < $1.key }) {
            let value: JSONValue
            do {
                value = try decoder.decode(JSONValue.self, from: data)
            } catch {
                throw VocabularyError.invalidJSON("\(name).json")
            }
            guard let members = value.objectValue else {
                throw VocabularyError.invalidShape("\(name).json: top level is not an object")
            }
            guard members["version"]?.numberValue == Double(Vocabulary.version) else {
                throw VocabularyError.versionMismatch(file: "\(name).json")
            }
            try walker.walk(members, file: name, path: [])
            parsed[name] = value
        }
        self.files = parsed
        self.ids = walker.ids
        self.namespaceFiles = walker.owners
        self.ranges = walker.ranges

        var labels: [VocabularyLanguage: [String: [String: String]]] = [:]
        var questions: [VocabularyLanguage: [String: [String: String]]] = [:]
        for (language, data) in languages {
            let file: LanguageFile
            do {
                file = try decoder.decode(LanguageFile.self, from: data)
            } catch {
                throw VocabularyError.invalidJSON("\(language.rawValue).json")
            }
            guard file.language == language.rawValue else {
                throw VocabularyError.languageMismatch(expected: language.rawValue, found: file.language)
            }
            labels[language] = file.labels
            questions[language] = file.questions
        }
        self.labels = labels
        self.questions = questions
    }

    /// Ids of one list, in file order.
    func ids(in namespace: Vocabulary.Namespace) -> [String] {
        ids[namespace.rawValue] ?? []
    }

    /// The display label of `id` in `namespace`. Throws if the id is not in
    /// the bundled vocabulary or its label is missing or empty.
    func label(namespace: Vocabulary.Namespace, id: String, language: VocabularyLanguage) throws -> String {
        try text(in: labels, namespace: namespace, id: id, language: language, isQuestion: false)
    }

    /// The display label of a generated vocabulary entry.
    func label<Item: VocabularyItem>(for item: Item, language: VocabularyLanguage) throws -> String {
        try label(namespace: Item.namespace, id: item.rawValue, language: language)
    }

    /// The question shown for `id` (lists with `hasQuestions`, the criteria).
    func question(namespace: Vocabulary.Namespace, id: String, language: VocabularyLanguage) throws -> String {
        try text(in: questions, namespace: namespace, id: id, language: language, isQuestion: true)
    }

    /// The value at a JSON path `<file>.<key>...`, for example `flavour_notes.max_picks`.
    func value(at path: String) -> JSONValue? {
        let parts = path.split(separator: ".").map(String.init)
        guard let fileName = parts.first, var current = files[fileName] else { return nil }
        for key in parts.dropFirst() {
            guard let next = current[key] else { return nil }
            current = next
        }
        return current
    }

    private func text(
        in table: [VocabularyLanguage: [String: [String: String]]],
        namespace: Vocabulary.Namespace,
        id: String,
        language: VocabularyLanguage,
        isQuestion: Bool
    ) throws -> String {
        guard let known = ids[namespace.rawValue] else {
            throw VocabularyError.unknownNamespace(namespace.rawValue)
        }
        guard known.contains(id) else {
            throw VocabularyError.unknownId(namespace: namespace.rawValue, id: id)
        }
        guard let text = table[language]?[namespace.rawValue]?[id] else {
            throw isQuestion
                ? VocabularyError.missingQuestion(namespace: namespace.rawValue, id: id, language: language.rawValue)
                : VocabularyError.missingLabel(namespace: namespace.rawValue, id: id, language: language.rawValue)
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw isQuestion
                ? VocabularyError.emptyQuestion(namespace: namespace.rawValue, id: id, language: language.rawValue)
                : VocabularyError.emptyLabel(namespace: namespace.rawValue, id: id, language: language.rawValue)
        }
        return text
    }

    private static func resource(_ name: String, in subdirectory: String, bundle: Bundle) throws -> Data {
        let path = "\(subdirectory)/\(name).json"
        guard let url = bundle.url(forResource: name, withExtension: "json", subdirectory: subdirectory) else {
            throw VocabularyError.missingResource(path)
        }
        do {
            return try Data(contentsOf: url)
        } catch {
            throw VocabularyError.unreadableResource(path)
        }
    }
}

/// contracts/i18n/<lang>.json
private struct LanguageFile: Decodable {
    let language: String
    let labels: [String: [String: String]]
    let questions: [String: [String: String]]
}

/// Finds every id list and range, by the rules in contracts/README.md:
/// every array is a non-empty list of objects with an `id`, its namespace is
/// the property name that holds it, a namespace lives in one file, and ids
/// are unique within a namespace. Nested lists are merged per namespace.
private struct ListWalker {
    var ids: [String: [String]] = [:]
    var owners: [String: String] = [:]
    var ranges: [String: VocabularyRange] = [:]

    private static let rangeKeys: Set<String> = ["minimum", "maximum", "multipleOf"]

    mutating func walk(_ members: [String: JSONValue], file: String, path: [String]) throws {
        for key in members.keys.sorted() {
            guard let child = members[key] else { continue }
            let childPath = path + [key]
            switch child {
            case .array(let items):
                try addList(key, items: items, file: file, path: childPath)
            case .object(let object):
                if let range = Self.range(object) {
                    ranges[([file] + childPath).joined(separator: ".")] = range
                } else {
                    try walk(object, file: file, path: childPath)
                }
            case .null, .bool, .number, .string:
                continue
            }
        }
    }

    private mutating func addList(_ namespace: String, items: [JSONValue], file: String, path: [String]) throws {
        let location = "\(file).json: /\(path.joined(separator: "/"))"
        guard !items.isEmpty else {
            throw VocabularyError.invalidShape("\(location) is an empty list")
        }
        if let owner = owners[namespace], owner != file {
            throw VocabularyError.invalidShape("\(namespace) is defined in \(owner).json and \(file).json")
        }
        owners[namespace] = file
        var known = ids[namespace] ?? []
        for (index, item) in items.enumerated() {
            guard let object = item.objectValue, let id = object["id"]?.stringValue else {
                throw VocabularyError.invalidShape("\(location)/\(index) is not an object with a string id")
            }
            guard !known.contains(id) else {
                throw VocabularyError.invalidShape("\(namespace): duplicate id \(id)")
            }
            known.append(id)
            ids[namespace] = known
            try walk(object, file: file, path: path + [String(index)])
            known = ids[namespace] ?? known
        }
        ids[namespace] = known
    }

    private static func range(_ object: [String: JSONValue]) -> VocabularyRange? {
        guard Set(object.keys) == rangeKeys,
              let minimum = object["minimum"]?.numberValue,
              let maximum = object["maximum"]?.numberValue,
              let multipleOf = object["multipleOf"]?.numberValue
        else { return nil }
        return VocabularyRange(minimum: minimum, maximum: maximum, multipleOf: multipleOf)
    }
}
