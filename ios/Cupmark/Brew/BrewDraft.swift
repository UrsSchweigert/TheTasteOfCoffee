import Foundation

/// A numeric field of the brew form (docs/04 F2), each set with a stepper. The bounds and the
/// step of each come from the bundled vocabulary (`Vocabulary.Ranges`), never from a view.
enum BrewNumberField: CaseIterable, Sendable {
    /// `dose_dg`, stepped in grams (brew.ranges.dose_g).
    case dose
    /// `water_g`, water or, for espresso, yield (brew.ranges.water_g).
    case water
    /// `water_temp_c` (brew.ranges.water_temp_c).
    case temperature
    /// `grind_normalised` (brew.ranges.grind_normalised).
    case grind

    /// The vocabulary range of the field, in the unit the stepper shows.
    var range: VocabularyRange {
        switch self {
        case .dose: Vocabulary.Ranges.doseG
        case .water: Vocabulary.Ranges.waterG
        case .temperature: Vocabulary.Ranges.waterTempC
        case .grind: Vocabulary.Ranges.grindNormalised
        }
    }
}

extension VocabularyRange {
    /// `value` moved into the bounds and onto the nearest step from the minimum. Nil for a
    /// value that is not finite, or a range without a positive step.
    func snapped(_ value: Double) -> Double? {
        guard value.isFinite, multipleOf > 0, multipleOf.isFinite else {
            return nil
        }
        let index = ((value - minimum) / multipleOf).rounded()
        let clamped = min(max(index, 0), Double(stepCount))
        return minimum + clamped * multipleOf
    }

    /// `value`, snapped, moved by `steps` steps (negative: down) and kept within the bounds.
    func stepped(_ value: Double, by steps: Int) -> Double? {
        guard let start = snapped(value) else {
            return nil
        }
        let index = ((start - minimum) / multipleOf).rounded() + Double(steps)
        return snapped(minimum + index * multipleOf)
    }

    /// The step nearest the middle of the range: where a stepper starts when nothing else
    /// suggests a value.
    var middle: Double {
        snapped((minimum + maximum) / 2) ?? minimum
    }
}

/// The values of a new brew while the user sets them (M2-T19, docs/04 F2). The screen edits
/// this draft, never a stored model, and the model writes it through `AccountStore` in one
/// step (ADR 0025).
///
/// Every value is a `Vocabulary` value or a number moved by a stepper within its
/// `Vocabulary.Ranges` range; nothing is typed (invariant 1). Only the method is required.
/// `water_temp_c` and `water_temp_special` are one `API.WaterTemperature`, so a temperature
/// and `cold` can never both be set.
///
/// The draft holds only fields its method allows (M2-T26, `Vocabulary.Method.allows(_:)`, the
/// rules of vocabulary v3): changing the method clears the fields it no longer allows, and a
/// setter ignores a field the method does not allow. The grind setting lies on the scale of
/// the grinder (`Vocabulary.Grinder.scale`), and picking another grinder clears it, because a
/// number of one dial means nothing on another. So `parameters` never holds a field the server
/// would answer with 400.
struct BrewDraft: Equatable, Sendable {
    /// Tenths of a gram per gram: `dose_dg` holds the dose in decigrams (ADR 0004).
    static let decigramsPerGram = 10

