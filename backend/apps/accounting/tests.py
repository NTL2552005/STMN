from datetime import date

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from rest_framework.test import APITestCase

from apps.accounts.models import Employee
from apps.inventory.models import GoodsReceipt, StorageLocation
from apps.partners.models import Partner

from .models import (
    ReceiptVoucher,
    SupplierDebt,
    SupplierPayment,
    SupplierReturnAdjustment,
)


class AccountingApiTests(APITestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="accounting-test", password="test-password"
        )
        self.accountant_group, _ = Group.objects.get_or_create(
            name="Nhân viên kế toán"
        )
        self.user.groups.add(self.accountant_group)
        self.employee = Employee.objects.create(
            code="NV-ACC-1", full_name="Kế toán kiểm thử", user=self.user
        )
        self.client.force_authenticate(self.user)
        self.supplier = Partner.objects.create(
            code="DT-ACC-SUP",
            name="Nhà cung cấp kiểm thử",
            role=Partner.Role.SUPPLIER,
        )
        self.location = StorageLocation.objects.create(
            code="DD-ACC-1",
            name="Kho kiểm thử",
            kind=StorageLocation.Kind.WAREHOUSE,
        )
        self.receipt = GoodsReceipt.objects.create(
            code="PN-ACC-1",
            supplier=self.supplier,
            location=self.location,
            employee=self.employee,
            received_on=date(2026, 11, 11),
            total_amount=1000,
            status=GoodsReceipt.Status.CONFIRMED,
        )

    def create_debt(self):
        response = self.client.post(
            f"/api/accounting/supplier-debts/from-receipt/{self.receipt.code}/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    def test_supplier_debt_payment_reserves_pending_and_confirms_once(self):
        debt = self.create_debt()
        cash = self.client.post(
            "/api/accounting/supplier-payments/",
            {"debt": debt["code"], "amount": 400, "method": "Tiền mặt"},
            format="json",
        )
        transfer = self.client.post(
            "/api/accounting/supplier-payments/",
            {"debt": debt["code"], "amount": 600, "method": "Chuyển khoản"},
            format="json",
        )
        overflow = self.client.post(
            "/api/accounting/supplier-payments/",
            {"debt": debt["code"], "amount": 1, "method": "Tiền mặt"},
            format="json",
        )

        self.assertEqual(cash.status_code, 201, cash.data)
        self.assertEqual(cash.data["status"], SupplierPayment.Status.SUCCESS)
        self.assertEqual(transfer.status_code, 201, transfer.data)
        self.assertEqual(transfer.data["status"], SupplierPayment.Status.PENDING)
        self.assertEqual(overflow.status_code, 400, overflow.data)
        self.assertEqual(
            self.client.get("/api/accounting/supplier-debts/").data[0]["balance"],
            600,
        )

        confirmed = self.client.post(
            f"/api/accounting/supplier-payments/{transfer.data['code']}/confirm/",
            {},
            format="json",
        )

        self.assertEqual(confirmed.status_code, 200, confirmed.data)
        self.assertEqual(confirmed.data["status"], SupplierPayment.Status.SUCCESS)
        self.assertEqual(
            self.client.get("/api/accounting/supplier-debts/").data[0]["balance"],
            0,
        )

    def test_supplier_payment_idempotency_and_manual_cash_voucher(self):
        debt = self.create_debt()
        payload = {
            "debt": debt["code"],
            "amount": 250,
            "method": "Tiền mặt",
            "idempotency_key": "supplier-payment-retry",
        }
        first = self.client.post(
            "/api/accounting/supplier-payments/", payload, format="json"
        )
        second = self.client.post(
            "/api/accounting/supplier-payments/", payload, format="json"
        )
        draft = self.client.post(
            "/api/accounting/receipts/",
            {
                "amount": 100,
                "method": "Tiền mặt",
                "date": "2026-11-11",
                "reason": "Thu khác",
            },
            format="json",
        )
        invalid_transfer = self.client.post(
            "/api/accounting/expenses/",
            {
                "amount": 100,
                "method": "Chuyển khoản",
                "date": "2026-11-11",
                "reason": "Chi khác",
            },
            format="json",
        )

        self.assertEqual(first.status_code, 201, first.data)
        self.assertEqual(second.status_code, 200, second.data)
        self.assertEqual(first.data["code"], second.data["code"])
        self.assertEqual(SupplierPayment.objects.count(), 1)
        self.assertEqual(draft.status_code, 201, draft.data)
        self.assertEqual(draft.data["status"], ReceiptVoucher.Status.DRAFT)
        self.assertEqual(invalid_transfer.status_code, 400)

        confirmed = self.client.post(
            f"/api/accounting/receipts/{draft.data['code']}/status/",
            {"status": ReceiptVoucher.Status.CONFIRMED},
            format="json",
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.data)
        self.assertEqual(confirmed.data["status"], ReceiptVoucher.Status.CONFIRMED)

    def test_supplier_return_adjustment_reduces_payable_and_preserves_credit(self):
        from apps.inventory.models import SupplierReturn
        from .services import record_supplier_return_adjustment

        debt_data = self.create_debt()
        debt = SupplierDebt.objects.get(receipt=self.receipt)
        returned = SupplierReturn.objects.create(
            code="TRNCC-ACC-1",
            supplier=self.supplier,
            receipt=self.receipt,
            source_location=self.location,
            employee=self.employee,
            return_date=date(2026, 11, 11),
            total_quantity=1,
            total_amount=400,
            status=SupplierReturn.Status.SHIPPED,
            reason="Hàng lỗi",
        )

        adjustment = record_supplier_return_adjustment(returned)
        debt.refresh_from_db()

        self.assertEqual(adjustment.amount, 400)
        self.assertEqual(SupplierReturnAdjustment.objects.count(), 1)
        self.assertEqual(debt.balance, 600)
        self.assertEqual(debt_data["code"], self.receipt.code)

        payment = self.client.post(
            "/api/accounting/supplier-payments/",
            {"debt": debt_data["code"], "amount": 700, "method": "Tiền mặt"},
            format="json",
        )
        self.assertEqual(payment.status_code, 400, payment.data)

    def test_accounting_api_rejects_non_accounting_roles(self):
        sales_user = get_user_model().objects.create_user(
            username="accounting-sales", password="test-password"
        )
        sales_group, _ = Group.objects.get_or_create(name="Nhân viên bán hàng")
        sales_user.groups.add(sales_group)
        self.client.force_authenticate(sales_user)

        response = self.client.get("/api/accounting/supplier-debts/")

        self.assertEqual(response.status_code, 403)

    def test_dashboard_reconciliation_cashbook_and_reports_are_available(self):
        self.create_debt()

        dashboard = self.client.get("/api/accounting/dashboard/")
        payments = self.client.get("/api/accounting/payment-reconciliation/")
        cashbook = self.client.get("/api/accounting/cashbook/")
        reports = self.client.get("/api/accounting/reports/")
        purchases = self.client.get("/api/accounting/purchase-reconciliation/")
        revenue = self.client.get("/api/accounting/revenue-reconciliation/")

        self.assertEqual(dashboard.status_code, 200, dashboard.data)
        self.assertEqual(payments.status_code, 200, payments.data)
        self.assertEqual(cashbook.status_code, 200, cashbook.data)
        self.assertEqual(reports.status_code, 200, reports.data)
        self.assertEqual(purchases.status_code, 200, purchases.data)
        self.assertEqual(revenue.status_code, 200, revenue.data)
        self.assertEqual(dashboard.data["payable_balance"], 1000)
