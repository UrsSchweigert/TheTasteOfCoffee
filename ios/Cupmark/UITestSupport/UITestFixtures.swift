#if DEBUG
import Foundation

/// The data of a UI-test launch (M2-T33). Every vocabulary value comes from the generated
/// enums (first, last or the first few entries of a list), never from a list typed here, so
/// the fixtures follow the vocabulary. Names and ids are made up. Every id is a valid contract
/// id (a ULID: Crockford base32 without I, L, O and U).
///
/// The store holds:
/// - a catalogue bean with an Open Food Facts name and brand, and a bean described with pick
///   lists, each on its own bag;
/// - on the first bag, rated brews of the first three methods, one unrated brew (the newest,
///   for the rating screen) and one recipe more than the bag's screen lists inline, so
///   "All Recipes" is offered;
/// - three brew photos on the first two rated brews, for the gallery (M2-T43);
/// - with `withProfile`, a profile without consent, so onboarding is over.
/// Everything is `synced`, so the outbox is empty and nothing is ever sent.
enum UITestFixtures {
    /// A made-up Cognito subject, never a real one.
    static let subject = "cupmark-ui-test-subject"
    /// A valid EAN-13. The stub API knows it (`UITestAPI`).
    static let barcode = "4006381333931"

    static let catalogueBeanID = "01JD00000000000000000000B1"
    static let describedBeanID = "01JD00000000000000000000B2"
    static let shelfEntryID = "01JD00000000000000000000S1"
    static let secondShelfEntryID = "01JD00000000000000000000S2"

    /// The brew photo folder of this launch: one per process, so a launch leaves at most one
    /// folder in the temporary directory, which the system clears.
    private static let brewPhotoFolder = FileManager.default.temporaryDirectory
        .appending(path: "CupmarkUITestBrewPhotos-\(UUID().uuidString)", directoryHint: .isDirectory)

    /// The brew photo backup setting of a UI-test launch: its own `UserDefaults` suite, emptied
    /// at the first use in the process, so every launch starts with the default (off) and the
    /// device's real setting is never read or written.
    static let photoBackupSetting: BrewPhotoBackupSetting = {
        let suite = "cupmark-ui-test-photo-backup"
        UserDefaults.standard.removePersistentDomain(forName: suite)
        return BrewPhotoBackupSetting(defaults: UserDefaults(suiteName: suite) ?? .standard)
    }()

    static var account: AccountID {
        AccountID(subject: subject)
    }

    /// The store and the local ids the screens open.
    struct Seeded {
        let store: AccountStore
        /// The bag with brews of several methods and the recipes.
        let shelfEntry: UUID
        /// The bag's newest brew, without a rating.
        let unratedBrew: UUID
    }

    /// A new in-memory store with the fixture data. On the main actor, like every store the
    /// app's screens use.
    @MainActor
    static func seed(withProfile: Bool, now: Date = Date(), calendar: Calendar = .current) throws -> Seeded {
        // The brew photos of a launch go to one folder of the temporary directory, emptied here.
        try? FileManager.default.removeItem(at: brewPhotoFolder)
        let store = try AccountStore.inMemory(brewPhotoFiles: BrewPhotoFileStore(directory: brewPhotoFolder))
        if withProfile {
            let profile = StoredProfile(API.Profile(locale: VocabularyLanguage.current, consent: API.Consent(contributeToAggregates: false)))
            profile.syncState = .synced
            store.context.insert(profile)
            try store.save()
        }
        let catalogue = StoredBean(catalogueBean())
        try store.addBean(catalogue, syncState: .synced)
        let described = StoredBean(describedBean())
        try store.addBean(described, syncState: .synced)

        let entry = StoredShelfEntry(
            try shelfEntryInput(beanID: catalogueBeanID, roastedDaysAgo: 9, now: now, calendar: calendar),
            serverID: shelfEntryID
        )
        try store.addShelfEntry(entry, bean: catalogue, syncState: .synced)
        let second = StoredShelfEntry(
            try shelfEntryInput(beanID: describedBeanID, roastedDaysAgo: 20, now: now, calendar: calendar),
            serverID: secondShelfEntryID
        )
        try store.addShelfEntry(second, bean: described, syncState: .synced)

        let methods = Array(Vocabulary.Method.allCases.prefix(3))
        var ratedBrews: [StoredBrew] = []
        for (index, method) in methods.enumerated() {
            let brew = try StoredBrew(
                try brewInput(method: method, index: index, daysAgo: methods.count - index + 1, rated: true, now: now),
                serverID: brewID(index)
            )
            try store.addBrew(brew, shelfEntry: entry, syncState: .synced)
            ratedBrews.append(brew)
        }
        // The gallery's photos (M2-T43): two on the brew of the first method, one on the second's.
        // The unrated brew has none, so the rating screen starts with an empty photo section.
        let photo = try BrewPhotoEncoder.encode(UITestBrewPhotoPicker.fixtureJPEG())
        for (position, brew) in photoBrews(of: ratedBrews).enumerated() {
            try store.addBrewPhoto(to: brew, jpeg: photo, createdAt: now.addingTimeInterval(TimeInterval(-60 * position)))
        }
        let newestMethod = try methods.first ?? first(Vocabulary.Method.self)
        let unrated = try StoredBrew(
            try brewInput(method: newestMethod, index: methods.count, daysAgo: 0, rated: false, now: now),
            serverID: brewID(methods.count)
        )
        try store.addBrew(unrated, shelfEntry: entry, syncState: .synced)

        let recipeMethods = Vocabulary.Method.allCases.prefix(BrewStartModel.inlineRecipeLimit + 1)
        for (index, method) in recipeMethods.enumerated() {
            let recipe = StoredRecipe(
                API.RecipeInput(vocabularyVersion: Vocabulary.version, parameters: parameters(method: method, index: index)),
                serverID: recipeID(index)
            )
            try store.addRecipe(recipe, syncState: .synced)
        }
        return Seeded(store: store, shelfEntry: entry.localID, unratedBrew: unrated.localID)
    }

