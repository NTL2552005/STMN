# Catalog API

Base URL: `/api/catalog/`. Endpoints require a DRF token in
`Authorization: Token <token>`. Authenticated users can read Catalog data.
Create/update operations require the `Chủ cửa hàng` group or a Django staff or
superuser account, using Accounts' `IsStoreOwnerOrAdmin` permission. Role values
from the frontend are not used to authorize requests.

Collections are paginated with `count`, `next`, `previous`, and `results`.
Default page size is 25; `page_size` may be set up to 100. Resource URLs use
business codes (`DM####`, `HH####`, `GB####`); response `id` is the SQLite
integer primary key.

## Frontend-to-backend mapping

| FE function | JavaScript service/rule | Backend API | SQLite model | Access |
|---|---|---|---|---|
| List/search categories, show product count | Catalog Service; server-side search and pagination | `GET /categories/?search=...&page=...` | `catalog_category`, count from `catalog_product` | Authenticated |
| Create/edit category | Catalog Service; required unique name; no physical delete for referenced categories | `POST /categories/`, `GET/PATCH /categories/{DM_Ma}/` | `catalog_category` | Owner/admin writes |
| Search/filter products by code, name, barcode, category, status | Catalog Service; server-side filters and pagination | `GET /products/?search=...&DM_Ma=...&HH_TrangThai=...&page=...` | `catalog_product` | Authenticated |
| Add/edit product | Catalog Service; unique name/barcode; required category and base unit; status is `Đang kinh doanh` or `Ngừng kinh doanh` | `POST /products/`, `GET/PATCH /products/{HH_Ma}/` | `catalog_product`, FK to `catalog_category` | Owner/admin writes |
| Configure base/package units | `unit-service.js`; one base unit, optional package unit and positive integer ratio; changing units with history requires confirmation | Product create/update fields `HH_DVi`, `HH_DViDongGoi`, `HH_TyLeQuyDoi`, `HH_ConfirmUnitChange` | Unit values are stored on `catalog_product`; no independent unit table in FE | Owner/admin writes |
| Display total/location stock | No mock stock is displayed as real; UI shows “Chưa đồng bộ dữ liệu tồn kho” | Not exposed by Catalog; belongs to Inventory API | Inventory-owned tables | Not connected in this integration |
| Display current sale price | Catalog Service queries the current local date; exactly one effective active price or the API's error | `GET /products/{HH_Ma}/active-price/?date=YYYY-MM-DD` | `catalog_saleprice` | Authenticated |
| Add/edit price | Catalog Service; integer VND, inclusive date interval, backend controls overlap and period adjustment | `POST /prices/`, `GET/PATCH /prices/{GB_Ma}/` | `catalog_saleprice`, FK to `catalog_product` | Owner/admin writes |
| End a price period | Catalog Service sets its end date without changing status | `POST /prices/{GB_Ma}/end/` with `GB_NgayKT` | `catalog_saleprice.ends_on` | Owner/admin writes |

The three Catalog pages in the owner app now use this API for list, detail,
create, update, filtering, and pagination; Catalog errors never fall back to
the browser's mock records. The API returns a standard paginated object
(`count`, `next`, `previous`, `results`) with page size 25 by default and a
maximum `page_size` of 100. The pages use the default page size and backend
search/filter parameters. Requests are sequenced so an older response cannot
replace a newer search or filter result.

All four authenticated business roles may read the Catalog pages and see no
write controls. Store owners see create/edit/end controls. The Django API
remains authoritative and rejects writes from any other user with `403`;
the frontend's role check is only for navigation and UX.

The FE product form only supports one optional package conversion. It does not
define a general unit catalog or multiple conversion tiers; Catalog therefore
stores `HH_DVi`, `HH_DViDongGoi`, and `HH_TyLeQuyDoi` on the product instead of
adding a standalone unit table. Product and category deletion are not offered by
the FE or API. Foreign keys use `PROTECT`, preserving
referenced records.

## Categories

- `GET /categories/` — list; supports `search` or `q` over category code/name.
- `POST /categories/` — create with `DM_Ten` (required) and optional `DM_MoTa`.
- `GET /categories/{DM_Ma}/` — detail.
- `PUT|PATCH /categories/{DM_Ma}/` — update.

Names are trimmed and unique case-insensitively. Responses include `DM_Ma`,
`DM_Ten`, `DM_MoTa`, and `product_count`.

## Products and unit conversion

- `GET /products/` — list with search/filter/pagination.
- `POST /products/` — create.
- `GET /products/{HH_Ma}/` — detail.
- `PUT|PATCH /products/{HH_Ma}/` — update.
- `GET /products/{HH_Ma}/active-price/?date=YYYY-MM-DD` — effective price
  contract for POS and other consumers; without `date`, uses the current local
  date. If there is no unique effective price, `GB_DonGia` and `GB_Ma` are null
  and `error` describes why.

Product request fields: `DM_Ma` (category code), `HH_MaVach` (optional, max 32
characters), `HH_Ten`, `HH_DVi`, optional `HH_DViDongGoi` and
`HH_TyLeQuyDoi`, optional `HH_Hinh`, and `HH_TrangThai`. Barcode and product
name must be unique; blank barcodes are stored as null. Product names are
case-insensitively unique. A package unit and ratio must either both be present
or both be absent; ratios must be positive safe integers. A unit change is
rejected if another installed Django app has a record with a foreign key to the
product, unless `HH_ConfirmUnitChange: true` is sent after the UI confirmation.
Downstream modules should use a Django FK to `Product` so this history guard can
detect references.

Catalog also exports `get_product(code)`, `get_active_price(product, on_date)`,
`to_base_quantity(quantity, factor)`, and `to_base_unit_price(amount, factor)`
from `apps.catalog.services`. The conversion helpers enforce positive safe
integer quantities/ratios and reject package prices that do not divide evenly
into the base-unit price. Catalog does not change stock or perform checkout.

## Sale prices

- `GET /prices/` — list; supports `search`/`q`, `HH_Ma`, and `GB_TrangThai`.
- `POST /prices/` — create.
- `GET /prices/{GB_Ma}/` — detail.
- `PUT|PATCH /prices/{GB_Ma}/` — update.
- `POST /prices/{GB_Ma}/end/` — set `GB_NgayKT`.

Fields: `HH_Ma`, `GB_DonGia` (integer VND, non-negative safe integer),
`GB_NgayBD`, optional `GB_NgayKT` (empty string/null means no end date), and
`GB_TrangThai` (`Đang áp dụng` or `Ngừng áp dụng`). End date is inclusive and
cannot be before the start date. Saving an active overlapping interval closes
an earlier-starting active interval at the preceding day; if an overlapping
interval starts on or after the proposed start date, the request returns 400.
Inactive prices do not participate in overlap checks. Price records cannot be
physically deleted.

## SQLite schema and integration

The Catalog migration creates:

- `catalog_category`: generated business code and case-folded unique name key.
- `catalog_product`: FK to category, optional unique barcode, status, and unit
  conversion fields.
- `catalog_saleprice`: FK to product, integer VND amount, inclusive effective
  dates, and status.

Purchasing, Inventory, and Sales models were not present when this API was
implemented. Their modules can use `Product`/`SalePrice` FKs and the service
functions above; they must apply their own permissions and must not use Catalog
to mutate stock or payments.

## Local setup

From `backend/`:

```powershell
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py runserver
.\.venv\Scripts\python.exe manage.py test apps.catalog
```
