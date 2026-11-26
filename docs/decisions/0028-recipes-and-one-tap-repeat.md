# 0028 Recipes and one-tap repeat: no name, copied into a new brew, kept from the brew form

- Status: accepted
- Date: 2026-11-26
- Decided by: ios-engineer under the lead's delegation (ADR 0014), task M2-T27; no cloud cost (the recipe routes exist)

## Context

docs/04 F2 says a brew can be saved as a recipe and repeated with one tap, which is how the 30-second repeat brew of docs/03 is met. The contract has `RecipeInput` (vocabulary version and `BrewParameters`) and the recipe routes; the outbox and the engine already send them (ADR 0025). M2-T27 leaves open:

- how a recipe is told apart without a name (invariant 1);
- what "repeat last brew" copies, and from which bag;
- where a recipe is saved and how one is replaced;
- what happens to two recipes with the same values.

## Decision

- **No name.** A recipe is shown by its method, then dose, ratio, temperature and grind, each only when set. Nothing else identifies it; there is no label, colour or number to pick.
- **A repeat copies every parameter.** One tap on a recipe or on "Repeat Last Brew" opens the brew form of the chosen shelf entry with every parameter copied, brew time included, and the timer stopped and ready. The rating is not copied; the rating screen offers an earlier rating, of the bag, of the same coffee or of the repeated brew (ADR 0026, Addendum M2-T27). `brewed_at` is the moment of the save. The form needs no further input, and saving goes on to the rating.
- **The last brew** is the newest brew of the chosen bag, or, for a bag without brews, the newest brew on the device, of any bag: a new bag of the usual coffee is repeated like the old one.
- **Where.** "Repeat Last Brew" is a swipe action on the shelf row (next to "Log a Brew", which stays the full-swipe action) and the first row of the bag's "Repeat" section. The section lists the three newest recipes and links to all of them; recipes are removed by swiping.
- **Keeping a recipe.** The brew form has one toggle, off by default: "Also Save as a Recipe", or, in a form started from a recipe, "Update the Recipe with These Values", which replaces that recipe's parameters (`PUT` replaces the whole item). The recipe is written in the brew's one save and queued after the brew, so a recipe waiting for a retry never holds the brew and its rating. Whether the recipe may be replaced is checked again at the save. A brew in the brew list can also be kept as a recipe afterwards, once the cup was tasted.
- **One recipe per set of values.** Saving parameters that a recipe on the device already has keeps that recipe and writes nothing. Replacing a recipe with the parameters of another recipe is refused (`alreadyRecipe`) and writes nothing; the brew form says beforehand that the values are already a recipe, and keeps that one. Deleting the replaced recipe instead was not chosen: it would remove a recipe the user did not ask to remove. A recipe whose create is parked matches nothing, since it never reaches the server; the same values are then kept as a new recipe. This also keeps the ambiguous-create check of ADR 0025, which matches a recipe by its parameters, unambiguous on one device.
- **A recipe from a newer vocabulary is never replaced.** Its parameters could hold values this build does not know; the toggle then saves a new recipe instead.

## Alternatives

- **A separate recipe editor with its own steppers.** It would duplicate the brew form, and a recipe is best tuned while brewing. Replacing from the brew form needs no second form.
- **Copying only some fields (no brew time).** The brew time is part of the recipe; the timer is there to measure a different one, and Stop replaces it.
- **"Last brew" only from the same bag.** A new bag would offer nothing to repeat until it had a brew, which is exactly when a repeat saves the most input.

## Consequences

- The repeat path from the shelf is: swipe the row, "Repeat Last Brew", Save, the rating offer, Save rating: 1 swipe and 4 taps, 6 actions with the timer (Start, Stop), 7 with the app icon. From the bag's screen: the row, "Repeat Last Brew" or a recipe, Save, the offer, Save rating: 5 taps, 7 with the timer, 8 with the app icon. With the Addendum (M2-T27) to ADR 0026 this holds for the first repeat onto a new bag too, whenever the same coffee or the repeated brew has a rating. A first brew from a recipe onto a coffee never rated still needs the eight scores, since a recipe holds no rating.
- No cloud cost: the routes and the outbox exist; recipes are small items of the user's own partition.
