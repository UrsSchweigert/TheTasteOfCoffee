import Foundation
import SwiftData

// Typed access to the stored models and conversion to and from the generated API types.
// Reading is lenient (an unknown id reads as nil); converting to an API value is strict
// (an unknown id throws `LocalStoreError.unknownVocabularyID`), so nothing unknown is sent.

// MARK: - Sync state

/// What every synced model has: a local id, its vocabulary version, its sync state and,
/// from M2-T16, its sync issue and the resource its outbox operations name.
protocol SyncTracked: AnyObject {
    var localID: UUID { get }
    var vocabularyVersion: Int { get set }
    var syncStateRaw: String { get set }
    var syncIssueRaw: String? { get set }
    /// The API resource of this model (`Store/Outbox.swift`).
    static var outboxResource: OutboxResource { get }
}

extension SyncTracked {
    /// The sync state. A raw value that is not a `SyncState` (it is never written) reads as
    /// `pendingUpdate`, so the item is sent again rather than lost.
    var syncState: SyncState {
        get { SyncState(rawValue: syncStateRaw) ?? .pendingUpdate }
        set { syncStateRaw = newValue.rawValue }
    }

    /// What went wrong when the item was last sent, nil when nothing did (M2-T16). A raw
    /// value that is not a `SyncIssue` reads as `rejected`.
    var syncIssue: SyncIssue? {
        get { syncIssueRaw.map { raw in SyncIssue(rawValue: raw) ?? .rejected } }
        set { syncIssueRaw = newValue?.rawValue }
    }
}

extension StoredBean: SyncTracked {}
extension StoredShelfEntry: SyncTracked {}
extension StoredBrew: SyncTracked {}
extension StoredRecipe: SyncTracked {}
extension StoredProfile: SyncTracked {}

/// The models `AccountStore.markDeleted(_:)` accepts. The profile is not one of them.
protocol LocalDeletable: SyncTracked {}

extension StoredBean: LocalDeletable {}
extension StoredShelfEntry: LocalDeletable {}
extension StoredBrew: LocalDeletable {}
extension StoredRecipe: LocalDeletable {}

// MARK: - Beans

/// The five bean attributes as contract ids, one group of `StoredBean`.
struct BeanAttributeIDs: Equatable, Sendable {
    var process: String?
    var roastLevel: String?
    var origin: String?
    var species: String?
    var variety: String?

    init(process: String? = nil, roastLevel: String? = nil, origin: String? = nil, species: String? = nil, variety: String? = nil) {
        self.process = process
        self.roastLevel = roastLevel
        self.origin = origin
        self.species = species
        self.variety = variety
    }

    init(_ attributes: API.BeanAttributes) {
        self.init(
            process: attributes.process?.rawValue,
            roastLevel: attributes.roastLevel?.rawValue,
            origin: attributes.origin?.rawValue,
            species: attributes.species?.rawValue,
            variety: attributes.variety?.rawValue
        )
    }

    /// The values the bundled vocabulary knows; unknown ids are nil.
    var known: API.BeanAttributes {
        API.BeanAttributes(
            process: StoredVocabulary.decode(process),
            roastLevel: StoredVocabulary.decode(roastLevel),
            origin: StoredVocabulary.decode(origin),
            species: StoredVocabulary.decode(species),
            variety: StoredVocabulary.decode(variety)
        )
    }

    /// All values, or `unknownVocabularyID` for the first id the vocabulary does not know.
    func apiAttributes() throws -> API.BeanAttributes {
        API.BeanAttributes(
            process: try StoredVocabulary.require(process),
            roastLevel: try StoredVocabulary.require(roastLevel),
            origin: try StoredVocabulary.require(origin),
            species: try StoredVocabulary.require(species),
            variety: try StoredVocabulary.require(variety)
        )
    }
}

