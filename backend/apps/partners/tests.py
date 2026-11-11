from importlib import import_module
from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.exceptions import ValidationError
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from apps.accounts.constants import STORE_OWNER_ROLE
from apps.suppliers.models import Supplier
from apps.suppliers.serializers import SupplierSerializer
from apps.suppliers.services import (
    get_active_supplier,
    get_supplier,
    supplier_is_selectable,
)

from .models import Partner
from .services import (
    create_partner,
    find_partner_by_phone,
    get_partner,
    save_customer_partner,
    update_partner,
)

User = get_user_model()


class PartnerDataMigrationTests(TestCase):
    def test_supplier_rows_are_copied_with_code_and_legacy_table_preserved(self):
        created_at = timezone.now()
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO suppliers_supplier
                    (id, code, name, phone, address, bank_account, status, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                [
                    98765,
                    "DT9876",
                    "Legacy supplier",
                    "0900000199",
                    "Address",
                    "Bank",
                    "Hoạt động",
                    created_at,
                    created_at,
                ],
            )

        migration = import_module("apps.partners.migrations.0001_initial")
        historical_apps = MigrationLoader(connection).project_state(
            [("partners", "0001_initial")]
        ).apps
        migration.migrate_suppliers(
            historical_apps, SimpleNamespace(connection=connection)
        )
        phone_key_migration = import_module(
            "apps.partners.migrations.0002_partner_phone_key"
        )
        phone_key_apps = MigrationLoader(connection).project_state(
            [("partners", "0002_partner_phone_key")]
        ).apps
        phone_key_migration.populate_phone_keys(
            phone_key_apps, SimpleNamespace(connection=connection)
        )

        partner = Partner.objects.get(pk=98765)
        self.assertEqual(partner.code, "DT9876")
        self.assertEqual(partner.role, Partner.Role.SUPPLIER)
        self.assertEqual(partner.phone, "0900000199")
        self.assertEqual(partner.phone_key, "0900000199")
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) FROM suppliers_supplier WHERE id = %s", [98765]
            )
            self.assertEqual(cursor.fetchone()[0], 1)


class PartnerTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="partner-owner", password="test")
        self.owner.groups.add(Group.objects.get(name=STORE_OWNER_ROLE))
        self.seller = User.objects.create_user(
            username="partner-seller", password="test"
        )
        self.seller.groups.add(Group.objects.get(name="Nhân viên bán hàng"))
        self.warehouse = User.objects.create_user(
            username="partner-warehouse", password="test"
        )
        self.warehouse.groups.add(Group.objects.get(name="Nhân viên kho"))

    def authenticate_as(self, user):
        token, _ = Token.objects.get_or_create(user=user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")

    def test_supplier_customer_and_both_roles_share_one_partner_record(self):
        supplier = Supplier.objects.create(name="NCC", phone="0900000101")
        customer = save_customer_partner(
            user=self.seller,
            name="Khách hàng",
            phone="0900000102",
        )
        both = create_partner(
            user=self.owner,
            name="Đối tác hai vai trò",
            phone="0900000103",
            role=Partner.Role.BOTH,
        )

        self.assertEqual(supplier.role, Partner.Role.SUPPLIER)
        self.assertEqual(customer.role, Partner.Role.CUSTOMER)
        self.assertEqual(both.role, Partner.Role.BOTH)
        self.assertEqual(
            Partner.objects.filter(code__in=(supplier.code, customer.code, both.code))
            .count(),
            3,
        )
        self.assertEqual(Supplier.objects.count(), 2)

    def test_customer_creation_promotes_supplier_by_phone_without_new_code(self):
        supplier = Supplier.objects.create(name="Công ty", phone="0900000104")

        promoted = save_customer_partner(
            user=self.seller,
            name="Công ty khách hàng",
            phone="0900000104",
        )

        self.assertEqual(promoted.pk, supplier.pk)
        self.assertEqual(promoted.code, supplier.code)
        self.assertEqual(promoted.role, Partner.Role.BOTH)
        self.assertEqual(Partner.objects.filter(phone="0900000104").count(), 1)

    def test_phone_is_unique_across_all_partner_roles(self):
        supplier = Supplier.objects.create(name="NCC", phone="0900000105")

        with self.assertRaisesRegex(ValueError, "đã được sử dụng"):
            create_partner(
                user=self.owner,
                name="Khách hàng trùng",
                phone="0900000105",
                role=Partner.Role.CUSTOMER,
            )
        self.assertIsNone(find_partner_by_phone(""))
        self.assertEqual(
            find_partner_by_phone("0900000105").role, Partner.Role.SUPPLIER
        )
        promoted = save_customer_partner(
            user=self.seller, name="NCC kiêm khách hàng", phone=supplier.phone
        )
        self.assertEqual(promoted.code, supplier.code)
        self.assertEqual(promoted.role, Partner.Role.BOTH)

    def test_phone_uniqueness_uses_case_insensitive_fe_normalization(self):
        create_partner(
            user=self.owner,
            name="NCC",
            phone="Vendor-A",
            role=Partner.Role.SUPPLIER,
        )

        with self.assertRaisesRegex(ValueError, "đã được sử dụng"):
            create_partner(
                user=self.owner,
                name="Khách hàng",
                phone="vendor-a",
                role=Partner.Role.CUSTOMER,
            )

    def test_supplier_api_phone_validation_uses_all_partner_roles(self):
        save_customer_partner(
            user=self.seller, name="Khách hàng", phone="0900000108"
        )
        serializer = SupplierSerializer(data={"DT_Ten": "NCC", "DT_SDT": "0900000108"})

        self.assertFalse(serializer.is_valid())
        self.assertIn("DT_SDT", serializer.errors)

    def test_partner_codes_are_allocated_globally_and_stable(self):
        customer = save_customer_partner(
            user=self.seller,
            name="Khách hàng",
        )
        supplier = Supplier.objects.create(name="NCC")
        original_code = customer.code

        customer.name = "Khách hàng sửa"
        customer.save()
        self.assertEqual(customer.code, original_code)
        customer.code = supplier.code
        with self.assertRaises(ValidationError):
            customer.save()
        customer.code = original_code
        self.assertNotEqual(customer.code, supplier.code)
        self.assertEqual(
            Partner.objects.filter(code__in=(customer.code, supplier.code)).count(),
            2,
        )

    def test_role_and_status_can_be_changed_by_owner(self):
        customer = save_customer_partner(user=self.seller, name="Khách hàng")

        updated = update_partner(
            user=self.owner,
            code=customer.code,
            role=Partner.Role.BOTH,
            status=Partner.Status.INACTIVE,
        )

        self.assertEqual(updated.role, Partner.Role.BOTH)
        self.assertEqual(updated.status, Partner.Status.INACTIVE)

    def test_partner_service_enforces_permissions(self):
        with self.assertRaises(PermissionError):
            create_partner(
                user=self.warehouse,
                name="No permission",
                role=Partner.Role.SUPPLIER,
            )
        with self.assertRaises(PermissionError):
            save_customer_partner(user=self.warehouse, name="No permission")
        customer = save_customer_partner(user=self.seller, name="Allowed customer")
        self.assertEqual(customer.role, Partner.Role.CUSTOMER)

    def test_customer_service_rejects_duplicate_customer_phone(self):
        save_customer_partner(
            user=self.seller,
            name="Khách thứ nhất",
            phone="0900000106",
        )
        with self.assertRaisesRegex(ValueError, "đã được gắn với một khách hàng"):
            save_customer_partner(
                user=self.seller,
                name="Khách trùng",
                phone="0900000106",
            )

    def test_customer_service_cannot_repurpose_supplier_code(self):
        supplier = Supplier.objects.create(name="NCC")

        with self.assertRaisesRegex(ValueError, "chưa có vai trò khách hàng"):
            save_customer_partner(
                user=self.seller,
                code=supplier.code,
                name="Đổi sai vai trò",
            )

    def test_authenticated_partner_api_lists_shared_records_read_only(self):
        supplier = Supplier.objects.create(name="NCC API")
        customer = save_customer_partner(user=self.seller, name="KH API")
        response_without_token = self.client.get("/api/partners/")
        self.assertEqual(
            response_without_token.status_code, status.HTTP_401_UNAUTHORIZED
        )

        self.authenticate_as(self.owner)
        listing = self.client.get("/api/partners/")
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertEqual(listing.data["count"], 2)
        self.assertEqual(
            {row["DT_Ma"]: row["DT_Loai"] for row in listing.data["results"]},
            {supplier.code: Partner.Role.SUPPLIER, customer.code: Partner.Role.CUSTOMER},
        )
        detail = self.client.get(f"/api/partners/{supplier.code}/")
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        self.assertEqual(detail.data["DT_Ma"], supplier.code)
        self.assertEqual(
            self.client.post("/api/partners/", {}, format="json").status_code,
            status.HTTP_405_METHOD_NOT_ALLOWED,
        )

    def test_supplier_service_interfaces_only_return_supplier_roles(self):
        supplier = Supplier.objects.create(name="NCC", phone="0900000107")
        customer = save_customer_partner(user=self.seller, name="KH")
        both = create_partner(
            user=self.owner, name="Cả hai", role=Partner.Role.BOTH
        )

        self.assertEqual(get_supplier(supplier.code).pk, supplier.pk)
        self.assertEqual(get_active_supplier(both.code).pk, both.pk)
        self.assertTrue(supplier_is_selectable(supplier.code))
        self.assertFalse(supplier_is_selectable(customer.code))
        self.assertTrue(supplier_is_selectable(both.code))

        supplier.status = Partner.Status.INACTIVE
        supplier.save()
        self.assertFalse(supplier_is_selectable(supplier.code))
        with self.assertRaises(Partner.DoesNotExist):
            get_active_supplier(supplier.code)
        with self.assertRaises(Partner.DoesNotExist):
            get_supplier(customer.code)
        self.assertEqual(get_partner(both.code).role, Partner.Role.BOTH)
