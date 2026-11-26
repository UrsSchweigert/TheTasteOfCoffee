import SwiftUI

/// The first level of the flavour notes (M2-T20, docs/04 F3): the vocabulary's
/// `flavour_categories` in file order, each with how many of its notes are picked, and how
/// many may be picked in all (`flavour_notes.max_picks`).
struct FlavourCategoryList: View {
    let model: RatingFormModel
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        List {
            FlavourNoteCountSection(draft: model.draft)
            Section {
                ForEach(Vocabulary.FlavourCategory.allCases) { category in
                    NavigationLink {
                        FlavourNoteList(model: model, category: category, vocabulary: vocabulary, language: language)
                    } label: {
                        LabeledContent {
                            if model.draft.pickedCount(in: category) > 0 {
                                Text(model.draft.pickedCount(in: category), format: .number)
                            }
                        } label: {
                            Text(verbatim: VocabularyLabels.label(for: category, in: vocabulary, language: language))
                        }
                    }
                    .accessibilityIdentifier("rating-flavour-category")
                }
            }
        }
        .navigationTitle(Text(L10n.ratingNotesHeader))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The second level: the notes of one category. A tap picks or removes a note; once
/// `RatingDraft.maxFlavourNotes` are picked, the notes that are not picked are disabled.
struct FlavourNoteList: View {
    let model: RatingFormModel
    let category: Vocabulary.FlavourCategory
    let vocabulary: VocabularyStore
    let language: VocabularyLanguage

    var body: some View {
        List {
            FlavourNoteCountSection(draft: model.draft)
            Section {
                ForEach(category.flavourNotes) { note in
                    Button {
                        model.toggle(note)
                    } label: {
                        HStack {
                            Text(verbatim: VocabularyLabels.label(for: note, in: vocabulary, language: language))
                            Spacer()
                            if model.draft.isPicked(note) {
                                Image(systemName: "checkmark")
                                    .accessibilityHidden(true)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .tint(.primary)
                    .disabled(!model.draft.canToggle(note))
                    .accessibilityAddTraits(model.draft.isPicked(note) ? .isSelected : [])
                    .accessibilityIdentifier("rating-flavour-note")
                }
            }
        }
        .navigationTitle(Text(verbatim: VocabularyLabels.label(for: category, in: vocabulary, language: language)))
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// How many notes are picked and how many may be, with a note once no more can be picked.
struct FlavourNoteCountSection: View {
    let draft: RatingDraft

    var body: some View {
        Section {
            LabeledContent {
                Text(draft.flavourNotes.count, format: .number)
            } label: {
                Text(L10n.ratingNotesPicked)
            }
            .accessibilityElement(children: .combine)
            LabeledContent {
                Text(RatingDraft.maxFlavourNotes, format: .number)
            } label: {
                Text(L10n.ratingNotesMax)
            }
            .accessibilityElement(children: .combine)
        } footer: {
            if !draft.canPickMoreNotes {
                Text(L10n.ratingNotesFull)
                    .accessibilityIdentifier("rating-notes-full")
            }
        }
    }
}