extension StoredBean {
    /// A bean read from the server.
    convenience init(_ bean: API.Bean) {
        self.init(serverID: bean.beanId, vocabularyVersion: bean.vocabularyVersion, barcode: bean.barcode)
        apply(bean)
    }

    /// A bean picked from lists (or confirmed from Open Food Facts) on the device.
    convenience init(_ create: API.BeanCreate) {
        self.init(vocabularyVersion: create.vocabularyVersion, barcode: create.barcode)
        openFoodFactsConfirmed = create.openFoodFactsConfirmed ?? false
        pickedAttributeIDs = BeanAttributeIDs(create.attributes)
    }

    /// Takes every value of the server's bean, including its id.
    func apply(_ bean: API.Bean) {
        serverID = bean.beanId
        vocabularyVersion = bean.vocabularyVersion
        barcode = bean.barcode
        verified = bean.verified
        openFoodFactsMatch = bean.openFoodFactsMatch
        hasOpenFoodFactsProduct = bean.openFoodFacts != nil
        openFoodFactsName = bean.openFoodFacts?.name
        openFoodFactsBrand = bean.openFoodFacts?.brand
        openFoodFactsImageID = bean.openFoodFacts?.imageId
        pickedAttributeIDs = BeanAttributeIDs(bean.pickedAttributes)
        operatorAttributeIDs = BeanAttributeIDs(bean.operatorAttributes)
    }

    var pickedAttributeIDs: BeanAttributeIDs {
        get {
            BeanAttributeIDs(
                process: pickedProcessID,
                roastLevel: pickedRoastLevelID,
                origin: pickedOriginID,
                species: pickedSpeciesID,
                variety: pickedVarietyID
            )
        }
        set {
            pickedProcessID = newValue.process
            pickedRoastLevelID = newValue.roastLevel
            pickedOriginID = newValue.origin
            pickedSpeciesID = newValue.species
            pickedVarietyID = newValue.variety
        }
    }

    var operatorAttributeIDs: BeanAttributeIDs {
        get {
            BeanAttributeIDs(
                process: operatorProcessID,
                roastLevel: operatorRoastLevelID,
                origin: operatorOriginID,
                species: operatorSpeciesID,
                variety: operatorVarietyID
            )
        }
        set {
            operatorProcessID = newValue.process
            operatorRoastLevelID = newValue.roastLevel
            operatorOriginID = newValue.origin
            operatorSpeciesID = newValue.species
            operatorVarietyID = newValue.variety
        }
    }

    /// `picked_attributes` as far as the bundled vocabulary knows them.
    var pickedAttributes: API.BeanAttributes { pickedAttributeIDs.known }

    /// `operator_attributes` as far as the bundled vocabulary knows them.
    var operatorAttributes: API.BeanAttributes { operatorAttributeIDs.known }

    /// The `Bean` the server sent, rebuilt. Throws without a server id or for an unknown id.
    func apiBean() throws -> API.Bean {
        guard let serverID else {
            throw LocalStoreError.missingServerID
        }
        return API.Bean(
            beanId: serverID,
            vocabularyVersion: vocabularyVersion,
            verified: verified,
            barcode: barcode,
            openFoodFactsMatch: openFoodFactsMatch,
            openFoodFacts: hasOpenFoodFactsProduct
                ? API.OpenFoodFactsProduct(name: openFoodFactsName, brand: openFoodFactsBrand, imageId: openFoodFactsImageID)
                : nil,
            pickedAttributes: try pickedAttributeIDs.apiAttributes(),
            operatorAttributes: try operatorAttributeIDs.apiAttributes()
        )
    }

    /// The `POST /beans` body for a bean made on the device. No Open Food Facts text is in it
    /// (ADR 0005).
    func apiCreate() throws -> API.BeanCreate {
        API.BeanCreate(
            vocabularyVersion: vocabularyVersion,
            barcode: barcode,
            openFoodFactsConfirmed: openFoodFactsConfirmed ? true : nil,
            attributes: try pickedAttributeIDs.apiAttributes()
        )
    }
}