    /// `method`, required. Setting it clears every field the new method does not allow. With
    /// no method, nothing is cleared (nothing can be saved or sent yet).
    var method: Vocabulary.Method? {
        didSet {
            conformToMethod()
        }
    }
    /// `dose_dg`, optional. Set it through `setValue(_:of:)` or `step(_:by:seed:)`.
    private(set) var doseDg: API.DoseDg?
    /// `water_g`, optional.
    private(set) var waterG: API.WaterG?
    /// `water_temp_c` or `water_temp_special`, optional, never both.
    private(set) var waterTemperature: API.WaterTemperature?
    /// `brew_time_s`, optional. Copied from a stored brew by `init(_:)`, otherwise set only
    /// through `setBrewTime(seconds:)` or the brew timer's `setBrewTime(_:)` (M2-T21), which
    /// clamp it to `Vocabulary.Ranges.brewTimeS`.
    private(set) var brewTimeS: API.BrewTimeS?
    /// `grind_normalised`, optional.
    private(set) var grindNormalised: API.GrindNormalised?
    /// `water_type`, optional.
    var waterType: Vocabulary.WaterType?
    /// `milk`, optional.
    var milk: Vocabulary.MilkType?
    /// `grinder`, optional, only with a method that allows it. Set it through `setGrinder(_:)`.
    private(set) var grinder: Vocabulary.Grinder?
    /// `grind_setting`, optional, on the scale of `grinder`. Set it through
    /// `setGrindSetting(_:)` or `stepGrindSetting(by:seed:)`.
    private(set) var grindSetting: API.GrindSetting?

    init(method: Vocabulary.Method? = nil) {
        self.method = method
        self.doseDg = nil
        self.waterG = nil
        self.waterTemperature = nil
        self.brewTimeS = nil
        self.grindNormalised = nil
        self.waterType = nil
        self.milk = nil
        self.grinder = nil
        self.grindSetting = nil
    }

    /// The values of a stored brew or recipe, as they are (the steppers' start values, and
    /// the copy a repeat starts from, M2-T27). An id the bundled vocabulary does not know
    /// reads as not set. A field the method does not allow (a brew or recipe of vocabulary 1 or
    /// 2 has no rules) or a grind setting off its grinder's scale is left out, so the copy can
    /// be saved as a brew of the bundled version.
    init(_ stored: some BrewParameterColumns) {
        self.init(method: stored.method)
        doseDg = stored.doseDg
        waterG = stored.waterG
        waterTemperature = stored.waterTemperature
        brewTimeS = stored.brewTimeS
        grindNormalised = stored.grindNormalised
        waterType = stored.waterType
        milk = stored.milk
        grinder = stored.grinder
        grindSetting = stored.grindSetting
        conformToMethod()
    }

    /// The values of `parameters` as they are, for showing them (a reference recipe, M2-T47).
    /// A field the method does not allow is left out, as in `init(_:)` of a stored value.
    init(_ parameters: API.BrewParameters) {
        self.init(method: parameters.method)
        doseDg = parameters.doseDg
        waterG = parameters.waterG
        waterTemperature = parameters.waterTemperature
        brewTimeS = parameters.brewTimeS
        grindNormalised = parameters.grindNormalised
        waterType = parameters.waterType
        milk = parameters.milk
        grinder = parameters.grinder
        grindSetting = parameters.grindSetting
        conformToMethod()
    }

    /// Sets `brew_time_s` to `seconds`, moved into its vocabulary range and onto its step
    /// (`BrewDraft.brewTimeRange`), or clears it for nil. A value already in the range is
    /// kept as it is.
    mutating func setBrewTime(seconds: API.BrewTimeS?) {
        brewTimeS = seconds
            .flatMap { value in BrewDraft.brewTimeRange.snapped(Double(value)) }
            .flatMap { value in API.scaledInteger(value, scale: 1) }
    }

    /// Whether the draft can be saved: it has a method.
    var isComplete: Bool {
        method != nil
    }

    // MARK: - Numbers

    /// The value of `field` in the unit of its range (grams, grams, °C, coarseness), nil
    /// while it is not set. The temperature is nil while `cold` (or nothing) is set.
    func value(of field: BrewNumberField) -> Double? {
        switch field {
        case .dose:
            return doseDg.map { decigrams in Double(decigrams) / Double(BrewDraft.decigramsPerGram) }
        case .water:
            return waterG.map { grams in Double(grams) }
        case .temperature:
            if case .some(.celsius(let celsius)) = waterTemperature {
                return Double(celsius)
            }
            return nil
        case .grind:
            return grindNormalised
        }
    }

