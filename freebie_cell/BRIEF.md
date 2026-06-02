# Freebie Cell — Project Brief

Handoff from conversation started in the wrong project (timeout_tales). Pick this up in a new Claude Code session rooted at `D:\My Creations\git\widgets`.

## What it is

A smartphone-targeted PWA Freecell game with score tracking. Personal project for Ruth (Joseph's wife); Joseph is the developer proxy.

## Confirmed decisions

| Concern | Decision |
|---|---|
| State / scores | Firebase Firestore |
| Auth + username | Google Identity Services — `given_name` from JWT as default username |
| Username override | Stored in `localStorage` (intentionally lost with cookies / new phone) |
| Offline play | PWA with service worker |
| Card assets | Free SVG cards (CC0), dark green felt background |
| Framework | Vanilla JS |
| Drag & drop | Yes, preferred (Interact.js or similar) |
| Seeds | Microsoft FreeCell deals 1–1,000,000 (LCG algorithm); known ~0.002% unsolvable rate is acceptable |
| Undo | Unlimited; each undo increments move count |
| Auto-solve alert | Banner: "Game is trivially solvable — continue or auto-finish?" No card animation needed |
| Stuck detection | No-progress heuristic → turn UI red. Stuck = no move available that (a) sends a card to foundation, (b) exposes a card reachable to foundation in 1–2 steps, or (c) clears a tableau column entirely. Accepts rare false positives by design. |
| Score saving | Saves: username, game number (seed), move count, datetime. Does NOT overwrite if a better (lower) score already exists for that user+game. |
| Leaderboard | Single user for now; architecture should make it easy to add a multi-user leaderboard later |

## Auto-solve definition

"Trivially solvable" = every remaining card can reach the foundation without rearranging any free cells or tableau ordering. Standard Freecell auto-complete condition.

## Stuck detection detail

Ruth's framing: she wants to always end a game either by winning or by the computer confirming there are no useful moves — so she can start using undo without second-guessing. False positives (calling stuck when technically a lateral shuffle exists) are acceptable. The heuristic above matches that intent.

## Seed approach

Use the Microsoft FreeCell LCG shuffle (well-documented, reproducible from seed integer). Deals 1–1,000,000 are the available pool. A small number are provably unsolvable; these can be excluded via a shipped blocklist, or ignored given the low rate. Recommend shipping the blocklist for correctness.

## File / folder target

`D:\My Creations\git\widgets\freebie_cell\`