// MARK: - Shelf entries

extension StoredShelfEntry {
    /// An entry with the values of `input`. The caller links the bean (`AccountStore`).
    convenience init(_ input: API.ShelfEntryInput, serverID: String? = nil) {
        self.init(serverID: serverID, vocabularyVersion: input.vocabularyVersion, purchaseDate: input.purchaseDate)
        apply(input)
    }

    /// Takes every value of `input` but `bean_id`: the caller links the matching bean.
    func apply(_ input: API.ShelfEntryInput) {
        vocabularyVersion = input.vocabularyVersion
        purchaseDateRaw = input.purchaseDate.description
        roastDateRaw = input.roastDate?.description
        bagSizeID = input.bagSize?.rawValue
        priceBandID = input.priceBand?.rawValue
    }

    var purchaseDate: API.CalendarDate? { API.CalendarDate(purchaseDateRaw) }

    var roastDate: API.CalendarDate? {
        get { roastDateRaw.flatMap { raw in API.CalendarDate(raw) } }
        set { roastDateRaw = newValue?.description }
    }

    var bagSize: Vocabulary.BagSize? {
        get { StoredVocabulary.decode(bagSizeID) }
        set { bagSizeID = newValue?.rawValue }
    }

    var priceBand: Vocabulary.PriceBand? {
        get { StoredVocabulary.decode(priceBandID) }
        set { priceBandID = newValue?.rawValue }
    }

    /// The brews not removed on the device, newest first.
    var liveBrewsNewestFirst: [StoredBrew] {
        brews
            .filter { brew in brew.syncState != .pendingDelete }
            .sorted { lhs, rhs in lhs.brewedAtMilliseconds > rhs.brewedAtMilliseconds }
    }

    /// The `POST /shelf` or `PUT /shelf/{id}` body. Throws while the bean has no server id.
    func apiInput() throws -> API.ShelfEntryInput {
        guard let beanID = bean?.serverID else {
            throw LocalStoreError.missingServerID
        }
        guard let purchaseDate else {
            throw LocalStoreError.invalidDate
        }
        var roast: API.CalendarDate?
        if let roastDateRaw {
            guard let parsed = API.CalendarDate(roastDateRaw) else {
                throw LocalStoreError.invalidDate
            }
            roast = parsed
        }
        return API.ShelfEntryInput(
            vocabularyVersion: vocabularyVersion,
            beanId: beanID,
            purchaseDate: purchaseDate,
            roastDate: roast,
            bagSize: try StoredVocabulary.require(bagSizeID),
            priceBand: try StoredVocabulary.require(priceBandID)
        )
    }
}

// MARK: - Brew parameters (brews and recipes)

/// The `BrewParameters` columns, which brews and recipes share.
protocol BrewParameterColumns: AnyObject {
    var methodID: String { get set }
    var doseDg: Int? { get set }
    var waterG: Int? { get set }
    var waterTempC: Int? { get set }
    var waterTempSpecialID: String? { get set }
    var brewTimeS: Int? { get set }
    var grindNormalised: Double? { get set }
    var waterTypeID: String? { get set }
    var milkID: String? { get set }
    /// `grinder` and `grind_setting` (vocabulary v3 on, M2-T26).
    var grinderID: String? { get set }
    var grindSetting: Double? { get set }
}

extension StoredBrew: BrewParameterColumns {}
extension StoredRecipe: BrewParameterColumns {}

extension BrewParameterColumns {
    /// The method, nil for an id the bundled vocabulary does not know.
    var method: Vocabulary.Method? { StoredVocabulary.decode(methodID) }

    var waterType: Vocabulary.WaterType? {
        get { StoredVocabulary.decode(waterTypeID) }
        set { waterTypeID = newValue?.rawValue }
    }

    var milk: Vocabulary.MilkType? {
        get { StoredVocabulary.decode(milkID) }
        set { milkID = newValue?.rawValue }
    }

