# DndOnlain — a shared virtual tabletop for D&D-style games

A browser table for tabletop role-playing sessions: the Dungeon Master builds
locations, uploads maps, hides them under fog of war and draws walls and doors;
players move their figures, roll dice and talk in chat. Everyone sees the same
board at the same time.

No build step and no backend of our own: plain HTML, CSS and ES modules. The
shared room lives in Firebase Realtime Database; images and the room snapshot
are cached locally in IndexedDB.

Live: **[kennys44.github.io/DndOnlain](https://kennys44.github.io/DndOnlain/)**

## What's inside

- **Rooms with keys.** The Master creates a room with a player key and a
  separate Master key; the Master key is what grants Master rights on entry.
  In the cloud the room path is the room slug plus a fingerprint of its key
  (`roomFingerprint` in `js/sync-firebase.js`), so a stranger who does not know
  the key does not find the room. The Master can change both keys later and copy
  ready-made invite links (`?r=room&k=key`, plus `&m=` for a Master link) —
  following a link fills the form in, but entering the table still takes a
  button press.
- **Locations.** Any number of scenes, each with its own map image, grid and
  camera. Created on the fly, switched from the left panel; a figure can be
  moved to another location from its card.
- **The board is one canvas.** Map, grid, tokens, fog, drawings and the ruler
  are all drawn into a single `<canvas>`, so zoom, panning and pinch-to-zoom
  stay consistent. Grid cell size, X/Y offset, feet per cell and grid visibility
  are all adjustable; there is a fit-to-screen button and a "tokens only" tool
  that keeps the map still while figures are dragged.
- **Fog of war.** Per-cell fog painted with a brush of 1–12 cells, in either
  direction — the brush reveals or hides, and Alt or the right mouse button
  temporarily flips the mode. "Reveal all" and "hide all" in one click.
- **Invisible walls and doors.** The Master draws walls as lines; doors are
  drawn the same way and swing open 160° on a click, in any tool mode. Walls
  block line of sight: a token with a vision radius (in feet) lights only what
  it can actually see, doors included — an open door lets vision through, a
  closed one does not.
- **Drawing tools** shared by everyone: pen, marker, straight line, arrow,
  rectangle, circle and cone, eight colours, adjustable thickness. The eraser
  rubs out pieces of lines and removes whole shapes; "erase mine" clears your
  own strokes only.
- **Ruler** with honest geometry — the readout is the straight-line distance,
  so a diagonal is longer than a cell side. It shows both feet and cells.
- **Token library.** The Master uploads icons, tags them as character, NPC or
  enemy, filters the library by that tag, then drags an icon onto the board or
  double-clicks it. Tokens are dragged smoothly and can span 1–6 cells.
- **Token card:** name, size in cells, current/maximum hit points, vision radius
  in feet, whether the hit-point bar is visible to players, which person at the
  table owns the figure, its location, and a button that rolls d20 initiative
  and puts the figure into the turn order.
- **Combat turn order.** Roll initiative for everyone, step through turns, count
  rounds. Each row shows the portrait, the initiative value, the hit-point bar
  (hidden from players when the Master says so) and the creature's conditions.
- **Conditions with on-screen effects.** Poisoned, stunned, frightened,
  restrained, unconscious, blessed, blinded. The player whose figure is affected
  sees it on their own screen — fear, for example, is a pulsing crimson veil with
  a heavy shake.
- **Dice** d4, d6, d8, d10, d12, d20, d100: dice count, modifier, advantage and
  disadvantage on d20. Each die is drawn as its real polyhedron with facet edges
  and an upright number; the throw flies across every screen at the table. The
  Master also has a secret roll that only the Master sees.
- **Chat and roll log** in separate tabs, with the Master able to clear either
  one on its own.
- **Inspiration.** The Master hands out and takes back inspiration gems; a
  player's count sits in the top bar.
- **Handouts.** The Master uploads images and shows one to the whole table with
  a click; players can collapse it to a chip and open it again, the Master can
  take it off everyone's screen.
- **Who is at the table.** Presence badges and a member list show only people
  currently connected; the Master can forget everyone who is offline.
- **Campaign export/import** as a single JSON file — locations, tokens, icon
  library, handouts and the log, with all images embedded.
- **Traffic counters and a load test.** The Firebase adapter counts actions and
  bytes in both directions; `tools/load.mjs` puts several browsers at one table
  at once and reports what it cost.

## Files

    index.html              the whole markup: gate, panels, board, dice tray
    css/app.css             the look: dark table, gold accent, Cinzel + Inter
    js/main.js              wiring: entry, panels, chat, dice, token card
    js/board.js             the canvas: map, grid, tokens, fog, walls, drawing
    js/store.js             room state and the pure reducer for every action
    js/dice.js              rolls and the die-shape animation
    js/sync-firebase.js     Firebase Realtime Database adapter
    js/sync.js              local adapter: BroadcastChannel between tabs
    js/firebase-config.js   project config; empty databaseURL = local mode
    js/idb.js               IndexedDB: room snapshot and images
    tools/*.mjs             Playwright checks: smoke tests, UI checks, load test

## How to run

Open the published site, or serve the folder yourself:

    git clone https://github.com/KennyS44/DndOnlain.git
    cd DndOnlain
    python3 -m http.server 20300

Then open `http://localhost:20300/`. A server is needed because the app is
built from ES modules — browsers refuse to load those over `file://`.

Out of the box `js/firebase-config.js` points at a live Realtime Database, so
the table works between devices. Blank out `databaseURL` and the app falls back
to the local adapter: the room then lives in `BroadcastChannel` plus IndexedDB,
which is enough for tabs of one browser and for offline testing.

The checks in `tools/` need Node and `playwright-chromium`
(`npm i -D playwright-chromium`; there is no `package.json` in the repo, it is
gitignored). They drive a real Chromium: `node tools/smoke.mjs` builds a table,
places a token and rolls a die, `node tools/smoke-invite.mjs` checks invite
links, `node tools/load.mjs 8 45` seats eight people at one table for 45
seconds. Most of them read `BASE_URL` and default to
`http://127.0.0.1:20300/index.html` (the load test defaults to the published
site).

## Honest limitations

- **Keys are checked in the browser, not on a server.** In cloud mode the room
  is protected by the fact that its database path contains a fingerprint of the
  player key — knowing the key is what gets you in. The Master key only decides
  which interface you are given: someone who has the player key and is willing
  to read the code can raise their own rights. This is fine for a table of
  friends, not for strangers.
- **The Firebase keys in `js/firebase-config.js` are public** — they are meant
  to be. What actually guards the data is the database rules and the room path.
- **Everyone writes the room snapshot,** because every client applies the same
  actions. Old actions are trimmed to the last hundred.
- **Images live inside the room** as data URLs, in the database and in
  IndexedDB. Large maps make the snapshot heavy; there is no image storage
  service behind this.
- **The interface is Russian only** for now.

## License

No license file yet — all rights reserved by the author.
