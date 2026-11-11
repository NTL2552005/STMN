from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from .constants import ROLE_DEFINITIONS, STORE_OWNER_ROLE
from .models import Employee
from .permissions import user_has_business_role, user_has_role

User = get_user_model()


class AccountsApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username="owner",
            password="Owner-test-pass-2026!",
        )
        self.owner.groups.add(Group.objects.get(name=STORE_OWNER_ROLE))
        self.employee = Employee.objects.create(full_name="Nguyen Van A")

    def authenticate_as(self, user):
        token, _ = Token.objects.get_or_create(user=user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        return token

    def test_login_returns_token_and_account(self):
        response = self.client.post(
            "/api/accounts/login/",
            {"username": "owner", "password": "Owner-test-pass-2026!"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(response.data["token"])
        self.assertEqual(response.data["user"]["username"], "owner")
        self.assertTrue(Token.objects.filter(user=self.owner).exists())

    def test_invalid_login_is_rejected(self):
        response = self.client.post(
            "/api/accounts/login/",
            {"username": "owner", "password": "wrong-password"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertFalse(Token.objects.filter(user=self.owner).exists())

    def test_authenticated_endpoints_require_a_valid_token(self):
        for endpoint in (
            "/api/accounts/me/",
            "/api/accounts/logout/",
            "/api/accounts/employees/",
            "/api/accounts/users/",
            "/api/accounts/roles/",
        ):
            with self.subTest(endpoint=endpoint):
                response = self.client.get(endpoint)
                self.assertEqual(
                    response.status_code, status.HTTP_401_UNAUTHORIZED
                )

        self.client.credentials(HTTP_AUTHORIZATION="Token invalid")
        response = self.client.get("/api/accounts/me/")
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_logout_invalidates_current_token(self):
        token = self.authenticate_as(self.owner)

        response = self.client.post("/api/accounts/logout/")

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Token.objects.filter(pk=token.pk).exists())
        self.assertEqual(
            self.client.get("/api/accounts/me/").status_code,
            status.HTTP_401_UNAUTHORIZED,
        )

    def test_locked_user_cannot_login(self):
        self.owner.is_active = False
        self.owner.save(update_fields=("is_active",))

        response = self.client.post(
            "/api/accounts/login/",
            {"username": "owner", "password": "Owner-test-pass-2026!"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertFalse(Token.objects.filter(user=self.owner).exists())

    def test_protected_endpoints_reject_anonymous_and_non_manager(self):
        self.assertEqual(
            self.client.get("/api/accounts/employees/").status_code,
            status.HTTP_401_UNAUTHORIZED,
        )
        staff_user = User.objects.create_user(
            username="warehouse",
            password="Warehouse-test-pass-2026!",
        )
        self.authenticate_as(staff_user)
        self.assertEqual(
            self.client.get("/api/accounts/employees/").status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.get("/api/accounts/roles/").status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.get("/api/accounts/users/").status_code,
            status.HTTP_403_FORBIDDEN,
        )

    def test_employee_crud_and_soft_deactivation(self):
        self.authenticate_as(self.owner)
        payload = {
            "NV_Ten": "Tran Thi B",
            "NV_SDT": "0901234567",
            "NV_DChi": "Quan 1",
            "NV_NgaySinh": "",
            "NV_GioiTinh": "Nữ",
            "NV_NgayVaoLam": "2026-01-02",
        }

        created = self.client.post(
            "/api/accounts/employees/", payload, format="json"
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        self.assertEqual(created.data["NV_Ten"], "Tran Thi B")
        self.assertEqual(created.data["NV_TrangThai"], "Đang làm")
        self.assertIsNone(created.data["NV_NgaySinh"])
        employee_id = created.data["id"]

        listed = self.client.get("/api/accounts/employees/")
        self.assertEqual(listed.status_code, status.HTTP_200_OK)
        self.assertEqual(len(listed.data), 2)

        detail = self.client.get(f"/api/accounts/employees/{employee_id}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        updated = self.client.patch(
            f"/api/accounts/employees/{employee_id}/",
            {"NV_Ten": "Tran Thi B Updated"},
            format="json",
        )
        self.assertEqual(updated.status_code, status.HTTP_200_OK)
        self.assertEqual(updated.data["NV_Ten"], "Tran Thi B Updated")

        deleted = self.client.delete(
            f"/api/accounts/employees/{employee_id}/"
        )
        self.assertEqual(deleted.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Employee.objects.get(pk=employee_id).is_active)

    def test_employee_deactivation_locks_attached_account_and_revokes_token(self):
        worker = User.objects.create_user(
            username="linked-worker",
            password="Worker-account-pass-2026!",
        )
        employee = Employee.objects.create(
            full_name="Linked Employee",
            user=worker,
        )
        token, _ = Token.objects.get_or_create(user=worker)
        self.authenticate_as(self.owner)

        response = self.client.patch(
            f"/api/accounts/employees/{employee.pk}/",
            {"NV_TrangThai": "Nghỉ việc"},
            format="json",
        )

        worker.refresh_from_db()
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(worker.is_active)
        self.assertFalse(Token.objects.filter(pk=token.pk).exists())

    def test_employee_validation_rejects_missing_name_and_invalid_date(self):
        self.authenticate_as(self.owner)
        missing_name = self.client.post(
            "/api/accounts/employees/",
            {"NV_SDT": "0901111111"},
            format="json",
        )
        self.assertEqual(missing_name.status_code, status.HTTP_400_BAD_REQUEST)

        invalid_date = self.client.post(
            "/api/accounts/employees/",
            {"NV_Ten": "Test", "NV_NgaySinh": "not-a-date"},
            format="json",
        )
        self.assertEqual(invalid_date.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(Employee.objects.count(), 1)

    def test_owner_cannot_deactivate_their_own_account_or_employee_profile(self):
        employee = Employee.objects.create(
            full_name="Owner Employee",
            user=self.owner,
        )
        self.authenticate_as(self.owner)

        account_response = self.client.delete(
            f"/api/accounts/users/{self.owner.pk}/"
        )
        employee_response = self.client.patch(
            f"/api/accounts/employees/{employee.pk}/",
            {"NV_TrangThai": "Nghỉ việc"},
            format="json",
        )

        self.assertEqual(account_response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(employee_response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue(self.owner.is_active)
        self.assertTrue(employee.is_active)

    def test_manager_creates_account_with_hashed_password_and_role(self):
        self.authenticate_as(self.owner)
        role_name = next(
            role["name"] for role in ROLE_DEFINITIONS if role["code"] == "VT002"
        )
        response = self.client.post(
            "/api/accounts/users/",
            {
                "username": "warehouse-user",
                "password": "Warehouse-account-pass-2026!",
                "employee_id": self.employee.pk,
                "role": role_name,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        account = User.objects.get(username="warehouse-user")
        self.assertTrue(account.check_password("Warehouse-account-pass-2026!"))
        self.assertNotEqual(account.password, "Warehouse-account-pass-2026!")
        self.assertEqual(account.employee, self.employee)
        self.assertTrue(account.groups.filter(name=role_name).exists())

    def test_account_creation_requires_active_employee_and_valid_password(self):
        self.authenticate_as(self.owner)
        missing_employee = self.client.post(
            "/api/accounts/users/",
            {
                "username": "orphan-account",
                "password": "Orphan-account-pass-2026!",
                "role": "VT002",
            },
            format="json",
        )
        weak_password = self.client.post(
            "/api/accounts/users/",
            {
                "username": "weak-password-account",
                "password": "password",
                "employee_id": self.employee.pk,
                "role": "VT002",
            },
            format="json",
        )
        self.assertEqual(missing_employee.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("employee_id", missing_employee.data)
        self.assertEqual(weak_password.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("password", weak_password.data)
        self.assertFalse(User.objects.filter(username="orphan-account").exists())

    def test_account_accepts_frontend_compatibility_fields(self):
        self.authenticate_as(self.owner)
        response = self.client.post(
            "/api/accounts/users/",
            {
                "TK_TenDangNhap": "legacy-account",
                "password": "Independent-Secret-2026!",
                "NV_Ma": self.employee.code,
                "VT_Ma": "VT002",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        self.assertEqual(response.data["TK_TenDangNhap"], "legacy-account")
        self.assertEqual(response.data["NV_Ma"], self.employee.code)
        self.assertEqual(response.data["VT_Ma"], "VT002")
        account_id = response.data["id"]

        listing = self.client.get("/api/accounts/users/")
        detail = self.client.get(f"/api/accounts/users/{account_id}/")
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        self.assertEqual(detail.data["TK_Ma"], f"TK{account_id:04d}")

    def test_password_change_hashes_password_and_revokes_tokens(self):
        self.authenticate_as(self.owner)
        account = User.objects.create_user(
            username="password-change-user",
            password="Original-password-2026!",
        )
        token, _ = Token.objects.get_or_create(user=account)

        response = self.client.post(
            f"/api/accounts/users/{account.pk}/password/",
            {"password": "Updated-password-2026!"},
            format="json",
        )

        account.refresh_from_db()
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertTrue(account.check_password("Updated-password-2026!"))
        self.assertFalse(Token.objects.filter(pk=token.pk).exists())

    def test_owner_can_lock_and_unlock_an_account(self):
        self.authenticate_as(self.owner)
        account = User.objects.create_user(
            username="temporary-user",
            password="Temporary-account-pass-2026!",
        )
        account.groups.add(Group.objects.get(name="Nhân viên kho"))
        token, _ = Token.objects.get_or_create(user=account)

        locked = self.client.patch(
            f"/api/accounts/users/{account.pk}/",
            {"TK_TrangThai": "Khóa"},
            format="json",
        )

        self.assertEqual(locked.status_code, status.HTTP_200_OK)
        self.assertFalse(locked.data["is_active"])
        self.assertFalse(Token.objects.filter(pk=token.pk).exists())
        login = self.client.post(
            "/api/accounts/login/",
            {
                "username": "temporary-user",
                "password": "Temporary-account-pass-2026!",
            },
            format="json",
        )
        self.assertEqual(login.status_code, status.HTTP_401_UNAUTHORIZED)

        unlocked = self.client.patch(
            f"/api/accounts/users/{account.pk}/",
            {"TK_TrangThai": "Hoạt động"},
            format="json",
        )
        self.assertEqual(unlocked.status_code, status.HTTP_200_OK)
        self.assertTrue(unlocked.data["is_active"])

    def test_frontend_blank_password_is_noop_but_username_change_requires_new_password(self):
        self.authenticate_as(self.owner)
        account = User.objects.create_user(
            username="editable-account",
            password="Original-password-2026!",
        )
        account.groups.add(Group.objects.get(name="Nhân viên kho"))

        renamed_without_password = self.client.patch(
            f"/api/accounts/users/{account.pk}/",
            {"TK_TenDangNhap": "renamed-account", "password": ""},
            format="json",
        )
        unchanged_password = self.client.patch(
            f"/api/accounts/users/{account.pk}/",
            {"password": ""},
            format="json",
        )

        account.refresh_from_db()
        self.assertEqual(
            renamed_without_password.status_code, status.HTTP_400_BAD_REQUEST
        )
        self.assertEqual(unchanged_password.status_code, status.HTTP_200_OK)
        self.assertEqual(account.username, "editable-account")
        self.assertTrue(account.check_password("Original-password-2026!"))

        renamed_with_password = self.client.patch(
            f"/api/accounts/users/{account.pk}/",
            {
                "TK_TenDangNhap": "renamed-account",
                "password": "Replacement-secret-2026!",
            },
            format="json",
        )
        account.refresh_from_db()
        self.assertEqual(renamed_with_password.status_code, status.HTTP_200_OK)
        self.assertEqual(account.username, "renamed-account")
        self.assertTrue(account.check_password("Replacement-secret-2026!"))

    def test_role_listing_and_role_assignment(self):
        self.authenticate_as(self.owner)
        response = self.client.get("/api/accounts/roles/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(response.data), 4)
        self.assertEqual(
            self.client.post("/api/accounts/roles/", {}, format="json").status_code,
            status.HTTP_405_METHOD_NOT_ALLOWED,
        )

        response = self.client.put(
            f"/api/accounts/users/{self.owner.pk}/role/",
            {"role": "VT001"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["VT_Ma"], "VT001")

    def test_role_helpers_are_suitable_for_other_apps(self):
        warehouse = Group.objects.get(name="Nhân viên kho")
        self.owner.groups.add(warehouse)

        self.assertTrue(user_has_role(self.owner, "Nhân viên kho"))
        self.assertTrue(user_has_business_role(self.owner, "VT002"))
        self.assertFalse(user_has_business_role(self.owner, "VT999"))

    def test_admin_staff_can_manage_employees(self):
        admin = User.objects.create_user(
            username="admin-staff",
            password="Admin-test-pass-2026!",
            is_staff=True,
        )
        self.authenticate_as(admin)
        response = self.client.get("/api/accounts/employees/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
