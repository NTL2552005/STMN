# Inventory Part 1: inbound receipts

Base URL: `/api/inventory/`. All endpoints require the Accounts token:

```http
Authorization: Token <token>
```

Inventory Part 1 implements receipt creation, draft reservations, accounting
review, receipt confirmation, and inbound stock history. It does not implement
sales, transfers, counts, supplier returns, or outbound stock movements.
Supplier returns are covered separately in
[Inventory Part 3C](./inventory-part3c-supplier-returns.md).

## FE flow and backend mapping

| FE behavior | Rule | State | API / model |
|---|---|---|---|
| Create a receipt from an order | Order must be waiting or partially received; supplier must match; products must be order lines; requested quantity must fit after confirmed and reserved receipts | `Nháp` | `POST /receipts/`; `inventory_goodsreceipt`, `inventory_goodsreceiptline` |
| Create without an order | FE permits an unlinked receipt; supplier role, location, date, and lines are still required | `Nháp` | Same endpoint; `purchase_order` is null |
| Save/edit draft | Draft quantities reserve ordered quantities; only drafts can be edited | `Nháp` | `PATCH /receipts/{PN_Ma}/` |
| Send to accounting | Revalidates order quantities and reserves them; stock remains unchanged | `Chờ kế toán xác nhận` | `POST /receipts/{PN_Ma}/submit/` |
| Accounting confirms | Only accounting or store owner; writes receipt status, stock balance, stock movement, and linked order progress in one transaction | `Đã xác nhận` | `POST /receipts/{PN_Ma}/confirm/`; `inventory_stockbalance`, `inventory_stockmovement` |
| Cancel draft | Only draft receipts can be cancelled; a linked order reservation is released | `Đã hủy` | `POST /receipts/{PN_Ma}/cancel/` |
| Inspect stock | Stock is grouped by location and receipt lot; only confirmed receipts contribute | Confirmed rows only | `GET /stock/` |
| Inspect receiving progress | Returns confirmed, reserved, remaining, and available quantities per ordered product | Purchasing states remain FE values | `GET /orders/{DH_Ma}/receiving-progress/` |

Receipt status values match FE exactly: `Nháp`, `Chờ kế toán xác nhận`,
`Đã xác nhận`, and `Đã hủy`. Draft and pending-accounting receipts hold
quantities against an order but do not increase stock. FE's no-order receipt
path is supported separately and is not constrained by purchase-order
quantities.

## Endpoints

| Method | URL | Permission | Purpose |
|---|---|---|---|
| GET | `/receipts/` | Authenticated | Filtered, paginated receipt list |
| POST | `/receipts/` | Warehouse, owner, or admin | Create a draft |
| GET | `/receipts/{PN_Ma}/` | Authenticated | Receipt and lot detail |
| PATCH | `/receipts/{PN_Ma}/` | Warehouse, owner, or admin | Edit a draft only |
| POST | `/receipts/{PN_Ma}/submit/` | Warehouse, owner, or admin | Send draft to accounting |
| POST | `/receipts/{PN_Ma}/confirm/` | Accountant, owner, or admin | Confirm and record inbound stock |
| POST | `/receipts/{PN_Ma}/cancel/` | Warehouse, owner, or admin | Cancel a draft and release its reservation |
| GET | `/orders/{DH_Ma}/receiving-progress/` | Authenticated | Read receiving progress for an order |
| GET | `/locations/` | Authenticated | List configured stock locations |
| GET | `/stock/` | Authenticated | Read positive, confirmed stock by lot |
| GET | `/movements/` | Authenticated | Read stock ledger movements |

Receipt list filters: `search`/`q`, `DT_Ma`, `DD_Ma`, `DH_Ma`, `status`/
`PN_TrangThai`, `from`/`date_from`, and `to`/`date_to`. Standard DRF pagination
uses `count`, `next`, `previous`, and `results` (default 25, maximum 100).
The stock endpoint accepts `HH_Ma` and `DD_Ma`.
The movement endpoint accepts `DD_Ma`, `HH_Ma`, `PNCT_Ma`, `BDK_Loai`,
`BDK_MaChungTu`, `from`/`date_from`, and `to`/`date_to`; its response fields
follow FE's `BDK_*` contract.

## Create/edit payload

