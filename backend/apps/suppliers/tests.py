from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from apps.accounts.constants import STORE_OWNER_ROLE
from .models import Supplier

User = get_user_model()


class SupplierApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="supplier-owner", password="test")
        self.owner.groups.add(Group.objects.get(name=STORE_OWNER_ROLE))
        self.worker = User.objects.create_user(username="supplier-worker", password="test")
        self.worker.groups.add(Group.objects.get(name="Nhân viên kho"))

    def authenticate_as(self, user):
        token, _ = Token.objects.get_or_create(user=user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")

    def create_supplier(self, **overrides):
        values = {
            "name": "Nhà cung cấp mẫu",
            "phone": "0900000001",
            "address": "Hà Nội",
            "bank_account": "0123456789",
        }
        values.update(overrides)
        return Supplier.objects.create(**values)

    def test_authentication_is_required_for_list_and_detail(self):
        supplier = self.create_supplier()
        self.assertEqual(
            self.client.get("/api/suppliers/").status_code,
            status.HTTP_401_UNAUTHORIZED,
        )
        self.assertEqual(
            self.client.get(f"/api/suppliers/{supplier.code}/").status_code,
            status.HTTP_401_UNAUTHORIZED,
        )

    def test_owner_can_create_retrieve_update_supplier(self):
        self.authenticate_as(self.owner)
        created = self.client.post(
            "/api/suppliers/",
            {
                "DT_Ten": "  Công ty Thực phẩm ",
                "DT_SDT": " 0900000002 ",
                "DT_DChi": " Hà Nội ",
                "DT_STK": " 123456 ",
            },
            format="json",
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
        self.assertEqual(created.data["DT_Ma"], "DT0001")
        self.assertEqual(created.data["DT_Ten"], "Công ty Thực phẩm")
        self.assertEqual(created.data["DT_SDT"], "0900000002")
        self.assertEqual(created.data["DT_Loai"], "Nhà cung cấp")
        self.assertEqual(created.data["DT_TrangThai"], Supplier.Status.ACTIVE)

        code = created.data["DT_Ma"]
        detail = self.client.get(f"/api/suppliers/{code}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        updated = self.client.patch(
            f"/api/suppliers/{code}/",
            {
                "DT_Ten": "Công ty Thực phẩm mới",
                "DT_TrangThai": Supplier.Status.INACTIVE,
            },
            format="json",
        )
        self.assertEqual(updated.status_code, status.HTTP_200_OK)
        self.assertEqual(updated.data["DT_Ten"], "Công ty Thực phẩm mới")
        self.assertEqual(updated.data["DT_TrangThai"], Supplier.Status.INACTIVE)

    def test_name_is_required_and_invalid_status_is_rejected(self):
        self.authenticate_as(self.owner)
        missing_name = self.client.post(
            "/api/suppliers/", {"DT_SDT": "0900000003"}, format="json"
        )
        invalid_status = self.client.post(
            "/api/suppliers/",
            {"DT_Ten": "NCC", "DT_TrangThai": "Đã xóa"},
            format="json",
        )
        self.assertEqual(missing_name.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("DT_Ten", missing_name.data)
        self.assertEqual(invalid_status.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("DT_TrangThai", invalid_status.data)

    def test_duplicate_phone_is_rejected_and_optional_blank_is_allowed(self):
        self.authenticate_as(self.owner)
        self.create_supplier()
        duplicate = self.client.post(
            "/api/suppliers/",
            {"DT_Ten": "NCC khác", "DT_SDT": "0900000001"},
            format="json",
        )
        no_phone = self.client.post(
            "/api/suppliers/",
            {"DT_Ten": "NCC không có điện thoại", "DT_SDT": ""},
            format="json",
        )
        self.assertEqual(duplicate.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("DT_SDT", duplicate.data)
        self.assertEqual(no_phone.status_code, status.HTTP_201_CREATED, no_phone.data)

    def test_search_filter_and_pagination(self):
        self.authenticate_as(self.owner)
        first = self.create_supplier(name="Công ty A")
        self.create_supplier(
            name="Công ty B",
            phone="0900000002",
            status=Supplier.Status.INACTIVE,
        )
        response = self.client.get(
            "/api/suppliers/?search=Công%20ty&status=Hoạt%20động&page_size=1"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["count"], 1)
        self.assertEqual(response.data["results"][0]["DT_Ma"], first.code)

    def test_only_owner_or_admin_can_create_or_update(self):
        self.authenticate_as(self.worker)
        create = self.client.post(
            "/api/suppliers/", {"DT_Ten": "Không được phép"}, format="json"
        )
        supplier = self.create_supplier()
        update = self.client.patch(
            f"/api/suppliers/{supplier.code}/",
            {"DT_Ten": "Không được sửa"},
            format="json",
        )
        self.assertEqual(create.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(update.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(
            self.client.get("/api/suppliers/").status_code, status.HTTP_200_OK
        )

    def test_supplier_cannot_be_deleted_through_api(self):
        self.authenticate_as(self.owner)
        supplier = self.create_supplier()
        response = self.client.delete(f"/api/suppliers/{supplier.code}/")
        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertTrue(Supplier.objects.filter(pk=supplier.pk).exists())

    def test_code_remains_stable_after_supplier_update(self):
        self.authenticate_as(self.owner)
        supplier = self.create_supplier()
        original_code = supplier.code
        response = self.client.put(
            f"/api/suppliers/{original_code}/",
            {
                "DT_Ten": "NCC đã cập nhật",
                "DT_SDT": "0900000004",
                "DT_DChi": "",
                "DT_STK": "",
                "DT_TrangThai": Supplier.Status.ACTIVE,
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        supplier.refresh_from_db()
        self.assertEqual(supplier.code, original_code)

    def test_supplier_api_preserves_read_only_supplier_role_contract(self):
        self.authenticate_as(self.owner)
        both = self.client.post(
            "/api/suppliers/",
            {"DT_Ten": "Đối tác hai vai trò", "DT_Loai": "Cả hai"},
            format="json",
        )
        customer_only = self.client.post(
            "/api/suppliers/",
            {"DT_Ten": "Chỉ khách hàng", "DT_Loai": "Khách hàng"},
            format="json",
        )
        self.assertEqual(both.status_code, status.HTTP_201_CREATED, both.data)
        self.assertEqual(both.data["DT_Loai"], "Nhà cung cấp")
        self.assertEqual(customer_only.status_code, status.HTTP_201_CREATED)
        self.assertEqual(customer_only.data["DT_Loai"], "Nhà cung cấp")
        self.assertEqual(Supplier.objects.count(), 2)
