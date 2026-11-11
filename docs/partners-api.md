# Shared Partner contract

`partners_partner` is the canonical store for shared customer/supplier identity.
The existing `suppliers_supplier` table is retained as a legacy archive; the
Partners and Suppliers APIs and services use `Partner` as the source of truth.
The migration copies existing Supplier rows and preserves their `DT_Ma` values.
It does not delete or rename the old table. The copy migration stops on
duplicate partner codes or exact non-empty phone values; the phone-key
migration separately stops on phone values that collide after case-folding.
Neither migration guesses that records should be merged.

## Shared data and roles

One Partner stores `code`, `name`, optional `phone`, `address`, `bank_account`,
`role`, and `status`. Roles exactly match FE values:

- `Khách hàng`
- `Nhà cung cấp`
- `Cả hai`

Non-empty phone values are globally unique after trimming and case-folding,
matching the general FE partner editor. Empty phone values are stored as null
and may occur on multiple Partners. Names are not unique. Codes are generated
centrally in the `DT####` format and remain stable on update.

The FE customer flow that creates a customer using the phone number of a
supplier promotes that same record to `Cả hai`, retaining its code. The shared
customer service implements this exact-phone match; it rejects a match that
already has a customer role.

## Read API

All endpoints require `Authorization: Token <token>`.

- `GET /api/partners/` — paginated list, optionally filtered by `search`/`q`,
  `role`/`DT_Loai`, and `status`/`DT_TrangThai`.
- `GET /api/partners/{DT_Ma}/` — retrieve one Partner by business code.

Page size defaults to 25 and is capped at 100. Responses use the FE field names
`DT_Ma`, `DT_Ten`, `DT_SDT`, `DT_DChi`, `DT_STK`, `DT_Loai`, and
`DT_TrangThai` (plus integer `id`). This generic API is read-only. Mutations
must use the service below or an owning module's authorized endpoint.

## Python service interface for Customers

Import from `apps.partners.services`:

- `get_partner(code)` returns one Partner or raises `Partner.DoesNotExist`.
- `find_partner_by_phone(phone)` returns the exact trimmed-phone match or
  `None`.
- `save_customer_partner(user=..., name=..., code="", phone="", address="",
  bank_account="", role=..., status=...)` creates/updates a customer or
  promotes a supplier matched by phone. It enforces the FE-allowed store owner
  or sales role and raises `PermissionError`/`ValueError` on rejected requests.
- `create_partner(...)` and `update_partner(...)` are owner/admin-only general
  Partner operations, including role/status changes.

Example:

```python
from apps.partners.models import Partner
from apps.partners.services import save_customer_partner

partner = save_customer_partner(
    user=request.user,
    name=validated_data["DT_Ten"],
    code=validated_data.get("DT_Ma", ""),
    phone=validated_data.get("DT_SDT", ""),
    address=validated_data.get("DT_DChi", ""),
    role=Partner.Role.CUSTOMER,
)
```

Do not generate `DT_Ma` in Customers or create a Customer-owned copy of shared
fields. Keep customer-specific data in Customers and reference `Partner` by FK
with `on_delete=PROTECT` where records must be retained.

## Suppliers compatibility

`apps.suppliers.models.Supplier` is now a proxy over Partner. Its manager only
exposes `Nhà cung cấp` and `Cả hai` roles. The existing Suppliers API paths
and FE fields remain available, including the legacy read-only
`DT_Loai: "Nhà cung cấp"` response value. Use
`/api/partners/{DT_Ma}/` to read the actual shared role; role changes belong to
the shared Partner services, not the Suppliers compatibility API.

The existing service names remain:

- `get_supplier(code)` returns a supplier-role Partner or raises
  `Partner.DoesNotExist`.
- `get_active_supplier(code)` additionally requires `Hoạt động`.
- `supplier_is_selectable(code)` returns true only for an active Supplier or
  `Cả hai` Partner.

Purchasing should call `get_active_supplier`; supplier returns can use
`get_supplier` if they must continue to allow inactive suppliers as the FE
currently does. No Purchasing model or workflow is implemented here.
