# Contracts

Everything the app and the backend agree on. Owned by the `contract-keeper` agent.

- `vocabulary/v<N>/`: the closed lists and numeric ranges. This is what makes the app free of free text. Ids are stable forever. A published version is never edited; changes go into the next version.
- `openapi.yaml`: the API (created in task M0-T2).
- `i18n/<lang>.json`: display labels for every id (created in task M0-T1).

`vocabulary/v1/criteria.json` and `brew.json` are seeds taken from `docs/04-specification.md`. They are marked `draft`. Task M0-T1 completes the set (processes, roast levels, price bands, origins, flavour notes) and the owner approves it before it is published.
