# era-board

A dynamic choice-board renderer for eye-gaze: renders a daily recipe JSON
(e.g. outfit choices with photos, weather tile) as a dwell-selectable board
with message bar, offline last-good fallback, and ETag freshness polling.
Part of the Our Era Communication Tools family; runs as a module of era-hub on
era-core engines. The content pipeline (clothing builder/generator) is a
separate module.

License: MPL-2.0.

Model tests own a synthetic recipe and run directly with
`node --test tests/board-model.test.mjs`. Standalone route tests require
`ERA_HUB_SRC` naming the intended hub checkout; the gate supplies this path.
They create temporary data and a local symbol provider instead of reading
private wardrobes or reaching a public service. For manual verification,
`ERA_BOARD_ROUTE_PORT` can select a free approved manual test port; the suite
otherwise uses its dedicated port and refuses an existing listener.

Clothing layout (2026-10-17): the hub's forecast spans the center pair and
retains ordinary speaking-control behavior, with a quiet sage background and
dark ink. `app/wardrobe.svg` is the Full wardrobe door's cupboard pictogram.
Other boards retain their existing control colors and layout. The coordinated
hub spec is `era-hub/docs/specs/2026-10-17-clothing-page-1.md`; develop and gate
both worktrees with `ERA_WT_SUFFIX=--wt-clothing-page-1`.

Song pages (2026-10-25): the image spans three quarters of the board; Back,
Stop and Full song fill the far-right column. Selecting a playing song's image
advances a video still without changing playback. Ten screened pictures are
cached for offline use. The touch-only Pictures panel lets a parent review or
refresh a set, choose a separate video for its pictures, or use cover art. The hub owns capture and screening; coordinate
both worktrees using `ERA_WT_SUFFIX=--wt-music-player-ux-recruitment` and see
`era-hub/docs/specs/2026-10-25-music-player-ux-recruitment.md`.

## App locks

The shared door bar now offers an independent app lock using era-core’s
controller and adult passcode UI. Locking stops activity, preserves work and
keeps exit and communication doors available. Music, Movies, Clothing and This week use separate lock IDs. The old combined
media lock migrates without changing its expiry. Implementation awaits testing
and has not been released.
