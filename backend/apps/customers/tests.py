from rest_framework import status
from rest_framework.test import APITestCase

from .models import DoiTacKinhDoanh


class PartnerAPITest(APITestCase):
    def test_create_customer_partner(self):
        payload = {
            'DT_Ma': 'DT100',
            'DT_Ten': 'Khách hàng test',
            'DT_SDT': '0909123456',
            'DT_DChi': 'HCM',
            'DT_Loai': 'Khách hàng',
            'DT_TrangThai': 'Hoạt động',
        }
        response = self.client.post('/api/customers/partners/', payload, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data['DT_Ten'], 'Khách hàng test')
        self.assertEqual(response.data['DT_Loai'], 'Khách hàng')
        self.assertEqual(response.data['DT_SDT'], '0909123456')

    def test_customer_phone_may_be_omitted(self):
        response = self.client.post('/api/customers/partners/', {
            'DT_Ma': 'DT101',
            'DT_Ten': 'Khách lẻ',
            'DT_Loai': 'Khách hàng',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertIsNone(response.data['DT_SDT'])

    def test_partner_id_is_generated_for_api_create(self):
        response = self.client.post('/api/customers/partners/', {
            'DT_Ten': 'Khách hàng có mã tự động',
            'DT_Loai': 'Khách hàng',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertRegex(response.data['DT_Ma'], r'^DT\d{4,}$')

    def test_phone_length_and_ascii_digits_are_validated(self):
        for index, phone in enumerate(['123456789', '123456789012', '09012abc45', '0901 234567'], start=1):
            with self.subTest(phone=phone):
                response = self.client.post('/api/customers/partners/', {
                    'DT_Ma': f'DT1{index:02d}',
                    'DT_Ten': 'Khách hàng lỗi SĐT',
                    'DT_SDT': phone,
                    'DT_Loai': 'Khách hàng',
                }, format='json')
                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn('DT_SDT', response.data)

        for index, phone in enumerate(['0901234567', '09012345678'], start=1):
            with self.subTest(phone=phone):
                response = self.client.post('/api/customers/partners/', {
                    'DT_Ma': f'DT2{index:02d}',
                    'DT_Ten': 'Khách hàng hợp lệ',
                    'DT_SDT': phone,
                    'DT_Loai': 'Khách hàng',
                }, format='json')
                self.assertEqual(response.status_code, status.HTTP_201_CREATED)
                self.assertEqual(response.data['DT_SDT'], phone)

    def test_phone_must_be_sent_as_text_to_preserve_leading_zero(self):
        response = self.client.post('/api/customers/partners/', {
            'DT_Ma': 'DT-NUMERIC-PHONE',
            'DT_Ten': 'Khách hàng số điện thoại số',
            'DT_SDT': 901234567,
            'DT_Loai': 'Khách hàng',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn('DT_SDT', response.data)

    def test_supplier_requires_phone_address_and_bank_account(self):
        base = {
            'DT_Ten': 'Nhà cung cấp',
            'DT_Loai': 'Nhà cung cấp',
            'DT_DChi': 'Hà Nội',
            'DT_STK': '123456789',
            'DT_SDT': '0901234567',
        }
        for field in ('DT_SDT', 'DT_DChi', 'DT_STK'):
            with self.subTest(field=field):
                payload = {**base, 'DT_Ma': f'DT-S-{field[-2:]}'}
                payload[field] = '   ' if field != 'DT_SDT' else ''
                response = self.client.post('/api/customers/partners/', payload, format='json')
                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)

        response = self.client.post('/api/customers/partners/', {
            **base, 'DT_Ma': 'DT-S-OK',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_blank_name_and_all_type_are_rejected(self):
        for payload in (
            {'DT_Ma': 'DT-NAME', 'DT_Ten': '   ', 'DT_Loai': 'Khách hàng'},
            {'DT_Ma': 'DT-ALL', 'DT_Ten': 'Đối tác', 'DT_Loai': 'Tất cả'},
        ):
            response = self.client.post('/api/customers/partners/', payload, format='json')
            self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_duplicate_phone_is_rejected(self):
        supplier = {
            'DT_Ma': 'DT200',
            'DT_Ten': 'Nhà cung cấp test',
            'DT_SDT': '0909111222',
            'DT_DChi': 'Hà Nội',
            'DT_STK': '123456789',
            'DT_Loai': 'Nhà cung cấp',
            'DT_TrangThai': 'Hoạt động',
        }
        self.client.post('/api/customers/partners/', supplier, format='json')

        customer = {
            'DT_Ma': 'DT201',
            'DT_Ten': 'Khách hàng đồng loại',
            'DT_SDT': '0909111222',
            'DT_DChi': 'Hà Nội',
            'DT_Loai': 'Khách hàng',
            'DT_TrangThai': 'Hoạt động',
        }
        response = self.client.post('/api/customers/partners/', customer, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(DoiTacKinhDoanh.objects.filter(DT_SDT='0909111222').count(), 1)

    def test_patch_validates_phone_and_supplier_fields(self):
        partner = DoiTacKinhDoanh.objects.create(
            DT_Ma='DT-PATCH',
            DT_Ten='Khách hàng',
            DT_Loai='Khách hàng',
        )
        response = self.client.patch(f'/api/customers/partners/{partner.DT_Ma}/', {
            'DT_SDT': '123',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(partner.DT_SDT, None)

        response = self.client.patch(f'/api/customers/partners/{partner.DT_Ma}/', {
            'DT_Loai': 'Nhà cung cấp',
            'DT_DChi': '   ',
            'DT_STK': '',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertTrue({'DT_SDT', 'DT_DChi', 'DT_STK'}.issubset(response.data.keys()))
        partner.refresh_from_db()
        self.assertEqual(partner.DT_Loai, 'Khách hàng')

    def test_patch_allows_unchanged_phone_and_customer_blank_address(self):
        partner = DoiTacKinhDoanh.objects.create(
            DT_Ma='DT-PATCH-OK',
            DT_Ten='Khách hàng',
            DT_SDT='0901234567',
            DT_DChi='',
            DT_Loai='Khách hàng',
        )
        response = self.client.patch(f'/api/customers/partners/{partner.DT_Ma}/', {
            'DT_Ten': 'Khách hàng cập nhật',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['DT_SDT'], '0901234567')
        self.assertEqual(response.data['DT_DChi'], '')

    def test_patch_rejects_phone_used_by_another_partner(self):
        DoiTacKinhDoanh.objects.create(
            DT_Ma='DT-PHONE-1',
            DT_Ten='Khách hàng 1',
            DT_SDT='0901234567',
            DT_Loai='Khách hàng',
        )
        partner = DoiTacKinhDoanh.objects.create(
            DT_Ma='DT-PHONE-2',
            DT_Ten='Khách hàng 2',
            DT_Loai='Khách hàng',
        )
        response = self.client.patch(f'/api/customers/partners/{partner.DT_Ma}/', {
            'DT_SDT': '0901234567',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        partner.refresh_from_db()
        self.assertIsNone(partner.DT_SDT)

    def test_all_filter_returns_both_partner_types(self):
        DoiTacKinhDoanh.objects.create(DT_Ma='DT300', DT_Ten='Khách 1', DT_Loai='Khách hàng')
        DoiTacKinhDoanh.objects.create(DT_Ma='DT301', DT_Ten='NCC 1', DT_Loai='Nhà cung cấp')

        response = self.client.get('/api/customers/partners/?type=T%E1%BA%A5t+c%E1%BA%A3')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual({row['DT_Loai'] for row in response.data}, {'Khách hàng', 'Nhà cung cấp'})

    def test_invalid_data_is_not_saved(self):
        response = self.client.post('/api/customers/partners/', {
            'DT_Ma': 'DT-INVALID',
            'DT_Ten': '   ',
            'DT_SDT': '123',
            'DT_Loai': 'Khách hàng',
        }, format='json')
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertFalse(DoiTacKinhDoanh.objects.filter(DT_Ma='DT-INVALID').exists())