    /// The brews that hold a photo, one entry per photo: the first rated brew twice, the second
    /// once (fewer if the vocabulary has fewer methods).
    private static func photoBrews(of brews: [StoredBrew]) -> [StoredBrew] {
        var result: [StoredBrew] = []
        if let first = brews.first {
            result += [first, first]
        }
        if brews.count > 1 {
            result.append(brews[1])
        }
        return result
    }

    // MARK: - Catalogue

    /// The bean the stub API answers for `barcode`, and the first bag's bean.
    static func catalogueBean() -> API.Bean {
        API.Bean(
            beanId: catalogueBeanID,
            vocabularyVersion: Vocabulary.version,
            verified: true,
            barcode: barcode,
            openFoodFactsMatch: true,
            openFoodFacts: API.OpenFoodFactsProduct(name: "Cupmark Test Blend", brand: "Cupmark Test Roastery"),
            pickedAttributes: API.BeanAttributes(
                process: Vocabulary.Process.allCases.first,
                roastLevel: Vocabulary.RoastLevel.allCases.first
            ),
            operatorAttributes: API.BeanAttributes(
                origin: Vocabulary.Origin.allCases.last,
                species: Vocabulary.Species.allCases.first,
                variety: Vocabulary.Variety.allCases.first
            )
        )
    }

    /// A bean without a barcode or Open Food Facts text, described with pick lists.
    static func describedBean() -> API.Bean {
        API.Bean(
            beanId: describedBeanID,
            vocabularyVersion: Vocabulary.version,
            verified: false,
            openFoodFactsMatch: false,
            pickedAttributes: API.BeanAttributes(
                process: Vocabulary.Process.allCases.last,
                roastLevel: Vocabulary.RoastLevel.allCases.last,
                origin: Vocabulary.Origin.allCases.first
            ),
            operatorAttributes: API.BeanAttributes()
        )
    }

    // MARK: - Values

    private enum FixtureError: Error {
        case invalid
    }

    private static func first<Item: VocabularyItem>(_ type: Item.Type) throws -> Item {
        guard let item = Item.allCases.first else {
            throw FixtureError.invalid
        }
        return item
    }

    private static func brewID(_ index: Int) -> String {
        "01JD000000000000000000BRW\(index)"
    }

    private static func recipeID(_ index: Int) -> String {
        "01JD000000000000000000RCP\(index)"
    }

    private static func shelfEntryInput(beanID: String, roastedDaysAgo: Int, now: Date, calendar: Calendar) throws -> API.ShelfEntryInput {
        API.ShelfEntryInput(
            vocabularyVersion: Vocabulary.version,
            beanId: beanID,
            purchaseDate: try day(daysAgo: roastedDaysAgo - 2, now: now, calendar: calendar),
            roastDate: try day(daysAgo: roastedDaysAgo, now: now, calendar: calendar),
            bagSize: Vocabulary.BagSize.allCases.first,
            priceBand: Vocabulary.PriceBand.allCases.last
        )
    }

    private static func day(daysAgo: Int, now: Date, calendar: Calendar) throws -> API.CalendarDate {
        guard let date = calendar.date(byAdding: .day, value: -daysAgo, to: now) else {
            throw FixtureError.invalid
        }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let dayOfMonth = parts.day,
              let value = API.CalendarDate(year: year, month: month, day: dayOfMonth) else {
            throw FixtureError.invalid
        }
        return value
    }

    /// Dose, water, brew time and the normalised grind: fields every method allows.
    private static func parameters(method: Vocabulary.Method, index: Int) -> API.BrewParameters {
        API.BrewParameters(
            method: method,
            doseDg: 180 + index * 10,
            waterG: 300 + index * 20,
            brewTimeS: 180 + index * 15,
            grindNormalised: 4.5
        )
    }

    private static func brewInput(method: Vocabulary.Method, index: Int, daysAgo: Int, rated: Bool, now: Date) throws -> API.BrewInput {
        // Whole seconds an hour before `now`, minus whole days: a valid, past timestamp.
        let seconds = (now.timeIntervalSince1970 - 3600).rounded(.down) - Double(daysAgo * 86_400)
        guard let brewedAt = API.Timestamp(millisecondsSince1970: Int64(seconds) * 1000) else {
            throw FixtureError.invalid
        }
        return API.BrewInput(
            vocabularyVersion: Vocabulary.version,
            shelfEntryId: shelfEntryID,
            brewedAt: brewedAt,
            parameters: parameters(method: method, index: index),
            rating: rated ? try rating(index) : nil
        )
    }

    /// A score for every criterion on the scale's half steps, different per brew, two flavour
    /// notes, and buy again on every other brew.
    private static func rating(_ index: Int) throws -> API.Rating {
        let scale = Vocabulary.Ranges.scale
        var values: [String: Double] = [:]
        for (position, criterion) in Vocabulary.Criterion.allCases.enumerated() {
            let steps = Double((position + index) % 8)
            values[criterion.rawValue] = min(scale.maximum, scale.middle + steps * scale.multipleOf - 1)
        }
        let scores = try JSONDecoder().decode(API.Scores.self, from: JSONEncoder().encode(values))
        return API.Rating(
            scores: scores,
            flavourNotes: Array(Vocabulary.FlavourNote.allCases.prefix(2)),
            buyAgain: index.isMultiple(of: 2)
        )
    }
}
#endif
