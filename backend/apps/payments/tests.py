from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from rest_framework.test import APITestCase

from apps.accounts.models import Employee
from apps.customers.models import DoiTacKinhDoanh
from apps.inventory.models import StorageLocation
from apps.sales.models import SaleInvoice, SalePayment
from apps.shifts.models import CashShift


class InvoicePaymentApiTests(APITestCase):
    def setUp(self):
        user = get_user_model().objects.create_user(
            username="payments-owner",
            password="test-password",
        )
        owner_group, _ = Group.objects.get_or_create(name="Chủ cửa hàng")
        user.groups.add(owner_group)
        self.employee = Employee.objects.create(
            code="NV-PAYMENTS-1",
            full_name="Payments Employee",
            user=user,
        )
        self.client.force_authenticate(user)

        self.location = StorageLocation.objects.create(
            code="DD-PAYMENTS-1",
            name="Cửa hàng thanh toán",
            kind=StorageLocation.Kind.STORE,
            status=StorageLocation.Status.ACTIVE,
        )
        self.customer = DoiTacKinhDoanh.objects.create(
            DT_Ma="KH-PAYMENTS-1",
            DT_Ten="Khách hàng thanh toán",
            DT_Loai=DoiTacKinhDoanh.Loai.KHACH_HANG,
            DT_TrangThai=DoiTacKinhDoanh.TrangThai.HOAT_DONG,
        )
        self.invoice = SaleInvoice.objects.create(
            code="BH-PAYMENTS-1",
            employee=self.employee,
            location=self.location,
            customer=self.customer,
            total_quantity=1,
            total_amount=1000,
            status=SaleInvoice.Status.CONFIRMED,
        )
        self.shift = CashShift.objects.create(
            Ca_Ma="CA-PAYMENTS-1",
            NV_Ma=self.employee.code,
            DD_Ma=self.location.code,
            TrangThai=CashShift.Status.OPEN,
            invoice_ids=[self.invoice.code],
            payment_ids=[],
        )

    def test_create_payment_is_invoice_scoped_idempotent_and_confirmable(self):
        url = f"/api/payments/invoices/{self.invoice.code}/"
        payload = {
            "amount": 400,
            "method": SalePayment.Method.BANK_TRANSFER,
            "role": "Chủ cửa hàng",
            "NV_Ma": self.employee.code,
        }

        created = self.client.post(
            url,
            payload,
            format="json",
            HTTP_IDEMPOTENCY_KEY="invoice-payment-request-1",
        )
        retried = self.client.post(
            url,
            payload,
            format="json",
            HTTP_IDEMPOTENCY_KEY="invoice-payment-request-1",
        )

        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(retried.status_code, 200, retried.data)
        self.assertEqual(retried.data["TTBH_Ma"], created.data["TTBH_Ma"])
        self.assertEqual(SalePayment.objects.filter(invoice=self.invoice).count(), 1)
        self.assertEqual(
            CashShift.objects.get(pk=self.shift.pk).payment_ids,
            [created.data["TTBH_Ma"]],
        )

        confirmed = self.client.post(
            f"/api/payments/{created.data['TTBH_Ma']}/confirm/",
            {"role": "Chủ cửa hàng"},
            format="json",
        )

        self.assertEqual(confirmed.status_code, 200, confirmed.data)
        self.assertEqual(confirmed.data["TTBH_TrangThai"], SalePayment.Status.SUCCESS)

    def test_list_filters_and_cancel_use_the_same_invoice_payment_records(self):
        pending = SalePayment.objects.create(
            invoice=self.invoice,
            amount=300,
            method=SalePayment.Method.BANK_TRANSFER,
            status=SalePayment.Status.PENDING,
        )
        SalePayment.objects.create(
            invoice=self.invoice,
            amount=200,
            method=SalePayment.Method.CASH,
            status=SalePayment.Status.SUCCESS,
        )

        listed = self.client.get(
            "/api/payments/",
            {"invoice": self.invoice.code, "status": SalePayment.Status.PENDING},
        )
        cancelled = self.client.post(
            f"/api/payments/{pending.code}/cancel/",
            {"status": SalePayment.Status.CANCELLED, "role": "Chủ cửa hàng"},
            format="json",
        )

        self.assertEqual(listed.status_code, 200, listed.data)
        self.assertEqual([row["TTBH_Ma"] for row in listed.data], [pending.code])
        self.assertEqual(cancelled.status_code, 200, cancelled.data)
        pending.refresh_from_db()
        self.assertEqual(pending.status, SalePayment.Status.CANCELLED)