    var grinder: Vocabulary.Grinder? {
        get { StoredVocabulary.decode(grinderID) }
        set { grinderID = newValue?.rawValue }
    }

    /// `water_temp_c` or `water_temp_special`. Setting one clears the other. Reading prefers
    /// `water_temp_c` if both columns were ever set; `apiParameters()` refuses that case.
    var waterTemperature: API.WaterTemperature? {
        get {
            if let waterTempC {
                return .celsius(waterTempC)
            }
            let special: Vocabulary.WaterTempSpecial? = StoredVocabulary.decode(waterTempSpecialID)
            return special.map { value in API.WaterTemperature.special(value) }
        }
        set {
            switch newValue {
            case .celsius(let celsius):
                waterTempC = celsius
                waterTempSpecialID = nil
            case .special(let special):
                waterTempC = nil
                waterTempSpecialID = special.rawValue
            case nil:
                waterTempC = nil
                waterTempSpecialID = nil
            }
        }
    }

    /// The ratio (`BrewDerivedValues.ratio`).
    var ratio: Double? { BrewDerivedValues.ratio(doseDg: doseDg, waterG: waterG) }

    /// Takes every value of `parameters`.
    func setParameters(_ parameters: API.BrewParameters) {
        methodID = parameters.method.rawValue
        doseDg = parameters.doseDg
        waterG = parameters.waterG
        waterTemperature = parameters.waterTemperature
        brewTimeS = parameters.brewTimeS
        grindNormalised = parameters.grindNormalised
        waterTypeID = parameters.waterType?.rawValue
        milkID = parameters.milk?.rawValue
        grinderID = parameters.grinder?.rawValue
        grindSetting = parameters.grindSetting
    }

    /// The parameters to send. Throws for any id the bundled vocabulary does not know, and
    /// `conflictingWaterTemperature` when both temperature columns are set (the contract
    /// allows at most one; `waterTemperature` never writes both).
    func apiParameters() throws -> API.BrewParameters {
        guard let method = try StoredVocabulary.require(methodID, as: Vocabulary.Method.self) else {
            throw LocalStoreError.unknownVocabularyID(namespace: Vocabulary.Method.namespace, id: methodID)
        }
        guard waterTempC == nil || waterTempSpecialID == nil else {
            throw LocalStoreError.conflictingWaterTemperature
        }
        var temperature: API.WaterTemperature?
        if let waterTempC {
            temperature = .celsius(waterTempC)
        } else if let special = try StoredVocabulary.require(waterTempSpecialID, as: Vocabulary.WaterTempSpecial.self) {
            temperature = .special(special)
        }
        return API.BrewParameters(
            method: method,
            doseDg: doseDg,
            waterG: waterG,
            waterTemperature: temperature,
            brewTimeS: brewTimeS,
            grindNormalised: grindNormalised,
            waterType: try StoredVocabulary.require(waterTypeID),
            milk: try StoredVocabulary.require(milkID),
            grinder: try StoredVocabulary.require(grinderID),
            grindSetting: grindSetting
        )
    }
}

// MARK: - Ratings

/// A stored rating: every value as its contract id, so a rating made with a newer
/// vocabulary survives on a device with an older one.
struct RatingValues: Codable, Equatable, Sendable {
    /// Score by criterion id.
    var scores: [String: Double]
    /// Intensity level id by dimension id; nil when the rating has no intensities.
    var intensities: [String: String]?
    /// Flavour note ids, in the order picked.
    var flavourNotes: [String]?
    var buyAgain: Bool?

    init(scores: [String: Double], intensities: [String: String]? = nil, flavourNotes: [String]? = nil, buyAgain: Bool? = nil) {
        self.scores = scores
        self.intensities = intensities
        self.flavourNotes = flavourNotes
        self.buyAgain = buyAgain
    }

