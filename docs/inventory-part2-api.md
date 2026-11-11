# Inventory Part 2: stock, ledger, and expiry reads

Inventory Part 2 uses the Part 1 tables; it adds no model or migration. All
endpoints below require the Accounts token. Reads require authentication and
never modify stock or movement history.

## FE-to-backend mapping

| FE behavior | Rule | Source | Endpoint / model |
|---|---|---|---|
| Stock summary | Group by product and location; show base unit/package conversion, physical, sellable, expired and unavailable quantities | Confirmed receipt lots and `StockBalance` | `GET /stock/?view=summary`; `inventory_stockbalance` |
| Stock detail | One row per positive lot; include dates, location and quantity | `GoodsReceiptLine` plus confirmed `StockBalance` | `GET /stock/?view=detail` |
| Stock position | Physical is on-hand; sellable excludes expired lots and inactive products | Confirmed lot balances | `TK_SLThucTe`, `TK_SLCoTheBan`, `TK_SLKhongKhaDung` |
| Low stock | FE's low threshold is quantity <= 10; status shown separately from sellability | Physical quantity by item/location | `TK_TrangThai`; overview uses positive sellable stock <=10 |
| Expiry tracking | Lot-specific threshold, default 30 days; HSD today remains sellable and is within warning window | `PNCT_HSD`, `PNCT_HSDToiThieu`, balance | `GET /expiry/` |
| Movement history | Read-only, newest first; filters use location, product, lot, type, voucher and dates | Actual `StockMovement` rows | `GET /movements/` |
| Stock ledger | Product + location + inclusive local-date range; stable timestamp/id order; only assert balances if ledger reconciles | Movements and balances | `GET /stock-ledger/` |
| Warehouse overview | Count products/quantity with stock, low sellable products, soon/expired lots and draft receipts | Live confirmed stock and receipt data | `GET /overview/` |

No value is computed from browser mock data. Expiry is calculated against
`timezone.localdate()` in Django's configured timezone. A lot without HSD has
status `Không áp dụng HSD`, is not listed as expiring/expired, and remains
eligible for sale if its product is active and balance is positive. HSD equal
to today has zero days remaining, is `Sắp hết hạn` when the threshold permits,
and is sale-eligible through that date.

## Endpoints

