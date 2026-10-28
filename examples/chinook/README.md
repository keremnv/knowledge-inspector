# Chinook: what the database stores, and one reader's interpretation of it

Two demonstrations over the same real, independently published SQLite file:

| | Structural room — `/sqlite` | Conceptual room — `/` |
|---|---|---|
| Adapter | `adapters/sqlite/server.py` | `adapters/world/server.py` + `declaration.json` |
| Shows | Tables, views, columns, declared keys, foreign keys and paged rows, exactly as stored | Three relations a **reader** chose to name, over records the file already holds |
| Reads the file | By reference, opened read-only on every request | Once, at startup, into a private read-only snapshot |
| Meaning | None added: no entity, relation or status is inferred | The reader's declaration, attributed as such in the UI and API |

The database's author wrote neither declaration in this directory. Serving one does not make it true; it makes a reading inspectable against the rows it reads.

## Dataset and licence

The data is the **Chinook Database**, v1.4.5:
- Project: <https://github.com/lerocha/chinook-database>
- Release: <https://github.com/lerocha/chinook-database/releases/tag/v1.4.5>
- Asset: `Chinook_Sqlite.sqlite`, 1,067,008 bytes.
- SHA-256, measured on download (not taken from upstream): `bdf635be69850bd3be09c9a2dbeef7ddfb80036bd3ef3381383cd03b61e4a61a`.
- Inspected with SQLite 3.51.1 (Python `sqlite3`).

Nothing from the dataset is committed here. `prepare.py` downloads the pinned asset, or verifies a copy you already have.

> Chinook Database — Copyright (c) 2008-2024 Luis Rocha
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## What the file contains

These facts were read from the artifact, not from documentation:
- **Objects:** 11 tables and **no views**. Upstream Chinook defines none; the view used later in this demo is added to a separate copy.
- **Rows:**

  | Table | Rows | Table | Rows |
  |---|---|---|---|
  | Album | 347 | InvoiceLine | 2,240 |
  | Artist | 275 | MediaType | 5 |
  | Customer | 59 | Playlist | 18 |
  | Employee | 8 | PlaylistTrack | 8,715 |
  | Genre | 25 | Track | 3,503 |
  | Invoice | 412 | | |

- **Primary keys:** each table has a single integer key, except `PlaylistTrack`, whose key is the composite `(PlaylistId, TrackId)`.
- **Foreign keys:**
  - `Album.ArtistId → Artist`
  - `Track.AlbumId → Album`, `Track.MediaTypeId → MediaType`, `Track.GenreId → Genre`
  - `InvoiceLine.InvoiceId → Invoice`, `InvoiceLine.TrackId → Track`
  - `Invoice.CustomerId → Customer`
  - `Customer.SupportRepId → Employee`, `Employee.ReportsTo → Employee`
  - `PlaylistTrack.PlaylistId → Playlist`, `PlaylistTrack.TrackId → Track`
  - None of these references is orphaned.
- **Values worth watching:**
  - `Track.Composer` is null in 978 rows.
  - Prices (`NUMERIC(10,2)`) are stored as SQLite REAL, for example `0.99`.
  - Every `InvoiceLine.Quantity` is `1`.
  - Names keep their spelling, for example `Antônio Carlos Jobim`.
  - 199 track names repeat, so a name is a label and never an identity.

## Prepare and verify

From the repository root, with Python 3 and Node (`npm ci` done once):

```bash
python3 examples/chinook/prepare.py                 # download v1.4.5, verify SHA-256
# or, offline, with a copy you already have:
python3 examples/chinook/prepare.py --from ~/Downloads/Chinook_Sqlite.sqlite

python3 examples/chinook/prepare.py --view-copy     # optional: the view working copy
python3 examples/chinook/prepare.py --verify        # any time: hash, size, mtime, sidecars
```

- Files land in `examples/chinook/data/`, which is gitignored.
- A file whose SHA-256 is not the pinned one is refused.
- The prepared upstream file is made read-only on disk (mode 0444). `--from` only reads your file: it is verified, then copied byte-for-byte.
- `--verify` prints the SHA-256, size, modification time (ns) and any `-journal`, `-wal` or `-shm` sidecars. Run it before and after a demo; both must be identical.

## Run

```bash
python3 examples/chinook/run.py            # upstream file: both rooms
python3 examples/chinook/run.py --view     # the view copy and its reading (after --view-copy)
```

This starts three processes, and Ctrl-C stops all of them:
- the structural adapter on `127.0.0.1:8149`;
- the conceptual adapter on `127.0.0.1:8139`;
- Vite on `127.0.0.1:5173`, with `/sqlite/*` proxied to 8149 and `/world/*` to 8139.

