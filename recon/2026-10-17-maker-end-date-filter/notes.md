# Notes — what worked, what didn't

## Finding the column's field id

The filter row is `tr.csi-table-filters`, one cell per column. Each cell holds a
`dijitDropDownButton` with
`data-csi-automation="filter-ApparelViews-StyleSupplierRequests-<field>"`.
The column header text is useless for the id — read the automation attribute.

Mapping was confirmed by x-position, not by guessing:

| Header (x, w) | Filter cell (x, w) | Field |
| --- | --- | --- |
| Maker Due Date (1114, 110) | 18 (1114, 110) | `bogroutineseq9add` |
| Maker File Received Date (1224, 142) | 19 (1224, 142) | `bogroutineseq9afrd` |
| **Maker End Date (1366, 144)** | **20 (1366, 144)** | **`bogroutineseq9acd`** |

Suffix reading matches: `dd` due, `frd` file received, `cd` completion/end.

## Applying the filter

Path: click the cell → menu → `Custom` → `.csi-date-range-popup` with two
`dijitDateTextBox` (`uniqName_15_4/5`, pattern `dd/MMM/yyyy`) → type dates.

Two problems, both reproducible:

1. **Enter does not reliably commit.** Typing both dates and pressing Enter left
   the cell reading `All` and sent nothing. `document.activeElement.blur()` (or a
   real click elsewhere) committed it and fired `QueryByXML`.
2. **Typing From before To throws**
   `TypeError: Cannot read properties of null (reading 'getMonth')`
   at `updateRange` / `_onChangeDateStart`. Non-fatal — the filter still applied
   once both were set — but it means the "to" date must exist when "from" changes.
   Set To first, then From, then blur.

After commit the cell shows `15/Oct/2026` (single day) or
`01/Oct/2026 - 17/Oct/2026` (range). That text is the cheapest apply signal —
read it before declaring success.

## Timing

The one-day query took **45 s** (`pirequestextime: 43909`). While in flight,
`page_network` showed `→ 0` with no body; the status appeared only after it
landed. Do not treat `0` as failure for this API.

## Restore

Cell → menu → `All` → blur. Verified by re-reading the cell (`All`) and by the
follow-up query returning 200 in 8.7 s.

## Mistakes made

- First attempt typed From → To; got the `getMonth` error and a range query that
  sat in "Suspend" for a long time. It still produced the right `Qry.XML`, which
  is how the encoding was first confirmed.
- Assumed Enter applied the filter; lost one cycle. The blur commit is the rule.
