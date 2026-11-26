# 0032 The coffee look: espresso accent, cream and dark-roast backgrounds, named colours

- Status: accepted
- Date: 2026-11-26
- Decided by: lead (ADR 0014), on the owner's reaction to the first TestFlight build ("a lot of black and white forms and buttons; it doesn't remind me of coffee yet") and the owner's "the taste looks good" to the proposal below. No cloud cost.

## Context

The app uses the default system look: grey grouped forms, a blue accent. The owner wants it to feel like coffee. The constraints that stay: Dynamic Type and VoiceOver on every control (docs/04, Non-functional), no third-party fonts or SDKs (invariant 7), and every colour reads in light and dark mode.

## Decision

1. **A warm palette, defined once as named colour sets** in `ios/Cupmark/Assets.xcassets`, each with a light and a dark (`appearances`) value. The sets are the only place a colour value is written. Screens use the names (through the generated symbols or one `Theme` file), never a literal.

   | Name | Light | Dark | Used for |
   | --- | --- | --- | --- |
   | `AccentColor` | `#6B4428` espresso | `#E0B27E` caramel | tint of buttons, links, selection, sliders, scores |
   | `OnAccent` | `#FFFBF4` | `#1B120D` | text and icons on a filled accent button |
   | `FormBackground` | `#F4EBDD` cream | `#1B120D` dark roast | behind forms (grouped) |
   | `ListBackground` | `#F7F0E6` | `#1E1510` | behind lists and plain screens |
   | `Surface` | `#FFFBF4` | `#2A1E17` | rows and cards on those backgrounds |
   | `TextPrimary` | `#2B1D14` | `#F3E9DC` | body and headings |
   | `TextSecondary` | `#5E4B3C` | `#BFAE9C` | captions, footers, hints |

2. **Contrast was calculated, not judged by eye** (WCAG 2.x relative luminance). Every text and tint pairing passes AA for normal text (4.5:1), with the margin shown:

   | Pairing | Light | Dark |
   | --- | --- | --- |
   | `AccentColor` on `FormBackground` | 7.16 | 9.52 |
   | `AccentColor` on `ListBackground` | 7.48 | 9.26 |
   | `AccentColor` on `Surface` | 8.20 | 8.36 |
   | `TextPrimary` on `FormBackground` | 13.79 | 15.37 |
   | `TextPrimary` on `ListBackground` | 14.40 | 14.96 |
   | `TextPrimary` on `Surface` | 15.80 | 13.50 |
   | `TextSecondary` on `FormBackground` | 6.98 | 8.56 |
   | `TextSecondary` on `ListBackground` | 7.29 | 8.33 |
   | `TextSecondary` on `Surface` | 7.99 | 7.52 |
   | `OnAccent` on `AccentColor` | 8.20 | 9.52 |

   A unit test reads the colour set JSON and recomputes every pairing above, in both appearances, so a changed value that fails fails the build.
3. **Secondary text uses `TextSecondary`, not the system's `.secondary`.** The system secondary colour is a 60% alpha grey; on cream it falls close to the 4.5:1 line, which is what the accessibility audit kept reporting as "Contrast nearly passed". Footers, hints and captions use the named colour.
4. **Typography stays on system fonts.** Titles and large headings use the `.rounded` design and a heavier weight, which reads warmer, and nothing is bundled or downloaded, so Dynamic Type works unchanged.
5. **The app icon stays the placeholder bean** and is redrawn in a later task; it is not part of the look.
6. **A static check** (`scripts/`, run with the other script checks) fails on a colour literal (`Color(red:`, `Color(white:`, `UIColor(red:`, a hex string, a system colour used as a brand colour) in `ios/Cupmark` outside the `Theme` file, with a test that shows it failing.

## Consequences

- One edit to a colour set restyles the app; the contrast test says whether the edit is allowed.
- The macOS accessibility audits keep reporting only (M2-T33); this change should reduce their contrast findings, which is part of how it is judged. The owner judges the look on a device (M2-T34).
- `Color.secondary` and `.tint(.indigo)`-style literals are removed from screens as part of the task.
