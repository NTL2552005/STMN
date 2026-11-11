# Accounts API

Base URL: `/api/accounts/`. All endpoints except login require a Django REST
Framework token in the `Authorization: Token <token>` header. Account, employee,
and role-management endpoints require the `Chủ cửa hàng` group or a Django staff
administrator (`is_staff`/`is_superuser`); the backend does not trust role values
from the browser.

## FE-to-backend mapping and authorization

| Existing FE function | Backend API | SQLite model/data | Authorization |
|---|---|---|---|
| View/search/filter employees | `GET /employees/` | `accounts_employee` | Store owner or Django admin |
| Add employee | `POST /employees/` | `accounts_employee` | Store owner or Django admin |
| View/edit employee | `GET`, `PUT`, `PATCH /employees/{id}/` | `accounts_employee` | Store owner or Django admin |
| Change employee status to `Nghỉ việc` | `PATCH /employees/{id}/` with `NV_TrangThai` | Employee `is_active`; linked `auth_user.is_active` and token are also revoked | Store owner or Django admin; cannot disable own account |
| Create account and assign employee | `POST /users/` | `auth_user`, `accounts_employee.user`, `auth_user_groups` | Store owner or Django admin |
| Edit account username, employee, or role | `PUT`, `PATCH /users/{id}/` | `auth_user`, `accounts_employee.user`, `auth_user_groups` | Store owner or Django admin |
| Set account status to `Khóa` / `Hoạt động` | `PATCH /users/{id}/` with `TK_TrangThai` | `auth_user.is_active`, `authtoken_token` | Store owner or Django admin; cannot lock own account |
| Change/reset account password | `POST /users/{id}/password/` or include `password` in account update | `auth_user.password` (Django hasher) | Store owner or Django admin |
| View fixed role list and assigned counts | `GET /roles/` | `auth_group`, `auth_user_groups` | Store owner or Django admin |
| Change a user's assigned role | `PUT /users/{id}/role/` | `auth_user_groups` | Store owner or Django admin |

The current FE's role page only displays a fixed list; it does not create,
rename, or delete roles. Accordingly, the role API is read-only and role
assignments are performed through account management. Employee/account
deactivation is soft; no related records are physically deleted.

The employee, account, and role pages in the owner interface now load directly
from these APIs. Employee/account search, status filtering, and pagination are
applied client-side to the API response (10 rows per page); the API currently
returns the full list. API errors are shown without falling back to local mock
records. IDs in URL paths are database integer `id` values. Compatibility
fields use the FE naming convention: employee `NV_Ma` is `NV####`, account
`TK_Ma` is `TK####`, and role codes are the fixed `VT001`–`VT004`; clients
should use response `id` for resource URLs rather than a display code.

## Authentication

### `POST /api/accounts/login/`

Request:

```json
{"username": "owner", "password": "password"}
```

Success response (`200`):

```json
{
  "token": "token-value",
  "user": {
    "id": 1,
    "username": "owner",
    "is_active": true,
    "roles": ["Chủ cửa hàng"]
  }
}
```

Invalid credentials or a locked account return `401`.

### `POST /api/accounts/logout/`

Requires authentication. Deletes the presented token and returns `204`.

### `GET /api/accounts/me/`

Returns the current user's account, assigned employee, and server-side role
membership.

## Frontend authentication

The static frontend uses this Accounts contract without changing the Accounts
API:

1. `POST /api/accounts/login/` with username/password; the response token is
   held in `sessionStorage` for the current browser tab only.
2. `GET /api/accounts/me/` with `Authorization: Token <token>` verifies the
   account and supplies its assigned `roles` and linked employee.
3. Each business page checks the server response again before rendering. The
   browser cannot grant a role by editing local storage or submitting a role
   name.
4. `POST /api/accounts/logout/` revokes the token. If the Backend is
   unreachable, the browser session is cleared locally and the login screen
   warns that server-side revocation could not be confirmed.

Because `sessionStorage` is readable by JavaScript, an XSS vulnerability could
expose the token. It is intentionally tab-scoped; passwords are never stored.
The Backend remains responsible for authorization on every protected API.
Frontend route guards are only a UI/access-navigation layer.

When serving the frontend with a development static server at port 5500 and
Django at port 8000, `config.settings` allows only
`http://localhost:5500` and `http://127.0.0.1:5500` by default in DEBUG mode.
Set `STMN_CORS_ALLOWED_ORIGINS` to a comma-separated list of exact origins for
other development hosts or production. Do not use wildcard origins. The API
base defaults to the current frontend hostname at port 8000; define
`window.STMN_API_BASE_URL` before loading the auth service if the API is hosted
elsewhere.

Run the backend from `backend/` with `python manage.py runserver`, then serve
the static frontend from `frontend/` with `python -m http.server 5500`. Open
`http://127.0.0.1:5500/`; do not open the HTML files as `file://` URLs.

### Frontend role and page mapping

| Backend-assigned role | Main interface | Additional guarded pages | Frontend operations shown by existing role checks |
|---|---|---|---|
| Chủ cửa hàng (`VT001`) | `/pages/chu-cua-hang/tong-quan.html` | Owner, catalog/system, warehouse, sales, accounting pages | Existing owner-level mock UI actions |
| Nhân viên kho (`VT002`) | `/pages/kho/tong-quan-kho.html` | Warehouse pages | Manage receipts, dispatch transfers, manage supplier returns, create/count inventory |
| Nhân viên bán hàng (`VT003`) | `/pages/ban-hang-ke-toan/tong-quan-ban-hang.html` | Sales pages; transfer receipt page | POS/sales actions and receive internal transfers |
| Nhân viên kế toán (`VT004`) | `/pages/ban-hang-ke-toan/tong-quan-ke-toan.html` | Accounting pages; read-only supplier-return and inventory views; transfer page | Accounting actions and create internal transfers |