    /// Sets `field` to `value`, moved into its vocabulary range and onto a step, or clears it
    /// for nil. A temperature replaces `cold`; clearing the temperature clears `cold` too.
    mutating func setValue(_ value: Double?, of field: BrewNumberField) {
        let snapped = value.flatMap { number in field.range.snapped(number) }
        switch field {
        case .dose:
            doseDg = snapped.flatMap { grams in API.scaledInteger(grams, scale: BrewDraft.decigramsPerGram) }
        case .water:
            waterG = snapped.flatMap { grams in API.scaledInteger(grams, scale: 1) }
        case .temperature:
            if allows(.waterTempC) {
                waterTemperature = snapped
                    .flatMap { celsius in API.scaledInteger(celsius, scale: 1) }
                    .map { celsius in API.WaterTemperature.celsius(celsius) }
            } else if case .some(.celsius) = waterTemperature {
                waterTemperature = nil
            }
        case .grind:
            grindNormalised = snapped
        }
    }

    /// One stepper tap: moves a set value by `steps` steps within its range. A field that is
    /// not set starts at `seed` (snapped into the range), or the middle of the range without
    /// one, so the first tap turns the field on.
    mutating func step(_ field: BrewNumberField, by steps: Int, seed: Double?) {
        if let current = value(of: field) {
            setValue(field.range.stepped(current, by: steps), of: field)
        } else {
            setValue(seed.flatMap { value in field.range.snapped(value) } ?? field.range.middle, of: field)
        }
    }

    // MARK: - Temperature or a special value

    /// What the temperature picker shows: not set, a temperature in °C, or one of the
    /// vocabulary's `water_temp_special` values (`cold`).
    enum TemperatureChoice: Hashable, Sendable {
        case notSet
        case celsius
        case special(Vocabulary.WaterTempSpecial)

        /// Every choice, the special values in vocabulary order.
        static var all: [TemperatureChoice] {
            [.notSet, .celsius] + Vocabulary.WaterTempSpecial.allCases.map { special in TemperatureChoice.special(special) }
        }
    }

    /// The choices the method allows: "not set", a temperature in °C where `water_temp_c` is
    /// allowed, and the special values where `water_temp_special` is. Only "not set" for a
    /// method that allows neither (moka pot, cezve), and while no method is picked.
    var temperatureChoices: [TemperatureChoice] {
        var choices: [TemperatureChoice] = [.notSet]
        if allows(.waterTempC) {
            choices.append(.celsius)
        }
        if allows(.waterTempSpecial) {
            choices += Vocabulary.WaterTempSpecial.allCases.map { special in TemperatureChoice.special(special) }
        }
        return choices
    }

    var temperatureChoice: TemperatureChoice {
        switch waterTemperature {
        case .some(.celsius): .celsius
        case .some(.special(let special)): .special(special)
        case .none: .notSet
        }
    }

    /// Picks a choice. `celsius` keeps a temperature already set, otherwise starts at `seed`
    /// (or the middle of the range); a special value replaces any temperature.
    mutating func chooseTemperature(_ choice: TemperatureChoice, seed: Double?) {
        switch choice {
        case .notSet:
            waterTemperature = nil
        case .celsius:
            guard allows(.waterTempC) else {
                return
            }
            if value(of: .temperature) == nil {
                setValue(seed.flatMap { value in BrewNumberField.temperature.range.snapped(value) } ?? BrewNumberField.temperature.range.middle, of: .temperature)
            }
        case .special(let special):
            guard allows(.waterTempSpecial) else {
                return
            }
            waterTemperature = .special(special)
        }
    }

    // MARK: - Method rules, grinder and grind setting (M2-T26)

    /// Whether the method allows `field` (`Vocabulary.Method.allows(_:)`, the generated rules).
    /// While no method is picked, only a field without a rule is allowed, so the form shows
    /// no field that a method might not allow.
    func allows(_ field: Vocabulary.BrewField) -> Bool {
        if let method {
            return method.allows(field)
        }
        return Vocabulary.Method.fieldRules[field] == nil
    }

