# Contributing

Thanks for helping improve Web Anki Miner.

## Local checks

Use Node.js 18 or newer, then run:

```bash
npm ci
npm run check
```

Add or update tests for every behavior change. Keep browser APIs behind small boundaries where possible so that application logic remains testable without Firefox.

## Change guidelines

- Preserve existing settings when changing their shape; add an explicit migration when needed.
- Treat runtime message payloads as public contracts between extension contexts.
- Do not add remote executable code. Firefox extension code and OCR workers must remain packaged locally.
- Document any new external service, host permission, or data transfer in `docs/privacy.md`.
- Do not commit generated `.zip` or `.xpi` packages; attach them to a tagged release instead.
- Keep user-facing copy consistent with the current Portuguese interface until localization is introduced.

## Pull requests

Describe the user problem, the chosen behavior, and how it was verified. For interface changes, include before-and-after screenshots or a short recording.

