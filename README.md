# Web Anki Miner

Turn Japanese text, streaming subtitles, PDFs, and screen regions into enriched Anki notes without leaving the browser.

Web Anki Miner is a Firefox Manifest V3 extension for language learners who practice sentence mining. It captures context, looks up the base word and reading, adds a Portuguese translation and Japanese audio, and sends the result to a user-selected deck through AnkiConnect.

## What it does

- Mines selected text and the surrounding sentence with `Alt+A`.
- Detects active subtitles on YouTube, Netflix, and compatible web players.
- Captures a video frame when the configured note type has an image field.
- Runs packaged Japanese OCR on a selected screen region with `Alt+C`.
- Supports text selection and screenshot OCR in Firefox's PDF viewer.
- Lets users review and edit the term, context, and destination deck before saving.
- Adapts field mappings to existing Anki note types.
- Detects duplicates within the destination deck and asks before overriding.
- Optionally syncs with AnkiWeb after a configurable number of additions.

## Requirements

- Firefox 126 or newer.
- Anki Desktop running locally.
- The [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on listening on its default `http://localhost:8765` endpoint.
- Internet access for dictionary lookup, translation, and generated audio. OCR itself uses files packaged with the extension.

## Install for development

1. Clone the repository and run `npm ci`.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Choose **Load Temporary Add-on** and select `manifest.json`.
4. Start Anki Desktop and confirm that the extension badge turns green.
5. Open the extension popup to choose a deck, note type, and field mappings.

Temporary extensions are removed when Firefox closes. Packaged releases will be published separately from the source tree.

## Typical workflow

1. Select a Japanese word or pause on a subtitle.
2. Press `Alt+A`, then review the detected term and sentence.
3. Choose the destination deck and submit.
4. For text embedded in an image or PDF, press `Alt+C` and drag over the text first.

## Development

The project intentionally has no runtime build dependency yet. Node.js is used for repository checks and tests:

```bash
npm ci
npm run check
```

`npm run check` verifies that the package and extension manifests agree, checks referenced entry files, and runs the Node test suite.

See [docs/architecture.md](docs/architecture.md) for component boundaries and the incremental refactoring direction. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing behavior.

## Data and privacy

The extension reads selected website text and visible pixels only after a user action. Data used to build a card may be sent to local AnkiConnect and to third-party dictionary, translation, and audio services. The project does not include analytics or an application server. See [docs/privacy.md](docs/privacy.md) for the exact data flow and current limitations.

## Project status

Version 1.5 is a working Firefox-focused release under active development. The next engineering milestone is to separate application workflows from browser and provider integrations while preserving the current behavior with tests.

No open-source license has been selected yet. Until one is added, the source remains all-rights-reserved.