Existing Part 1 reads are extended:

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/inventory/locations/` | List locations |
| GET | `/api/inventory/stock/` | Read grouped summary (default) or lot detail |
| GET | `/api/inventory/movements/` | Read actual stock movement history |
| GET | `/api/inventory/stock-ledger/` | Read a product/location period ledger |
| GET | `/api/inventory/expiry/` | Read positive stock by expiry state |
| GET | `/api/inventory/overview/` | Read supported live warehouse metrics |

### Stock filters and response

`/stock/` accepts:

- `view=summary|detail` (aliases: `mode`, default `summary`)
- `HH_Ma` or `item`, `DD_Ma` or `location`
- `DM_Ma` or `category`, `search`
- `status` matching `Sắp hết` or `Đang có tồn` in summary mode; detail mode
  also accepts the FE expiry states `Còn hạn`, `Sắp hết hạn`, `Đã hết hạn`,
  or `Không áp dụng HSD`

Both modes return DRF pagination (`count`, `next`, `previous`, `results`),
default 25 and maximum 100. Summary rows are one product/location pair and
include `TK_SL`/`TK_SLThucTe`, `TK_SLCoTheBan`, `TK_SLHetHan`,
`TK_SLKhongKhaDung`, `TK_SoLo`, category, barcode, unit, package unit/ratio,
and `TK_TrangThai`. Detail rows additionally include `PN_Ma`, `PNCT_Ma`,
manufacturing/expiry dates, expiry days/threshold/status, and per-lot
quantities.

Physical quantity is the confirmed `StockBalance`. Sellable quantity excludes
expired inventory and inactive products, but does not reserve stock for sales;
expiry alone never deletes or changes physical stock. Unavailable is physical
minus sellable. The low-stock badge on rows follows FE's physical quantity
threshold (<=10). The overview's low-stock metric counts products with
positive sellable stock <=10.

### Expiry filters and response

`/expiry/` accepts `status` or `expiry` with one of
`Sắp hết hạn`, `Đã hết hạn`, `Còn hạn`, `Không áp dụng HSD`; also `HH_Ma`/
`item`, `DD_Ma`/`location`, and `search`/`q`. Only positive balances from
confirmed receipts are listed. Results include `PNCT_Ma`, `PN_Ma`, product,
location, NSX/HSD, remaining days, applied warning threshold, status, physical
quantity and sellable quantity. It does not create disposal documents.

### Movement and ledger filters

`/movements/` accepts `DD_Ma`, `HH_Ma`, `PNCT_Ma`, `BDK_Loai`,
`BDK_MaChungTu`, `search`/`q`, `from`/`date_from`, and `to`/`date_to`.
Results are newest first with `BDK_Ma` as stable tie-breaker. Movement records
are read-only through HTTP; writes occur only inside the owning inventory
document services.

`/stock-ledger/` requires `HH_Ma`, `DD_Ma`, `from`, and `to`; optional
`PNCT_Ma` scopes to a lot. Dates are inclusive and use configured local time.
The response contains opening, inbound, outbound, closing and current
quantities, `complete`/`error`, and paginated `results`. Ledger rows are
chronological by timestamp then movement id. When current per-lot balances do
not reconcile to actual movement deltas, the API reports `complete=false` and
does not provide opening/closing balances. Confirmed inbound, approved
stock-count adjustment, internal transfer, and confirmed supplier-return
movements are recorded. Sales still requires its own document service before
claiming a complete enterprise stock ledger. Supplier returns are documented
in [Inventory Part 3C](./inventory-part3c-supplier-returns.md).

### Overview

`/overview/` accepts optional `DD_Ma` to scope the current stock/expiry metrics.
It returns `as_of`, scope, thresholds, `metrics`, up to five soon-expiring
lots, and up to six recent movements. Metrics include distinct products with
physical stock, total physical quantity, products with positive sellable
quantity <=10, soon-expiring lots, expired lots, and draft receipts. No
inventory monetary valuation is returned: FE does not specify a cost valuation
method, and an average/FIFO choice would be a new accounting rule.

## Sales service contract

`apps.inventory.services.get_stock_for_sale(product_code, location_code,
on_date=None)` is a **read-only availability query**. It returns lots ordered
FEFO (earliest expiry first; no-expiry lots last; `PNCT_Ma` tie-breaker), with
`PNCT_Ma`, product and location codes, source receipt, HSD, base-unit quantity,
and Catalog unit/package metadata. It returns no rows for an inactive product,
zero balance, non-confirmed receipt, or expiry earlier than `on_date`. HSD on
`on_date` is allowed.

`apps.inventory.services.get_available_stock(product_code, location_code,
on_date=None)` returns the sum of those eligible lot quantities. It is also
read-only and is not a reservation.

This function does not reserve or deduct stock. Sales must not treat a read as
a hold. A later sale operation must atomically re-read the lot balance, apply
its outbound movement and balance decrement, and handle competing sales in one
Inventory-owned transaction/service. No sale mutation endpoint is included in
this phase.

## Accounting boundary

Part 1 `confirm_goods_receipt()` remains transaction-compatible with an outer
Accounting transaction. This task does not modify Accounting or create payables. FE
currently combines receipt confirmation and payable creation, so the existing
confirmation endpoint is **not ready for production FE wiring** until
Accounting coordinates its payable write in the same outer transaction and
rolls back both sides on failure.

## Scope and known data gap

This database starts with the Part 1 schema and does not import FE's
localStorage examples or historical stock. Existing confirmed receipts without
the corresponding balance/movement are reported as an incomplete ledger rather
than repaired or guessed. Sales and its movements are not implemented here.
Supplier returns are documented in
[Inventory Part 3C](./inventory-part3c-supplier-returns.md). Stock-count and internal-transfer workflows are
documented in [inventory-part3a-stock-count.md](./inventory-part3a-stock-count.md)
and [inventory-part3b-internal-transfers.md](./inventory-part3b-internal-transfers.md).
