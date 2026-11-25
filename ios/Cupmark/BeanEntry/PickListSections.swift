import Foundation

/// One origin country with the regions that name it (ADR 0011), both in vocabulary order.
struct OriginGroup: Hashable, Sendable {
    /// A top-level entry of `origins`: a country, or `blend`, `other` or `unknown`.
    let country: Vocabulary.Origin
    /// Every entry whose `country` is `country`, for example Sumatra and Java under Indonesia.
    let regions: [Vocabulary.Origin]
}

extension Vocabulary.Origin {
    /// Every origin, grouped under its country through `Vocabulary.Origin.country`: one group
    /// per top-level entry, in vocabulary order, each with its regions. The groups hold every
    /// entry of the list exactly once, because the contract only lets a region name a
    /// top-level entry (`checkParentReferences` in contracts/lib/vocabulary.mjs).
    static var groupedByCountry: [OriginGroup] {
        let entries = Vocabulary.Origin.allCases
        return entries
            .filter { $0.country == nil }
            .map { country in
                OriginGroup(country: country, regions: entries.filter { $0.country == country })
            }
    }
}

/// One row of a pick list: a vocabulary entry with its label in the shown language.
struct PickListRow<Item: VocabularyItem>: Hashable, Identifiable, Sendable {
    let item: Item
    /// The label from contracts/i18n (the id if the bundle lacks it). Shown with
    /// `Text(verbatim:)`.
    let label: String
    /// True for a region shown under its country (origins only).
    let isRegion: Bool

    var id: String { item.rawValue }
}

/// A section of a pick list under one index letter, for the A to Z index.
struct PickListSection<Item: VocabularyItem>: Hashable, Identifiable, Sendable {
    /// An uppercase letter without diacritics, or `PickListSections.otherLetter`.
    let letter: String
    var rows: [PickListRow<Item>]

    var id: String { letter }
}

/// Builds the A to Z sections of the long pick lists (origins and varieties). There is no
/// search field (invariant 1): the index letters and the sections replace it. Pure Foundation,
/// so tests can call it with any labels.
enum PickListSections {
    /// The index letter of labels that do not start with a letter. Not translatable text.
    static let otherLetter = "#"

    /// The index letter of `label`: its first character without case or diacritics, so that
    /// "Äthiopien" is under A. `otherLetter` if the label does not start with a letter.
    static func indexLetter(for label: String, locale: Locale) -> String {
        let folded = label.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: locale)
        guard let first = folded.first, first.isLetter else {
            return otherLetter
        }
        return String(first).uppercased(with: locale)
    }

    /// Whether `lhs` sorts before `rhs`: by label, ignoring case and diacritics, in `locale`;
    /// by id when the labels compare equal, so the order is always the same.
    static func precedes<Item: VocabularyItem>(_ lhs: PickListRow<Item>, _ rhs: PickListRow<Item>, locale: Locale) -> Bool {
        let order = lhs.label.compare(rhs.label, options: [.caseInsensitive, .diacriticInsensitive], range: nil, locale: locale)
        if order == .orderedSame {
            return lhs.item.rawValue < rhs.item.rawValue
        }
        return order == .orderedAscending
    }

    /// Every entry of `Item`, sorted by label and split into sections by index letter.
    static func alphabetical<Item: VocabularyItem>(
        _ type: Item.Type = Item.self,
        locale: Locale,
        label: (Item) -> String
    ) -> [PickListSection<Item>] {
        let rows = Item.allCases
            .map { PickListRow(item: $0, label: label($0), isRegion: false) }
            .sorted { precedes($0, $1, locale: locale) }
        return sections(of: rows.map { [$0] }, locale: locale)
    }

    /// The origins, grouped by country (`Vocabulary.Origin.groupedByCountry`): the countries
    /// sorted by label and split by index letter, each followed by its regions, also sorted by
    /// label. A region stays under its country's letter.
    static func origins(locale: Locale, label: (Vocabulary.Origin) -> String) -> [PickListSection<Vocabulary.Origin>] {
        let groups = Vocabulary.Origin.groupedByCountry.map { group -> [PickListRow<Vocabulary.Origin>] in
            let country = PickListRow(item: group.country, label: label(group.country), isRegion: false)
            let regions = group.regions
                .map { PickListRow(item: $0, label: label($0), isRegion: true) }
                .sorted { precedes($0, $1, locale: locale) }
            return [country] + regions
        }
        let sorted = groups.sorted { lhs, rhs in
            guard let left = lhs.first, let right = rhs.first else {
                return false
            }
            return precedes(left, right, locale: locale)
        }
        return sections(of: sorted, locale: locale)
    }

    /// Sections from sorted blocks of rows; each block goes under the letter of its first row.
    /// A letter has one section even if the collation put another letter between its blocks,
    /// so section ids stay unique.
    private static func sections<Item: VocabularyItem>(of blocks: [[PickListRow<Item>]], locale: Locale) -> [PickListSection<Item>] {
        var result: [PickListSection<Item>] = []
        for block in blocks {
            guard let first = block.first else {
                continue
            }
            let letter = indexLetter(for: first.label, locale: locale)
            if let existing = result.firstIndex(where: { $0.letter == letter }) {
                result[existing].rows.append(contentsOf: block)
            } else {
                result.append(PickListSection(letter: letter, rows: block))
            }
        }
        return result
    }
}