    /// The fields the form shows, in `BrewParameters` order.
    var visibleFields: [Vocabulary.BrewField] {
        Vocabulary.BrewField.allCases.filter { field in allows(field) }
    }

    /// The scale of the grinder's grind setting: nil while the method allows no grind setting,
    /// no grinder is picked, or the grinder has no scale (`pre_ground`, `other`, a grinder
    /// whose dial is not in steps). The stepper is hidden then, and `grind_normalised` stays.
    var grindSettingRange: VocabularyRange? {
        allows(.grindSetting) ? grinder?.scale : nil
    }

    /// Picks the grinder, or none for nil. Another grinder clears the grind setting. Ignored
    /// (the grinder stays unset) where the method allows no grinder.
    mutating func setGrinder(_ newGrinder: Vocabulary.Grinder?) {
        guard allows(.grinder) else {
            grinder = nil
            grindSetting = nil
            return
        }
        if newGrinder != grinder {
            grindSetting = nil
        }
        grinder = newGrinder
    }

    /// Sets the grind setting, moved onto the grinder's scale (`grindSettingRange`), or clears
    /// it for nil. Without a scale it stays unset.
    mutating func setGrindSetting(_ value: Double?) {
        guard let range = grindSettingRange else {
            grindSetting = nil
            return
        }
        grindSetting = value.flatMap { number in range.snapped(number) }
    }

    /// One stepper tap on the grind setting: moves a set value by `steps` steps of the scale.
    /// A setting that is not set starts at `seed` (moved onto the scale) or the middle of the
    /// scale.
    mutating func stepGrindSetting(by steps: Int, seed: Double?) {
        guard let range = grindSettingRange else {
            grindSetting = nil
            return
        }
        if let current = grindSetting {
            setGrindSetting(range.stepped(current, by: steps))
        } else {
            setGrindSetting(seed.flatMap { value in range.snapped(value) } ?? range.middle)
        }
    }

    /// Clears every field the method does not allow, and a grind setting that is not on the
    /// grinder's scale. Does nothing while no method is picked.
    private mutating func conformToMethod() {
        guard method != nil else {
            return
        }
        for field in Vocabulary.BrewField.allCases where !allows(field) {
            clear(field)
        }
        if let setting = grindSetting, grinder?.accepts(setting) != true {
            grindSetting = nil
        }
    }

    private mutating func clear(_ field: Vocabulary.BrewField) {
        switch field {
        case .doseDg:
            doseDg = nil
        case .waterG:
            waterG = nil
        case .waterTempC:
            if case .some(.celsius) = waterTemperature {
                waterTemperature = nil
            }
        case .waterTempSpecial:
            if case .some(.special) = waterTemperature {
                waterTemperature = nil
            }
        case .brewTimeS:
            brewTimeS = nil
        case .grindNormalised:
            grindNormalised = nil
        case .waterType:
            waterType = nil
        case .milk:
            milk = nil
        case .grinder:
            grinder = nil
            grindSetting = nil
        case .grindSetting:
            grindSetting = nil
        }
    }

    // MARK: - Derived values and the request

    /// The ratio (`BrewDerivedValues.ratio`), nil until dose and water are set.
    var ratio: Double? {
        BrewDerivedValues.ratio(doseDg: doseDg, waterG: waterG)
    }

    /// The `parameters` of the request, nil without a method. The draft holds only what the
    /// method allows, and `conformingToMethodRules()` makes sure once more, so no request
    /// holds a field the server would refuse.
    var parameters: API.BrewParameters? {
        guard let method else {
            return nil
        }
        return API.BrewParameters(
            method: method,
            doseDg: doseDg,
            waterG: waterG,
            waterTemperature: waterTemperature,
            brewTimeS: brewTimeS,
            grindNormalised: grindNormalised,
            waterType: waterType,
            milk: milk,
            grinder: grinder,
            grindSetting: grindSetting
        ).conformingToMethodRules()
    }

