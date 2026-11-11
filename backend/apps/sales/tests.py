from datetime import timedelta

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.utils import timezone
from rest_framework.test import APITestCase

from apps.accounts.models import Employee
from apps.catalog.models import Category, Product, SalePrice
from apps.customers.models import DoiTacKinhDoanh
from apps.inventory.models import (
    GoodsReceipt,
    GoodsReceiptLine,
    StockBalance,
    StockMovement,
    StorageLocation,
)
from apps.partners.models import Partner
from apps.shifts.models import CashShift

from .models import SaleInvoice, SaleInvoiceLine, SalePayment


class SalesCheckoutTests(APITestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="seller", password="test-password"
        )
        self.owner_group, _ = Group.objects.get_or_create(
            name="Chủ cửa hàng"
        )
        self.user.groups.add(self.owner_group)
        self.employee = Employee.objects.create(
            code="NV-SALES-1",
            full_name="Sales Employee",
            user=self.user,
        )
        self.client.force_authenticate(self.user)

        self.location = StorageLocation.objects.create(
            code="DD-SALES-1",
            name="Cửa hàng kiểm thử",
            kind=StorageLocation.Kind.STORE,
            status=StorageLocation.Status.ACTIVE,
        )
        self.customer = DoiTacKinhDoanh.objects.create(
            DT_Ma="KH-SALES-1",
            DT_Ten="Khách hàng kiểm thử",
            DT_Loai=DoiTacKinhDoanh.Loai.KHACH_HANG,
            DT_TrangThai=DoiTacKinhDoanh.TrangThai.HOAT_DONG,
        )
        self.category = Category.objects.create(name="Hàng kiểm thử")
        self.product = Product.objects.create(
            code="HH-SALES-1",
            category=self.category,
            name="Sản phẩm kiểm thử",
            base_unit="cái",
            status=Product.Status.ACTIVE,
        )
        today = timezone.localdate()
        SalePrice.objects.create(
            code="GB-SALES-1",
            product=self.product,
            amount=100,
            starts_on=today - timedelta(days=1),
            status=SalePrice.Status.ACTIVE,
        )
        supplier = Partner.objects.create(
            code="DT-SUP-1",
            name="Nhà cung cấp kiểm thử",
            role=Partner.Role.SUPPLIER,
        )
        receipt = GoodsReceipt.objects.create(
            code="PN-SALES-1",
            supplier=supplier,
            location=self.location,
            employee=self.employee,
            received_on=today,
            status=GoodsReceipt.Status.CONFIRMED,
        )
        self.expiring_line = GoodsReceiptLine.objects.create(
            code="PNCT-SALES-1",
            receipt=receipt,
            product=self.product,
            expiry_date=today + timedelta(days=10),
            quantity=1,
            unit_price=50,
            amount=50,
        )
        self.later_line = GoodsReceiptLine.objects.create(
            code="PNCT-SALES-2",
            receipt=receipt,
            product=self.product,
            expiry_date=today + timedelta(days=20),
            quantity=3,
            unit_price=50,
            amount=150,
        )
        self.expired_line = GoodsReceiptLine.objects.create(
            code="PNCT-SALES-3",
            receipt=receipt,
            product=self.product,
            expiry_date=today - timedelta(days=1),
            quantity=20,
            unit_price=50,
            amount=1000,
        )
        for line, quantity in (
            (self.expiring_line, 1),
            (self.later_line, 3),
            (self.expired_line, 20),
        ):
            StockBalance.objects.create(
                location=self.location, receipt_line=line, quantity=quantity
            )
        self.shift = CashShift.objects.create(
            Ca_Ma="CA-SALES-1",
            NV_Ma=self.employee.code,
            DD_Ma=self.location.code,
            TrangThai=CashShift.Status.OPEN,
            invoice_ids=[],
            payment_ids=[],
        )

    def _create_draft(self, quantity=3):
        response = self.client.post(
            "/api/sales/invoices/create/",
            {
                "NV_Ma": self.employee.code,
                "DD_Ma": self.location.code,
                "DT_Ma": self.customer.DT_Ma,
                "allowCredit": True,
                "role": "Chủ cửa hàng",
                "lines": [
                    {
                        "HH_Ma": self.product.code,
                        "BH_SL": quantity,
                        "BH_DonGia": 100,
                        "GB_GiaGoc": 100,
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return response.data["BH_Ma"]

    def _confirm(self, invoice_code, amount=300):
        return self.client.post(
            f"/api/sales/invoices/{invoice_code}/confirm/",
            {
                "lines": [
                    {
                        "HH_Ma": self.product.code,
                        "BH_SL": 3,
                        "BH_DonGia": 100,
                        "GB_GiaGoc": 100,
                    }
                ],
                "payment": {
                    "allocations": [
                        {"method": "Tiền mặt", "amount": amount // 3},
                        {"method": "QR", "amount": amount - amount // 3},
                    ]
                },
                "role": "Chủ cửa hàng",
                "NV_Ma": self.employee.code,
                "DD_Ma": self.location.code,
                "DT_Ma": self.customer.DT_Ma,
                "allowCredit": True,
            },
            format="json",
        )

    def test_checkout_allocates_fefo_and_links_split_payments_atomically(self):
        invoice_code = self._create_draft()

        response = self._confirm(invoice_code)

        self.assertEqual(response.status_code, 200, response.data)
        invoice = SaleInvoice.objects.get(code=invoice_code)
        self.assertEqual(invoice.status, SaleInvoice.Status.CONFIRMED)
        self.assertEqual(
            list(
                invoice.lines.values_list("lot_code", "quantity").order_by("id")
            ),
            [("PNCT-SALES-1", 1), ("PNCT-SALES-2", 2)],
        )
        self.assertEqual(
            StockBalance.objects.get(receipt_line=self.expiring_line).quantity, 0
        )
        self.assertEqual(
            StockBalance.objects.get(receipt_line=self.later_line).quantity, 1
        )
        self.assertEqual(
            StockBalance.objects.get(receipt_line=self.expired_line).quantity, 20
        )
        self.assertEqual(
            StockMovement.objects.filter(
                source="HoaDonBanHang", document_code=invoice_code
            ).count(),
            2,
        )
        self.assertEqual(
            set(self.shift.__class__.objects.get(pk=self.shift.pk).payment_ids),
            set(invoice.payments.values_list("code", flat=True)),
        )
        self.assertEqual(
            set(invoice.payments.values_list("status", flat=True)),
            {SalePayment.Status.SUCCESS, SalePayment.Status.PENDING},
        )
        payment_listing = self.client.get("/api/sales/payments/")
        pending_listing = self.client.get(
            "/api/sales/payments/", {"status": SalePayment.Status.PENDING}
        )
        self.assertEqual(payment_listing.status_code, 200)
        self.assertEqual(len(payment_listing.data), 2)
        self.assertEqual(len(pending_listing.data), 1)

    def test_failed_confirmation_does_not_partially_decrement_stock(self):
        invoice_code = self._create_draft()
        StockBalance.objects.filter(receipt_line=self.later_line).update(quantity=0)

        response = self._confirm(invoice_code)

        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(
            SaleInvoice.objects.get(code=invoice_code).status,
            SaleInvoice.Status.DRAFT,
        )
        self.assertEqual(
            StockMovement.objects.filter(
                source="HoaDonBanHang", document_code=invoice_code
            ).count(),
            0,
        )
        self.assertEqual(
            StockBalance.objects.get(receipt_line=self.expiring_line).quantity, 1
        )

    def test_payment_overflow_and_idempotency_key(self):
        invoice_code = self._create_draft()
        response = self._confirm(invoice_code, amount=100)
        self.assertEqual(response.status_code, 200, response.data)
        invoice = SaleInvoice.objects.get(code=invoice_code)
        self.assertEqual(invoice.payments.filter(status=SalePayment.Status.SUCCESS).first().amount, 33)

        overflow = self.client.post(
            f"/api/sales/invoices/{invoice_code}/payments/",
            {"amount": 201, "method": "Tiền mặt"},
            format="json",
            HTTP_IDEMPOTENCY_KEY="sales-payment-overflow",
        )
        invalid_method = self.client.post(
            f"/api/sales/invoices/{invoice_code}/payments/",
            {"amount": 1, "method": "Tiền séc"},
            format="json",
            HTTP_IDEMPOTENCY_KEY="sales-payment-invalid-method",
        )
        self.assertEqual(overflow.status_code, 400, overflow.data)
        self.assertEqual(invalid_method.status_code, 400, invalid_method.data)

        payment_payload = {
            "amount": 100,
            "method": "Tiền mặt",
            "role": "Chủ cửa hàng",
            "cashierId": self.employee.code,
            "locationId": self.location.code,
        }
        first = self.client.post(
            f"/api/sales/invoices/{invoice_code}/payments/",
            payment_payload,
            format="json",
            HTTP_IDEMPOTENCY_KEY="sales-payment-retry-1",
        )
        second = self.client.post(
            f"/api/sales/invoices/{invoice_code}/payments/",
            payment_payload,
            format="json",
            HTTP_IDEMPOTENCY_KEY="sales-payment-retry-1",
        )
        self.assertEqual(first.status_code, 201, first.data)
        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(first.data["TTBH_Ma"], second.data["TTBH_Ma"])
        self.assertEqual(invoice.payments.count(), 3)

    def test_invoice_confirmation_is_idempotent(self):
        invoice_code = self._create_draft()
        first = self._confirm(invoice_code)
        second = self._confirm(invoice_code)

        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(SaleInvoiceLine.objects.filter(invoice__code=invoice_code).count(), 2)
        self.assertEqual(
            StockMovement.objects.filter(
                source="HoaDonBanHang", document_code=invoice_code
            ).count(),
            2,
        )

    def test_invoice_list_and_detail_endpoints(self):
        invoice_code = self._create_draft()

        listing = self.client.get("/api/sales/invoices/")
        detail = self.client.get(f"/api/sales/invoices/{invoice_code}/")
        missing = self.client.get("/api/sales/invoices/BH-MISSING/")

        self.assertEqual(listing.status_code, 200)
        self.assertEqual(
            [row["BH_Ma"] for row in listing.data], [invoice_code]
        )
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.data["BH_Ma"], invoice_code)
        self.assertEqual(missing.status_code, 404)

    def test_frontend_generated_draft_code_can_be_created_and_updated(self):
        payload = {
            "BH_Ma": "BH-FE-001",
            "NV_Ma": self.employee.code,
            "DD_Ma": self.location.code,
            "lines": [
                {"HH_Ma": self.product.code, "BH_SL": 1, "BH_DonGia": 100}
            ],
        }
        created = self.client.post(
            "/api/sales/invoices/create/", payload, format="json"
        )
        payload["lines"][0]["BH_SL"] = 2
        updated = self.client.post(
            "/api/sales/invoices/create/", payload, format="json"
        )

        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["BH_Ma"], "BH-FE-001")
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(
            SaleInvoice.objects.get(code="BH-FE-001").total_quantity, 2
        )

    def test_only_draft_invoice_can_be_deleted(self):
        invoice_code = self._create_draft()

        deleted = self.client.delete(f"/api/sales/invoices/{invoice_code}/")

        self.assertEqual(deleted.status_code, 204)
        self.assertFalse(SaleInvoice.objects.filter(code=invoice_code).exists())

    def test_open_shift_and_status_endpoints(self):
        self.shift.delete()

        opened = self.client.post(
            "/api/sales/shifts/open/",
            {
                "employeeId": self.employee.code,
                "locationId": self.location.code,
                "openingCash": 500_000,
                "role": "Chủ cửa hàng",
            },
            format="json",
        )
        state = self.client.get(
            f"/api/sales/shifts/{self.employee.code}/{self.location.code}/"
        )

        self.assertEqual(opened.status_code, 201, opened.data)
        self.assertEqual(state.status_code, 200)
        self.assertEqual(state.data["Ca_Ma"], opened.data["Ca_Ma"])
        self.assertEqual(state.data["TrangThai"], CashShift.Status.OPEN)

    def test_pending_payment_can_be_cancelled(self):
        invoice_code = self._create_draft()
        confirmed = self._confirm(invoice_code, amount=100)
        self.assertEqual(confirmed.status_code, 200, confirmed.data)
        pending = SalePayment.objects.get(
            invoice__code=invoice_code, status=SalePayment.Status.PENDING
        )

        response = self.client.post(
            f"/api/sales/payments/{pending.code}/cancel/",
            {"status": SalePayment.Status.CANCELLED},
            format="json",
        )

        self.assertEqual(response.status_code, 200, response.data)
        pending.refresh_from_db()
        self.assertEqual(pending.status, SalePayment.Status.CANCELLED)

    def test_accountant_can_confirm_pending_payment_while_shift_is_open(self):
        invoice_code = self._create_draft()
        response = self._confirm(invoice_code)
        self.assertEqual(response.status_code, 200, response.data)
        pending = SalePayment.objects.get(
            invoice__code=invoice_code, status=SalePayment.Status.PENDING
        )
        accountant = get_user_model().objects.create_user(
            username="accountant", password="test-password"
        )
        accountant_group, _ = Group.objects.get_or_create(
            name="Nhân viên kế toán"
        )
        accountant.groups.add(accountant_group)
        self.client.force_authenticate(accountant)

        confirmed = self.client.post(
            f"/api/sales/payments/{pending.code}/confirm/",
            {"role": "Nhân viên kế toán"},
            format="json",
        )

        self.assertEqual(confirmed.status_code, 200, confirmed.data)
        pending.refresh_from_db()
        self.assertEqual(pending.status, SalePayment.Status.SUCCESS)
