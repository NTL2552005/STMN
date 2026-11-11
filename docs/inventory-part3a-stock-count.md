# Inventory Part 3A: stock counts

## FE-to-backend mapping

| FE behavior | Rule | State | JavaScript service | API | SQLite models |
|---|---|---|---|---|---|
| Create a count | Warehouse staff or store owner; select a location and count date; count each shown confirmed receipt lot | `Nháp` | `createCount()` | `POST /api/inventory/stock-counts/` | `inventory_stockcount`, `inventory_stockcountline` |
| Snapshot book quantity and record actual quantity | Book quantity must still match live stock; actual is a non-negative safe integer; difference is actual minus book | `Nháp` | `createCount()` | Create endpoint | `StockCountLine` joined to `StockBalance` and `GoodsReceiptLine` |
| Submit for approval | Draft only and at least one detail line | `Nháp` → `Chờ duyệt` | `submitCount()` | `POST /api/inventory/stock-counts/{PKK_Ma}/submit/` | `StockCount.status` |
| Approve and adjust stock | Store owner only; revalidate snapshot; apply each nonzero difference once | `Chờ duyệt` → `Đã duyệt` | `approveCount()` | `POST /api/inventory/stock-counts/{PKK_Ma}/approve/` | `StockBalance`, `StockMovement`, `StockCount` |
| View counts and details | Authenticated read; list filters by location, status, date range and search | All states | Render/list view | `GET /api/inventory/stock-counts/`, `GET /api/inventory/stock-counts/{PKK_Ma}/` | Count and line tables |

FE has no edit or cancel action for stock counts. Those endpoints are therefore
not exposed. Its statuses are exactly `Nháp`, `Chờ duyệt`, and `Đã duyệt`.
The creator is recorded from the authenticated Accounts employee, not from
frontend role or employee claims. Submission is permitted to warehouse staff
or the store owner; approval is limited to the store owner (and Django admin
accounts).

## Snapshot, lot identity, and adjustments

Each detail is keyed by an existing `PNCT_Ma`, which identifies the inbound
lot. The API only accepts receipt lines whose receipt is confirmed. It reads
the current `StockBalance` for the requested location and lot and compares it
with `PKKCT_SLSoSach` submitted by the FE; the client value is never used as
the authoritative snapshot. `PKKCT_ChenhLech` is stored as
`PKKCT_SLThucTe - PKKCT_SLSoSach`.

The FE supplies its confirmed receipt-line rows, including rows with zero
stock at the selected location. A surplus can therefore be applied to an
identified existing lot even when its location balance is zero. A count cannot
invent a lot or refer to an unknown/unconfirmed `PNCT_Ma`.

Creation, submission, and approval share Inventory's SQLite mutation lock and
transaction pattern. Before submitting and again before approving, the service
checks the current balance against the snapshot and rejects later lot
movements (including same-day movements). A stale count must be recounted; it
is never applied over newer stock. Approval updates balances, writes signed
`Điều chỉnh kiểm kê` movement rows with source `PhieuKiemKeKho` and the count
code, and marks the count approved in one transaction. Zero differences do not
create fake movement rows. Negative differences cannot make the balance
negative because the target is the non-negative physical count.

The shared `StockMovement` ledger is now signed for inbound and count
adjustments. Existing inbound uniqueness remains; an additional database
constraint prevents duplicate adjustment movements for the same count, lot,
and location. No other movement type or stock mutation is added by this phase.
Stock, expiry, overview, movement, ledger, and read-only Sales availability
services read the updated `StockBalance` and count movements directly.

## API contract

All endpoints require Accounts authentication.

| Method | URL | Permission | Purpose |
|---|---|---|---|
| GET | `/api/inventory/stock-counts/` | Authenticated | Paginated list; optional `DD_Ma`, `status`/`PKK_TrangThai`, `from`, `to`, `search`/`q` |
| POST | `/api/inventory/stock-counts/` | Warehouse staff or owner | Create a draft |
| GET | `/api/inventory/stock-counts/{PKK_Ma}/` | Authenticated | Count and details |
| POST | `/api/inventory/stock-counts/{PKK_Ma}/submit/` | Warehouse staff or owner | Submit a draft |
| POST | `/api/inventory/stock-counts/{PKK_Ma}/approve/` | Store owner | Apply adjustments and approve |

Create payload:

```json
{
  "DD_Ma": "DD0001",
  "NV_Ma": "NV0001",
  "PKK_Ngay": "2026-11-10",
  "PKK_GhiChu": "Kiểm kê định kỳ",
  "lines": [
    {
      "PNCT_Ma": "PNCT0001",
      "PKKCT_SLSoSach": 12,
      "PKKCT_SLThucTe": 10,
      "PKKCT_LyDo": "Thiếu hàng"
    }
  ]
}
```

`NV_Ma` is optional but, when supplied, must match the authenticated
employee. The response includes `PKK_Ma`, location, creator, approver, date,
status, note, and detail rows with product, lot, book quantity, actual
quantity, difference, reason, and expiry date. `PATCH`, `DELETE`, and a cancel
action are not available because FE does not define them.

## Limits

No supplier return, transfer, sales issue, inventory valuation, or other
Inventory Part 3 workflow is included. Accounting is unchanged. Current
Sales-facing `get_stock_for_sale()` remains a read-only query; it does not
reserve or deduct stock.
