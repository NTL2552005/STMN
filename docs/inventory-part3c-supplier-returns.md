# Inventory Part 3C: supplier returns

Base URL: `/api/inventory/`. All endpoints require an authenticated Accounts
token. The workflow preserves the FE states and does not create accounting
records.

## FE flow and backend mapping

| FE behavior | JS service | Business rule | State transition | API | SQLite model |
|---|---|---|---|---|---|
| Create/save a return draft | `saveSupplierReturn` | Warehouse employee or owner; supplier role must be Supplier/Both; receipt must be confirmed and belong to that supplier; source location must be active; duplicate receipt lines are rejected | `Nháp` | `POST /supplier-returns/` | `inventory_supplierreturn`, `inventory_supplierreturnline` |
| Edit/delete draft | `saveSupplierReturn`, `deleteDraftSupplierReturn` | Draft only; edit recalculates quantity and purchase-cost totals | `Nháp` | `PATCH` / `DELETE /supplier-returns/{TRNCC_Ma}/` | Same |
| Submit for owner review | `submitSupplierReturn` | Revalidates source lot and current available quantity; does not reserve stock | `Nháp` → `Chờ duyệt` | `POST /supplier-returns/{TRNCC_Ma}/submit/` | Same |
| Approve/reject | `approveSupplierReturn`, `rejectSupplierReturn` | Owner/admin only; approval revalidates; neither action changes stock | `Chờ duyệt` → `Đã duyệt` or `Từ chối` | `POST .../approve/`, `POST .../reject/` | Same |
| Cancel | `cancelSupplierReturn` | Warehouse employee or owner; allowed from Nháp, Chờ duyệt, or Đã duyệt only | → `Đã hủy` | `POST .../cancel/` | Same |
| Confirm physical shipment to supplier | `confirmSupplierReturn` | Warehouse employee or owner; approved only; current stock and returnable source quantity are rechecked transactionally | `Đã duyệt` → `Đã xuất trả` | `POST .../confirm/` | Return models, `inventory_stockbalance`, `inventory_stockmovement` |
| List/detail and owner review page | `getSupplierReturns` | Any authenticated user may read; optional filters include supplier, receipt, location, state, date, and search | All states | `GET /supplier-returns/`, `GET /supplier-returns/{TRNCC_Ma}/` | Return models |

`Nháp`, `Chờ duyệt`, `Đã duyệt`, `Từ chối`, `Đã xuất trả`, and `Đã hủy` are
the FE states. The owner page has no accounting-confirmation action. FE labels
the return value as informational and explicitly states that it does not
automatically adjust supplier debt.

## Validation and stock behavior

- Supplier eligibility follows FE: role Supplier or Both; inactive suppliers
  remain selectable. The source receipt must be confirmed and belong to that
  supplier.
- A return line refers to the original `GoodsReceiptLine.code` (`PNCT_Ma`).
  There is no separate lot table. Product, manufacture/expiry data, and unit
  purchase price are read from the original receipt line.
- FE chooses one receipt for a return document. Each line must belong to that
  receipt, and a receipt line can appear only once per return.
- Unit return price is the original receipt line's base-unit price.
  `TRNCC_TTien = TRNCC_SL × PNCT_DonGia`; totals use integer VND, never floats.
  Client-submitted price/amount values are not used.
- Returnable quantity per lot is the lesser of (a) original receipt quantity
  minus quantities in already shipped returns and (b) current balance at the
  selected source location. The selected location may differ from the original
  receipt location if that same `PNCT_Ma` has been transferred there.
- Draft, pending, and approved returns do not reserve stock. Availability is
  revalidated at submission, approval, and shipment. Expiry is not a return
  restriction in FE; expired inventory can be returned if it is physically
  present.
- Only `confirm` decreases stock. It conditionally decrements each matching
  location/receipt-line balance, writes a negative `Trả NCC` movement with
  source `TraHangNCC` and the return code, then changes status, all in one
  transaction. Failure rolls back every balance, movement, and status change.
- A SQLite mutation lock serializes Inventory writes; conditional balance
  updates and a database uniqueness constraint also prevent overselling or
  duplicate return movements. `select_for_update()` is not relied on.

The existing `/stock/`, `/movements/`, `/stock-ledger/`, `/expiry/`, and
`/overview/` APIs read the updated balance/movement rows. The existing
`get_available_stock()` and `get_stock_for_sale()` read the updated
`StockBalance`; return confirmation does not alter receipt history.

## API payload

Create a draft with FE-style fields:

```json
{
  "DT_Ma": "DT0001",
  "PN_Ma": "PN0001",
  "DD_Ma": "DD0001",
  "TRNCC_Ngay": "2026-11-10",
  "TRNCC_LyDo": "Hàng hư hỏng",
  "TRNCC_GhiChu": "",
  "lines": [
    {
      "PNCT_Ma": "PNCT0001",
      "TRNCC_SL": 2,
      "TRNCC_SLNhap": 2,
      "TRNCC_HeSo": 1,
      "TRNCC_LyDoChiTiet": "Hàng hư hỏng"
    }
  ]
}
```

`TRNCC_SL` is canonical base quantity. If the FE supplies entered quantity and
conversion factor, the backend verifies the conversion and that the factor is
1 or the Catalog package ratio. Response data uses FE field names and includes
`TRNCC_TongSL`, `TRNCC_TongTien`, actor/timestamp fields, and `lines`.

## Accounting integration boundary

`apps.inventory.services` exposes:

- `get_supplier_return(code)` for the document and its prefetched lines.
- `get_supplier_return_lines(code)` for the return detail rows.
- `get_supplier_return_total(code)` for informational purchase-cost value.
- `SupplierReturn.Status` and `get_supplier_return(code).status` for state.
- `confirm_supplier_return(code, confirmed_by=user)` for the stock-only
  shipment step. It is transaction-compatible: an Accounting caller can invoke
  it inside an outer `transaction.atomic()` and let any later accounting error
  propagate to roll back both operations.

No Accounts payable, supplier refund, or payment model is written here. The FE
does not define financial adjustment or accounting approval at this step, so
the API intentionally does not claim that a return settles supplier debt.
Developer 2 must agree on and implement that separate financial treatment
before the return value is used as an accounting posting.
