# 0030 Brew form v3: method rules in the draft, the grinder pick list, and local schema version 3

- Status: accepted
- Date: 2026-11-26
- Decided by: lead (ADR 0014); no cloud cost

## Context

M2-T26 applies ADR 0021 in the app. The backend (M2-T5) answers 400 for a field its method does not allow, a grind setting off the grinder's scale or without a grinder that has one, and a grinder under vocabulary 1 or 2. The local store had no column for the grinder or its setting.

## Decision

- **Rules live in the draft.** `BrewDraft` clears the fields a new method does not allow, ignores a setter for a field its method does not allow, and clears the grind setting when the grinder changes. Its `parameters` are also passed through `conformingToMethodRules()`. The rules are the generated ones.
- **Old values are conformed when copied.** A repeat or a recipe built from a brew or recipe of vocabulary 1 or 2 drops any field its method does not allow, because the new brew is saved at the bundled version, where the rules apply. The old brew or recipe is not changed. A recipe kept from a brew is conformed in `AccountStore`.
- **Edits.** `StoredBrew.setEditedParameters(_:)`: an old brew keeps its `vocabulary_version`, unless the edit sets `grinder` or `grind_setting`; then it moves to the bundled version and the method rules apply. No screen edits a brew yet.
- **Grinder list.** An A to Z pick list with a "Recent" section (grinders of the latest brews), no search field. The grind setting stepper is hidden for a grinder without a scale.
- **Local schema version 3.** `StoredBrew` and `StoredRecipe` gain two optional attributes, so version 2 migrates with a lightweight stage. A new version rather than an edit of version 2, since stores of version 2 may exist on development devices (ADR 0025 added the outbox to version 1 only because nothing had been written by it).

## Alternatives

- **Edit version 2 in place:** a development store written by the earlier build would no longer match any known version.
- **Keep the old fields in a repeat and let the server refuse:** the brew would be stuck in the outbox, parked.

## Consequences

- **Brews saved before this change.** Since M2-T4 the app has saved brews at vocabulary 3, and until this change the form offered every field with every method. A development device can therefore hold version 3 brews or recipes with a field the v3 rules forbid (`water_temp_c` with moka pot, cezve or cold brew, or `cold` with any other method than cold brew). The sync sends such an item unchanged, so the backend (#71) answers 400 and the operation is parked. Only development stores are affected: nothing is deployed yet. Grinder fields cannot be involved, since no earlier brew has one.
- **Migration tested only in the simulator.** The V1 to V3 and V2 to V3 migrations are tested with real store files in `StoreMigrationTests` on the macOS runner, not on a device store.

- A repeat of an old brew with a field its method now disallows loses that field in the new brew, by design.
- Switching the method and back loses the cleared values.