    init(_ rating: API.Rating) {
        var scores: [String: Double] = [:]
        for criterion in Vocabulary.Criterion.allCases {
            scores[criterion.rawValue] = rating.scores[criterion]
        }
        let intensities = rating.intensities.map { values in
            var levels: [String: String] = [:]
            for dimension in Vocabulary.IntensityDimension.allCases {
                levels[dimension.rawValue] = values[dimension]?.rawValue
            }
            return levels
        }
        self.init(
            scores: scores,
            intensities: intensities,
            flavourNotes: rating.flavourNotes?.map(\.rawValue),
            buyAgain: rating.buyAgain
        )
    }

    /// The score for `criterion`, nil if it is not stored.
    func score(for criterion: Vocabulary.Criterion) -> API.Score? {
        scores[criterion.rawValue]
    }

    /// The flavour notes the bundled vocabulary knows.
    var knownFlavourNotes: [Vocabulary.FlavourNote] {
        (flavourNotes ?? []).compactMap { id in StoredVocabulary.decode(id, as: Vocabulary.FlavourNote.self) }
    }

    /// The rating to send. Throws for an unknown id, or `incompleteRating` when a criterion
    /// of the bundled vocabulary has no score.
    func apiRating() throws -> API.Rating {
        for id in scores.keys.sorted() where Vocabulary.Criterion(rawValue: id) == nil {
            throw LocalStoreError.unknownVocabularyID(namespace: Vocabulary.Criterion.namespace, id: id)
        }
        let missing = Vocabulary.Criterion.allCases.filter { criterion in scores[criterion.rawValue] == nil }
        guard missing.isEmpty else {
            throw LocalStoreError.incompleteRating(missing: missing)
        }
        // `API.Scores` has one property per criterion, keyed by the criterion id, so it is
        // built from the id map without naming any criterion here.
        let apiScores = try JSONDecoder().decode(API.Scores.self, from: JSONEncoder().encode(scores))

        var apiIntensities: API.Intensities?
        if let intensities {
            var levels = API.Intensities()
            for (dimensionID, levelID) in intensities.sorted(by: { lhs, rhs in lhs.key < rhs.key }) {
                guard let dimension = try StoredVocabulary.require(dimensionID, as: Vocabulary.IntensityDimension.self),
                      let level = try StoredVocabulary.require(levelID, as: Vocabulary.IntensityLevel.self) else {
                    continue
                }
                levels[dimension] = level
            }
            apiIntensities = levels
        }

        let notes = try flavourNotes?.map { (id: String) throws -> Vocabulary.FlavourNote in
            guard let note = try StoredVocabulary.require(id, as: Vocabulary.FlavourNote.self) else {
                throw LocalStoreError.unknownVocabularyID(namespace: Vocabulary.FlavourNote.namespace, id: id)
            }
            return note
        }

        return API.Rating(scores: apiScores, intensities: apiIntensities, flavourNotes: notes, buyAgain: buyAgain)
    }

    /// The stored bytes, with sorted keys, so the same rating always encodes the same way.
    /// Throws `nonFiniteScore` for a score that is NaN or infinite (JSON cannot hold it), and
    /// passes on any other encoding error. Never returns nothing for a rating.
    static func encoded(_ values: RatingValues) throws -> Data {
        for id in values.scores.keys.sorted() where values.scores[id].map({ score in !score.isFinite }) == true {
            throw LocalStoreError.nonFiniteScore(id: id)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(values)
    }

    static func decoded(_ data: Data) -> RatingValues? {
        try? JSONDecoder().decode(RatingValues.self, from: data)
    }
}

// MARK: - Brews

extension StoredBrew {
    /// A brew with the values of `input`. The caller links the shelf entry (`AccountStore`).
    /// Throws like `setRating(_:)` for a rating that cannot be stored.
    convenience init(_ input: API.BrewInput, serverID: String? = nil) throws {
        self.init(
            serverID: serverID,
            vocabularyVersion: input.vocabularyVersion,
            brewedAtMilliseconds: input.brewedAt.millisecondsSince1970,
            methodID: input.parameters.method.rawValue
        )
        try apply(input)
    }