Users assigned multiple business roles must choose one explicitly after login;
the frontend never infers a higher-privilege role. Users without one of these
four roles are sent to an access notice. The Accounts API's owner/admin
restriction remains in force for account and employee management. Other
business modules are not connected to this authentication UI in this task;
their APIs must continue to apply their own server-side permissions.

The employee, account, and role management screens use the Accounts API;
catalog, purchasing, inventory, sales, accounting, and reporting screens
remain on their existing browser-local data and are not integrated by this
change. The identity shown in the owner interface header comes from `/me/`.

## Employees

### `GET|POST /api/accounts/employees/`

List employees or create one. `POST` requires `NV_Ten`; optional fields:
`NV_SDT`, `NV_DChi`, `NV_NgaySinh` (`YYYY-MM-DD`, `null`, or empty string),
`NV_GioiTinh`,
`NV_NgayVaoLam` (`YYYY-MM-DD`). Employee codes are generated as `NV####`.

### `GET|PUT|PATCH|DELETE /api/accounts/employees/{id}/`

`DELETE` is a soft deactivation, not a physical deletion. An attached account
is also locked and its token revoked. `NV_TrangThai` accepts `Đang làm` or
`Nghỉ việc`; `is_active` is also available as a boolean.

## Accounts

### `GET|POST /api/accounts/users/`

List or create an account. Creation requires `username`, `password`,
`employee_id` (an active employee), and `role`. The role accepts a role name or
one of `VT001`–`VT004`. Passwords are checked against Django's configured
validators and hashed by Django. Username uniqueness is checked
case-insensitively to match the FE validation.

### `GET|PUT|PATCH|DELETE /api/accounts/users/{id}/`

Update username, email, employee assignment, account status, or role. For FE
compatibility, `password: ""` leaves the existing password unchanged; changing
the username requires a non-empty new password. An existing account cannot be
unassigned from its employee. `DELETE` locks the account
instead of deleting it. A locked account's token is revoked.
Compatibility response fields include `TK_Ma`, `TK_TenDangNhap`,
`TK_TrangThai`, `NV_Ma`, `VT_Ma`, and `VT_Ten`.

### `POST /api/accounts/users/{id}/password/`

Request: `{"password": "a-new-password"}`. Updates the password using Django's
password hasher and revokes existing tokens for that account.

### `PUT /api/accounts/users/{id}/role/`

Request: `{"role": "VT002"}` or `{"role": "Nhân viên kho"}`. Replaces the
account's assigned business role.

## Roles

### `GET /api/accounts/roles/`

Lists the four fixed business roles and account counts. `GET
/api/accounts/roles/{group-id}/` returns one role. Roles are seeded as Django
`Group` records by the Accounts migration; role assignment is managed through
the account role endpoints.

| Code | Role |
|---|---|
| `VT001` | Chủ cửa hàng |
| `VT002` | Nhân viên kho |
| `VT003` | Nhân viên bán hàng |
| `VT004` | Nhân viên kế toán |

## Shared authentication and permission interface

For other Django apps, use the authenticated `request.user`; do not accept a
role name from request data as proof of authorization. The token must be sent in
`Authorization: Token <token>`. For DRF views:

```python
from rest_framework.permissions import IsAuthenticated
from apps.accounts.permissions import HasAnyRole

class WarehouseRole(HasAnyRole):
    allowed_roles = ("Nhân viên kho",)

class WarehouseViewSet(...):
    permission_classes = [IsAuthenticated, WarehouseRole]
```

For imperative checks, import `user_has_role(user, "Nhân viên kho")` or
`user_has_business_role(user, "VT002")` from
`apps.accounts.permissions`. `user_has_any_role(user, role_names)` checks a
collection of group names. Account-management endpoints use
`IsStoreOwnerOrAdmin`; that permission accepts the store-owner group or a Django
staff/superuser account. Other apps should explicitly choose their allowed
roles per operation rather than assuming every authenticated account has the
same access. The four role names/codes are exported by
`apps.accounts.constants` as `ROLE_DEFINITIONS`, `ROLE_NAMES`, and
`ROLE_BY_CODE`.

## Local setup

Set `DJANGO_SECRET_KEY` in `backend/.env`, install `backend/requirements.txt`,
then run these commands from `backend/`:

```powershell
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py runserver
```

### Creating the first development manager

After migrations seed the four role Groups, create a development superuser
interactively so Django prompts for its password; do not put credentials in
source code or command history:

```powershell
python manage.py createsuperuser
python manage.py shell
```

In the Django shell, attach the store-owner Group to the username just created
(this does not change any existing account):

```python
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group

username = input("New superuser username: ")
user = get_user_model().objects.get(username=username)
user.groups.add(Group.objects.get(name="Chủ cửa hàng"))
```

The Django superuser privilege independently satisfies the backend management
permission. The group assignment also lets the frontend's owner-role route
guard select the owner interface. Never use a real or shared production
password for development.

Employee status is managed separately from account status. Deactivating an
employee locks a linked account and revokes its token. Reactivating the
employee record does not automatically unlock that account; an authorized
manager must explicitly reopen it on the account page.

To confirm records were persisted, open `python manage.py shell` from
`backend/` and inspect only non-sensitive fields:

```python
from django.contrib.auth import get_user_model
from apps.accounts.models import Employee

list(Employee.objects.values("id", "code", "full_name", "is_active", "user_id"))
list(get_user_model().objects.values(
    "id", "username", "is_active", "groups__name", "employee__code"
))
```

These queries read the configured SQLite database and do not select password
hashes or tokens.
