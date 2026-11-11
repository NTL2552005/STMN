from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from rest_framework import status
from rest_framework.test import APITestCase

from apps.accounts.models import Employee
from apps.inventory.models import StorageLocation
from apps.sales.models import SaleInvoice, SalePayment

from .models import CashShift


class CashShiftAPITest(APITestCase):
    def setUp(self):
        user = get_user_model().objects.create_user(username="shift-test", password="test-pass")
        owner_role, _ = Group.objects.get_or_create(name="Chủ cửa hàng")
        user.groups.add(owner_role)
        Employee.objects.create(code="NV-SHIFT-TEST", full_name="Shift Test", user=user)
        self.client.force_authenticate(user)
        self.location = StorageLocation.objects.create(
            code="DD-SHIFT-TEST",
            name="Shift Test Store",
            kind=StorageLocation.Kind.STORE,
        )

    def test_open_cash_shift(self):
        payload = {
            'Ca_Ma': 'CA00001',
            'NV_Ma': 'NV-SHIFT-TEST',
            'DD_Ma': self.location.code,
            'TienMatDauCa': 100000,
            'GhiChu': 'Mở ca đầu ngày',
        }
        response = self.client.post('/api/shifts/open/', payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['TrangThai'], CashShift.Status.OPEN)
        self.assertEqual(response.data['TienMatDauCa'], 100000)

    def test_sales_user_can_only_open_their_own_shift(self):
        sales_user = get_user_model().objects.create_user(username="cashier-test", password="test-pass")
        sales_role, _ = Group.objects.get_or_create(name="Nhân viên bán hàng")
        sales_user.groups.add(sales_role)
        Employee.objects.create(code="NV-CASHIER-TEST", full_name="Cashier Test", user=sales_user)
        self.client.force_authenticate(sales_user)

        self.assertEqual(self.client.get('/api/shifts/').status_code, status.HTTP_403_FORBIDDEN)
        own_shift = self.client.post('/api/shifts/open/', {
            'Ca_Ma': 'CA-CASHIER-TEST',
            'NV_Ma': 'NV-CASHIER-TEST',
            'DD_Ma': self.location.code,
            'TienMatDauCa': 100000,
        }, format='json')
        self.assertEqual(own_shift.status_code, status.HTTP_201_CREATED)

        other_shift = self.client.post('/api/shifts/open/', {
            'Ca_Ma': 'CA-OTHER-TEST',
            'NV_Ma': 'NV-SHIFT-TEST',
            'DD_Ma': self.location.code,
            'TienMatDauCa': 100000,
        }, format='json')
        self.assertEqual(other_shift.status_code, status.HTTP_403_FORBIDDEN)

    def test_submit_cash_shift_closes_with_pending_reconcile(self):
        shift = CashShift.objects.create(
            Ca_Ma='CA00002',
            NV_Ma='NV-SHIFT-TEST',
            DD_Ma=self.location.code,
            TienMatDauCa=100000,
            TrangThai=CashShift.Status.OPEN,
        )
        invoice = SaleInvoice.objects.create(
            code="BH-SHIFT-TEST",
            employee=Employee.objects.get(code="NV-SHIFT-TEST"),
            location=self.location,
            total_amount=30000,
            status=SaleInvoice.Status.CONFIRMED,
        )
        SalePayment.objects.create(
            code="TTBH-SHIFT-TEST",
            invoice=invoice,
            amount=30000,
            method=SalePayment.Method.CASH,
            status=SalePayment.Status.SUCCESS,
        )
        payload = {
            'TienMatThucDem': 130000,
            'cash_payments': [{'amount': 900000, 'method': 'Tiền mặt'}],
            'GiaiTrinh': 'Đúng số',
        }
        response = self.client.post(f'/api/shifts/{shift.Ca_Ma}/submit/', payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['TrangThai'], CashShift.Status.PENDING_RECONCILE)
        self.assertEqual(response.data['TienMatDuKien'], 130000)
        self.assertEqual(response.data['ChenhLech'], 0)

    def test_reconcile_and_handover_flow(self):
        shift = CashShift.objects.create(
            Ca_Ma='CA00003',
            NV_Ma='NV-SHIFT-TEST',
            DD_Ma=self.location.code,
            TienMatDauCa=100000,
            TienMatThucDem=90000,
            TienMatDuKien=100000,
            ChenhLech=-10000,
            GiaiTrinh='Sai số do trả lại tiền',
            TrangThai=CashShift.Status.PENDING_RECONCILE,
        )
        reconcile = self.client.post(f'/api/shifts/{shift.Ca_Ma}/reconcile/', {'employeeId': 'NV005', 'note': 'Đối soát xong'}, format='json')
        self.assertEqual(reconcile.status_code, status.HTTP_200_OK)
        self.assertEqual(reconcile.data['TrangThai'], CashShift.Status.RECONCILED)

        handover = self.client.post(f'/api/shifts/{shift.Ca_Ma}/handover/', {'employeeId': 'NV005', 'TienMatBanGiao': 90000, 'GhiChuBanGiao': 'Bàn giao tiền mặt'}, format='json')
        self.assertEqual(handover.status_code, status.HTTP_200_OK)
        self.assertEqual(handover.data['TrangThai'], CashShift.Status.HANDED_OVER)
