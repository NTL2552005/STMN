# Inventory Part 3B: internal stock transfers

## FE-to-backend mapping

| FE | JavaScript service | Rule | State | API | SQLite model |
|---|---|---|---|---|---|
| Create transfer | `createTransfer()` | Accountant or store owner; active, distinct source/destination locations; active product, confirmed receipt lot, unexpired HSD, positive quantity within source balance; no duplicate `PNCT_Ma` | `Chờ xuất` | `POST /api/inventory/transfers/` | `StockTransfer`, `StockTransferLine` |
| Confirm dispatch | `dispatchTransfer()` | Warehouse staff or store owner; revalidate each lot and atomically deduct sent quantity at source | `Chờ xuất` → `Đang chuyển` | `POST /api/inventory/transfers/{PXCN_Ma}/dispatch/` | Transfer models, `StockBalance`, `StockMovement` |
| Confirm receipt | `receiveTransfer()` | Sales staff or store owner; actual quantity for each line is an integer from zero through sent quantity; credit actual quantities at destination by the same lot | `Đang chuyển` → `Hoàn tất` if all received, otherwise `Chờ đối chiếu` | `POST /api/inventory/transfers/{PXCN_Ma}/receive/` | Transfer models, `StockBalance`, `StockMovement` |
| List and view | Render transfer register/detail | Authenticated reads, filters by location, status, date range and search | All statuses | `GET /api/inventory/transfers/`, `GET /api/inventory/transfers/{PXCN_Ma}/` | Transfer models |

`Chờ nhận` in the FE is a display tab/filter label; the persisted status is
`Đang chuyển`. The lifecycle states are exactly `Chờ xuất`, `Đang chuyển`,
`Hoàn tất`, and `Chờ đối chiếu`. FE has no edit or cancel action, so neither
API action is exposed.

## Inventory behavior

Creating a transfer does not reserve or deduct stock. Dispatch rechecks current
stock and reduces the source by the full sent quantity. The transfer remains
in transit and no destination stock is added until a store employee confirms
the actual receipt. Receiving adds the confirmed quantity using the same
`PNCT_Ma`, preserving the existing lot's receipt, product, manufacturing
date, and expiry date. No new lot is created.

If fewer units arrive than dispatched, the transfer becomes `Chờ đối chiếu`.
Only the actually received units are added at the destination; the difference
is left unresolved, as in FE, and is not automatically restored to the source
or credited to the destination. A zero receipt creates no destination balance
or fake movement. Full transfer conserves total physical stock across the two
locations.

FE only allows transfer lots whose product is active and whose HSD is today
or later (or absent). The backend applies that rule at creation and again at
dispatch. This is the transfer-specific FE rule; expired goods are not sent
for sale. Receipt confirmation does not reapply the dispatch expiry check:
the FE receive step accepts quantities for an already dispatched transfer.

Both dispatch and receipt use the shared Inventory SQLite mutation lock and a
database transaction. Source deduction is a conditional update requiring
`quantity >= quantity sent`; every updated row is checked. Destination
balances are incremented with a safe-quantity bound. Movements and state
changes are in the same transaction. Database uniqueness prevents duplicate
outbound/inbound movement rows for the same document, location, lot, and
movement type.

Movement types are `Xuất chuyển nội bộ` (negative at source) and `Nhận chuyển
nội bộ` (positive at destination), with source `PhieuXuatChuyenNoiBo` and the
transfer code as document reference. Existing `/stock/`, `/movements/`,
`/stock-ledger/`, `/expiry/`, `/overview/`, `get_available_stock()`, and
`get_stock_for_sale()` read the updated `StockBalance` and `StockMovement`
records.

## API contract

All endpoints require Accounts authentication.

| Method | URL | Permission | Purpose |
|---|---|---|---|
| GET | `/api/inventory/transfers/` | Authenticated | Paginated list |
| GET | `/api/inventory/transfers/{PXCN_Ma}/` | Authenticated | Header and lines |
| POST | `/api/inventory/transfers/` | Accountant or store owner | Create `Chờ xuất` transfer |
| POST | `/api/inventory/transfers/{PXCN_Ma}/dispatch/` | Warehouse staff or store owner | Deduct source inventory and start transit |
| POST | `/api/inventory/transfers/{PXCN_Ma}/receive/` | Sales staff or store owner | Record actual destination receipt |

List filters: `DD_Xuat` (or `DD_Ma`), `DD_Nhan`, `status` (or
`PXCN_TrangThai`), `from`, `to`, `search`/`q`.

Create payload:

```json
{
  "DD_Xuat": "DD0001",
  "DD_Nhan": "DD0002",
  "NV_Ma": "NV0002",
  "PXCN_Ngay": "2026-11-10",
  "PXCN_NguoiNhan": "Nhân viên cửa hàng",
  "lines": [
    {"PNCT_Ma": "PNCT0001", "PXCN_SL": 5}
  ]
}
```

`NV_Ma`, when supplied, must match the authenticated employee. Receive payload:

```json
{
  "PXCN_NguoiNhan": "Nhân viên cửa hàng",
  "lines": [
    {"PNCT_Ma": "PNCT0001", "PXCN_SLThucNhan": 4}
  ]
}
```

Receive requires exactly one row for every transfer lot. The actor is recorded
from the authenticated account; frontend role or employee claims do not grant
permission.

## Scope and known limitations

This phase implements transfers only. It does not implement standalone
consumption, supplier returns, sales issue, inventory reservation, discrepancy
resolution, transfer cancellation, or editing. FE leaves the `Chờ đối chiếu`
case unresolved; any follow-up process requires a separate business contract.
Stock received at a destination is immediately eligible according to the
existing product status and expiry rules.
