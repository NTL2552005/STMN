from datetime import date, timedelta
from threading import Barrier, Thread
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.db import close_old_connections, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from apps.accounts.constants import STORE_OWNER_ROLE
from apps.accounts.models import Employee
from apps.catalog.models import Category, Product
from apps.partners.models import Partner
from apps.purchasing.models import PurchaseOrder, PurchaseOrderLine

from .models import (
    GoodsReceipt,
    GoodsReceiptLine,
    StockCount,
    StockBalance,
    StockMovement,
    StockTransfer,
    SupplierReturn,
    SupplierReturnLine,
    StorageLocation,
)

User = get_user_model()


class InventoryApiTests(APITestCase):
    def setUp(self):
        self.owner_group = Group.objects.get(name=STORE_OWNER_ROLE)
        self.warehouse_group, _ = Group.objects.get_or_create(name="Nhân viên kho")
        self.accountant_group, _ = Group.objects.get_or_create(name="Nhân viên kế toán")
        self.sales_group, _ = Group.objects.get_or_create(name="Nhân viên bán hàng")

        self.warehouse_user = User.objects.create_user(
            username="inventory-warehouse", password="Warehouse-test-pass-2026!"
        )
        self.warehouse_user.groups.add(self.warehouse_group)
        self.warehouse = Employee.objects.create(
            full_name="Nhân viên kho", user=self.warehouse_user
        )
        self.accountant_user = User.objects.create_user(
            username="inventory-accountant", password="Accountant-test-pass-2026!"
        )
        self.accountant_user.groups.add(self.accountant_group)
        self.accountant = Employee.objects.create(
            full_name="Nhân viên kế toán", user=self.accountant_user
        )
        self.owner_user = User.objects.create_user(
            username="inventory-owner", password="Owner-test-pass-2026!"
        )
        self.owner_user.groups.add(self.owner_group)
        self.owner = Employee.objects.create(
            full_name="Chủ cửa hàng", user=self.owner_user
        )
        self.other_user = User.objects.create_user(
            username="inventory-viewer", password="Viewer-test-pass-2026!"
        )
        self.viewer = Employee.objects.create(
            full_name="Nhân viên bán hàng", user=self.other_user
        )
        self.other_user.groups.add(self.sales_group)

        self.category = Category.objects.create(name="Hàng nhập")
        self.product = Product.objects.create(
            category=self.category,
            name="Sản phẩm nhập",
            base_unit="Cái",
            package_unit="Thùng",
            package_ratio=6,
        )
        self.second_product = Product.objects.create(
            category=self.category, name="Sản phẩm khác", base_unit="Hộp"
        )
        self.supplier = Partner.objects.create(
            name="Nhà cung cấp hợp lệ", role=Partner.Role.SUPPLIER
        )
        self.customer = Partner.objects.create(
            name="Khách hàng", role=Partner.Role.CUSTOMER
        )
        self.inactive_supplier = Partner.objects.create(
            name="Nhà cung cấp đã ngừng",
            role=Partner.Role.SUPPLIER,
            status=Partner.Status.INACTIVE,
        )
        self.location = StorageLocation.objects.create(
            name="Kho trung tâm", kind=StorageLocation.Kind.WAREHOUSE
        )
        self.destination = StorageLocation.objects.create(
            name="Cửa hàng nhận", kind=StorageLocation.Kind.STORE
        )
        self.order = self.make_order(quantity=10)

        self.client.force_authenticate(self.warehouse_user)

    def make_order(self, *, quantity=10, status_value=PurchaseOrder.Status.WAITING):
        order = PurchaseOrder.objects.create(
            supplier=self.supplier,
            employee=self.warehouse,
            ordered_on=date(2026, 11, 10),
            status=status_value,
        )
        PurchaseOrderLine.objects.create(
            order=order,
            product=self.product,
            quantity=quantity,
            unit_price=100,
            amount=quantity * 100,
        )
        order.total_quantity = quantity
        order.total_amount = quantity * 100
        order.save(update_fields=("total_quantity", "total_amount"))
        return order

    def payload(self, *, quantity=4, order_code=None, product_code=None, **changes):
        payload = {
            "DT_Ma": self.supplier.code,
            "DD_Ma": self.location.code,
            "PN_Ngay": "2026-11-10",
            "NV_Ma": self.warehouse.code,
            "lines": [
                {
                    "HH_Ma": product_code or self.product.code,
                    "PNCT_SL": quantity,
                    "PNCT_DonGia": 120,
                    "PNCT_NSX": "",
                    "PNCT_HSD": "2027-01-01",
                    "PNCT_HSDToiThieu": 30,
                }
            ],
        }
        if order_code is not None:
            payload["DH_Ma"] = order_code
        payload.update(changes)
        return payload

    def create_receipt(self, *, quantity=4, order_code=None, product_code=None, **changes):
        response = self.client.post(
            "/api/inventory/receipts/",
            self.payload(
                quantity=quantity,
                order_code=order_code,
                product_code=product_code,
                **changes,
            ),
            format="json",
        )
        return response

    def submit(self, receipt_code):
        return self.client.post(
            f"/api/inventory/receipts/{receipt_code}/submit/", {}, format="json"
        )

    def confirm_as_accountant(self, receipt_code):
        self.client.force_authenticate(self.accountant_user)
        return self.client.post(
            f"/api/inventory/receipts/{receipt_code}/confirm/", {}, format="json"
        )

    def test_create_draft_preserves_lot_fields_and_does_not_change_stock(self):
        response = self.create_receipt(order_code=self.order.code)

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        receipt = GoodsReceipt.objects.get(code=response.data["PN_Ma"])
        line = receipt.lines.get()
        self.assertEqual(receipt.status, GoodsReceipt.Status.DRAFT)
        self.assertEqual(receipt.total_quantity, 4)
        self.assertEqual(receipt.total_amount, 480)
        self.assertEqual(line.code, "PNCT0001")
        self.assertEqual(line.expiry_date, date(2027, 1, 1))
        self.assertEqual(line.minimum_expiry_days, 30)
        self.assertFalse(StockBalance.objects.exists())
        self.assertFalse(StockMovement.objects.exists())

    def test_create_without_purchase_order_is_supported(self):
        response = self.create_receipt()

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        self.assertIsNone(response.data["DH_Ma"])

    def test_supplier_must_have_supplier_role_and_match_order(self):
        response = self.create_receipt(DT_Ma=self.customer.code)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        inactive_order = PurchaseOrder.objects.create(
            supplier=self.inactive_supplier,
            employee=self.warehouse,
            ordered_on=date(2026, 11, 10),
            status=PurchaseOrder.Status.WAITING,
        )
        PurchaseOrderLine.objects.create(
            order=inactive_order,
            product=self.product,
            quantity=10,
            unit_price=100,
            amount=1000,
        )
        response = self.create_receipt(
            DT_Ma=self.inactive_supplier.code, order_code=inactive_order.code
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)

    def test_linked_order_must_be_receivable_and_supplier_must_match(self):
        draft_order = self.make_order(status_value=PurchaseOrder.Status.DRAFT)
        response = self.create_receipt(order_code=draft_order.code)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        other_supplier = Partner.objects.create(
            name="Nhà cung cấp khác", role=Partner.Role.SUPPLIER
        )
        other_order = PurchaseOrder.objects.create(
            supplier=other_supplier,
            employee=self.warehouse,
            ordered_on=date(2026, 11, 10),
            status=PurchaseOrder.Status.WAITING,
        )
        PurchaseOrderLine.objects.create(
            order=other_order,
            product=self.product,
            quantity=10,
            unit_price=100,
            amount=1000,
        )
        response = self.create_receipt(order_code=other_order.code)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_product_must_belong_to_order(self):
        response = self.create_receipt(
            order_code=self.order.code, product_code=self.second_product.code
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_package_quantity_and_price_are_converted_to_base_units(self):
        response = self.client.post(
            "/api/inventory/receipts/",
            self.payload(
                quantity=2,
                lines=[
                    {
                        "HH_Ma": self.product.code,
                        "PNCT_SL": 2,
                        "PNCT_DonGia": 720,
                        "PNCT_DViNhap": 6,
                    }
                ],
            ),
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        line = GoodsReceiptLine.objects.get(receipt__code=response.data["PN_Ma"])
        self.assertEqual((line.quantity, line.unit_price, line.amount), (12, 120, 1440))

    def test_invalid_quantity_money_date_and_conversion_are_rejected(self):
        invalid_lines = (
            {"HH_Ma": self.product.code, "PNCT_SL": 0, "PNCT_DonGia": 1},
            {"HH_Ma": self.product.code, "PNCT_SL": 1, "PNCT_DonGia": 1.5},
            {
                "HH_Ma": self.product.code,
                "PNCT_SL": 1,
                "PNCT_DonGia": 10,
                "PNCT_DViNhap": 6,
            },
            {
                "HH_Ma": self.product.code,
                "PNCT_SL": 1,
                "PNCT_DonGia": 1,
                "PNCT_NSX": "2027-01-02",
                "PNCT_HSD": "2027-01-01",
            },
        )
        for line in invalid_lines:
            with self.subTest(line=line):
                response = self.client.post(
                    "/api/inventory/receipts/",
                    self.payload(lines=[line]),
                    format="json",
                )
                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_order_reservations_include_draft_and_pending_receipts(self):
        first = self.create_receipt(quantity=6, order_code=self.order.code)
        self.assertEqual(first.status_code, status.HTTP_201_CREATED, first.data)
        second = self.create_receipt(quantity=5, order_code=self.order.code)
        self.assertEqual(second.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(GoodsReceipt.objects.count(), 1)

        response = self.submit(first.data["PN_Ma"])
        self.assertEqual(
            response.data["PN_TrangThai"], GoodsReceipt.Status.WAITING_ACCOUNTING
        )
        rejected = self.create_receipt(quantity=5, order_code=self.order.code)
        self.assertEqual(rejected.status_code, status.HTTP_400_BAD_REQUEST)

    def test_cancel_draft_releases_order_reservation(self):
        receipt = self.create_receipt(quantity=6, order_code=self.order.code)
        code = receipt.data["PN_Ma"]
        response = self.client.post(
            f"/api/inventory/receipts/{code}/cancel/", {}, format="json"
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        self.assertEqual(response.data["PN_TrangThai"], GoodsReceipt.Status.CANCELLED)
        replacement = self.create_receipt(quantity=10, order_code=self.order.code)
        self.assertEqual(replacement.status_code, status.HTTP_201_CREATED, replacement.data)

    def test_cannot_cancel_submitted_receipt_or_edit_non_draft(self):
        receipt = self.create_receipt(order_code=self.order.code)
        code = receipt.data["PN_Ma"]
        self.assertEqual(self.submit(code).status_code, status.HTTP_200_OK)
        response = self.client.post(
            f"/api/inventory/receipts/{code}/cancel/", {}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        response = self.client.patch(
            f"/api/inventory/receipts/{code}/",
            {"PN_Ngay": "2026-11-11"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_edit_draft_recalculates_totals_and_order_reservation(self):
        receipt = self.create_receipt(quantity=3, order_code=self.order.code)
        code = receipt.data["PN_Ma"]
        response = self.client.patch(
            f"/api/inventory/receipts/{code}/",
            {"lines": [{"HH_Ma": self.product.code, "PNCT_SL": 5, "PNCT_DonGia": 200}]},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        self.assertEqual(response.data["PN_TongSL"], 5)
        self.assertEqual(response.data["PN_TongTien"], 1000)
        self.assertEqual(response.data["lines"][0]["PNCT_Ma"], "PNCT0002")

    def test_warehouse_submits_but_only_accountant_or_owner_can_confirm(self):
        receipt = self.create_receipt(order_code=self.order.code)
        code = receipt.data["PN_Ma"]
        self.assertEqual(self.submit(code).status_code, status.HTTP_200_OK)
        denied = self.client.post(
            f"/api/inventory/receipts/{code}/confirm/", {}, format="json"
        )
        self.assertEqual(denied.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(StockMovement.objects.exists())

    def test_confirm_updates_stock_ledger_and_order_progress_atomically(self):
        receipt = self.create_receipt(quantity=4, order_code=self.order.code)
        code = receipt.data["PN_Ma"]
        self.submit(code)

        response = self.confirm_as_accountant(code)

        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        self.assertEqual(response.data["PN_TrangThai"], GoodsReceipt.Status.CONFIRMED)
        balance = StockBalance.objects.get()
        movement = StockMovement.objects.get()
        self.assertEqual(balance.quantity, 4)
        self.assertEqual(movement.quantity_delta, 4)
        self.assertEqual(movement.document_code, code)
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, PurchaseOrder.Status.PARTIAL)
        progress = self.client.get(
            f"/api/inventory/orders/{self.order.code}/receiving-progress/"
        )
        self.assertEqual(progress.data["total_received"], 4)
        self.assertEqual(progress.data["lines"][0]["available_to_receive"], 6)
        movement_list = self.client.get(
            f"/api/inventory/movements/?PNCT_Ma={response.data['lines'][0]['PNCT_Ma']}"
        )
        self.assertEqual(movement_list.data["count"], 1)
        self.assertEqual(movement_list.data["results"][0]["BDK_Nguon"], "PhieuNhap")

        duplicate = self.confirm_as_accountant(code)
        self.assertEqual(duplicate.status_code, status.HTTP_400_BAD_REQUEST)
        balance.refresh_from_db()
        self.assertEqual(balance.quantity, 4)
        self.assertEqual(StockMovement.objects.count(), 1)

    def test_multiple_receipts_can_receive_in_parts_then_complete_order(self):
        first = self.create_receipt(quantity=4, order_code=self.order.code)
        second = self.create_receipt(quantity=6, order_code=self.order.code)
        self.assertEqual(first.status_code, status.HTTP_201_CREATED, first.data)
        self.assertEqual(second.status_code, status.HTTP_201_CREATED, second.data)

        self.submit(first.data["PN_Ma"])
        self.submit(second.data["PN_Ma"])
        self.assertEqual(
            self.confirm_as_accountant(first.data["PN_Ma"]).status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            self.confirm_as_accountant(second.data["PN_Ma"]).status_code,
            status.HTTP_200_OK,
        )

        self.order.refresh_from_db()
        self.assertEqual(self.order.status, PurchaseOrder.Status.COMPLETE)
        self.assertEqual(
            sum(StockBalance.objects.values_list("quantity", flat=True)), 10
        )

    def test_confirmation_rolls_back_status_balance_and_ledger_on_failure(self):
        response = self.create_receipt(
            quantity=2,
            lines=[
                {"HH_Ma": self.product.code, "PNCT_SL": 2, "PNCT_DonGia": 100},
                {"HH_Ma": self.second_product.code, "PNCT_SL": 1, "PNCT_DonGia": 100},
            ],
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        code = response.data["PN_Ma"]
        self.submit(code)
        receipt = GoodsReceipt.objects.get(code=code)
        second_line = receipt.lines.order_by("pk")[1]
        StockMovement.objects.create(
            location=self.location,
            receipt_line=second_line,
            employee=self.warehouse,
            movement_type=StockMovement.Kind.INBOUND,
            quantity_delta=1,
            document_code="PREEXISTING",
        )

        result = self.confirm_as_accountant(code)

        self.assertEqual(result.status_code, status.HTTP_400_BAD_REQUEST)
        receipt.refresh_from_db()
        self.assertEqual(receipt.status, GoodsReceipt.Status.WAITING_ACCOUNTING)
        self.assertFalse(StockBalance.objects.exists())
        self.assertEqual(StockMovement.objects.count(), 1)

    def test_anonymous_and_unauthorized_users_are_rejected(self):
        self.client.force_authenticate(user=None)
        self.assertEqual(
            self.client.get("/api/inventory/receipts/").status_code,
            status.HTTP_401_UNAUTHORIZED,
        )

        self.client.force_authenticate(self.other_user)
        self.assertEqual(
            self.create_receipt().status_code, status.HTTP_403_FORBIDDEN
        )
        self.client.force_authenticate(self.owner_user)
        owner_receipt = self.create_receipt(NV_Ma=self.owner.code)
        self.assertEqual(
            owner_receipt.status_code, status.HTTP_201_CREATED, owner_receipt.data
        )
        self.assertEqual(self.submit(owner_receipt.data["PN_Ma"]).status_code, status.HTTP_200_OK)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/receipts/{owner_receipt.data['PN_Ma']}/confirm/",
                {},
                format="json",
            ).status_code,
            status.HTTP_200_OK,
        )
        self.client.force_authenticate(self.accountant_user)
        self.assertEqual(
            self.create_receipt().status_code, status.HTTP_403_FORBIDDEN
        )

    def test_employee_code_cannot_be_forged_and_missing_employee_is_rejected(self):
        response = self.create_receipt(NV_Ma=self.accountant.code)
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

        unlinked_user = User.objects.create_user(
            username="unlinked-warehouse", password="Warehouse-test-pass-2026!"
        )
        unlinked_user.groups.add(self.warehouse_group)
        self.client.force_authenticate(unlinked_user)
        response = self.create_receipt()
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_list_filters_and_location_stock_endpoints(self):
        response = self.create_receipt(order_code=self.order.code)
        code = response.data["PN_Ma"]
        listing = self.client.get(
            f"/api/inventory/receipts/?DH_Ma={self.order.code}&PN_TrangThai=Nháp"
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertEqual(listing.data["count"], 1)
        self.assertEqual(listing.data["results"][0]["PN_Ma"], code)
        self.assertEqual(len(self.client.get("/api/inventory/locations/").data), 2)
        self.assertEqual(self.client.get("/api/inventory/stock/").data["count"], 0)

    def create_confirmed_unlinked_receipt(self, *, quantity, expiry=None, threshold=None):
        line = {
            "HH_Ma": self.product.code,
            "PNCT_SL": quantity,
            "PNCT_DonGia": 100,
        }
        if expiry is not None:
            line["PNCT_HSD"] = expiry.isoformat()
        if threshold is not None:
            line["PNCT_HSDToiThieu"] = threshold
        response = self.create_receipt(
            quantity=quantity,
            lines=[line],
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        code = response.data["PN_Ma"]
        self.assertEqual(self.submit(code).status_code, status.HTTP_200_OK)
        confirmed = self.confirm_as_accountant(code)
        self.assertEqual(confirmed.status_code, status.HTTP_200_OK, confirmed.data)
        self.client.force_authenticate(self.warehouse_user)
        return confirmed.data

    def count_payload(self, line_code, book_quantity, actual_quantity, **changes):
        payload = {
            "DD_Ma": self.location.code,
            "NV_Ma": self.warehouse.code,
            "PKK_Ngay": timezone.localdate().isoformat(),
            "PKK_GhiChu": "Kiểm kê định kỳ",
            "lines": [
                {
                    "PNCT_Ma": line_code,
                    "PKKCT_SLSoSach": book_quantity,
                    "PKKCT_SLThucTe": actual_quantity,
                    "PKKCT_LyDo": "Đếm thực tế",
                }
            ],
        }
        payload.update(changes)
        return payload

    def create_stock_count(self, line_code, book_quantity, actual_quantity, **changes):
        return self.client.post(
            "/api/inventory/stock-counts/",
            self.count_payload(line_code, book_quantity, actual_quantity, **changes),
            format="json",
        )

    def submit_stock_count(self, count_code):
        return self.client.post(
            f"/api/inventory/stock-counts/{count_code}/submit/",
            {},
            format="json",
        )

    def approve_stock_count_as_owner(self, count_code):
        self.client.force_authenticate(self.owner_user)
        return self.client.post(
            f"/api/inventory/stock-counts/{count_code}/approve/",
            {},
            format="json",
        )

    def create_transfer_payload(self, lines, **changes):
        payload = {
            "DD_Xuat": self.location.code,
            "DD_Nhan": self.destination.code,
            "NV_Ma": self.accountant.code,
            "PXCN_Ngay": timezone.localdate().isoformat(),
            "PXCN_NguoiNhan": "Nhân viên cửa hàng",
            "lines": lines,
        }
        payload.update(changes)
        return payload

    def create_transfer(self, lines, **changes):
        self.client.force_authenticate(self.accountant_user)
        return self.client.post(
            "/api/inventory/transfers/",
            self.create_transfer_payload(lines, **changes),
            format="json",
        )

    def dispatch_transfer_as_warehouse(self, transfer_code):
        self.client.force_authenticate(self.warehouse_user)
        return self.client.post(
            f"/api/inventory/transfers/{transfer_code}/dispatch/",
            {},
            format="json",
        )

    def receive_transfer_as_sales(self, transfer_code, received_lines, **changes):
        self.client.force_authenticate(self.other_user)
        payload = {"lines": received_lines, **changes}
        return self.client.post(
            f"/api/inventory/transfers/{transfer_code}/receive/",
            payload,
            format="json",
        )

    def supplier_return_payload(self, receipt, line_code, quantity=4, **changes):
        payload = {
            "DT_Ma": self.supplier.code,
            "PN_Ma": receipt["PN_Ma"],
            "DD_Ma": self.location.code,
            "NV_Ma": self.warehouse.code,
            "TRNCC_Ngay": timezone.localdate().isoformat(),
            "TRNCC_LyDo": "Hàng hư hỏng",
            "TRNCC_GhiChu": "Kiểm tra theo FE",
            "lines": [{"PNCT_Ma": line_code, "TRNCC_SL": quantity}],
        }
        payload.update(changes)
        return payload

    def create_supplier_return(self, receipt, line_code, quantity=4, **changes):
        self.client.force_authenticate(self.warehouse_user)
        return self.client.post(
            "/api/inventory/supplier-returns/",
            self.supplier_return_payload(
                receipt, line_code, quantity=quantity, **changes
            ),
            format="json",
        )

    def submit_supplier_return(self, return_code):
        return self.client.post(
            f"/api/inventory/supplier-returns/{return_code}/submit/",
            {},
            format="json",
        )

    def approve_supplier_return_as_owner(self, return_code):
        self.client.force_authenticate(self.owner_user)
        return self.client.post(
            f"/api/inventory/supplier-returns/{return_code}/approve/",
            {},
            format="json",
        )

    def confirm_supplier_return_as_warehouse(self, return_code):
        self.client.force_authenticate(self.warehouse_user)
        return self.client.post(
            f"/api/inventory/supplier-returns/{return_code}/confirm/",
            {},
            format="json",
        )

    def test_supplier_return_follows_review_then_shipment_and_updates_stock_ledger(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]
        created = self.create_supplier_return(receipt, line_code, quantity=4)
        self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
        code = created.data["TRNCC_Ma"]
        self.assertEqual(created.data["TRNCC_TrangThai"], SupplierReturn.Status.DRAFT)
        self.assertEqual(created.data["TRNCC_TongTien"], 400)
        self.assertEqual(created.data["lines"][0]["TRNCC_DonGia"], 100)
        self.assertEqual(StockBalance.objects.get().quantity, 10)

        submitted = self.submit_supplier_return(code)
        self.assertEqual(submitted.status_code, status.HTTP_200_OK, submitted.data)
        self.assertEqual(
            submitted.data["TRNCC_TrangThai"], SupplierReturn.Status.WAITING_APPROVAL
        )
        approved = self.approve_supplier_return_as_owner(code)
        self.assertEqual(approved.status_code, status.HTTP_200_OK, approved.data)
        self.assertEqual(approved.data["TRNCC_TrangThai"], SupplierReturn.Status.APPROVED)
        self.assertEqual(StockBalance.objects.get().quantity, 10)

        shipped = self.confirm_supplier_return_as_warehouse(code)
        self.assertEqual(shipped.status_code, status.HTTP_200_OK, shipped.data)
        self.assertEqual(shipped.data["TRNCC_TrangThai"], SupplierReturn.Status.SHIPPED)
        self.assertEqual(shipped.data["NV_Xuat"], self.warehouse.code)
        self.assertEqual(StockBalance.objects.get().quantity, 6)
        movement = StockMovement.objects.get(source="TraHangNCC", document_code=code)
        self.assertEqual(movement.quantity_delta, -4)
        self.assertEqual(movement.receipt_line.code, line_code)
        self.assertEqual(movement.location, self.location)

        stock = self.client.get(
            f"/api/inventory/stock/?view=detail&DD_Ma={self.location.code}"
        )
        self.assertEqual(stock.status_code, status.HTTP_200_OK)
        self.assertEqual(stock.data["results"][0]["TK_SL"], 6)
        from .services import get_available_stock, get_stock_for_sale

        self.assertEqual(
            get_available_stock(self.product.code, self.location.code), 6
        )
        self.assertEqual(
            sum(
                row["quantity"]
                for row in get_stock_for_sale(self.product.code, self.location.code)
            ),
            6,
        )
        ledger = self.client.get(
            f"/api/inventory/movements/?BDK_MaChungTu={code}&BDK_Loai=Tr%E1%BA%A3%20NCC"
        )
        self.assertEqual(ledger.status_code, status.HTTP_200_OK)
        self.assertEqual(ledger.data["count"], 1)
        stock_ledger = self.client.get(
            "/api/inventory/stock-ledger/",
            {
                "HH_Ma": self.product.code,
                "DD_Ma": self.location.code,
                "PNCT_Ma": line_code,
                "from": "2020-01-01",
                "to": "2030-01-01",
            },
        )
        self.assertTrue(stock_ledger.data["complete"])
        self.assertEqual(stock_ledger.data["current"], 6)
        self.assertEqual(stock_ledger.data["outbound"], 4)
        expiry = self.client.get(
            f"/api/inventory/expiry/?DD_Ma={self.location.code}&PNCT_Ma={line_code}"
        )
        self.assertEqual(expiry.status_code, status.HTTP_200_OK)
        self.assertEqual(expiry.data["results"][0]["TK_SL"], 6)
        overview = self.client.get(
            f"/api/inventory/overview/?DD_Ma={self.location.code}"
        )
        self.assertEqual(overview.data["metrics"]["TK_TongSoLuongThucTe"], 6)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/supplier-returns/{code}/confirm/",
                {},
                format="json",
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertEqual(
            SupplierReturnLine.objects.get(supplier_return__code=code).quantity, 4
        )

    def test_supplier_return_allows_expired_lot_and_does_not_reserve_drafts(self):
        self.supplier.status = Partner.Status.INACTIVE
        self.supplier.save(update_fields=("status",))
        receipt = self.create_confirmed_unlinked_receipt(
            quantity=5, expiry=timezone.localdate() - timedelta(days=1)
        )
        line_code = receipt["lines"][0]["PNCT_Ma"]
        first = self.create_supplier_return(receipt, line_code, quantity=4)
        second = self.create_supplier_return(receipt, line_code, quantity=4)
        self.assertEqual(first.status_code, status.HTTP_201_CREATED, first.data)
        self.assertEqual(second.status_code, status.HTTP_201_CREATED, second.data)
        self.assertEqual(StockBalance.objects.get().quantity, 5)

        for response in (first, second):
            code = response.data["TRNCC_Ma"]
            self.assertEqual(self.submit_supplier_return(code).status_code, status.HTTP_200_OK)
            self.assertEqual(
                self.approve_supplier_return_as_owner(code).status_code,
                status.HTTP_200_OK,
            )
        successful = self.confirm_supplier_return_as_warehouse(
            first.data["TRNCC_Ma"]
        )
        self.assertEqual(successful.status_code, status.HTTP_200_OK, successful.data)
        rejected = self.confirm_supplier_return_as_warehouse(
            second.data["TRNCC_Ma"]
        )
        self.assertEqual(rejected.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(StockBalance.objects.get().quantity, 1)
        self.assertEqual(
            StockMovement.objects.filter(source="TraHangNCC").count(), 1
        )

    def test_supplier_return_supports_multiple_products_and_unit_conversion(self):
        self.product.package_ratio = 6
        self.product.save(update_fields=("package_ratio",))
        draft = self.create_receipt(
            quantity=14,
            lines=[
                {"HH_Ma": self.product.code, "PNCT_SL": 12, "PNCT_DonGia": 100},
                {
                    "HH_Ma": self.second_product.code,
                    "PNCT_SL": 2,
                    "PNCT_DonGia": 200,
                },
            ],
        )
        self.assertEqual(draft.status_code, status.HTTP_201_CREATED, draft.data)
        code = draft.data["PN_Ma"]
        self.assertEqual(self.submit(code).status_code, status.HTTP_200_OK)
        confirmed = self.confirm_as_accountant(code)
        self.assertEqual(confirmed.status_code, status.HTTP_200_OK, confirmed.data)
        self.client.force_authenticate(self.warehouse_user)
        line_codes = [line["PNCT_Ma"] for line in confirmed.data["lines"]]
        payload = self.supplier_return_payload(
            confirmed.data,
            line_codes[0],
            quantity=12,
            lines=[
                {
                    "PNCT_Ma": line_codes[0],
                    "TRNCC_SL": 12,
                    "TRNCC_SLNhap": 2,
                    "TRNCC_HeSo": 6,
                },
                {"PNCT_Ma": line_codes[1], "TRNCC_SL": 2},
            ],
        )
        created = self.client.post(
            "/api/inventory/supplier-returns/", payload, format="json"
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
        self.assertEqual(created.data["TRNCC_TongSL"], 14)
        self.assertEqual(created.data["TRNCC_TongTien"], 1600)
        self.assertEqual(created.data["lines"][0]["TRNCC_SLNhap"], 2)

        return_code = created.data["TRNCC_Ma"]
        self.assertEqual(
            self.submit_supplier_return(return_code).status_code, status.HTTP_200_OK
        )
        self.assertEqual(
            self.approve_supplier_return_as_owner(return_code).status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            self.confirm_supplier_return_as_warehouse(return_code).status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            list(
                StockBalance.objects.order_by("receipt_line__product__code")
                .values_list("quantity", flat=True)
            ),
            [0, 0],
        )
        self.assertEqual(
            StockMovement.objects.filter(
                source="TraHangNCC", document_code=return_code
            ).count(),
            2,
        )

    def test_supplier_return_can_participate_in_outer_accounting_transaction(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=5)
        created = self.create_supplier_return(
            receipt, receipt["lines"][0]["PNCT_Ma"], quantity=2
        )
        code = created.data["TRNCC_Ma"]
        self.submit_supplier_return(code)
        self.approve_supplier_return_as_owner(code)
        from .services import confirm_supplier_return

        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                confirm_supplier_return(code, confirmed_by=self.warehouse_user)
                raise RuntimeError("accounting update failed")
        self.assertEqual(StockBalance.objects.get().quantity, 5)
        self.assertEqual(
            SupplierReturn.objects.get(code=code).status,
            SupplierReturn.Status.APPROVED,
        )
        self.assertFalse(StockMovement.objects.filter(source="TraHangNCC").exists())

    def test_supplier_return_validation_and_draft_patch_delete(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]
        payload = self.supplier_return_payload(receipt, line_code)
        payload["DT_Ma"] = self.customer.code
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/", payload, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        payload = self.supplier_return_payload(receipt, "PNCT9999")
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/", payload, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        payload = self.supplier_return_payload(receipt, line_code, quantity=11)
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/", payload, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        for invalid_quantity in (0, 1.5):
            payload = self.supplier_return_payload(
                receipt, line_code, quantity=invalid_quantity
            )
            with self.subTest(quantity=invalid_quantity):
                self.assertEqual(
                    self.client.post(
                        "/api/inventory/supplier-returns/",
                        payload,
                        format="json",
                    ).status_code,
                    status.HTTP_400_BAD_REQUEST,
                )
        payload = self.supplier_return_payload(
            receipt,
            line_code,
            quantity=4,
            lines=[
                {
                    "PNCT_Ma": line_code,
                    "TRNCC_SL": 4,
                    "TRNCC_HeSo": 2,
                }
            ],
        )
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/", payload, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        payload = self.supplier_return_payload(
            receipt,
            line_code,
            quantity=4,
            lines=[
                {"PNCT_Ma": line_code, "TRNCC_SL": 4},
                {"PNCT_Ma": line_code, "TRNCC_SL": 1},
            ],
        )
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/", payload, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        payload = self.supplier_return_payload(
            receipt, line_code, quantity=2, TRNCC_LyDo="khác"
        )
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/", payload, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        created = self.create_supplier_return(receipt, line_code, quantity=2)
        code = created.data["TRNCC_Ma"]
        forged_price = self.create_supplier_return(
            receipt,
            line_code,
            quantity=1,
            lines=[
                {
                    "PNCT_Ma": line_code,
                    "TRNCC_SL": 1,
                    "TRNCC_DonGia": 1,
                    "TRNCC_TTien": 1,
                }
            ],
        )
        self.assertEqual(forged_price.status_code, status.HTTP_201_CREATED)
        self.assertEqual(forged_price.data["lines"][0]["TRNCC_DonGia"], 100)
        self.assertEqual(forged_price.data["lines"][0]["TRNCC_TTien"], 100)
        patched = self.client.patch(
            f"/api/inventory/supplier-returns/{code}/",
            {"TRNCC_GhiChu": "Đã cập nhật"},
            format="json",
        )
        self.assertEqual(patched.status_code, status.HTTP_200_OK, patched.data)
        self.assertEqual(patched.data["TRNCC_GhiChu"], "Đã cập nhật")
        self.assertEqual(
            self.client.delete(f"/api/inventory/supplier-returns/{code}/").status_code,
            status.HTTP_204_NO_CONTENT,
        )
        self.assertFalse(SupplierReturn.objects.filter(code=code).exists())
        self.assertEqual(StockBalance.objects.get().quantity, 10)

    def test_supplier_return_can_return_partial_then_entire_remaining_balance(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]
        for quantity in (4, 6):
            created = self.create_supplier_return(receipt, line_code, quantity)
            self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
            code = created.data["TRNCC_Ma"]
            self.assertEqual(self.submit_supplier_return(code).status_code, status.HTTP_200_OK)
            self.assertEqual(
                self.approve_supplier_return_as_owner(code).status_code,
                status.HTTP_200_OK,
            )
            self.assertEqual(
                self.confirm_supplier_return_as_warehouse(code).status_code,
                status.HTTP_200_OK,
            )
        self.assertEqual(StockBalance.objects.get().quantity, 0)
        self.assertEqual(
            sum(
                StockMovement.objects.filter(
                    source="TraHangNCC"
                ).values_list("quantity_delta", flat=True)
            ),
            -10,
        )
        blocked = self.create_supplier_return(receipt, line_code, quantity=1)
        self.assertEqual(blocked.status_code, status.HTTP_400_BAD_REQUEST)

    def test_supplier_return_rejects_mismatched_supplier_and_unconfirmed_receipt(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]
        another_supplier = Partner.objects.create(
            name="Different supplier", role=Partner.Role.SUPPLIER
        )
        payload = self.supplier_return_payload(receipt, line_code)
        payload["DT_Ma"] = another_supplier.code
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/", payload, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

        draft = self.create_receipt(quantity=3)
        self.assertEqual(draft.status_code, status.HTTP_201_CREATED)
        draft_line = draft.data["lines"][0]["PNCT_Ma"]
        payload = self.supplier_return_payload(
            draft.data, draft_line, quantity=1
        )
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/", payload, format="json"
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_supplier_return_permissions_reject_cancel_and_invalid_transitions(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]
        self.client.force_authenticate(self.other_user)
        self.assertEqual(
            self.client.post(
                "/api/inventory/supplier-returns/",
                self.supplier_return_payload(receipt, line_code),
                format="json",
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.client.force_authenticate(self.warehouse_user)
        created = self.create_supplier_return(receipt, line_code)
        code = created.data["TRNCC_Ma"]
        self.assertEqual(
            self.client.post(
                f"/api/inventory/supplier-returns/{code}/approve/",
                {},
                format="json",
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.submit_supplier_return(code).status_code, status.HTTP_200_OK
        )
        self.client.force_authenticate(self.accountant_user)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/supplier-returns/{code}/reject/",
                {},
                format="json",
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.client.force_authenticate(self.owner_user)
        rejected = self.client.post(
            f"/api/inventory/supplier-returns/{code}/reject/",
            {},
            format="json",
        )
        self.assertEqual(rejected.status_code, status.HTTP_200_OK)
        self.assertEqual(rejected.data["TRNCC_TrangThai"], SupplierReturn.Status.REJECTED)
        self.assertEqual(
            rejected.data["TRNCC_GhiChuDuyet"],
            "Chủ cửa hàng từ chối yêu cầu.",
        )
        self.assertEqual(
            self.client.post(
                f"/api/inventory/supplier-returns/{code}/confirm/",
                {},
                format="json",
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertEqual(StockBalance.objects.get().quantity, 10)

        draft = self.create_supplier_return(receipt, line_code)
        cancelled = self.client.post(
            f"/api/inventory/supplier-returns/{draft.data['TRNCC_Ma']}/cancel/",
            {},
            format="json",
        )
        self.assertEqual(cancelled.status_code, status.HTTP_200_OK)
        self.assertEqual(
            cancelled.data["TRNCC_TrangThai"], SupplierReturn.Status.CANCELLED
        )

    def test_supplier_return_confirmation_rolls_back_on_movement_failure(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        created = self.create_supplier_return(
            receipt, receipt["lines"][0]["PNCT_Ma"], quantity=4
        )
        code = created.data["TRNCC_Ma"]
        self.submit_supplier_return(code)
        self.approve_supplier_return_as_owner(code)
        self.client.force_authenticate(self.warehouse_user)
        with patch(
            "apps.inventory.services.StockMovement.objects.create",
            side_effect=RuntimeError("movement write failed"),
        ):
            with self.assertRaises(RuntimeError):
                self.client.post(
                    f"/api/inventory/supplier-returns/{code}/confirm/",
                    {},
                    format="json",
                )
        self.assertEqual(StockBalance.objects.get().quantity, 10)
        self.assertEqual(
            SupplierReturn.objects.get(code=code).status,
            SupplierReturn.Status.APPROVED,
        )
        self.assertFalse(StockMovement.objects.filter(source="TraHangNCC").exists())

    def transfer_line_payload(self, lot_code, quantity):
        return {"PNCT_Ma": lot_code, "PXCN_SL": quantity}

    def test_create_transfer_validates_locations_lots_quantity_and_duplicates(self):
        confirmed = self.create_confirmed_unlinked_receipt(quantity=10)
        lot_code = confirmed["lines"][0]["PNCT_Ma"]
        initial = StockBalance.objects.get().quantity

        created = self.create_transfer([self.transfer_line_payload(lot_code, 6)])

        self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
        self.assertEqual(created.data["PXCN_Ma"], "PXCN0001")
        self.assertEqual(created.data["PXCN_Loai"], "Chuyển nội bộ")
        self.assertEqual(created.data["PXCN_TrangThai"], StockTransfer.Status.WAITING_DISPATCH)
        self.assertEqual(created.data["lines"][0]["PXCN_SLThucNhan"], None)
        self.assertEqual(StockBalance.objects.get().quantity, initial)
        listing = self.client.get(
            f"/api/inventory/transfers/?DD_Xuat={self.location.code}&status=Ch%E1%BB%9D%20xu%E1%BA%A5t"
        )
        self.assertEqual(listing.status_code, status.HTTP_200_OK)
        self.assertEqual(listing.data["count"], 1)
        detail = self.client.get(
            f"/api/inventory/transfers/{created.data['PXCN_Ma']}/"
        )
        self.assertEqual(detail.status_code, status.HTTP_200_OK)
        self.assertEqual(detail.data["PXCN_Ma"], created.data["PXCN_Ma"])

        same_location = self.create_transfer(
            [self.transfer_line_payload(lot_code, 1)],
            DD_Nhan=self.location.code,
        )
        self.assertEqual(same_location.status_code, status.HTTP_400_BAD_REQUEST)
        missing_location = self.create_transfer(
            [self.transfer_line_payload(lot_code, 1)],
            DD_Nhan="DD-MISSING",
        )
        self.assertEqual(missing_location.status_code, status.HTTP_400_BAD_REQUEST)
        too_many = self.create_transfer(
            [self.transfer_line_payload(lot_code, 11)]
        )
        self.assertEqual(too_many.status_code, status.HTTP_400_BAD_REQUEST)
        unknown_lot = self.create_transfer(
            [self.transfer_line_payload("PNCT-MISSING", 1)]
        )
        self.assertEqual(unknown_lot.status_code, status.HTTP_400_BAD_REQUEST)
        duplicate = self.create_transfer(
            [
                self.transfer_line_payload(lot_code, 1),
                self.transfer_line_payload(lot_code, 1),
            ]
        )
        self.assertEqual(duplicate.status_code, status.HTTP_400_BAD_REQUEST)
        invalid_quantity = self.create_transfer(
            [self.transfer_line_payload(lot_code, 1.5)]
        )
        self.assertEqual(invalid_quantity.status_code, status.HTTP_400_BAD_REQUEST)

    def test_expired_lots_cannot_be_transferred_per_frontend_rule(self):
        receipt = self.create_confirmed_unlinked_receipt(
            quantity=5, expiry=timezone.localdate() - timedelta(days=1)
        )
        response = self.create_transfer(
            [self.transfer_line_payload(receipt["lines"][0]["PNCT_Ma"], 1)]
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(StockTransfer.objects.exists())

    def test_transfer_dispatch_and_full_receipt_update_each_location_and_ledger(self):
        today = timezone.localdate()
        first = self.create_confirmed_unlinked_receipt(
            quantity=10, expiry=today
        )
        second = self.create_confirmed_unlinked_receipt(
            quantity=8, expiry=today + timedelta(days=1)
        )
        first_lot = first["lines"][0]["PNCT_Ma"]
        second_lot = second["lines"][0]["PNCT_Ma"]
        transfer = self.create_transfer(
            [
                self.transfer_line_payload(first_lot, 4),
                self.transfer_line_payload(second_lot, 3),
            ]
        )
        self.assertEqual(transfer.status_code, status.HTTP_201_CREATED, transfer.data)
        code = transfer.data["PXCN_Ma"]
        dispatched = self.dispatch_transfer_as_warehouse(code)

        self.assertEqual(dispatched.status_code, status.HTTP_200_OK, dispatched.data)
        self.assertEqual(dispatched.data["PXCN_TrangThai"], StockTransfer.Status.IN_TRANSIT)
        self.assertEqual(
            StockBalance.objects.get(
                location=self.location, receipt_line__code=first_lot
            ).quantity,
            6,
        )
        self.assertFalse(
            StockBalance.objects.filter(
                location=self.destination, receipt_line__code=first_lot
            ).exists()
        )

        received = self.receive_transfer_as_sales(
            code,
            [
                {"PNCT_Ma": first_lot, "PXCN_SLThucNhan": 4},
                {"PNCT_Ma": second_lot, "PXCN_SLThucNhan": 3},
            ],
        )
        self.assertEqual(received.status_code, status.HTTP_200_OK, received.data)
        self.assertEqual(received.data["PXCN_TrangThai"], StockTransfer.Status.COMPLETE)
        self.assertEqual(received.data["NV_Nhan"], self.viewer.code)
        self.assertEqual(
            StockBalance.objects.get(
                location=self.destination, receipt_line__code=first_lot
            ).quantity,
            4,
        )
        self.assertEqual(
            StockBalance.objects.get(
                location=self.destination, receipt_line__code=second_lot
            ).quantity,
            3,
        )
        self.assertEqual(
            sum(StockBalance.objects.values_list("quantity", flat=True)),
            18,
        )
        movements = StockMovement.objects.filter(document_code=code)
        self.assertEqual(movements.count(), 4)
        self.assertEqual(
            set(movements.values_list("movement_type", flat=True)),
            {StockMovement.Kind.TRANSFER_OUT, StockMovement.Kind.TRANSFER_IN},
        )

        today_key = today.isoformat()
        source_ledger = self.client.get(
            "/api/inventory/stock-ledger/",
            {
                "HH_Ma": self.product.code,
                "DD_Ma": self.location.code,
                "PNCT_Ma": first_lot,
                "from": today_key,
                "to": today_key,
            },
        )
        destination_ledger = self.client.get(
            "/api/inventory/stock-ledger/",
            {
                "HH_Ma": self.product.code,
                "DD_Ma": self.destination.code,
                "PNCT_Ma": first_lot,
                "from": today_key,
                "to": today_key,
            },
        )
        self.assertTrue(source_ledger.data["complete"], source_ledger.data)
        self.assertTrue(destination_ledger.data["complete"], destination_ledger.data)
        self.assertEqual(source_ledger.data["outbound"], 4)
        self.assertEqual(source_ledger.data["current"], 6)
        self.assertEqual(destination_ledger.data["inbound"], 4)
        self.assertEqual(destination_ledger.data["current"], 4)
        self.assertEqual(
            self.client.get(
                f"/api/inventory/movements/?BDK_MaChungTu={code}"
            ).data["count"],
            4,
        )
        destination_stock = self.client.get(
            f"/api/inventory/stock/?view=detail&DD_Ma={self.destination.code}"
        )
        self.assertEqual(destination_stock.data["count"], 2)
        destination_expiry = self.client.get(
            f"/api/inventory/expiry/?DD_Ma={self.destination.code}"
        )
        expiry_by_lot = {
            row["PNCT_Ma"]: row for row in destination_expiry.data["results"]
        }
        self.assertEqual(expiry_by_lot[first_lot]["TK_SL"], 4)
        self.assertEqual(expiry_by_lot[first_lot]["PNCT_HSD"], today)
        from .services import get_available_stock, get_stock_for_sale

        self.assertEqual(
            get_available_stock(self.product.code, self.destination.code), 7
        )
        lots = get_stock_for_sale(self.product.code, self.destination.code)
        self.assertEqual([lot["PNCT_Ma"] for lot in lots], [first_lot, second_lot])

    def test_partial_receipt_enters_discrepancy_and_does_not_restore_missing_units(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        lot_code = receipt["lines"][0]["PNCT_Ma"]
        transfer = self.create_transfer([self.transfer_line_payload(lot_code, 7)])
        code = transfer.data["PXCN_Ma"]
        self.assertEqual(
            self.dispatch_transfer_as_warehouse(code).status_code,
            status.HTTP_200_OK,
        )

        received = self.receive_transfer_as_sales(
            code,
            [{"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 5}],
        )

        self.assertEqual(received.status_code, status.HTTP_200_OK, received.data)
        self.assertEqual(received.data["PXCN_TrangThai"], StockTransfer.Status.DISCREPANCY)
        self.assertEqual(
            StockBalance.objects.get(
                location=self.location, receipt_line__code=lot_code
            ).quantity,
            3,
        )
        self.assertEqual(
            StockBalance.objects.get(
                location=self.destination, receipt_line__code=lot_code
            ).quantity,
            5,
        )
        self.assertEqual(sum(StockBalance.objects.values_list("quantity", flat=True)), 8)
        self.assertEqual(
            StockMovement.objects.filter(
                document_code=code,
                movement_type=StockMovement.Kind.TRANSFER_OUT,
            ).get().quantity_delta,
            -7,
        )
        inbound = StockMovement.objects.get(
            document_code=code,
            movement_type=StockMovement.Kind.TRANSFER_IN,
        )
        self.assertEqual(inbound.quantity_delta, 5)
        self.assertIn("chờ đối chiếu", inbound.note)

    def test_zero_receipt_and_invalid_receive_payloads(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        lot_code = receipt["lines"][0]["PNCT_Ma"]
        transfer = self.create_transfer([self.transfer_line_payload(lot_code, 3)])
        code = transfer.data["PXCN_Ma"]
        before_dispatch = self.receive_transfer_as_sales(
            code, [{"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 0}]
        )
        self.assertEqual(before_dispatch.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            self.dispatch_transfer_as_warehouse(code).status_code,
            status.HTTP_200_OK,
        )

        too_many = self.receive_transfer_as_sales(
            code, [{"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 4}]
        )
        self.assertEqual(too_many.status_code, status.HTTP_400_BAD_REQUEST)
        missing_line = self.receive_transfer_as_sales(code, [])
        self.assertEqual(missing_line.status_code, status.HTTP_400_BAD_REQUEST)
        duplicates = self.receive_transfer_as_sales(
            code,
            [
                {"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 1},
                {"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 1},
            ],
        )
        self.assertEqual(duplicates.status_code, status.HTTP_400_BAD_REQUEST)
        zero = self.receive_transfer_as_sales(
            code, [{"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 0}]
        )
        self.assertEqual(zero.status_code, status.HTTP_200_OK, zero.data)
        self.assertEqual(zero.data["PXCN_TrangThai"], StockTransfer.Status.DISCREPANCY)
        self.assertFalse(
            StockBalance.objects.filter(
                location=self.destination, receipt_line__code=lot_code
            ).exists()
        )
        self.assertFalse(
            StockMovement.objects.filter(
                document_code=code,
                movement_type=StockMovement.Kind.TRANSFER_IN,
            ).exists()
        )

    def test_transfer_permissions_repeated_actions_and_unsupported_edits(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=5)
        lot_code = receipt["lines"][0]["PNCT_Ma"]
        self.client.force_authenticate(self.warehouse_user)
        denied_create = self.client.post(
            "/api/inventory/transfers/",
            self.create_transfer_payload([self.transfer_line_payload(lot_code, 1)]),
            format="json",
        )
        self.assertEqual(denied_create.status_code, status.HTTP_403_FORBIDDEN)
        transfer = self.create_transfer([self.transfer_line_payload(lot_code, 3)])
        code = transfer.data["PXCN_Ma"]
        self.client.force_authenticate(self.accountant_user)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/transfers/{code}/dispatch/", {}, format="json"
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.receive_transfer_as_sales(
                code, [{"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 3}]
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        dispatched = self.dispatch_transfer_as_warehouse(code)
        self.assertEqual(dispatched.status_code, status.HTTP_200_OK)
        self.assertEqual(
            self.dispatch_transfer_as_warehouse(code).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.client.force_authenticate(self.accountant_user)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/transfers/{code}/receive/",
                {
                    "lines": [
                        {"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 3}
                    ]
                },
                format="json",
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.receive_transfer_as_sales(
                code, [{"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 3}]
            ).status_code,
            status.HTTP_200_OK,
        )
        self.assertEqual(
            self.receive_transfer_as_sales(
                code, [{"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 3}]
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.assertEqual(
            self.client.patch(
                f"/api/inventory/transfers/{code}/",
                {"PXCN_NguoiNhan": "Edited"},
                format="json",
            ).status_code,
            status.HTTP_405_METHOD_NOT_ALLOWED,
        )
        self.assertEqual(
            self.client.post(
                f"/api/inventory/transfers/{code}/cancel/", {}, format="json"
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )

    def test_dispatch_rolls_back_all_balances_movements_and_status_on_failure(self):
        first = self.create_confirmed_unlinked_receipt(quantity=8)
        second = self.create_confirmed_unlinked_receipt(quantity=8)
        first_lot = first["lines"][0]["PNCT_Ma"]
        second_lot = second["lines"][0]["PNCT_Ma"]
        transfer = self.create_transfer(
            [
                self.transfer_line_payload(first_lot, 3),
                self.transfer_line_payload(second_lot, 3),
            ]
        )
        code = transfer.data["PXCN_Ma"]

        with patch(
            "apps.inventory.services.StockMovement.objects.create",
            side_effect=[StockMovement(), RuntimeError("movement write failed")],
        ):
            with self.assertRaises(RuntimeError):
                from .services import dispatch_stock_transfer

                dispatch_stock_transfer(code, dispatched_by=self.warehouse_user)

        self.assertEqual(
            list(
                StockBalance.objects.filter(location=self.location)
                .order_by("receipt_line__code")
                .values_list("quantity", flat=True)
            ),
            [8, 8],
        )
        self.assertEqual(StockTransfer.objects.get(code=code).status, StockTransfer.Status.WAITING_DISPATCH)
        self.assertFalse(
            StockMovement.objects.filter(document_code=code).exists()
        )

    def test_receive_rolls_back_balance_details_movements_and_status_on_failure(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=8)
        lot_code = receipt["lines"][0]["PNCT_Ma"]
        transfer = self.create_transfer([self.transfer_line_payload(lot_code, 5)])
        code = transfer.data["PXCN_Ma"]
        self.assertEqual(
            self.dispatch_transfer_as_warehouse(code).status_code,
            status.HTTP_200_OK,
        )

        with patch(
            "apps.inventory.services.StockMovement.objects.create",
            side_effect=RuntimeError("movement write failed"),
        ):
            with self.assertRaises(RuntimeError):
                from .services import receive_stock_transfer

                receive_stock_transfer(
                    code,
                    received_by=self.other_user,
                    lines=[{"PNCT_Ma": lot_code, "PXCN_SLThucNhan": 4}],
                )

        self.assertFalse(
            StockBalance.objects.filter(
                location=self.destination, receipt_line__code=lot_code
            ).exists()
        )
        self.assertIsNone(
            StockTransfer.objects.get(code=code).lines.get().received_quantity
        )
        self.assertEqual(
            StockTransfer.objects.get(code=code).status,
            StockTransfer.Status.IN_TRANSIT,
        )
        self.assertFalse(
            StockMovement.objects.filter(
                document_code=code,
                movement_type=StockMovement.Kind.TRANSFER_IN,
            ).exists()
        )

    def test_create_count_snapshots_confirmed_lot_without_adjusting_stock(self):
        receipt = self.create_confirmed_unlinked_receipt(
            quantity=10, expiry=timezone.localdate() + timedelta(days=30)
        )
        line_code = receipt["lines"][0]["PNCT_Ma"]

        response = self.create_stock_count(line_code, 10, 10)

        self.assertEqual(response.status_code, status.HTTP_201_CREATED, response.data)
        self.assertEqual(response.data["PKK_Ma"], "PKK0001")
        self.assertEqual(response.data["PKK_TrangThai"], StockCount.Status.DRAFT)
        self.assertEqual(response.data["NV_Ma"], self.warehouse.code)
        self.assertEqual(response.data["lines"][0]["PKKCT_ChenhLech"], 0)
        self.assertEqual(StockBalance.objects.get().quantity, 10)
        self.assertEqual(StockMovement.objects.count(), 1)

    def test_count_creation_rejects_stale_invalid_duplicate_and_unknown_lots(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]

        stale = self.create_stock_count(line_code, 9, 8)
        self.assertEqual(stale.status_code, status.HTTP_400_BAD_REQUEST)

        negative = self.create_stock_count(line_code, 10, -1)
        self.assertEqual(negative.status_code, status.HTTP_400_BAD_REQUEST)
        fractional = self.create_stock_count(line_code, 10, 1.5)
        self.assertEqual(fractional.status_code, status.HTTP_400_BAD_REQUEST)

        duplicate_payload = self.count_payload(line_code, 10, 10)
        duplicate_payload["lines"].append(duplicate_payload["lines"][0].copy())
        duplicate = self.client.post(
            "/api/inventory/stock-counts/", duplicate_payload, format="json"
        )
        self.assertEqual(duplicate.status_code, status.HTTP_400_BAD_REQUEST)

        unknown = self.create_stock_count("PNCT-NOT-FOUND", 0, 1)
        self.assertEqual(unknown.status_code, status.HTTP_400_BAD_REQUEST)

        draft = self.create_receipt(
            lines=[
                {"HH_Ma": self.product.code, "PNCT_SL": 2, "PNCT_DonGia": 10}
            ]
        )
        draft_line = draft.data["lines"][0]["PNCT_Ma"]
        unconfirmed = self.create_stock_count(draft_line, 0, 1)
        self.assertEqual(unconfirmed.status_code, status.HTTP_400_BAD_REQUEST)

        forged_employee = self.create_stock_count(
            line_code, 10, 10, NV_Ma=self.accountant.code
        )
        self.assertEqual(forged_employee.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(StockCount.objects.exists())

    def test_approval_applies_shortage_and_updates_stock_ledger_and_sale_availability(self):
        receipt = self.create_confirmed_unlinked_receipt(
            quantity=10, expiry=timezone.localdate() + timedelta(days=20)
        )
        line_code = receipt["lines"][0]["PNCT_Ma"]
        created = self.create_stock_count(line_code, 10, 7)
        self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
        code = created.data["PKK_Ma"]
        submitted = self.submit_stock_count(code)
        self.assertEqual(submitted.status_code, status.HTTP_200_OK, submitted.data)
        approved = self.approve_stock_count_as_owner(code)

        self.assertEqual(approved.status_code, status.HTTP_200_OK, approved.data)
        self.assertEqual(approved.data["PKK_TrangThai"], StockCount.Status.APPROVED)
        self.assertEqual(approved.data["NV_Duyet"], self.owner.code)
        self.assertIsNotNone(approved.data["PKK_NgayDuyet"])
        self.assertEqual(StockBalance.objects.get().quantity, 7)

        adjustment = StockMovement.objects.get(source="PhieuKiemKeKho")
        self.assertEqual(adjustment.quantity_delta, -3)
        self.assertEqual(adjustment.document_code, code)
        self.assertEqual(adjustment.receipt_line.code, line_code)
        movements = self.client.get(
            f"/api/inventory/movements/?BDK_MaChungTu={code}"
        )
        self.assertEqual(movements.data["count"], 1)
        self.assertEqual(movements.data["results"][0]["BDK_SoLuong"], -3)

        today = timezone.localdate().isoformat()
        ledger = self.client.get(
            "/api/inventory/stock-ledger/",
            {
                "HH_Ma": self.product.code,
                "DD_Ma": self.location.code,
                "from": today,
                "to": today,
            },
        )
        self.assertTrue(ledger.data["complete"], ledger.data)
        self.assertEqual(ledger.data["current"], 7)
        self.assertEqual(ledger.data["outbound"], 3)

        from .services import get_available_stock, get_stock_for_sale

        self.assertEqual(
            get_available_stock(self.product.code, self.location.code), 7
        )
        self.assertEqual(
            get_stock_for_sale(self.product.code, self.location.code)[0]["quantity"],
            7,
        )
        expiry = self.client.get("/api/inventory/expiry/")
        self.assertEqual(expiry.data["results"][0]["TK_SL"], 7)
        overview = self.client.get("/api/inventory/overview/")
        self.assertEqual(
            overview.data["metrics"]["TK_TongSoLuongThucTe"], 7
        )

    def test_approval_applies_surplus_to_the_identified_existing_lot(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]
        created = self.create_stock_count(line_code, 10, 12)
        self.assertEqual(created.status_code, status.HTTP_201_CREATED, created.data)
        code = created.data["PKK_Ma"]
        self.assertEqual(self.submit_stock_count(code).status_code, status.HTTP_200_OK)

        approved = self.approve_stock_count_as_owner(code)

        self.assertEqual(approved.status_code, status.HTTP_200_OK, approved.data)
        self.assertEqual(StockBalance.objects.get().quantity, 12)
        self.assertEqual(
            StockMovement.objects.get(source="PhieuKiemKeKho").quantity_delta, 2
        )
        self.assertEqual(GoodsReceiptLine.objects.count(), 1)

    def test_matching_count_approves_without_creating_a_zero_movement(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        count = self.create_stock_count(receipt["lines"][0]["PNCT_Ma"], 10, 10)
        code = count.data["PKK_Ma"]
        self.assertEqual(self.submit_stock_count(code).status_code, status.HTTP_200_OK)

        approved = self.approve_stock_count_as_owner(code)

        self.assertEqual(approved.status_code, status.HTTP_200_OK, approved.data)
        self.assertEqual(approved.data["PKK_TrangThai"], StockCount.Status.APPROVED)
        self.assertEqual(StockMovement.objects.count(), 1)
        self.assertEqual(
            self.submit_stock_count(code).status_code,
            status.HTTP_400_BAD_REQUEST,
        )
        self.client.force_authenticate(self.owner_user)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/stock-counts/{code}/approve/",
                {},
                format="json",
            ).status_code,
            status.HTTP_400_BAD_REQUEST,
        )

    def test_expired_and_no_expiry_lots_keep_their_sale_rules_after_count(self):
        today = timezone.localdate()
        expired = self.create_confirmed_unlinked_receipt(
            quantity=2, expiry=today - timedelta(days=1)
        )
        no_expiry = self.create_confirmed_unlinked_receipt(quantity=3)
        payload = self.count_payload(
            expired["lines"][0]["PNCT_Ma"], 2, 1
        )
        payload["lines"].append(
            {
                "PNCT_Ma": no_expiry["lines"][0]["PNCT_Ma"],
                "PKKCT_SLSoSach": 3,
                "PKKCT_SLThucTe": 4,
                "PKKCT_LyDo": "Thừa một sản phẩm",
            }
        )
        count = self.client.post(
            "/api/inventory/stock-counts/", payload, format="json"
        )
        self.assertEqual(count.status_code, status.HTTP_201_CREATED, count.data)
        code = count.data["PKK_Ma"]
        self.assertEqual(self.submit_stock_count(code).status_code, status.HTTP_200_OK)
        approved = self.approve_stock_count_as_owner(code)
        self.assertEqual(approved.status_code, status.HTTP_200_OK, approved.data)

        from .services import get_stock_for_sale

        sale_lots = get_stock_for_sale(self.product.code, self.location.code)
        self.assertEqual([lot["PNCT_Ma"] for lot in sale_lots], [no_expiry["lines"][0]["PNCT_Ma"]])
        self.assertEqual(sale_lots[0]["quantity"], 4)
        expiry_rows = self.client.get("/api/inventory/expiry/").data["results"]
        by_lot = {row["PNCT_Ma"]: row for row in expiry_rows}
        self.assertEqual(by_lot[expired["lines"][0]["PNCT_Ma"]]["TK_SL"], 1)
        self.assertEqual(by_lot[expired["lines"][0]["PNCT_Ma"]]["HSD_TrangThai"], "Đã hết hạn")
        self.assertEqual(by_lot[no_expiry["lines"][0]["PNCT_Ma"]]["TK_SL"], 4)
        self.assertEqual(by_lot[no_expiry["lines"][0]["PNCT_Ma"]]["HSD_TrangThai"], "Không áp dụng HSD")

    def test_same_balance_with_post_snapshot_movements_is_stale(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]
        created = self.create_stock_count(line_code, 10, 8)
        code = created.data["PKK_Ma"]
        count = StockCount.objects.get(code=code)
        line = GoodsReceiptLine.objects.get(code=line_code)
        for delta, document_code in ((1, "TEST-IN"), (-1, "TEST-OUT")):
            StockMovement.objects.create(
                location=self.location,
                receipt_line=line,
                employee=self.warehouse,
                movement_type=StockMovement.Kind.COUNT_ADJUSTMENT,
                quantity_delta=delta,
                source="TestMovement",
                document_code=document_code,
            )
        StockMovement.objects.filter(
            source="TestMovement"
        ).update(occurred_at=count.created_at + timedelta(seconds=1))
        stale = self.submit_stock_count(code)
        self.assertEqual(stale.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            StockBalance.objects.get().quantity,
            10,
        )

    def test_stale_count_is_rejected_if_a_lot_moves_after_creation(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        line_code = receipt["lines"][0]["PNCT_Ma"]
        count_response = self.create_stock_count(line_code, 10, 9)
        code = count_response.data["PKK_Ma"]
        self.assertEqual(self.submit_stock_count(code).status_code, status.HTTP_200_OK)

        balance = StockBalance.objects.get()
        StockBalance.objects.filter(pk=balance.pk).update(quantity=9)
        StockMovement.objects.create(
            location=self.location,
            receipt_line=GoodsReceiptLine.objects.get(code=line_code),
            employee=self.warehouse,
            movement_type=StockMovement.Kind.COUNT_ADJUSTMENT,
            quantity_delta=-1,
            source="TestMovement",
            document_code="TEST-001",
        )
        self.client.force_authenticate(self.owner_user)
        rejected = self.client.post(
            f"/api/inventory/stock-counts/{code}/approve/", {}, format="json"
        )

        self.assertEqual(rejected.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("lập phiếu kiểm kê mới", str(rejected.data))
        self.assertEqual(StockCount.objects.get(code=code).status, StockCount.Status.WAITING_APPROVAL)
        self.assertFalse(
            StockMovement.objects.filter(source="PhieuKiemKeKho").exists()
        )

    def test_stock_count_approval_rolls_back_balance_movement_and_status_on_failure(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        count = self.create_stock_count(receipt["lines"][0]["PNCT_Ma"], 10, 8)
        code = count.data["PKK_Ma"]
        self.assertEqual(self.submit_stock_count(code).status_code, status.HTTP_200_OK)
        self.client.force_authenticate(self.owner_user)

        with patch(
            "apps.inventory.services.StockMovement.objects.create",
            side_effect=RuntimeError("movement write failed"),
        ):
            with self.assertRaises(RuntimeError):
                self.client.post(
                    f"/api/inventory/stock-counts/{code}/approve/",
                    {},
                    format="json",
                )

        self.assertEqual(StockBalance.objects.get().quantity, 10)
        self.assertEqual(StockCount.objects.get(code=code).status, StockCount.Status.WAITING_APPROVAL)
        self.assertFalse(
            StockMovement.objects.filter(source="PhieuKiemKeKho").exists()
        )

    def test_stock_count_permissions_and_unsupported_edit_cancel_actions(self):
        receipt = self.create_confirmed_unlinked_receipt(quantity=10)
        count = self.create_stock_count(receipt["lines"][0]["PNCT_Ma"], 10, 10)
        code = count.data["PKK_Ma"]

        self.client.force_authenticate(self.warehouse_user)
        self.assertEqual(self.submit_stock_count(code).status_code, status.HTTP_200_OK)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/stock-counts/{code}/approve/", {}, format="json"
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.client.force_authenticate(self.accountant_user)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/stock-counts/{code}/approve/", {}, format="json"
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.client.force_authenticate(self.other_user)
        self.assertEqual(
            self.client.post(
                f"/api/inventory/stock-counts/{code}/submit/", {}, format="json"
            ).status_code,
            status.HTTP_403_FORBIDDEN,
        )
        self.assertEqual(
            self.client.patch(
                f"/api/inventory/stock-counts/{code}/",
                {"PKK_GhiChu": "Sửa"},
                format="json",
            ).status_code,
            status.HTTP_405_METHOD_NOT_ALLOWED,
        )
        self.assertEqual(
            self.client.post(
                f"/api/inventory/stock-counts/{code}/cancel/", {}, format="json"
            ).status_code,
            status.HTTP_404_NOT_FOUND,
        )
        self.client.force_authenticate(user=None)
        self.assertEqual(
            self.client.get("/api/inventory/stock-counts/").status_code,
            status.HTTP_401_UNAUTHORIZED,
        )

    def test_stock_summary_detail_location_and_unconfirmed_exclusion(self):
        draft = self.create_receipt(
            quantity=2, lines=[{"HH_Ma": self.product.code, "PNCT_SL": 2, "PNCT_DonGia": 5}]
        )
        self.assertEqual(draft.status_code, status.HTTP_201_CREATED)
        first = self.create_confirmed_unlinked_receipt(quantity=5)

        summary = self.client.get("/api/inventory/stock/")
        self.assertEqual(summary.status_code, status.HTTP_200_OK)
        self.assertEqual(summary.data["count"], 1)
        row = summary.data["results"][0]
        self.assertEqual(row["TK_SLThucTe"], 5)
        self.assertEqual(row["TK_SLCoTheBan"], 5)
        self.assertEqual(row["TK_SoLo"], 1)
        self.assertEqual(row["HH_DVi"], "Cái")

        detail = self.client.get("/api/inventory/stock/?view=detail")
        self.assertEqual(detail.data["count"], 1)
        self.assertEqual(detail.data["results"][0]["PNCT_Ma"], first["lines"][0]["PNCT_Ma"])
        self.assertEqual(detail.data["results"][0]["TK_SL"], 5)
        self.assertNotEqual(first["PN_Ma"], draft.data["PN_Ma"])

        other_location = StorageLocation.objects.create(
            name="Cửa hàng", kind=StorageLocation.Kind.STORE
        )
        self.assertEqual(
            self.client.get(f"/api/inventory/stock/?DD_Ma={other_location.code}").data["count"],
            0,
        )

    def test_expiry_statuses_threshold_no_expiry_and_sale_fefo(self):
        today = timezone.localdate()
        expired = self.create_confirmed_unlinked_receipt(
            quantity=2, expiry=today - timedelta(days=1), threshold=30
        )
        soon = self.create_confirmed_unlinked_receipt(
            quantity=3, expiry=today + timedelta(days=2), threshold=3
        )
        today_lot = self.create_confirmed_unlinked_receipt(
            quantity=4, expiry=today, threshold=0
        )
        default_threshold = self.create_confirmed_unlinked_receipt(
            quantity=1, expiry=today + timedelta(days=20)
        )
        no_expiry = self.create_confirmed_unlinked_receipt(
            quantity=5, expiry=None
        )
        later = self.create_confirmed_unlinked_receipt(
            quantity=6, expiry=today + timedelta(days=60), threshold=30
        )

        expired_rows = self.client.get(
            "/api/inventory/expiry/?status=%C4%90%C3%A3%20h%E1%BA%BFt%20h%E1%BA%A1n"
        )
        self.assertEqual(expired_rows.data["count"], 1)
        self.assertEqual(expired_rows.data["results"][0]["PNCT_Ma"], expired["lines"][0]["PNCT_Ma"])
        self.assertEqual(expired_rows.data["results"][0]["TK_SL"], 2)

        soon_rows = self.client.get("/api/inventory/expiry/?status=S%E1%BA%AFp%20h%E1%BA%BFt%20h%E1%BA%A1n")
        self.assertEqual(soon_rows.data["count"], 3)
        statuses = {
            row["PNCT_Ma"]: row["HSD_TrangThai"]
            for row in self.client.get("/api/inventory/expiry/").data["results"]
        }
        self.assertEqual(statuses[today_lot["lines"][0]["PNCT_Ma"]], "Sắp hết hạn")
        self.assertEqual(
            statuses[default_threshold["lines"][0]["PNCT_Ma"]], "Sắp hết hạn"
        )
        self.assertEqual(statuses[no_expiry["lines"][0]["PNCT_Ma"]], "Không áp dụng HSD")
        self.assertEqual(statuses[later["lines"][0]["PNCT_Ma"]], "Còn hạn")

        sale_lots = self.client.get("/api/inventory/expiry/?status=bad").status_code
        self.assertEqual(sale_lots, status.HTTP_400_BAD_REQUEST)
        from apps.inventory.services import get_stock_for_sale

        lots = get_stock_for_sale(self.product.code, self.location.code, on_date=today)
        lot_ids = [lot["PNCT_Ma"] for lot in lots]
        self.assertNotIn(expired["lines"][0]["PNCT_Ma"], lot_ids)
        self.assertEqual(
            lot_ids,
            [
                today_lot["lines"][0]["PNCT_Ma"],
                soon["lines"][0]["PNCT_Ma"],
                default_threshold["lines"][0]["PNCT_Ma"],
                later["lines"][0]["PNCT_Ma"],
                no_expiry["lines"][0]["PNCT_Ma"],
            ],
        )
        from apps.inventory.services import get_available_stock

        self.assertEqual(
            get_available_stock(self.product.code, self.location.code, on_date=today),
            sum(lot["quantity"] for lot in lots),
        )

    def test_stock_summary_separates_expired_unavailable_and_low_stock(self):
        today = timezone.localdate()
        expired = self.create_confirmed_unlinked_receipt(
            quantity=3, expiry=today - timedelta(days=1)
        )
        active = self.create_confirmed_unlinked_receipt(
            quantity=4, expiry=today + timedelta(days=10)
        )
        summary = self.client.get("/api/inventory/stock/")

        self.assertEqual(summary.data["count"], 1)
        row = summary.data["results"][0]
        self.assertEqual(row["TK_SLThucTe"], 7)
        self.assertEqual(row["TK_SLCoTheBan"], 4)
        self.assertEqual(row["TK_SLKhongKhaDung"], 3)
        self.assertEqual(row["TK_SLHetHan"], 3)
        self.assertEqual(row["TK_TrangThai"], "Sắp hết")
        self.assertNotEqual(expired["PN_Ma"], active["PN_Ma"])

    def test_overview_uses_live_stock_expiry_and_receipt_data(self):
        today = timezone.localdate()
        self.create_confirmed_unlinked_receipt(
            quantity=4, expiry=today + timedelta(days=5), threshold=5
        )
        self.create_confirmed_unlinked_receipt(
            quantity=2, expiry=today - timedelta(days=1)
        )
        response = self.client.get("/api/inventory/overview/")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["metrics"]["HH_SoMatHangCoTon"], 1)
        self.assertEqual(response.data["metrics"]["TK_TongSoLuongThucTe"], 6)
        self.assertEqual(response.data["metrics"]["HH_SoMatHangDuoiNguong"], 1)
        self.assertEqual(response.data["metrics"]["TK_SoLoSapHetHan"], 1)
        self.assertEqual(response.data["metrics"]["TK_SoLoDaHetHan"], 1)
        self.assertEqual(len(response.data["expiring_lots"]), 1)
        self.assertNotIn("inventory_value", response.data["metrics"])

    def test_stock_ledger_reconciles_period_balances_and_filters_by_lot(self):
        today = timezone.localdate()
        first = self.create_confirmed_unlinked_receipt(quantity=3)
        second = self.create_confirmed_unlinked_receipt(quantity=4)
        response = self.client.get(
            "/api/inventory/stock-ledger/",
            {
                "HH_Ma": self.product.code,
                "DD_Ma": self.location.code,
                "PNCT_Ma": second["lines"][0]["PNCT_Ma"],
                "from": (today - timedelta(days=1)).isoformat(),
                "to": (today + timedelta(days=1)).isoformat(),
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        self.assertTrue(response.data["complete"])
        self.assertEqual(response.data["current"], 4)
        self.assertEqual(response.data["opening"], 0)
        self.assertEqual(response.data["inbound"], 4)
        self.assertEqual(response.data["outbound"], 0)
        self.assertEqual(response.data["closing"], 4)
        self.assertEqual(response.data["count"], 1)
        self.assertEqual(response.data["results"][0]["PNCT_Ma"], second["lines"][0]["PNCT_Ma"])
        self.assertNotEqual(first["PN_Ma"], second["PN_Ma"])

    def test_stock_ledger_reports_incomplete_when_movement_is_missing(self):
        today = timezone.localdate()
        receipt = self.create_confirmed_unlinked_receipt(quantity=4)
        StockMovement.objects.filter(document_code=receipt["PN_Ma"]).delete()

        response = self.client.get(
            "/api/inventory/stock-ledger/",
            {
                "HH_Ma": self.product.code,
                "DD_Ma": self.location.code,
                "from": today.isoformat(),
                "to": today.isoformat(),
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(response.data["complete"])
        self.assertIsNone(response.data["opening"])
        self.assertIn("đối chiếu", response.data["error"])

    def test_movement_filters_and_order_are_read_only(self):
        today = timezone.localdate()
        first = self.create_confirmed_unlinked_receipt(quantity=3)
        second = self.create_confirmed_unlinked_receipt(quantity=4)
        StockMovement.objects.filter(document_code=first["PN_Ma"]).update(
            occurred_at=timezone.now() - timedelta(hours=2)
        )
        StockMovement.objects.filter(document_code=second["PN_Ma"]).update(
            occurred_at=timezone.now() - timedelta(hours=1)
        )

        response = self.client.get(
            "/api/inventory/movements/",
            {
                "HH_Ma": self.product.code,
                "DD_Ma": self.location.code,
                "BDK_Loai": "Nhập kho",
                "from": today.isoformat(),
                "to": today.isoformat(),
            },
        )
        self.assertEqual(response.data["count"], 2)
        self.assertEqual(
            response.data["results"][0]["BDK_MaChungTu"], second["PN_Ma"]
        )
        self.assertEqual(
            self.client.post(
                "/api/inventory/movements/",
                {"BDK_SoLuong": 999},
                format="json",
            ).status_code,
            status.HTTP_405_METHOD_NOT_ALLOWED,
        )

    def test_stock_reads_require_authentication(self):
        self.client.force_authenticate(user=None)
        for endpoint in (
            "/api/inventory/stock/",
            "/api/inventory/expiry/",
            "/api/inventory/overview/",
            "/api/inventory/stock-ledger/",
            "/api/inventory/movements/",
        ):
            with self.subTest(endpoint=endpoint):
                self.assertEqual(
                    self.client.get(endpoint).status_code,
                    status.HTTP_401_UNAUTHORIZED,
                )


class InventoryConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def test_concurrent_drafts_cannot_reserve_more_than_ordered(self):
        warehouse_group, _ = Group.objects.get_or_create(name="Nhân viên kho")
        user = User.objects.create_user(
            username="concurrent-warehouse", password="Warehouse-test-pass-2026!"
        )
        user.groups.add(warehouse_group)
        employee = Employee.objects.create(full_name="Nhân viên kho", user=user)
        category = Category.objects.create(name="Concurrent inbound")
        product = Product.objects.create(
            category=category, name="Concurrent product", base_unit="Cái"
        )
        supplier = Partner.objects.create(
            name="Concurrent supplier", role=Partner.Role.SUPPLIER
        )
        location = StorageLocation.objects.create(
            name="Concurrent location", kind=StorageLocation.Kind.WAREHOUSE
        )
        order = PurchaseOrder.objects.create(
            supplier=supplier,
            employee=employee,
            ordered_on=date(2026, 11, 10),
            status=PurchaseOrder.Status.WAITING,
        )
        PurchaseOrderLine.objects.create(
            order=order, product=product, quantity=5, unit_price=10, amount=50
        )

        barrier = Barrier(2)
        outcomes = []

        def reserve():
            close_old_connections()
            barrier.wait()
            try:
                from .services import save_goods_receipt

                save_goods_receipt(
                    user=user,
                    supplier_code=supplier.code,
                    location_code=location.code,
                    received_on=date(2026, 11, 10),
                    purchase_order_code=order.code,
                    employee_code=employee.code,
                    lines=[
                        {
                            "HH_Ma": product.code,
                            "PNCT_SL": 3,
                            "PNCT_DonGia": 10,
                        }
                    ],
                )
                outcomes.append("created")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        threads = [Thread(target=reserve), Thread(target=reserve)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertCountEqual(outcomes, ["created", "rejected"])
        self.assertEqual(GoodsReceipt.objects.count(), 1)

    def test_concurrent_approval_of_one_count_adjusts_stock_once(self):
        owner_group, _ = Group.objects.get_or_create(name=STORE_OWNER_ROLE)
        owner_user = User.objects.create_user(
            username="concurrent-count-owner", password="test-password"
        )
        owner_user.groups.add(owner_group)
        owner = Employee.objects.create(
            full_name="Chủ cửa hàng", user=owner_user
        )
        warehouse_user = User.objects.create_user(
            username="concurrent-count-warehouse", password="test-password"
        )
        warehouse_group, _ = Group.objects.get_or_create(name="Nhân viên kho")
        warehouse_user.groups.add(warehouse_group)
        warehouse = Employee.objects.create(
            full_name="Nhân viên kho", user=warehouse_user
        )
        category = Category.objects.create(name="Concurrent count")
        product = Product.objects.create(
            category=category, name="Count product", base_unit="Cái"
        )
        supplier = Partner.objects.create(
            name="Count supplier", role=Partner.Role.SUPPLIER
        )
        location = StorageLocation.objects.create(
            name="Count location", kind=StorageLocation.Kind.WAREHOUSE
        )
        receipt = GoodsReceipt.objects.create(
            supplier=supplier,
            location=location,
            employee=warehouse,
            received_on=date(2026, 11, 10),
            status=GoodsReceipt.Status.CONFIRMED,
        )
        receipt_line = GoodsReceiptLine.objects.create(
            receipt=receipt,
            product=product,
            quantity=5,
            unit_price=10,
            amount=50,
        )
        StockBalance.objects.create(
            location=location,
            receipt_line=receipt_line,
            quantity=5,
        )
        StockMovement.objects.create(
            location=location,
            receipt_line=receipt_line,
            employee=warehouse,
            movement_type=StockMovement.Kind.INBOUND,
            quantity_delta=5,
            source="PhieuNhap",
            document_code=receipt.code,
        )

        from .services import create_stock_count, submit_stock_count

        count = create_stock_count(
            user=warehouse_user,
            location_code=location.code,
            count_date=date(2026, 11, 10),
            employee_code=warehouse.code,
            lines=[
                {
                    "PNCT_Ma": receipt_line.code,
                    "PKKCT_SLSoSach": 5,
                    "PKKCT_SLThucTe": 3,
                    "PKKCT_LyDo": "Thiếu hai",
                }
            ],
        )
        submit_stock_count(count.code)
        barrier = Barrier(2)
        outcomes = []

        def approve():
            close_old_connections()
            barrier.wait()
            try:
                from .services import approve_stock_count

                approve_stock_count(count.code, approved_by=owner_user)
                outcomes.append("approved")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        threads = [Thread(target=approve), Thread(target=approve)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertCountEqual(outcomes, ["approved", "rejected"])
        self.assertEqual(
            StockMovement.objects.filter(
                source="PhieuKiemKeKho", document_code=count.code
            ).count(),
            1,
        )
        self.assertEqual(
            StockBalance.objects.get(
                location=location, receipt_line=receipt_line
            ).quantity,
            3,
        )

    def test_concurrent_transfers_cannot_dispatch_more_than_source_stock(self):
        warehouse_group, _ = Group.objects.get_or_create(name="Nhân viên kho")
        accountant_group, _ = Group.objects.get_or_create(name="Nhân viên kế toán")
        user = User.objects.create_user(
            username="concurrent-transfer-user", password="test-password"
        )
        user.groups.add(warehouse_group, accountant_group)
        employee = Employee.objects.create(
            full_name="Nhân viên chuyển", user=user
        )
        category = Category.objects.create(name="Concurrent transfer")
        product = Product.objects.create(
            category=category, name="Transfer product", base_unit="Cái"
        )
        supplier = Partner.objects.create(
            name="Transfer supplier", role=Partner.Role.SUPPLIER
        )
        source = StorageLocation.objects.create(
            name="Transfer source", kind=StorageLocation.Kind.WAREHOUSE
        )
        destination = StorageLocation.objects.create(
            name="Transfer destination", kind=StorageLocation.Kind.STORE
        )
        receipt = GoodsReceipt.objects.create(
            supplier=supplier,
            location=source,
            employee=employee,
            received_on=date(2026, 11, 10),
            status=GoodsReceipt.Status.CONFIRMED,
        )
        receipt_line = GoodsReceiptLine.objects.create(
            receipt=receipt,
            product=product,
            quantity=5,
            unit_price=10,
            amount=50,
        )
        StockBalance.objects.create(
            location=source,
            receipt_line=receipt_line,
            quantity=5,
        )
        StockMovement.objects.create(
            location=source,
            receipt_line=receipt_line,
            employee=employee,
            movement_type=StockMovement.Kind.INBOUND,
            quantity_delta=5,
            source="PhieuNhap",
            document_code=receipt.code,
        )

        from .services import create_stock_transfer

        transfer_codes = []
        for _ in range(2):
            transfer = create_stock_transfer(
                user=user,
                source_location_code=source.code,
                destination_location_code=destination.code,
                transfer_date=date(2026, 11, 10),
                employee_code=employee.code,
                lines=[{"PNCT_Ma": receipt_line.code, "PXCN_SL": 4}],
            )
            transfer_codes.append(transfer.code)

        barrier = Barrier(2)
        outcomes = []

        def dispatch(code):
            close_old_connections()
            barrier.wait()
            try:
                from .services import dispatch_stock_transfer

                dispatch_stock_transfer(code, dispatched_by=user)
                outcomes.append("dispatched")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        threads = [
            Thread(target=dispatch, args=(code,)) for code in transfer_codes
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertCountEqual(outcomes, ["dispatched", "rejected"])
        self.assertEqual(
            StockBalance.objects.get(location=source, receipt_line=receipt_line).quantity,
            1,
        )
        self.assertEqual(
            StockMovement.objects.filter(
                source="PhieuXuatChuyenNoiBo",
                movement_type=StockMovement.Kind.TRANSFER_OUT,
            ).count(),
            1,
        )
        self.assertEqual(
            StockTransfer.objects.filter(status=StockTransfer.Status.IN_TRANSIT).count(),
            1,
        )

    def test_concurrent_supplier_returns_cannot_issue_same_remaining_stock_twice(self):
        warehouse_user = User.objects.create_user(
            username="concurrent-return-warehouse", password="test-password"
        )
        warehouse = Employee.objects.create(
            full_name="Nhân viên kho trả hàng", user=warehouse_user
        )
        owner_user = User.objects.create_user(
            username="concurrent-return-owner", password="test-password"
        )
        owner = Employee.objects.create(
            full_name="Chủ cửa hàng trả hàng", user=owner_user
        )
        category = Category.objects.create(name="Concurrent supplier return")
        product = Product.objects.create(
            category=category, name="Return product", base_unit="Cái"
        )
        supplier = Partner.objects.create(
            name="Return supplier", role=Partner.Role.SUPPLIER
        )
        location = StorageLocation.objects.create(
            name="Return source", kind=StorageLocation.Kind.WAREHOUSE
        )
        receipt = GoodsReceipt.objects.create(
            supplier=supplier,
            location=location,
            employee=warehouse,
            received_on=date(2026, 11, 10),
            status=GoodsReceipt.Status.CONFIRMED,
        )
        receipt_line = GoodsReceiptLine.objects.create(
            receipt=receipt,
            product=product,
            quantity=5,
            unit_price=10,
            amount=50,
        )
        StockBalance.objects.create(
            location=location, receipt_line=receipt_line, quantity=5
        )
        StockMovement.objects.create(
            location=location,
            receipt_line=receipt_line,
            employee=warehouse,
            movement_type=StockMovement.Kind.INBOUND,
            quantity_delta=5,
            source="PhieuNhap",
            document_code=receipt.code,
        )

        from .services import (
            confirm_supplier_return,
            review_supplier_return,
            save_supplier_return,
            submit_supplier_return,
        )

        return_codes = []
        for _ in range(2):
            supplier_return = save_supplier_return(
                user=warehouse_user,
                supplier_code=supplier.code,
                receipt_code=receipt.code,
                location_code=location.code,
                return_date=date(2026, 11, 10),
                reason="Hàng hư hỏng",
                lines=[
                    {
                        "PNCT_Ma": receipt_line.code,
                        "TRNCC_SL": 4,
                        "TRNCC_LyDoChiTiet": "Hàng hư hỏng",
                    }
                ],
            )
            submit_supplier_return(supplier_return.code)
            review_supplier_return(
                supplier_return.code, reviewed_by=owner_user, approve=True
            )
            return_codes.append(supplier_return.code)

        barrier = Barrier(2)
        outcomes = []

        def confirm(code):
            close_old_connections()
            barrier.wait()
            try:
                confirm_supplier_return(code, confirmed_by=warehouse_user)
                outcomes.append("shipped")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        threads = [Thread(target=confirm, args=(code,)) for code in return_codes]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertCountEqual(outcomes, ["shipped", "rejected"])
        self.assertEqual(
            StockBalance.objects.get(location=location, receipt_line=receipt_line).quantity,
            1,
        )
        self.assertEqual(
            StockMovement.objects.filter(source="TraHangNCC").count(), 1
        )
        self.assertEqual(
            SupplierReturn.objects.filter(status=SupplierReturn.Status.SHIPPED).count(),
            1,
        )

    def test_concurrent_confirmation_of_same_supplier_return_only_ships_once(self):
        warehouse_user = User.objects.create_user(
            username="same-return-warehouse", password="test-password"
        )
        warehouse = Employee.objects.create(
            full_name="Kho xác nhận trả", user=warehouse_user
        )
        owner_user = User.objects.create_user(
            username="same-return-owner", password="test-password"
        )
        owner = Employee.objects.create(full_name="Chủ cửa hàng", user=owner_user)
        product = Product.objects.create(
            category=Category.objects.create(name="Same return category"),
            name="Same return product",
            base_unit="Cái",
        )
        supplier = Partner.objects.create(
            name="Same return supplier", role=Partner.Role.SUPPLIER
        )
        location = StorageLocation.objects.create(
            name="Same return location", kind=StorageLocation.Kind.WAREHOUSE
        )
        receipt = GoodsReceipt.objects.create(
            supplier=supplier,
            location=location,
            employee=warehouse,
            received_on=date(2026, 11, 10),
            status=GoodsReceipt.Status.CONFIRMED,
        )
        receipt_line = GoodsReceiptLine.objects.create(
            receipt=receipt, product=product, quantity=5, unit_price=10, amount=50
        )
        StockBalance.objects.create(
            location=location, receipt_line=receipt_line, quantity=5
        )
        StockMovement.objects.create(
            location=location,
            receipt_line=receipt_line,
            employee=warehouse,
            movement_type=StockMovement.Kind.INBOUND,
            quantity_delta=5,
            source="PhieuNhap",
            document_code=receipt.code,
        )

        from .services import (
            confirm_supplier_return,
            review_supplier_return,
            save_supplier_return,
            submit_supplier_return,
        )

        supplier_return = save_supplier_return(
            user=warehouse_user,
            supplier_code=supplier.code,
            receipt_code=receipt.code,
            location_code=location.code,
            return_date=date(2026, 11, 10),
            reason="Hàng hư hỏng",
            lines=[
                {
                    "PNCT_Ma": receipt_line.code,
                    "TRNCC_SL": 4,
                    "TRNCC_LyDoChiTiet": "Hàng hư hỏng",
                }
            ],
        )
        submit_supplier_return(supplier_return.code)
        review_supplier_return(
            supplier_return.code, reviewed_by=owner_user, approve=True
        )
        barrier = Barrier(2)
        outcomes = []

        def confirm():
            close_old_connections()
            barrier.wait()
            try:
                confirm_supplier_return(
                    supplier_return.code, confirmed_by=warehouse_user
                )
                outcomes.append("shipped")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        threads = [Thread(target=confirm), Thread(target=confirm)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertCountEqual(outcomes, ["shipped", "rejected"])
        self.assertEqual(
            StockBalance.objects.get(
                location=location, receipt_line=receipt_line
            ).quantity,
            1,
        )
        self.assertEqual(
            StockMovement.objects.filter(
                source="TraHangNCC", document_code=supplier_return.code
            ).count(),
            1,
        )

    def test_supplier_return_and_transfer_cannot_both_consume_same_stock(self):
        warehouse_user = User.objects.create_user(
            username="return-transfer-warehouse", password="test-password"
        )
        warehouse = Employee.objects.create(
            full_name="Kho xử lý trả và chuyển", user=warehouse_user
        )
        owner_user = User.objects.create_user(
            username="return-transfer-owner", password="test-password"
        )
        owner = Employee.objects.create(full_name="Chủ cửa hàng", user=owner_user)
        product = Product.objects.create(
            category=Category.objects.create(name="Return-transfer category"),
            name="Return-transfer product",
            base_unit="Cái",
        )
        supplier = Partner.objects.create(
            name="Return-transfer supplier", role=Partner.Role.SUPPLIER
        )
        source = StorageLocation.objects.create(
            name="Return-transfer source", kind=StorageLocation.Kind.WAREHOUSE
        )
        destination = StorageLocation.objects.create(
            name="Return-transfer destination", kind=StorageLocation.Kind.STORE
        )
        receipt = GoodsReceipt.objects.create(
            supplier=supplier,
            location=source,
            employee=warehouse,
            received_on=date(2026, 11, 10),
            status=GoodsReceipt.Status.CONFIRMED,
        )
        receipt_line = GoodsReceiptLine.objects.create(
            receipt=receipt, product=product, quantity=5, unit_price=10, amount=50
        )
        StockBalance.objects.create(
            location=source, receipt_line=receipt_line, quantity=5
        )
        StockMovement.objects.create(
            location=source,
            receipt_line=receipt_line,
            employee=warehouse,
            movement_type=StockMovement.Kind.INBOUND,
            quantity_delta=5,
            source="PhieuNhap",
            document_code=receipt.code,
        )

        from .services import (
            confirm_supplier_return,
            create_stock_transfer,
            dispatch_stock_transfer,
            review_supplier_return,
            save_supplier_return,
            submit_supplier_return,
        )

        supplier_return = save_supplier_return(
            user=warehouse_user,
            supplier_code=supplier.code,
            receipt_code=receipt.code,
            location_code=source.code,
            return_date=date(2026, 11, 10),
            reason="Hàng hư hỏng",
            lines=[
                {
                    "PNCT_Ma": receipt_line.code,
                    "TRNCC_SL": 4,
                    "TRNCC_LyDoChiTiet": "Hàng hư hỏng",
                }
            ],
        )
        submit_supplier_return(supplier_return.code)
        review_supplier_return(
            supplier_return.code, reviewed_by=owner_user, approve=True
        )
        transfer = create_stock_transfer(
            user=warehouse_user,
            source_location_code=source.code,
            destination_location_code=destination.code,
            transfer_date=date(2026, 11, 10),
            employee_code=warehouse.code,
            lines=[{"PNCT_Ma": receipt_line.code, "PXCN_SL": 4}],
        )
        barrier = Barrier(2)
        outcomes = []

        def return_stock():
            close_old_connections()
            barrier.wait()
            try:
                confirm_supplier_return(
                    supplier_return.code, confirmed_by=warehouse_user
                )
                outcomes.append("returned")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        def dispatch_stock():
            close_old_connections()
            barrier.wait()
            try:
                dispatch_stock_transfer(
                    transfer.code, dispatched_by=warehouse_user
                )
                outcomes.append("transferred")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        threads = [Thread(target=return_stock), Thread(target=dispatch_stock)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertCountEqual(
            outcomes, ["rejected", "returned"]
            if SupplierReturn.objects.filter(
                code=supplier_return.code, status=SupplierReturn.Status.SHIPPED
            ).exists()
            else ["rejected", "transferred"],
        )
        self.assertEqual(
            StockBalance.objects.get(
                location=source, receipt_line=receipt_line
            ).quantity,
            1,
        )
        self.assertEqual(
            StockMovement.objects.filter(
                receipt_line=receipt_line,
                source__in=("TraHangNCC", "PhieuXuatChuyenNoiBo"),
            ).exclude(source="PhieuNhap").count(),
            1,
        )

    def test_supplier_return_and_count_approval_serialize_source_balance(self):
        warehouse_user = User.objects.create_user(
            username="return-count-warehouse", password="test-password"
        )
        warehouse = Employee.objects.create(
            full_name="Kho kiểm kê trả hàng", user=warehouse_user
        )
        owner_user = User.objects.create_user(
            username="return-count-owner", password="test-password"
        )
        owner = Employee.objects.create(full_name="Chủ cửa hàng", user=owner_user)
        product = Product.objects.create(
            category=Category.objects.create(name="Return-count category"),
            name="Return-count product",
            base_unit="Cái",
        )
        supplier = Partner.objects.create(
            name="Return-count supplier", role=Partner.Role.SUPPLIER
        )
        location = StorageLocation.objects.create(
            name="Return-count location", kind=StorageLocation.Kind.WAREHOUSE
        )
        receipt = GoodsReceipt.objects.create(
            supplier=supplier,
            location=location,
            employee=warehouse,
            received_on=date(2026, 11, 10),
            status=GoodsReceipt.Status.CONFIRMED,
        )
        receipt_line = GoodsReceiptLine.objects.create(
            receipt=receipt, product=product, quantity=5, unit_price=10, amount=50
        )
        StockBalance.objects.create(
            location=location, receipt_line=receipt_line, quantity=5
        )
        StockMovement.objects.create(
            location=location,
            receipt_line=receipt_line,
            employee=warehouse,
            movement_type=StockMovement.Kind.INBOUND,
            quantity_delta=5,
            source="PhieuNhap",
            document_code=receipt.code,
        )

        from .services import (
            approve_stock_count,
            confirm_supplier_return,
            create_stock_count,
            review_supplier_return,
            save_supplier_return,
            submit_stock_count,
            submit_supplier_return,
        )

        count = create_stock_count(
            user=warehouse_user,
            location_code=location.code,
            count_date=date(2026, 11, 10),
            lines=[
                {
                    "PNCT_Ma": receipt_line.code,
                    "PKKCT_SLSoSach": 5,
                    "PKKCT_SLThucTe": 2,
                }
            ],
        )
        submit_stock_count(count.code)
        supplier_return = save_supplier_return(
            user=warehouse_user,
            supplier_code=supplier.code,
            receipt_code=receipt.code,
            location_code=location.code,
            return_date=date(2026, 11, 10),
            reason="Hàng hư hỏng",
            lines=[
                {
                    "PNCT_Ma": receipt_line.code,
                    "TRNCC_SL": 4,
                    "TRNCC_LyDoChiTiet": "Hàng hư hỏng",
                }
            ],
        )
        submit_supplier_return(supplier_return.code)
        review_supplier_return(
            supplier_return.code, reviewed_by=owner_user, approve=True
        )

        barrier = Barrier(2)
        outcomes = []

        def approve_count():
            close_old_connections()
            barrier.wait()
            try:
                approve_stock_count(count.code, approved_by=owner_user)
                outcomes.append("counted")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        def return_stock():
            close_old_connections()
            barrier.wait()
            try:
                confirm_supplier_return(
                    supplier_return.code, confirmed_by=warehouse_user
                )
                outcomes.append("returned")
            except ValueError:
                outcomes.append("rejected")
            finally:
                close_old_connections()

        threads = [Thread(target=approve_count), Thread(target=return_stock)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(outcomes.count("rejected"), 1)
        self.assertEqual(
            outcomes.count("counted") + outcomes.count("returned"), 1
        )
        self.assertIn(
            StockBalance.objects.get(
                location=location, receipt_line=receipt_line
            ).quantity,
            (1, 2),
        )
