# Purchasing API contract

Base URL: `/api/purchasing/orders/`. Requests use the Accounts DRF token:

```http
Authorization: Token <token>
```

Authenticated users can list and retrieve orders. Only the store-owner role or
a Django staff/superuser account can create, edit, confirm, or cancel an order.
The API does not expose PUT or DELETE.

## Endpoints

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/purchasing/orders/` | Search/filter/paginate orders |
| POST | `/api/purchasing/orders/` | Create a draft |
| GET | `/api/purchasing/orders/{DH_Ma}/` | Retrieve order and lines |
| PATCH | `/api/purchasing/orders/{DH_Ma}/` | Edit a draft only |
| POST | `/api/purchasing/orders/{DH_Ma}/confirm/` | Move draft to `Chờ giao` |
| POST | `/api/purchasing/orders/{DH_Ma}/cancel/` | Cancel an eligible draft/waiting order |

List filters: `search`/`q` matches order code, supplier code or supplier name;
`DT_Ma` filters by supplier; `status`/`DH_TrangThai` filters by status; `from`
or `date_from`, and `to` or `date_to` filter inclusive order dates. Pagination
uses DRF's `count`, `next`, `previous`, `results`, with default page size 25
and maximum 100.

## Create and edit payload

```json
{
  "DT_Ma": "DT0001",
  "NV_Ma": "NV0001",
  "DH_Ngay": "2026-11-10",
  "lines": [
    {"HH_Ma": "HH0001", "DN_SL": 12, "DN_DonGia": 2000}
  ]
}
```

The FE already sends quantity and unit price normalized to the Catalog
product's base unit. The backend treats `DN_SL` and `DN_DonGia` as base-unit
values. An optional `DN_DonVi` can be supplied when these two values are still
in the chosen base/package unit: `DN_DonVi` must be `1` or the product's
configured package ratio; the backend converts quantity with Catalog's
`to_base_quantity` and unit price with `to_base_unit_price`. Package price
must divide evenly by the ratio. Responses always return canonical base units.
The original order unit is not stored, matching FE; the Product FK is also
recognized by Catalog's product-history guard for later unit changes.

The server validates active Supplier/Both Partner, active Employee, valid
date, at least one active Product, unique products per order, positive safe
integer quantities, non-negative safe integer VND prices, and safe totals.
Each line amount and order totals are recomputed server-side.

Response fields include `DH_Ma`, `DT_Ma`, `DT_Ten`, `NV_Ma`, `NV_Ten`,
`DH_Ngay`, `DH_TongSL`, `DH_TongTien`, `DH_TrangThai`, and `lines`. Each line
includes `HH_Ma`, `HH_Ten`, `DN_DVi` (base unit), `DN_SL`, `DN_DonGia`, and
`DN_TTien`.

## State and Inventory integration

Statuses are exactly `Nháp`, `Chờ giao`, `Đã nhận một phần`, `Đã nhận đủ`,
`Đã hủy`. New orders are drafts. Only draft can be confirmed or edited.
Confirmation changes no stock or accounting data. Cancellation is limited to
draft/waiting orders without active linked receipts or confirmed receipt
quantities. Orders and lines cannot be physically deleted.

Inventory integration functions in `apps.purchasing.services`:

- `get_order(code)` returns an order with Supplier, Employee and lines.
- `get_order_for_receiving(code)` obtains a row lock and requires waiting or
  partially received status. Inventory should call it inside the same outer
  `transaction.atomic()` block used to validate/save a receipt; this keeps the
  lock through the receipt transaction on databases that support row locks.
- `get_order_receiving_summary(order, receipts)` calculates confirmed,
  reserved, remaining, and available quantities.
- `get_receipt_progress(order, receipts)` calculates the same progress without
  requiring a receivable status.
- `sync_receipt_progress(code, receipts)` locks the order and syncs its derived
  status after Inventory persists/cancels receipt documents.

Pass receipt records as dictionaries with `status` or `PN_TrangThai`, and
`lines` containing `product_code` or `HH_Ma` plus `quantity` or `PNCT_SL`.
Confirmed receipts use `Đã xác nhận`; reservations use `Nháp` and
`Chờ kế toán xác nhận`; cancelled documents use `Đã hủy`. Cancelled receipts
do not count. The helper rejects products outside the order and quantities
that exceed ordered quantities. Inventory must serialize competing receipt
creation/confirmation against the same order within the transaction that
persists the receipt. No receipt model, received quantity, stock, or accounting
record is created by Purchasing.

## FE-to-backend mapping

| FE behavior | Rule | API | SQLite |
|---|---|---|---|
| Create order | Active Supplier/Both; active employee; valid date; non-empty lines | `POST /orders/` | `purchasing_purchaseorder` |
| Add products | Active Product, unique per order; positive integer quantity; integer VND price | Nested `lines` payload | `purchasing_purchaseorderline` FK to `catalog_product` |
| Package conversion | One optional product package ratio; exact price division; canonical base values | Optional `DN_DonVi`; server conversion | Values stored in base units; Product FK |
| Edit draft | Draft only and no non-cancelled linked receipt | `PATCH /orders/{DH_Ma}/` | Order and lines in one transaction |
| Confirm | Draft with lines only; no stock/debt side effects | `POST .../confirm/` | Status becomes `Chờ giao` |
| Cancel | Not received/complete/cancelled; no active receipt dependency | `POST .../cancel/` | Status becomes `Đã hủy` |
| Receive progress | Confirmed receipt quantities and pending reservations | Inventory service interface only | Inventory-owned receipt tables when implemented |

## Not yet integrated

Inventory is not implemented here, so no actual received quantity, reserved
receipt, partial/complete transition, stock update, or cancellation dependency
can be observed in the development database yet. Purchasing includes the
integration/query contract but does not fabricate receipt data.
