# Nuvio

A document editor that behaves like a typewriter. You type onto paper held in a carriage: the paper slides left with every keystroke, a bell rings 7 characters before the right margin, the carriage locks at the margin, and Return slams it back. Every letter is inked a little differently, and documents are saved to your account like in Google Docs.

## Features

- **Carriage view**: the paper moves while the strike point stays still. There's a platen, a margin scale, a ribbon that lifts on every strike, and line/column/page counters.
- **Pages view**: the machine slides away so you can read and scroll the full sheets. Click anywhere on a sheet to move the carriage there.
- **Real typewriter rules**:
  - Backspace moves the carriage back, so typing over a letter **overstrikes** it.
  - Optional *correction tape* mode makes Backspace lift the last letter off instead.
  - Margin lock, or optional auto-return of whole words.
  - Tab stops every 5 columns. ↑/↓ (or the mouse wheel) rolls the platen. Home returns the carriage without feeding a line.
- **Two-colour ribbon** (black/red), two typefaces (Elite and Pica), four kinds of paper, single or double spacing, line widths from 50 to 80.
- **Synthesised sound** (Web Audio, no audio files): key strikes, a duller space bar, the carriage-return ratchet and slam, the margin bell and the paper feed.
- **Paste to auto-type**: pasted text gets typed out key by key.
- **Accounts and cloud saving**: autosave, a document list with templates (blank, letter, manuscript, poem), rename/delete, and read-only share links.
- **Export** as `.txt`, or print/save as PDF with one sheet per US Letter page.

## Stack

- **Backend**: Node 20+ and Express (`server/`). Cookie sessions, bcrypt-hashed passwords, rate-limited auth, Helmet CSP.
- **Storage**: PostgreSQL when `DATABASE_URL` is set. Without it, a local JSON file at `data/nuvio.json` (for development only).
- **Frontend**: plain ES modules with no build step (`public/`).

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000 and create an account.

## Deploy to Render

1. Push this folder to a GitHub/GitLab repo.
2. In Render, choose **New → Blueprint** and select the repo. `render.yaml` creates:
   - `nuvio`, a Node web service (`npm start`, health check at `/healthz`)
   - `nuvio-db`, a Postgres database whose `DATABASE_URL` is injected automatically
3. Deploy. The tables are created on first boot.

> On Render's free plan the local disk is wiped on every deploy, so production must use Postgres (the Blueprint sets this up). Free Postgres instances expire after a limited period, so upgrade the database plan to keep the data.

## Keyboard

| Key | Action |
| --- | --- |
| any character | strike a key |
| Return | carriage return + line feed |
| Backspace | carriage back one space (or lift off, in correction-tape mode) |
| Tab | next tab stop |
| ↑ / ↓, mouse wheel | roll the platen |
| ← / → | move the carriage without typing |
| Home | carriage return without a line feed |
| PageUp / PageDown | roll to the previous/next sheet |
| ⌘/Ctrl + S | save now |
