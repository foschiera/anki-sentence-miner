# Data and privacy

Web Anki Miner has no application server and includes no analytics SDK. Processing is split between packaged code, a local Anki installation, and external content services.

## Data flow

| Destination | Data | Purpose |
|---|---|---|
| Packaged Tesseract worker | User-selected image region | Japanese OCR |
| `http://localhost:8765` | Note fields, tags, and optional media | Create and synchronize notes through AnkiConnect |
| Jisho | Detected Japanese term | Reading, base form, definitions, and JLPT metadata |
| Google Translate | Detected sentence or term | Portuguese translation |
| Google text-to-speech | Detected sentence or term | Japanese audio downloaded by AnkiConnect |
| Firefox local extension storage | Deck, model, field mappings, and sync preferences | Preserve configuration |

The extension requests access to website content because it must inspect user-selected text, visible subtitles, and user-selected screen regions. These operations are initiated by keyboard shortcuts or context-menu actions.

## Current limitations

- Dictionary, translation, and text-to-speech requests depend on third-party availability and policies.
- The translation and audio integrations use public web endpoints rather than user-configured provider credentials.
- Users should avoid mining sensitive text they do not want sent to the listed services.

Any new destination, telemetry, permission, or remotely transferred field must be documented here before release.