If a port is already taken, choose others with `--structural-port` and `--world-port`.

Then open:
- **Structure:** <http://127.0.0.1:5173/sqlite>
- **Reading:** <http://127.0.0.1:5173/>

The same, by hand, in three terminals:

```bash
python3 adapters/sqlite/server.py --db examples/chinook/data/Chinook_Sqlite.sqlite --port 8149
python3 adapters/world/server.py --db examples/chinook/data/Chinook_Sqlite.sqlite \
  --declaration examples/chinook/declaration.json --port 8139
VITE_SQLITE_TARGET=http://127.0.0.1:8149 VITE_WORLD_TARGET=http://127.0.0.1:8139 npm run dev
```

**The two adapters read the file differently, on purpose.**
- **Structural adapter.** It opens the file read-only for every request, so it always shows the file as it is now. The SHA-256 in its header was taken once, at startup.
- **Conceptual adapter.** It copies the file once at startup, using SQLite's online backup from a read-only connection, into a private temporary snapshot, then validates and serves only that snapshot. Its World id, `chinook:<snapshot-fingerprint>+<declaration-digest>`, names that snapshot and that declaration. The first half is a fingerprint of the snapshot, so it is **not** the file's SHA-256 prefix (see `docs/SNAPSHOT_CONSISTENCY.md`). Restarting re-reads the file.

## Demo A — the structural room

Open `/sqlite`. Expected:

1. **Header:** `Chinook_Sqlite.sqlite`, `SHA-256 bdf635be6985…`, `11 tables · 0 views`. Album opens first: primary key `AlbumId`, foreign key `ArtistId → Artist (ArtistId)`, and "Record keys verified for structural navigation. Row order: declared key."
2. **Track:** three foreign keys (`MediaTypeId`, `GenreId`, `AlbumId`). Row 2, *Balls to the Wall*, shows `Composer` as `NULL`, and `UnitPrice` `0.99`, as stored.
3. **PlaylistTrack** (the joining table): primary key `PlaylistId + TrackId`, verified, so its rows page in key order: `1–50 of 8715`.
4. **InvoiceLine:** two foreign keys. **Next** shows `51–100 of 2240`.
5. **A foreign-key link,** such as `TrackId → Track (TrackId)`, opens the **table** at its first row. Its tooltip says so: "table-level; does not follow to the referenced record".

Column types (`NVARCHAR(160)`, `NUMERIC(10,2)`, …) are served by `GET /sqlite/schema` but not displayed on the structural page. The reading's relation reader prints each scalar role's declared type with SQLite's affinity for it, for example `declared NUMERIC(10,2) · numeric affinity`; neither says what a given row holds (prices here are stored as REAL). To see the structural types:

```bash
curl -s http://127.0.0.1:5173/sqlite/schema | python3 -m json.tool | less
curl -s "http://127.0.0.1:5173/sqlite/rows?table=Track&limit=2&offset=1"
```

## Demo B — the reader's interpretation

`declaration.json` is a version-1 external declaration, validated by the unchanged generic adapter.

**Four entity kinds,** each keyed by its table's verified primary key:

| Kind | Source | Key | Label column |
|---|---|---|---|
| `artist` | `Artist` | `ArtistId` | `Name`, declared by the reader |
| `album` | `Album` | `AlbumId` | `Title`, declared by the reader |
| `track` | `Track` | `TrackId` | `Name`, declared by the reader |
| `invoice` | `Invoice` | `InvoiceId` | none declared: the adapter's default (the first key column) stands in. The reading descriptor says so (`label_column_source: "adapter_default"`) |

**Three relations,** each over a foreign key the file declares:

| Relation | Source (key) | Roles |
|---|---|---|
| `album_listed_under_artist` | `Album` (`AlbumId`) | `album`, `artist` |
| `track_on_album` | `Track` (`TrackId`) | `track`, `album`, plus scalars `composer`, `milliseconds`, `unit_price` |
| `invoice_line_track` | `InvoiceLine` (`InvoiceLineId`) | `invoice`, `track`, plus scalars `unit_price`, `quantity` |

Each description says what the rows support and what they do not. In particular, an invoice line is not described as payment, delivery, ownership or endorsement. **No origin, occurrence state, completeness or governance is declared,** and none is shown.

Open `/`:

1. **Header:** `chinook:c5dd7d78cbcc+06e00058e119`, with no revision: revision 1 is the generic adapter's default, which this verified reading does not print as if the database had recorded it (the API still reports it, and the "Adapter compatibility values" note says so). The vocabulary graph shows the four kinds and three relations.
2. **Expand "Reading attribution"** in the table dock. It shows:
   - "This World is a reading through an external reader declaration";
   - the declaration digest `06e00058e119869b92667a6c8526b00ed2daaec3cae5a605062f88d7c3a7d4f5`;
   - the reader's note, verbatim;
   - "Structural checks establish source addressability, not semantic correctness, human authorship or producer endorsement".
