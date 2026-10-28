# README screenshots

The three [README](../README.md) images are unedited PNG captures of the installed
Source application built from the Source implementation reviewed for this release, on 2026-10-27. They are not mockups.
The product source, CSS, data and rendered elements were not altered for capture.

## Capture and data

- Viewport and PNG size: 1440 × 900, device scale factor 1, browser zoom 100%.
- Appearance: dark throughout; the schema uses the application’s own black focus palette.
- Build: Node.js 22.22.1, npm 9.2.0, Vite 7.3.6; `scripts/build_release.py` built the wheel.
- Installed runtime: `ki 0.1.0` in a fresh virtual environment, launched from an empty directory; Python 3.13.12, SQLite 3.51.1, Chrome 155.0.8059.39 on Linux.
- Canvas layout and framing use ordinary UI clicks, drags, panel controls and canvas zoom. The primary canvas uses 1.5× canvas zoom; browser zoom stays at 100%.
- Data: the public Chinook v1.4.5 SQLite sample. See [dataset provenance and licensing](../examples/chinook/README.md#dataset-and-licence), including the upstream MIT notice.

The original database’s SHA-256, byte size, modification time and empty sidecar
list were identical before and after capture. Its SHA-256 is
`bdf635be69850bd3be09c9a2dbeef7ddfb80036bd3ef3381383cd03b61e4a61a`.
The temporary service was stopped and its private capture released afterwards.

## Reproduce the record investigation

Prepare Chinook and launch it using the [installation instructions](../README.md#installation-and-quickstart).
Choose each table’s `name by` field before opening records:

| Table | Naming column |
| --- | --- |
| Track | Name |
| Album | Title |
| Artist | Name |
| Genre | Name |

1. Filter Track to `Evil Walks` and select TrackId 10.
2. Follow `AlbumId=1` to Album 1, “For Those About To Rock We Salute You”.
3. Follow the album’s `ArtistId=1` to Artist 1, AC/DC.
4. Filter Track to `Inject The Venom` and select TrackId 8. Follow its `AlbumId=1` to the existing album.
5. Revisit each track and follow its `GenreId=1` to Genre 1, Rock.

This gives exactly five records and five displayed references. Neither a group
expansion nor inferred links are needed. Other declared references remain undrawn.

### Canvas

Close Tables and the Reader. Arrange the album above the tracks and Rock below
them, with the tracks on opposite sides and AC/DC on a separate branch to the
right of the album. The captured arrangement has no overlapping records or
crossing connections. Rock is selected and the album hovered, exposing all five
connection names through the existing attention behavior.

The full album title is shortened inside its disc. Its complete name appears in
the README caption; the screenshot itself has not been relabeled.

### Table and Reader

Open Track, filter to `Evil Walks` and select TrackId 10. Keep both panels open,
with the recorded values and dotted foreign-key controls visible in the Reader.
Reframe the same record canvas using its own pan and zoom controls.

### Schema

Enter `schema`, enable `names` in its filter, and keep the table catalogue open.
Frame all 11 tables and 11 declared foreign keys. The image retains the schema’s
fixed ring, its crossing lines and small relationship captions. The README links
to the full-resolution original instead of enlarging or replacing those labels.

## Original PNGs

These files are byte-identical to the owner-reviewed captures:

| File | Pixels | SHA-256 |
| --- | --- | --- |
| [canvas.png](images/readme/canvas.png) | 1440 × 900 | `d7b7a9deb18a32dd386cc83c2841707cc4641a883bed4f540b90c0419ef98376` |
| [table-reader.png](images/readme/table-reader.png) | 1440 × 900 | `4d4f59d022524e34f7c2e264ff40a07894ba8494aed5a2fa93b331dd4f815896` |
| [schema.png](images/readme/schema.png) | 1440 × 900 | `4f38d1fccb635fdc405147052c1a8db45af0a2101424e9af1ba754e52eda93df` |
