import Foundation

// The method rules of vocabulary v3 applied to brew parameters (M2-T26, docs/04 F2, ADR 0021).
//
// The rules and the grinder scales are the generated ones (`Vocabulary.Method.allows(_:)`,
// `Vocabulary.Grinder.scale`); nothing here lists a method, a field or a grinder. The server
// answers 400 for a field its method does not allow, for a grind setting off the grinder's
// scale or without a grinder that has one, and for a grinder under vocabulary 1 or 2, so the
// app never sends one: the brew form builds its parameters through `BrewDraft`, which keeps
// these rules by construction, and a copy of a stored brew or recipe (a repeat, a recipe kept
// from a brew) passes through `conformingToMethodRules()` first.

extension Vocabulary.Grinder {
    /// Whether `setting` is a setting of this grinder: it has a scale, and the value lies on it.
    func accepts(_ setting: Double) -> Bool {
        scale?.contains(setting) ?? false
    }
}

extension API.BrewParameters {
    /// Whether the parameters set a field that only vocabulary v3 has (`grinder`,
    /// `grind_setting`): they cannot be sent with version 1 or 2.
    var setsV3OnlyField: Bool {
        grinder != nil || grindSetting != nil
    }

    /// The fields these parameters set (every field of `Vocabulary.BrewField` but `method`).
    var setFields: Set<Vocabulary.BrewField> {
        var fields = Set<Vocabulary.BrewField>()
        for field in Vocabulary.BrewField.allCases where isSet(field) {
            fields.insert(field)
        }
        return fields
    }

    private func isSet(_ field: Vocabulary.BrewField) -> Bool {
        switch field {
        case .doseDg:
            return doseDg != nil
        case .waterG:
            return waterG != nil
        case .waterTempC:
            if case .some(.celsius) = waterTemperature {
                return true
            }
            return false
        case .waterTempSpecial:
            if case .some(.special) = waterTemperature {
                return true
            }
            return false
        case .brewTimeS:
            return brewTimeS != nil
        case .grindNormalised:
            return grindNormalised != nil
        case .waterType:
            return waterType != nil
        case .milk:
            return milk != nil
        case .grinder:
            return grinder != nil
        case .grindSetting:
            return grindSetting != nil
        }
    }

    /// Whether the method allows `field` (`Vocabulary.Method.allows(_:)`).
    func allows(_ field: Vocabulary.BrewField) -> Bool {
        method.allows(field)
    }

    /// Whether the parameters break a method rule: a field the method does not allow, or a
    /// grind setting that is not on the scale of the grinder (or has no grinder with a scale).
    var violatesMethodRules: Bool {
        self != conformingToMethodRules()
    }

    /// The parameters without any field the method does not allow, and without a grind
    /// setting that is not on its grinder's scale. Everything else is kept as it is.
    func conformingToMethodRules() -> API.BrewParameters {
        var result = self
        for field in Vocabulary.BrewField.allCases where !method.allows(field) {
            result.clear(field)
        }
        if let setting = result.grindSetting {
            if let grinder = result.grinder, grinder.accepts(setting) {
                // On the scale: kept.
            } else {
                result.grindSetting = nil
            }
        }
        return result
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
}

extension StoredBrew {
    /// Takes `parameters` as an edit of this brew (no screen edits a stored brew yet; this is
    /// the rule for when one does). The brew keeps its `vocabulary_version`, unless the edit
    /// sets a field that only vocabulary v3 has and the version is older: then it moves to the
    /// bundled version, and the method rules of that version apply, so the parameters lose any
    /// field the method does not allow. A brew of an older version that sets no such field keeps
    /// its version and its values as they are (those versions have no method rules). A brew of
    /// a newer version than this build bundles is never changed.
    func setEditedParameters(_ parameters: API.BrewParameters) {
        guard vocabularyVersion <= Vocabulary.version else {
            return
        }
        if parameters.setsV3OnlyField && vocabularyVersion < Vocabulary.version {
            vocabularyVersion = Vocabulary.version
        }
        setParameters(vocabularyVersion == Vocabulary.version ? parameters.conformingToMethodRules() : parameters)
    }
}