3. **Open `track_on_album`** (3,503 rows) and click the row whose first cell is `10`. The reader shows:
   - roles: track *Evil Walks*, album *For Those About To Rock We Salute You*, composer *Angus Young, Malcolm Young, Brian Johnson*, milliseconds `263497`, unit_price `0.99`;
   - **grounded by** SQLite, `row TrackId=10 in Track`;
   - `origins · unstated`, and no status chip.
   The catalogue dock says "Reading attribution · reader-declared interpretation" before anything is opened, and each reader panel repeats "Reader-declared interpretation" once. It says only what the descriptor establishes.
4. **Expand "Relation reading attribution"** in the reader. It shows each declared role mapped to its source column, the reader's description, "No construction origin declared.", "No occurrence state declared." and the digest.
5. **Click the album** to travel to `album:1`. The album's own source row is `row AlbumId=1 in Album`. Under "occurrences mentioning this referent", `track_on_album` lists ten occurrences (`track_on_album:1`, `:6` … `:14`), each with its own composer, milliseconds and unit_price. Those values are stated by each occurrence, not recorded as properties of the album, and each id opens its occurrence. Under "expand through", `track_on_album 10` places the ten tracks on the field; `invoice_line_track` is not offered, because no recorded occurrence in this reading mentions the album.

Under "Source metadata", SOURCE grounding names the stored row (`Track:TrackId=10`, key `{"TrackId": 10}`) and the raw reference values with their SQLite storage class. It cites the SQLite record; the declaration is not a source.

The same through the API:

```bash
curl -s http://127.0.0.1:5173/world/overview | python3 -m json.tool          # .reading
curl -s "http://127.0.0.1:5173/world/assertion?id=track_on_album:10" | python3 -m json.tool
sqlite3 -readonly examples/chinook/data/Chinook_Sqlite.sqlite "SELECT * FROM Track WHERE TrackId = 10"
```

## Optional — a SQL view, in a copy

`views/invoice_line_customer.sql` is a view written for this demo, reviewed as source text:
- **What it does:** an inner join of each `InvoiceLine` to its `Invoice` on the declared foreign key, exposing the invoice's recorded `CustomerId` beside the line's references.
- **What it doesn't do:** no filtering, no aggregation, no computed values.
- **Disclosure:** the statement itself carries "NOT part of upstream Chinook", so SQLite stores that disclosure with the view.

`prepare.py --view-copy` applies it to `data/Chinook_Sqlite.with-view.sqlite`, a separate file with its own SHA-256 (`58997c8b6c08…` with SQLite 3.51.1; measured, not guaranteed across SQLite versions). It then re-checks that the upstream file is unchanged. **The copy is not the upstream artifact,** and its World id differs.

`declaration-view.json` reads the view as `invoice_line_with_recorded_customer`:
- **Roles:** invoice, customer, track, unit_price, quantity.
- **Key:** `InvoiceLineId`, unique in the view's 2,240 rows.
- **Validation:** the unchanged adapter validated the key and every reference.

With `run.py --view`:
- **Structural room:** 11 tables and 1 view. The view is "SQL VIEW … Table-only records: no durable per-row identity is inferred". Views get no row identity there.
- **Conceptual room:** for line 1, grounding reads "output of view InvoiceLineCustomer for InvoiceLineId=1 — defined, not stored". "Source metadata" shows the full SQL definition, including the disclosure, and "lineage (source-reported): not recorded". The adapter cites the definition; it does not claim a certified lineage to the joined rows.

## Tests

```bash
python3 examples/chinook/test_chinook.py                      # 19 backend checks, real adapters
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome \
  npx playwright test tests/chinook-live.spec.ts              # both rooms, real browser
```

- Both suites skip unless `prepare.py --view-copy` has run.
- Both check that the prepared files' SHA-256, modification time and sidecar set are unchanged after the adapters have read them.
- `KI_CHINOOK_SHOTS=<dir>` makes the browser spec save its walkthrough screenshots.

## Files

- `prepare.py`: pinned download or local verification, `--verify`, `--view-copy`.
- `run.py`: both adapters and Vite, with one Ctrl-C.
- `declaration.json`: the reader's reading of the upstream file.
- `declaration-view.json` and `views/invoice_line_customer.sql`: the view variant.
- `test_chinook.py`: backend checks.
- `data/`: prepared files (gitignored).
