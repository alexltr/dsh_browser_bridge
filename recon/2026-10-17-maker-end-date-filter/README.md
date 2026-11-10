# Recon: filter a grid by "Maker End Date"

Captured 2026-10-17 on `deltabogart-prod.centricsoftware.com`, tab
`Home > Job Requests` (`Tab=StyleSupplierRequests`), build `C8_7_3_03APR2022`
lineage (2026-10 prod). Bridge: `dsh-browser-bridge`, extension v0.2.0.

## Question

> On Job Requests, when I set a date (single day or range) in the "Maker End Date"
> column filter, which request carries it, and what is the smallest body?

Answer: **no new endpoint** — it is the grid's normal `QueryByXML`, with two
`<Attribute>` elements appended to `Qry.XML`.

## Environment

- Tab: Home > Job Requests — `.../home.html#...&Tab=StyleSupplierRequests`
- View: `04. Marker View` (the view's own filters stay in `Qry.XML`)
- Auth: DSH bridge on an already-logged-in Edge tab

## State before → after

| | Before | After |
| --- | --- | --- |
| Maker End Date filter | `All` | `15/Oct/2026` |
| Rows | unfiltered | 50 refs returned (1 day) |
| URL / view | unchanged | unchanged |

Side effects: the grid filter only (not saved to the View). Restored to `All`
and verified by re-reading the cell text.

## Requests

| # | Operation | Method / path | Why it matters |
| --- | --- | --- | --- |
| 01 | `QueryByXML` | `POST /csi-requesthandler/RequestHandler` | intent: the grid query with the date conditions |

## Minimal call

```http
POST /csi-requesthandler/RequestHandler
Content-Type: multipart/form-data; boundary=…

Module=Search
Operation=QueryByXML
URL=centric://APPAREL/Views
OutputJSON=1
Fmt.Complete=Ref
Qry.Limit.Begin=1
Qry.Limit.End=20
Qry.XML=…
```

The date filter is these two lines inside `Qry.XML` (single day, 2026-10-15):

```xml
<Attribute Id="bogroutineseq9acd" Op="GE" DValue="1791993600000"/>
<Attribute Id="bogroutineseq9acd" Op="LE" DValue="1792079999000"/>
```

- `bogroutineseq9acd` = the column's field id, read from
  `data-csi-automation="filter-ApparelViews-StyleSupplierRequests-bogroutineseq9acd"`.
- `DValue` = **epoch ms in the user's local zone** (UTC+8 here):
  `GE` = 2026-10-15 00:00, `LE` = 2026-10-15 23:59:59.
- Range = different dates in the two conditions. One-sided = keep only `GE` or
  only `LE`. Single day = same date in both.

The other conditions in `Qry.XML` come from the saved View (`Marker` route,
`State` issued/complete, `bogjobreqcd > …`), not from the date filter.

## Verification

- Triggered from the real UI (filter cell → menu → `Custom` → dates → blur).
- Response: `HTTP 200`, `({Status:"Successful", CompleteResultRefs:{ref:[…50 ids…]},
  NODES:{ResultNode:[…]}})`, **45.1 s** server time.
- Sample row: `bogroutineseq9acd: 1792056600` = 2026-10-15 17:30 UTC+8, inside the
  requested day.

## Open questions

- Why does a single-day filter take 45 s? `pirequestextime: 43909` points at the
  server-side query, not the network. Likely the child-path condition.
- `Qry.Limit.Filter=10000` is still unexplained (`centric-plm-api` §2 marks it
  `[?]`).

## Files

- `requests.http` — curl, sanitized
- `captures/01-single-date.json` — parsed request fields + `Qry.XML`
- `captures/02-range.json` — the two-date variant
- `responses/01-single-date.txt` — trimmed response
- `notes.md` — how the UI commits, and what went wrong
