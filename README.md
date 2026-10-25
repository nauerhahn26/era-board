# era-board

A dynamic choice-board renderer for eye-gaze: renders a daily recipe JSON
(e.g. outfit choices with photos, weather tile) as a dwell-selectable board
with message bar, offline last-good fallback, and ETag freshness polling.
Part of the Our Era Communication Tools family; runs as a module of era-hub on
era-core engines. The content pipeline (clothing builder/generator) is a
separate module.

License: MPL-2.0.

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
refresh a set, or use cover art. The hub owns capture and screening; coordinate
both worktrees using `ERA_WT_SUFFIX=--wt-music-player-ux-recruitment` and see
`era-hub/docs/specs/2026-10-25-music-player-ux-recruitment.md`.