    /// The `POST /brews` body for the shelf entry with server id `shelfEntryID`, brewed at
    /// `brewedAt`: the bundled vocabulary version (3 or later, which a grinder needs), the
    /// draft's values and no rating (F3 rates it). Nil without a method. The outbox builds the body from the stored brew when it is
    /// sent; this is the same mapping.
    func input(shelfEntryID: API.Id, brewedAt: API.Timestamp) -> API.BrewInput? {
        guard let parameters else {
            return nil
        }
        return API.BrewInput(
            vocabularyVersion: Vocabulary.version,
            shelfEntryId: shelfEntryID,
            brewedAt: brewedAt,
            parameters: parameters,
            rating: nil
        )
    }
}

/// How the brew form writes its numbers. Numbers follow the given locale; units use
/// Foundation's measurement formatting, so no unit text is written here.
enum BrewFormat {
    /// The ratio as `1:<grams of water per gram of coffee>`, one decimal (`1:16.2`, in German
    /// `1:16,2`). The `1:` is in the String Catalog (`brew.ratio.value %@`), so a language that
    /// writes ratios differently changes it there; `bundle` is the app bundle.
    static func ratio(_ ratio: Double, locale: Locale = .current, bundle: Bundle = .main) -> String {
        L10n.brewRatioValue(number(ratio, fractionDigits: 1, locale: locale), bundle: bundle)
    }

    /// `value` with exactly `fractionDigits` decimals.
    static func number(_ value: Double, fractionDigits: Int, locale: Locale = .current) -> String {
        value.formatted(FloatingPointFormatStyle<Double>(locale: locale).precision(.fractionLength(fractionDigits)))
    }

    /// Grams, with the unit, for example `18.5 g`.
    static func grams(_ grams: Double, fractionDigits: Int, locale: Locale = .current) -> String {
        measurement(Measurement(value: grams, unit: UnitMass.grams), fractionDigits: fractionDigits, locale: locale)
    }

    /// Degrees Celsius, with the unit, for example `94°C`.
    static func celsius(_ celsius: Double, locale: Locale = .current) -> String {
        measurement(Measurement(value: celsius, unit: UnitTemperature.celsius), fractionDigits: 0, locale: locale)
    }

    /// The decimals a value of `range` needs: none for whole steps, one for tenths or halves.
    static func fractionDigits(for range: VocabularyRange) -> Int {
        var digits = 0
        var step = range.multipleOf
        while digits < 3, step.isFinite, abs(step - step.rounded()) > 1e-9 {
            step *= 10
            digits += 1
        }
        return digits
    }

    /// The text the grind setting stepper shows: the number with the digits of the grinder's
    /// own step (`1` for a dial in whole steps, `1.5` for one in halves).
    static func grindSetting(_ value: Double, on scale: VocabularyRange, locale: Locale = .current) -> String {
        number(value, fractionDigits: fractionDigits(for: scale), locale: locale)
    }

    /// The text a stepper shows for `field` at `value`.
    static func value(_ value: Double, of field: BrewNumberField, locale: Locale = .current) -> String {
        let digits = fractionDigits(for: field.range)
        switch field {
        case .dose, .water:
            return grams(value, fractionDigits: digits, locale: locale)
        case .temperature:
            return celsius(value, locale: locale)
        case .grind:
            return number(value, fractionDigits: digits, locale: locale)
        }
    }

    private static func measurement<UnitType: Dimension>(_ value: Measurement<UnitType>, fractionDigits: Int, locale: Locale) -> String {
        let numbers = NumberFormatter()
        numbers.locale = locale
        numbers.numberStyle = .decimal
        numbers.minimumFractionDigits = fractionDigits
        numbers.maximumFractionDigits = fractionDigits
        let formatter = MeasurementFormatter()
        formatter.locale = locale
        formatter.unitOptions = .providedUnit
        formatter.unitStyle = .medium
        formatter.numberFormatter = numbers
        return formatter.string(from: value)
    }
}
