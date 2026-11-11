from datetime import date
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from rest_framework import status
from rest_framework.authtoken.models import Token
from rest_framework.test import APITestCase

from apps.accounts.constants import STORE_OWNER_ROLE
from apps.accounts.models import Employee
from apps.catalog.models import Category, Product
from apps.partners.models import Partner

from .models import PurchaseOrder, PurchaseOrderLine
from .services import (
    cancel_purchase_order,
    confirm_purchase_order,
    create_purchase_order,
    get_order_for_receiving,
    get_order_receiving_summary,
    sync_receipt_progress,
    update_purchase_order,
)

User = get_user_model()


class PurchaseOrderApiTests(APITestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="order-owner", password="test")
        self.owner.groups.add(Group.objects.get(name=STORE_OWNER_ROLE))
        self.worker = User.objects.create_user(username="order-worker", password="test")
        self.worker.groups.add(Group.objects.get(name="Nhân viên kho"))
        self.supplier = Partner.objects.create(
            name="Nhà cung cấp", phone="0900000201", role=Partner.Role.SUPPLIER
        )
        self.both_partner = Partner.objects.create(
            name="Đối tác hai vai trò",
            phone="0900000202",
            role=Partner.Role.BOTH,
        )
        self.customer = Partner.objects.create(
            name="Khách hàng",
            phone="0900000203",
            role=Partner.Role.CUSTOMER,
        )
        self.employee = Employee.objects.create(
            full_name="Nhân viên lập đơn",
            is_active=True,
        )
        self.category = Category.objects.create(name="Hàng mẫu")
        self.product = Product.objects.create(
            category=self.category,
            name="Sản phẩm đóng gói",
            base_unit="Chai",
            package_unit="Thùng",
            package_ratio=6,
        )
        self.other_product = Product.objects.create(
            category=self.category,
            name="Sản phẩm khác",
            base_unit="Gói",
        )

    def authenticate_as(self, user):
        token, _ = Token.objects.get_or_create(user=user)
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {token.key}")

    def payload(self, **overrides):
        values = {
            "DT_Ma": self.supplier.code,
            "NV_Ma": self.employee.code,
            "DH_Ngay": "2026-11-10",
            "lines": [
                {
                    "HH_Ma": self.product.code,
                    "DN_SL": 2,
                    "DN_DonGia": 12000,
                    "DN_DonVi": 6,
                },
                {
                    "HH_Ma": self.other_product.code,
                    "DN_SL": 3,
                    "DN_DonGia": 500,
                },
            ],
        }
        values.update(overrides)
        return values

    def create_order(self, payload=None):
        self.authenticate_as(self.owner)
        response = self.client.post(
            "/api/purchasing/orders/", payload or self.payload(), format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        return response

    def test_create_order_converts_units_and_calculates_totals(self):
        response = self.create_order()

        self.assertEqual(response.data["DH_Ma"], "DH0001")
        self.assertEqual(response.data["DH_TrangThai"], PurchaseOrder.Status.DRAFT)
        self.assertEqual(response.data["DH_TongSL"], 15)
        self.assertEqual(response.data["DH_TongTien"], 25500)
        self.assertEqual(
            response.data["lines"][0],
            {
                "HH_Ma": self.product.code,
                "HH_Ten": self.product.name,
                "DN_DVi": "Chai",
                "DN_SL": 12,
                "DN_DonGia": 2000,
                "DN_TTien": 24000,
            },
        )
        self.assertEqual(PurchaseOrder.objects.count(), 1)
        self.assertEqual(PurchaseOrderLine.objects.count(), 2)

    def test_supplier_must_exist_be_active_and_have_supplier_role(self):
        self.authenticate_as(self.owner)
        missing = self.client.post(
            "/api/purchasing/orders/",
            self.payload(DT_Ma="DT9999"),
            format="json",
        )
        customer = self.client.post(
            "/api/purchasing/orders/",
            self.payload(DT_Ma=self.customer.code),
            format="json",
        )
        self.supplier.status = Partner.Status.INACTIVE
        self.supplier.save()
        inactive = self.client.post(
            "/api/purchasing/orders/",
            self.payload(DT_Ma=self.supplier.code),
            format="json",
        )
        both = self.client.post(
            "/api/purchasing/orders/",
            self.payload(DT_Ma=self.both_partner.code),
            format="json",
        )
        self.assertEqual(missing.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(customer.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(inactive.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(both.status_code, status.HTTP_201_CREATED, both.data)

    def test_employee_date_and_product_validation(self):
        self.authenticate_as(self.owner)
        inactive_employee = Employee.objects.create(
            full_name="Nghỉ việc", is_active=False
        )
        invalid_employee = self.client.post(
            "/api/purchasing/orders/",
            self.payload(NV_Ma=inactive_employee.code),
            format="json",
        )
        invalid_date = self.client.post(
            "/api/purchasing/orders/",
            self.payload(DH_Ngay="2026-02-30"),
            format="json",
        )
        invalid_product = self.client.post(
            "/api/purchasing/orders/",
            self.payload(
                lines=[{"HH_Ma": "HH9999", "DN_SL": 1, "DN_DonGia": 0}]
            ),
            format="json",
        )
        self.product.status = Product.Status.INACTIVE
        self.product.save()
        inactive_product = self.client.post(
            "/api/purchasing/orders/",
            self.payload(
                lines=[
                    {"HH_Ma": self.product.code, "DN_SL": 1, "DN_DonGia": 0}
                ]
            ),
            format="json",
        )
        self.assertEqual(invalid_employee.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(invalid_date.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(invalid_product.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(inactive_product.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(PurchaseOrder.objects.count(), 0)

    def test_lines_require_unique_products_positive_integer_quantity_and_valid_price(self):
        self.authenticate_as(self.owner)
        duplicate = self.client.post(
            "/api/purchasing/orders/",
            self.payload(
                lines=[
                    {"HH_Ma": self.product.code, "DN_SL": 1, "DN_DonGia": 0},
                    {"HH_Ma": self.product.code, "DN_SL": 2, "DN_DonGia": 0},
                ]
            ),
            format="json",
        )
        invalid_quantity = self.client.post(
            "/api/purchasing/orders/",
            self.payload(
                lines=[
                    {"HH_Ma": self.product.code, "DN_SL": 0, "DN_DonGia": 0}
                ]
            ),
            format="json",
        )
        bool_quantity = self.client.post(
            "/api/purchasing/orders/",
            self.payload(
                lines=[
                    {"HH_Ma": self.product.code, "DN_SL": True, "DN_DonGia": 0}
                ]
            ),
            format="json",
        )
        negative_price = self.client.post(
            "/api/purchasing/orders/",
            self.payload(
                lines=[
                    {"HH_Ma": self.product.code, "DN_SL": 1, "DN_DonGia": -1}
                ]
            ),
            format="json",
        )
        self.assertEqual(duplicate.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(invalid_quantity.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(bool_quantity.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(negative_price.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(PurchaseOrder.objects.count(), 0)

    def test_pack_price_must_divide_exactly_by_conversion_ratio(self):
        self.authenticate_as(self.owner)
        response = self.client.post(
            "/api/purchasing/orders/",
            self.payload(
                lines=[
                    {
                        "HH_Ma": self.product.code,
                        "DN_SL": 1,
                        "DN_DonGia": 12001,
                        "DN_DonVi": 6,
                    }
                ]
            ),
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(PurchaseOrder.objects.count(), 0)

    def test_create_failure_rolls_back_order_and_lines(self):
        self.authenticate_as(self.owner)
        with patch(
            "apps.purchasing.services.PurchaseOrderLine.objects.bulk_create",
            side_effect=RuntimeError("simulated line insert failure"),
        ):
            with self.assertRaises(RuntimeError):
                self.client.post(
                    "/api/purchasing/orders/", self.payload(), format="json"
                )
        self.assertEqual(PurchaseOrder.objects.count(), 0)
        self.assertEqual(PurchaseOrderLine.objects.count(), 0)

    def test_edit_only_draft_and_recalculates_all_totals(self):
        created = self.create_order()
        code = created.data["DH_Ma"]
        response = self.client.patch(
            f"/api/purchasing/orders/{code}/",
            {
                "lines": [
                    {
                        "HH_Ma": self.product.code,
                        "DN_SL": 1,
                        "DN_DonGia": 6000,
                        "DN_DonVi": 6,
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        self.assertEqual(response.data["DH_TongSL"], 6)
        self.assertEqual(response.data["DH_TongTien"], 6000)
        self.assertEqual(response.data["lines"][0]["DN_SL"], 6)
        self.assertEqual(PurchaseOrderLine.objects.filter(order__code=code).count(), 1)

    def test_confirm_transitions_once_without_inventory_effects(self):
        created = self.create_order()
        code = created.data["DH_Ma"]
        confirmed = self.client.post(
            f"/api/purchasing/orders/{code}/confirm/", {}, format="json"
        )
        repeated = self.client.post(
            f"/api/purchasing/orders/{code}/confirm/", {}, format="json"
        )
        self.assertEqual(confirmed.status_code, status.HTTP_200_OK)
        self.assertEqual(confirmed.data["DH_TrangThai"], PurchaseOrder.Status.WAITING)
        self.assertEqual(repeated.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(PurchaseOrder.objects.get(code=code).status, PurchaseOrder.Status.WAITING)

    def test_cancel_draft_or_waiting_and_reject_terminal_or_partial(self):
        draft = self.create_order()
        cancelled = self.client.post(
            f"/api/purchasing/orders/{draft.data['DH_Ma']}/cancel/", {}, format="json"
        )
        self.assertEqual(cancelled.status_code, status.HTTP_200_OK)
        self.assertEqual(cancelled.data["DH_TrangThai"], PurchaseOrder.Status.CANCELLED)
        self.assertEqual(
            self.client.post(
                f"/api/purchasing/orders/{draft.data['DH_Ma']}/cancel/", {}, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        waiting = self.create_order()
        self.client.post(
            f"/api/purchasing/orders/{waiting.data['DH_Ma']}/confirm/", {}, format="json"
        )
        self.assertEqual(
            self.client.post(
                f"/api/purchasing/orders/{waiting.data['DH_Ma']}/cancel/",
                {},
                format="json",
            ).status_code,
            status.HTTP_200_OK,
        )
        order = PurchaseOrder.objects.get(code=waiting.data["DH_Ma"])
        order.status = PurchaseOrder.Status.PARTIAL
        order.save(update_fields=("status",))
        with self.assertRaises(ValueError):
            cancel_purchase_order(order.code)

    def test_no_token_and_insufficient_write_permission(self):
        no_token = self.client.get("/api/purchasing/orders/")
        self.assertEqual(no_token.status_code, status.HTTP_401_UNAUTHORIZED)
        self.authenticate_as(self.worker)
        self.assertEqual(
            self.client.get("/api/purchasing/orders/").status_code,
            status.HTTP_200_OK,
        )
        create = self.client.post(
            "/api/purchasing/orders/", self.payload(), format="json"
        )
        self.assertEqual(create.status_code, status.HTTP_403_FORBIDDEN)

    def test_list_filters_and_detail_use_business_code(self):
        created = self.create_order()
        code = created.data["DH_Ma"]
        listing = self.client.get(
            f"/api/purchasing/orders/?search={self.supplier.name}&DT_Ma={self.supplier.code}&status=Nháp"
        )
        detail = self.client.get(f"/api/purchasing/orders/{code}/")
        invalid_date = self.client.get("/api/purchasing/orders/?from=not-a-date")
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertEqual(listing.data["count"], 1)
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        self.assertEqual(detail.data["DH_Ma"], code)
        self.assertEqual(invalid_date.status_code, status.HTTP_400_BAD_REQUEST)


class PurchaseOrderInventoryInterfaceTests(APITestCase):
    def setUp(self):
        self.supplier = Partner.objects.create(
            name="NCC", role=Partner.Role.SUPPLIER
        )
        self.employee = Employee.objects.create(full_name="Nhân viên")
        category = Category.objects.create(name="Đồ khô")
        self.product = Product.objects.create(
            category=category, name="Gạo", base_unit="Kg"
        )
        self.order = create_purchase_order(
            supplier_code=self.supplier.code,
            employee_code=self.employee.code,
            ordered_on=date(2026, 11, 10),
            lines=[
                {"HH_Ma": self.product.code, "DN_SL": 10, "DN_DonGia": 1000}
            ],
        )
        confirm_purchase_order(self.order.code)
        self.order.refresh_from_db()

    def test_receipt_summary_counts_confirmed_reserved_and_cancelled_documents(self):
        receipts = [
            {
                "PN_TrangThai": "Đã xác nhận",
                "lines": [{"HH_Ma": self.product.code, "PNCT_SL": 3}],
            },
            {
                "PN_TrangThai": "Nháp",
                "lines": [{"HH_Ma": self.product.code, "PNCT_SL": 2}],
            },
            {
                "PN_TrangThai": "Chờ kế toán xác nhận",
                "lines": [{"HH_Ma": self.product.code, "PNCT_SL": 1}],
            },
            {
                "PN_TrangThai": "Đã hủy",
                "lines": [{"HH_Ma": self.product.code, "PNCT_SL": 4}],
            },
        ]
        summary = get_order_receiving_summary(self.order, receipts)
        line = summary["lines"][0]
        self.assertEqual(summary["status"], PurchaseOrder.Status.PARTIAL)
        self.assertEqual(summary["received_quantity"], 3)
        self.assertEqual(line["remaining"], 7)
        self.assertEqual(line["pending"], 3)
        self.assertEqual(line["available_to_receive"], 4)

    def test_receive_eligibility_and_status_sync_use_supplied_receipt_records(self):
        self.assertEqual(get_order_for_receiving(self.order.code).pk, self.order.pk)
        complete = sync_receipt_progress(
            self.order.code,
            [
                {
                    "status": "Đã xác nhận",
                    "lines": [{"product_code": self.product.code, "quantity": 10}],
                }
            ],
        )
        self.assertEqual(complete["status"], PurchaseOrder.Status.COMPLETE)
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, PurchaseOrder.Status.COMPLETE)
        with self.assertRaises(ValueError):
            get_order_for_receiving(self.order.code)

    def test_receipt_progress_rejects_unknown_items_and_over_receipt(self):
        with self.assertRaises(ValueError):
            get_order_receiving_summary(
                self.order,
                [
                    {
                        "status": "Đã xác nhận",
                        "lines": [{"product_code": "HH9999", "quantity": 1}],
                    }
                ],
            )
        with self.assertRaises(ValueError):
            get_order_receiving_summary(
                self.order,
                [
                    {
                        "status": "Đã xác nhận",
                        "lines": [{"product_code": self.product.code, "quantity": 11}],
                    }
                ],
            )
