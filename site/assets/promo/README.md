# Promo art

Imagery for the public Cupmark promo page (`https://www.derschweigert.de/cupmark`). Nothing here is
used by the iOS app, the backend or the contracts; it is marketing material only.

All images are AI-generated for this project. People in them are synthetic: no real person is
depicted, and no third-party logo, brand or readable label text appears in any frame. The supermarket
shot deliberately turns the coffee bag away from the camera for that reason.

| File | Size | Role | Seed |
| --- | --- | --- | --- |
| `marble.jpg` | 1536×1024 | Page background, one large plate laid over the whole viewport (`center / cover`), never tiled | 612400 |
| `crema.jpg` | 512×512 | Texture under the buttons, dark brown gradient on top | 90317 |
| `cafe-friends.jpg` | 1536×864 | Hero: two friends laughing over coffee, phone face down on the table | 440292 |
| `cafe-phone.jpg` | 1152×1440 | Community section: a hand holds a phone with its back to the camera beside a flat white | 733815 |
| `cafe-sip.jpg` | 1152×1440 | Test section: a man in his thirties smells a handmade ceramic cup | 220119 |
| `in-store.jpg` | 1152×1440 | Shopping section: a woman in her thirties holds a bag with the label turned away | 902611 |
| `roastery.jpg` | 1152×1440 | Roasters section: hands over the cooling tray of a small roastery | 581104 |
| `cup.svg` | 24×24 | The coffee-cup marker used instead of bullet points, applied as a CSS mask | — |

## How they were made

Generated with [fal.ai](https://fal.ai) FLUX.1 `[dev]` through `tools/fal_image.py` in the
`UrsSchweigert/DerSchweigert` repository, which also holds the page that uses them. The seed in the
table reproduces each frame with a comparable prompt; the prompts were written for that page.

The palette comes from the app icon: espresso `#3E271B` ground, cream `#ECD6B8` bean. The page tints
the photographs to sit on that palette, so the files themselves stay neutral.

## Licence and reuse

Generated for Cupmark and free to use in its marketing material, including the App Store listing and
the website. No stock-photo licence is attached, and no attribution is required. If an image is
reused, keep this README with it so the provenance stays clear.
