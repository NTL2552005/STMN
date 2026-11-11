from datetime import date
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from apps.accounts.constants import STORE_OWNER_ROLE
from .models import Category, Product, SalePrice
from .services import to_base_quantity, to_base_unit_price

User = get_user_model()


class CatalogApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username="catalog-owner",
            password="Catalog-owner-test-2026!",
        )
        self.owner.groups.add(Group.objects.get(name=STORE_OWNER_ROLE))
        self.worker = User.objects.create_user(
            username="catalog-worker",
            password="Catalog-worker-test-2026!",
        )
        self.worker.groups.add(Group.objects.get(name="Nhân viên kho"))
        self.category = Category.objects.create(name="Nước giải khát")

    def authenticate_as(self, user):
        token, _ = Token.objects.get_or_create(user=user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")
        return token

    def create_product(self, **overrides):
        values = {
            "category": self.category,
            "name": "Nước khoáng đóng chai",
            "base_unit": "Chai",
            **overrides,
        }
        return Product.objects.create(**values)

    def create_price(self, product, **overrides):
        values = {
            "product": product,
            "amount": 12000,
            "starts_on": date(2026, 1, 1),
            "ends_on": date(2026, 12, 31),
            **overrides,
        }
        return SalePrice.objects.create(**values)

    def test_category_crud_and_compatibility_fields(self):
        self.authenticate_as(self.owner)
        created = self.client.post(
            "/api/catalog/categories/",
            {"DM_Ten": "Thực phẩm khô", "DM_MoTa": "Đồ khô"},
            format="json",
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        self.assertEqual(created.data["DM_Ma"], "DM0002")
        self.assertEqual(created.data["product_count"], 0)

        listing = self.client.get("/api/catalog/categories/?search=Thực")
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertEqual(listing.data["count"], 1)

        code = created.data["DM_Ma"]
        detail = self.client.get(f"/api/catalog/categories/{code}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        updated = self.client.patch(
            f"/api/catalog/categories/{code}/",
            {"DM_Ten": "Thực phẩm khô và mì"},
            format="json",
        )
        self.assertEqual(updated.status_code, status.HTTP_200_OK)
        self.assertEqual(updated.data["DM_Ten"], "Thực phẩm khô và mì")
        deleted = self.client.delete(f"/api/catalog/categories/{code}/")
        self.assertEqual(deleted.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)

    def test_category_name_is_unique_case_insensitively(self):
        self.authenticate_as(self.owner)
        response = self.client.post(
            "/api/catalog/categories/",
            {"DM_Ten": "nƯớC GIẢI KHÁT"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("DM_Ten", response.data)

    def test_product_crud_supports_packaging_and_preserves_product_code(self):
        self.authenticate_as(self.owner)
        payload = {
            "DM_Ma": self.category.code,
            "HH_MaVach": " 8934588063071 ",
            "HH_Ten": "Nước đóng chai 500ml",
            "HH_DVi": "Chai",
            "HH_DViDongGoi": " Lốc ",
            "HH_TyLeQuyDoi": 6,
            "HH_Hinh": "",
            "HH_TrangThai": Product.Status.ACTIVE,
        }
        created = self.client.post(
            "/api/catalog/products/", payload, format="json"
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
        self.assertEqual(created.data["HH_Ma"], "HH0001")
        self.assertEqual(created.data["HH_MaVach"], "8934588063071")
        self.assertEqual(created.data["HH_DViDongGoi"], "Lốc")
        self.assertEqual(created.data["HH_TyLeQuyDoi"], 6)

        listing = self.client.get(
            f"/api/catalog/products/?DM_Ma={self.category.code}&search=893458"
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertEqual(listing.data["count"], 1)
        code = created.data["HH_Ma"]
        updated = self.client.patch(
            f"/api/catalog/products/{code}/",
            {"HH_TrangThai": Product.Status.INACTIVE},
            format="json",
        )
        self.assertEqual(updated.status_code, status.HTTP_200_OK)
        self.assertEqual(updated.data["HH_TrangThai"], Product.Status.INACTIVE)
        self.assertEqual(
            self.client.delete(f"/api/catalog/products/{code}/").status_code,
            status.HTTP_405_METHOD_NOT_ALLOWED,
        )

    def test_product_validation_rejects_duplicate_barcode_and_name(self):
        self.authenticate_as(self.owner)
        self.create_product(barcode="1234567890123")

        duplicate_barcode = self.client.post(
            "/api/catalog/products/",
            {
                "DM_Ma": self.category.code,
                "HH_MaVach": "1234567890123",
                "HH_Ten": "Một mặt hàng khác",
                "HH_DVi": "Chai",
            },
            format="json",
        )
        duplicate_name = self.client.post(
            "/api/catalog/products/",
            {
                "DM_Ma": self.category.code,
                "HH_Ten": "  NƯỚC KHOÁNG ĐÓNG CHAI ",
                "HH_DVi": "Chai",
            },
            format="json",
        )
        self.assertEqual(duplicate_barcode.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(duplicate_name.status_code, status.HTTP_400_BAD_REQUEST)

    def test_product_validation_rejects_invalid_conversion(self):
        self.authenticate_as(self.owner)
        missing_ratio = self.client.post(
            "/api/catalog/products/",
            {
                "DM_Ma": self.category.code,
                "HH_Ten": "Invalid conversion",
                "HH_DVi": "Chai",
                "HH_DViDongGoi": "Thùng",
            },
            format="json",
        )
        empty_base_unit = self.client.post(
            "/api/catalog/products/",
            {
                "DM_Ma": self.category.code,
                "HH_Ten": "Missing base unit",
                "HH_DVi": "  ",
            },
            format="json",
        )
        self.assertEqual(missing_ratio.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(empty_base_unit.status_code, status.HTTP_400_BAD_REQUEST)

    @patch("apps.catalog.serializers.has_product_history", return_value=True)
    def test_unit_changes_with_history_require_explicit_confirmation(self, history):
        self.authenticate_as(self.owner)
        product = self.create_product()

        blocked = self.client.patch(
            f"/api/catalog/products/{product.code}/",
            {"HH_DVi": "Hộp"},
            format="json",
        )
        confirmed = self.client.patch(
            f"/api/catalog/products/{product.code}/",
            {"HH_DVi": "Hộp", "HH_ConfirmUnitChange": True},
            format="json",
        )

        self.assertEqual(blocked.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("HH_ConfirmUnitChange", blocked.data)
        self.assertEqual(confirmed.status_code, status.HTTP_200_OK)
        self.assertEqual(confirmed.data["HH_DVi"], "Hộp")
        self.assertEqual(history.call_count, 2)

    def test_price_creation_closes_previous_interval_and_active_price_lookup(self):
        self.authenticate_as(self.owner)
        product = self.create_product()
        previous = self.create_price(product, ends_on=None)

        created = self.client.post(
            "/api/catalog/prices/",
            {
                "HH_Ma": product.code,
                "GB_DonGia": 15000,
                "GB_NgayBD": "2026-03-01",
                "GB_NgayKT": "",
                "GB_TrangThai": SalePrice.Status.ACTIVE,
            },
            format="json",
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
        previous.refresh_from_db()
        self.assertEqual(previous.ends_on, date(2026, 2, 28))
        self.assertEqual(created.data["GB_Ma"], "GB0002")
        self.assertIsNone(created.data["GB_NgayKT"])

        active = self.client.get(
            f"/api/catalog/products/{product.code}/active-price/?date=2026-03-01"
        )
        self.assertEqual(active.status_code, status.HTTP_200_OK)
        self.assertEqual(active.data["GB_DonGia"], 15000)
        self.assertEqual(active.data["GB_Ma"], created.data["GB_Ma"])

    def test_overlapping_active_price_is_rejected_without_mutating_previous(self):
        self.authenticate_as(self.owner)
        product = self.create_product()
        previous = self.create_price(product)

        response = self.client.post(
            "/api/catalog/prices/",
            {
                "HH_Ma": product.code,
                "GB_DonGia": 9000,
                "GB_NgayBD": "2026-01-01",
                "GB_NgayKT": "2026-06-30",
                "GB_TrangThai": SalePrice.Status.ACTIVE,
            },
            format="json",
        )

        previous.refresh_from_db()
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(previous.ends_on, date(2026, 12, 31))
        self.assertEqual(product.sale_prices.count(), 1)

    def test_price_dates_amount_status_and_end_action_validation(self):
        self.authenticate_as(self.owner)
        product = self.create_product()
        invalid = self.client.post(
            "/api/catalog/prices/",
            {
                "HH_Ma": product.code,
                "GB_DonGia": -1,
                "GB_NgayBD": "2026-04-02",
                "GB_NgayKT": "2026-04-01",
                "GB_TrangThai": "Chờ duyệt",
            },
            format="json",
        )
        self.assertEqual(invalid.status_code, status.HTTP_400_BAD_REQUEST)

        price = self.create_price(product)
        ended = self.client.post(
            f"/api/catalog/prices/{price.code}/end/",
            {"GB_NgayKT": "2025-12-31"},
            format="json",
        )
        self.assertEqual(ended.status_code, status.HTTP_400_BAD_REQUEST)
        ended = self.client.post(
            f"/api/catalog/prices/{price.code}/end/",
            {"GB_NgayKT": "2026-05-01"},
            format="json",
        )
        self.assertEqual(ended.status_code, status.HTTP_200_OK)
        self.assertEqual(ended.data["GB_NgayKT"], "2026-05-01")
        self.assertEqual(ended.data["GB_TrangThai"], SalePrice.Status.ACTIVE)

    def test_ending_price_cannot_extend_into_another_active_price(self):
        self.authenticate_as(self.owner)
        product = self.create_product()
        first = self.create_price(
            product,
            starts_on=date(2026, 1, 1),
            ends_on=date(2026, 3, 31),
        )
        self.create_price(
            product,
            amount=15000,
            starts_on=date(2026, 4, 1),
            ends_on=None,
        )

        response = self.client.post(
            f"/api/catalog/prices/{first.code}/end/",
            {"GB_NgayKT": "2026-04-15"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        first.refresh_from_db()
        self.assertEqual(first.ends_on, date(2026, 3, 31))

    def test_discontinued_price_is_not_selected_as_active_price(self):
        self.authenticate_as(self.owner)
        product = self.create_product()
        self.create_price(product, status=SalePrice.Status.INACTIVE)

        active = self.client.get(
            f"/api/catalog/products/{product.code}/active-price/?date=2026-06-01"
        )
        self.assertEqual(active.status_code, status.HTTP_200_OK)
        self.assertIsNone(active.data["GB_DonGia"])
        self.assertIn("Không có giá", active.data["error"])

    def test_search_filter_and_pagination(self):
        self.authenticate_as(self.owner)
        self.create_product(name="Chai nước số 1", barcode="111")
        self.create_product(name="Chai nước số 2", barcode="222")
        response = self.client.get(
            f"/api/catalog/products/?DM_Ma={self.category.code}&search=Chai&page_size=1"
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["count"], 2)
        self.assertEqual(len(response.data["results"]), 1)
        self.assertIsNotNone(response.data["next"])

    def test_catalog_requires_token_and_write_requires_owner(self):
        for endpoint in (
            "/api/catalog/categories/",
            "/api/catalog/products/",
            "/api/catalog/prices/",
        ):
            with self.subTest(endpoint=endpoint):
                self.assertEqual(
                    self.client.get(endpoint).status_code,
                    status.HTTP_401_UNAUTHORIZED,
                )

        self.authenticate_as(self.worker)
        self.assertEqual(
            self.client.get("/api/catalog/products/").status_code,
            status.HTTP_200_OK,
        )
        response = self.client.post(
            "/api/catalog/categories/",
            {"DM_Ten": "Worker category"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(Category.objects.count(), 1)

    def test_conversion_services_validate_boundaries(self):
        self.assertEqual(to_base_quantity(3, 6), 18)
        self.assertEqual(to_base_unit_price(12000, 6), 2000)
        for quantity, ratio in ((0, 6), (-1, 6), (1.5, 6), (1, 0), (1, True)):
            with self.subTest(quantity=quantity, ratio=ratio):
                with self.assertRaises(ValueError):
                    to_base_quantity(quantity, ratio)
        with self.assertRaises(ValueError):
            to_base_unit_price(10000, 6)
        with self.assertRaises(ValueError):
            to_base_unit_price(9_007_199_254_740_992, 1)
        with self.assertRaises(ValueError):
            to_base_quantity(9_007_199_254_740_991, 2)
