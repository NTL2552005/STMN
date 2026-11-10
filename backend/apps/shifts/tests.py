from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase

from .models import CashShift


class CashShiftAPITest(APITestCase):
    def test_open_cash_shift(self):
        payload = {
            'Ca_Ma': 'CA00001',
            'NV_Ma': 'NV004',
            'DD_Ma': 'DD001',
            'TienMatDauCa': 100000,
            'GhiChu': 'Mở ca đầu ngày',
        }
        response = self.client.post('/api/shifts/open/', payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['TrangThai'], CashShift.Status.OPEN)
        self.assertEqual(response.data['TienMatDauCa'], 100000)

    def test_submit_cash_shift_closes_with_pending_reconcile(self):
        shift = CashShift.objects.create(
            Ca_Ma='CA00002',
            NV_Ma='NV004',
            DD_Ma='DD001',
            TienMatDauCa=100000,
            TrangThai=CashShift.Status.OPEN,
        )
        payload = {
            'TienMatThucDem': 130000,
            'cash_payments': [{'amount': 30000, 'method': 'Tiền mặt'}],
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
            NV_Ma='NV004',
            DD_Ma='DD001',
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