    /// Takes every value of `input` but `shelf_entry_id`: the caller links the entry.
    /// The rating is encoded first, so a rating that cannot be stored throws and changes
    /// nothing.
    func apply(_ input: API.BrewInput) throws {
        let ratingBytes = try input.rating.map { value in try RatingValues.encoded(RatingValues(value)) }
        vocabularyVersion = input.vocabularyVersion
        brewedAtMilliseconds = input.brewedAt.millisecondsSince1970
        setParameters(input.parameters)
        ratingData = ratingBytes
    }

    var brewedAt: Date {
        Date(timeIntervalSince1970: Double(brewedAtMilliseconds) / 1000)
    }

    /// The rating, nil for an unrated brew (or stored bytes that do not decode).
    /// Set it with `setRating(_:)`.
    var rating: RatingValues? {
        ratingData.flatMap { data in RatingValues.decoded(data) }
    }

    /// Stores `values`, or removes the rating for nil. Throws `nonFiniteScore` (or an
    /// encoding error) and keeps the previous rating, instead of dropping it silently.
    func setRating(_ values: RatingValues?) throws {
        ratingData = try values.map { value in try RatingValues.encoded(value) }
    }

    /// Days since roast (`BrewDerivedValues.daysSinceRoast`), in the device calendar unless
    /// another is given.
    func daysSinceRoast(calendar: Calendar = .current) -> Int? {
        BrewDerivedValues.daysSinceRoast(roastDate: shelfEntry?.roastDate, brewedAt: brewedAt, calendar: calendar)
    }

    /// The `POST /brews` or `PUT /brews/{id}` body. Throws while the shelf entry has no
    /// server id.
    func apiInput() throws -> API.BrewInput {
        guard let shelfEntryID = shelfEntry?.serverID else {
            throw LocalStoreError.missingServerID
        }
        guard let brewedAt = API.Timestamp(millisecondsSince1970: brewedAtMilliseconds) else {
            throw LocalStoreError.invalidDate
        }
        return API.BrewInput(
            vocabularyVersion: vocabularyVersion,
            shelfEntryId: shelfEntryID,
            brewedAt: brewedAt,
            parameters: try apiParameters(),
            rating: try rating?.apiRating()
        )
    }
}

// MARK: - Recipes

extension StoredRecipe {
    convenience init(_ input: API.RecipeInput, serverID: String? = nil) {
        self.init(serverID: serverID, vocabularyVersion: input.vocabularyVersion, methodID: input.parameters.method.rawValue)
        apply(input)
    }

    func apply(_ input: API.RecipeInput) {
        vocabularyVersion = input.vocabularyVersion
        setParameters(input.parameters)
    }

    /// The `POST /recipes` or `PUT /recipes/{id}` body.
    func apiInput() throws -> API.RecipeInput {
        API.RecipeInput(vocabularyVersion: vocabularyVersion, parameters: try apiParameters())
    }
}

// MARK: - Profile

extension StoredProfile {
    convenience init(_ profile: API.Profile) {
        self.init(localeID: profile.locale.rawValue, contributeToAggregates: profile.consent.contributeToAggregates)
    }

    func apply(_ profile: API.Profile) {
        localeID = profile.locale.rawValue
        contributeToAggregates = profile.consent.contributeToAggregates
    }

    /// The locale, nil for a language the app has no labels for.
    var locale: VocabularyLanguage? { VocabularyLanguage(rawValue: localeID) }

    /// The `PUT /profile` body.
    func apiProfile() throws -> API.Profile {
        guard let locale else {
            throw LocalStoreError.unknownLanguage(localeID)
        }
        return API.Profile(locale: locale, consent: API.Consent(contributeToAggregates: contributeToAggregates))
    }
}
