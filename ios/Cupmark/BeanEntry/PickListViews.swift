import SwiftUI

/// A long pick list (origins, varieties) as a pushed screen: "Not set", then the entries in
/// sections by index letter, with an A to Z index on the trailing edge. A tap picks the entry
/// and goes back. No search field (invariant 1).
struct IndexedPickList<Item: VocabularyItem>: View {
    let title: LocalizedStringKey
    let sections: [PickListSection<Item>]
    @Binding var selection: Item?
    /// Entries to offer first, under "Recent" (the grinders of the latest brews, M2-T26), in
    /// the order given. Empty for no such section.
    var recents: [Item] = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// The rows of `recents`, with the labels the sections already hold.
    private var recentRows: [PickListRow<Item>] {
        let rows = sections.flatMap(\.rows)
        return recents.compactMap { item in rows.first { row in row.item == item } }
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                Section {
                    Button {
                        pick(nil)
                    } label: {
                        PickListRowLabel(isSelected: selection == nil, isRegion: false) {
                            Text(L10n.lookupPickNotSet)
                        }
                    }
                    .accessibilityAddTraits(selection == nil ? [.isSelected] : [])
                }
                if !recentRows.isEmpty {
                    Section {
                        ForEach(recentRows) { row in
                            Button {
                                pick(row.item)
                            } label: {
                                PickListRowLabel(isSelected: selection == row.item, isRegion: false) {
                                    Text(verbatim: row.label)
                                }
                            }
                            .accessibilityAddTraits(selection == row.item ? [.isSelected] : [])
                        }
                    } header: {
                        Text(L10n.pickListRecent)
                    }
                }
                ForEach(sections) { section in
                    Section {
                        ForEach(section.rows) { row in
                            Button {
                                pick(row.item)
                            } label: {
                                PickListRowLabel(isSelected: selection == row.item, isRegion: row.isRegion) {
                                    Text(verbatim: row.label)
                                }
                            }
                            .accessibilityAddTraits(selection == row.item ? [.isSelected] : [])
                            .id(row.id)
                        }
                    } header: {
                        Text(verbatim: section.letter)
                    }
                }
            }
            .safeAreaInset(edge: .trailing, spacing: 0) {
                // At accessibility text sizes the letters would not fit; the section headers
                // remain, and VoiceOver users move between them with the headings rotor.
                if !dynamicTypeSize.isAccessibilitySize {
                    index(proxy)
                }
            }
        }
        .navigationTitle(Text(title))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The A to Z index: one button per section, scrolling to its first row. Hidden from
    /// VoiceOver, which reads the section headers as headings instead.
    private func index(_ proxy: ScrollViewProxy) -> some View {
        VStack(spacing: 2) {
            ForEach(sections) { section in
                // Tap target: the index letters stay small, like the system's section index, so
                // A to Z fit beside the list; the rows themselves are full-height list rows.
                Button {
                    guard let first = section.rows.first else {
                        return
                    }
                    withAnimation {
                        proxy.scrollTo(first.id, anchor: .top)
                    }
                } label: {
                    Text(verbatim: section.letter)
                        .font(.caption2.weight(.semibold))
                        .frame(minWidth: 20)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 2)
        .frame(maxHeight: .infinity)
        .accessibilityHidden(true)
    }

    private func pick(_ item: Item?) {
        selection = item
        dismiss()
    }
}

/// The label of a pick-list row: the text, indented for a region, and a checkmark when picked.
struct PickListRowLabel<Content: View>: View {
    let isSelected: Bool
    let isRegion: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack {
            content()
                .foregroundStyle(.primary)
                .padding(.leading, isRegion ? 20 : 0)
            Spacer(minLength: 8)
            if isSelected {
                Image(systemName: "checkmark")
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
    }
}

/// A form row that opens an `IndexedPickList` and shows the current pick, or "Not set".
/// VoiceOver reads the title as the label and the pick as the value ("Origin, Not set",
/// M2-T33), like a `Picker`.
struct IndexedPickListRow<Item: VocabularyItem>: View {
    let title: LocalizedStringKey
    @Binding var selection: Item?
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    /// Builds the sections when the list opens.
    let sections: @MainActor () -> [PickListSection<Item>]
    /// Entries offered first under "Recent" (see `IndexedPickList`).
    var recents: [Item] = []

    var body: some View {
        NavigationLink {
            IndexedPickList(title: title, sections: sections(), selection: $selection, recents: recents)
        } label: {
            LabeledContent {
                if let selection {
                    Text(verbatim: VocabularyLabels.label(for: selection, in: vocabulary, language: language))
                } else {
                    Text(L10n.lookupPickNotSet)
                }
            } label: {
                Text(title)
            }
        }
        .accessibilityLabel(Text(title))
        .accessibilityValue(accessibilityValue)
    }

    private var accessibilityValue: Text {
        if let selection {
            return Text(verbatim: VocabularyLabels.label(for: selection, in: vocabulary, language: language))
        }
        return Text(L10n.lookupPickNotSet)
    }
}

/// Roast level as a segmented control (M2-T22). Optional: nothing is selected until a level is
/// picked, and "Clear" sets it back to not set. At accessibility text sizes the segments would
/// be cut off, so it becomes a pushed list instead.
struct RoastLevelPicker: View {
    @Binding var selection: Vocabulary.RoastLevel?
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            OptionalVocabularyPicker(
                title: BeanAttributeField.roastLevel.title,
                selection: $selection,
                vocabulary: vocabulary,
                language: language
            )
            .pickerStyle(.navigationLink)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(BeanAttributeField.roastLevel.title)
                    Spacer()
                    if selection != nil {
                        Button {
                            selection = nil
                        } label: {
                            Text(L10n.beanEntryClear)
                                .minimumTapTarget()
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Text(L10n.beanEntryRoastLevelClear))
                    }
                }
                Picker(selection: $selection) {
                    ForEach(Vocabulary.RoastLevel.allCases) { level in
                        Text(verbatim: VocabularyLabels.label(for: level, in: vocabulary, language: language))
                            .tag(Optional<Vocabulary.RoastLevel>.some(level))
                    }
                } label: {
                    Text(BeanAttributeField.roastLevel.title)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                // The hidden label is not read; VoiceOver names the control like the others.
                .accessibilityLabel(Text(BeanAttributeField.roastLevel.title))
                .accessibilityIdentifier("bean-entry-roast-level")
            }
            .padding(.vertical, 4)
        }
    }
}

/// Vocabulary labels from contracts/i18n, with the id as the fallback if the bundle lacks one.
enum VocabularyLabels {
    static func label<Item: VocabularyItem>(for item: Item, in vocabulary: VocabularyStore, language: VocabularyLanguage) -> String {
        (try? vocabulary.label(for: item, language: language)) ?? item.rawValue
    }
}