```json
{
  "DT_Ma": "DT0001",
  "DH_Ma": "DH0001",
  "DD_Ma": "DD0001",
  "PN_Ngay": "2026-11-10",
  "NV_Ma": "NV0002",
  "lines": [
    {
      "HH_Ma": "HH0001",
      "PNCT_SL": 12,
      "PNCT_DonGia": 2000,
      "PNCT_NSX": "2026-10-01",
      "PNCT_HSD": "2027-10-01",
      "PNCT_HSDToiThieu": 30
    }
  ]
}
```

`DH_Ma` can be omitted or empty for a receipt not linked to an order. FE's
supplier picker includes partners with supplier role without filtering status;
the backend therefore validates supplier role/existence and exact order
matching, but does not add an active-status restriction for a receipt.
Quantity
and price are integers in Catalog base units, matching FE's
`toBaseQuantity`/`toBaseUnitPrice` conversion. An optional `PNCT_DViNhap`
accepts the product package ratio and lets the backend convert an unconverted
quantity and price; package price must divide evenly by the ratio. Prices are
VND integers; no float arithmetic is used. Each receipt line is a lot and
retains `PNCT_Ma`, product, quantity, unit cost, production date, expiry date,
and optional minimum-expiry warning days. Multiple lots for one product can
appear in a receipt.

`NV_Ma` is optional and, if provided, must match the authenticated user's
linked active Employee. The stored employee is derived from that account;
frontend-supplied employee or role data is not trusted.

## Data model

- `inventory_storagelocation` stores `DD_Ma`, name, kind, address, and status.
  Locations can be configured through Django admin; no mock locations are
  inserted into the development database.
- `inventory_goodsreceipt` references Partner, StorageLocation, Employee, and
  optionally a Purchasing order. All foreign keys use `PROTECT`.
- `inventory_goodsreceiptline` uses immutable generated `PNCT_Ma` as the lot
  identity and references Product. It stores base-unit quantities and integer
  VND cost, plus FE's manufacturing/expiry fields.
- `inventory_stockbalance` stores quantity by location and receipt lot.
- `inventory_stockmovement` records each inbound movement once per receipt
  line, with source `PhieuNhap`, document code `PN_Ma`, and positive delta.

No separate lot table duplicates `PNCT_Ma`; the receipt line is the lot record.
Physical deletes are not exposed, and protected foreign keys prevent removing
referenced records.

## Transaction and concurrency behavior

All receipt mutations are atomic. Before reading/updating receipt progress,
SQLite mutations acquire a database sentinel write lock. In-process writes are
also serialized. This avoids SQLite's deferred read-to-write upgrade race;
confirmed quantity and draft/pending reservations are rechecked while holding
the lock. A conditional status update prevents repeat confirmation, and a
partial unique constraint permits at most one inbound movement per receipt
line. Any validation or database failure rolls back the status, stock, ledger,
and Purchasing progress together.

Purchasing's `get_order`, `get_order_for_receiving`,
`get_order_receiving_summary`, `get_receipt_progress`, and
`sync_receipt_progress` services are reused. Inventory additionally checks
that confirmed plus reserved quantities do not exceed an order line, including
the aggregate case of several pending receipts.

## Accounting integration contract

FE's accounting step is preserved: only an accountant or owner may confirm.
Developer 2 can call
`apps.inventory.services.confirm_goods_receipt(receipt_code, confirmed_by=user)`
inside the Accounting operation's outer `transaction.atomic()` block. The
service uses a nested atomic block; if subsequent payable creation fails, the
outer transaction can roll back inventory, ledger, receipt, and order progress
together. The Accounting module is not modified here, and payable/debt records
are not created by Inventory. The API confirmation action currently performs
the Inventory half only; it must be coordinated with Accounting's payable
operation before production FE wiring.

## Sales read interface

`apps.inventory.services.get_stock_for_sale(product_code, location_code,
on_date=None)` returns positive, confirmed, non-expired lots for active
products in FE's expiry-first order. It is read-only. Sales must later perform
its stock decrement and outbound ledger write in its own transaction through
an agreed Inventory service; no outbound operation is implemented here.

## Not included

No actual receipt data is imported from FE's browser mock/localStorage.
Part 1 doesn't implement outbound sales, transfer, count, supplier return, or
Accounting debt/payment workflows. Supplier returns are covered in
[Inventory Part 3C](./inventory-part3c-supplier-returns.md). Existing mock
location labels are not seeded as production records; configure real locations
in Django admin first.
