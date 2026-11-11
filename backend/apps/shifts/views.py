from django.core.exceptions import ValidationError
from django.db.models import Q
from django.utils import timezone
from rest_framework import generics, serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.constants import STORE_OWNER_ROLE
from apps.accounts.permissions import user_has_any_role
from apps.accounts.models import Employee
from apps.inventory.permissions import IsAccountantOrOwner, IsSalesOrOwner
from apps.sales.models import SaleInvoice, SalePayment

from .models import CashShift


def _is_store_owner(user):
    return bool(
        user.is_staff
        or user.is_superuser
        or user_has_any_role(user, (STORE_OWNER_ROLE,))
    )


def _active_employee_code(user):
    return Employee.objects.filter(user=user, is_active=True).values_list('code', flat=True).first()


def _owns_shift(user, shift):
    if _is_store_owner(user):
        return True
    return _active_employee_code(user) == shift.NV_Ma


class CashShiftSerializer(serializers.ModelSerializer):
    invoiceIds = serializers.ListField(child=serializers.CharField(), source='invoice_ids', required=False)
    paymentIds = serializers.ListField(child=serializers.CharField(), source='payment_ids', required=False)

    class Meta:
        model = CashShift
        fields = [
            'Ca_Ma', 'NV_Ma', 'DD_Ma', 'GioMo', 'GioDong', 'TienMatDauCa',
            'TienMatThucDem', 'TienMatDuKien', 'ChenhLech', 'GiaiTrinh', 'GhiChu',
            'TrangThai', 'ThoiDiemGuiDoiSoat', 'NguoiYeuCauGiaiTrinh',
            'ThoiDiemYeuCauGiaiTrinh', 'GhiChuKeToan', 'NguoiDoiSoat',
            'ThoiDiemDoiSoat', 'TienMatBanGiao', 'NguoiNhanBanGiao',
            'ThoiDiemXacNhanBanGiao', 'GhiChuBanGiao', 'invoiceIds', 'paymentIds',
        ]
        read_only_fields = [
            'GioMo', 'GioDong', 'TienMatThucDem', 'TienMatDuKien', 'ChenhLech',
            'TrangThai', 'ThoiDiemGuiDoiSoat', 'ThoiDiemYeuCauGiaiTrinh',
            'ThoiDiemDoiSoat', 'ThoiDiemXacNhanBanGiao'
        ]

    def validate_TienMatDauCa(self, value):
        if value < 0:
            raise serializers.ValidationError('Tiền mặt đầu ca không được âm.')
        return value

    def validate(self, attrs):
        attrs['invoice_ids'] = attrs.get('invoice_ids', [])
        attrs['payment_ids'] = attrs.get('payment_ids', [])
        return attrs


class CashShiftListCreateAPIView(generics.ListCreateAPIView):
    queryset = CashShift.objects.all().order_by('-GioMo')
    serializer_class = CashShiftSerializer
    permission_classes = (IsAccountantOrOwner,)

    def get_permissions(self):
        if self.request.method == 'POST':
            return [IsSalesOrOwner()]
        return [IsAccountantOrOwner()]

    def create(self, request, *args, **kwargs):
        payload = request.data.copy()
        if not payload.get('Ca_Ma'):
            payload['Ca_Ma'] = self._generate_shift_code()
        if not _is_store_owner(request.user):
            employee_code = _active_employee_code(request.user)
            if not employee_code:
                return Response({'detail': 'Tài khoản chưa được gán hồ sơ nhân viên.'}, status=status.HTTP_403_FORBIDDEN)
            if employee_code != payload.get('NV_Ma'):
                return Response({'detail': 'Chỉ được mở ca cho nhân viên đang đăng nhập.'}, status=status.HTTP_403_FORBIDDEN)
        if CashShift.objects.filter(NV_Ma=payload.get('NV_Ma'), TrangThai=CashShift.Status.OPEN).exists():
            raise ValidationError('Nhân viên đã có ca đang mở. Hãy tiếp tục ca hiện tại hoặc đóng ca trước.')
        serializer = self.get_serializer(data=payload)
        serializer.is_valid(raise_exception=True)
        shift = serializer.save()
        return Response(self.get_serializer(shift).data, status=status.HTTP_201_CREATED)

    @staticmethod
    def _generate_shift_code():
        last_shift = CashShift.objects.order_by('-Ca_Ma').first()
        if not last_shift:
            return 'CA00001'
        number = int(last_shift.Ca_Ma.replace('CA', '') or '0') + 1
        return f'CA{number:05d}'


class CashShiftDetailAPIView(generics.RetrieveAPIView):
    queryset = CashShift.objects.all()
    serializer_class = CashShiftSerializer
    lookup_field = 'pk'
    permission_classes = (IsAccountantOrOwner,)


class CashShiftOpenAPIView(APIView):
    permission_classes = (IsSalesOrOwner,)

    def post(self, request, *args, **kwargs):
        data = request.data.copy()
        if not data.get('Ca_Ma'):
            data['Ca_Ma'] = CashShiftListCreateAPIView._generate_shift_code()
        if not _is_store_owner(request.user):
            employee_code = _active_employee_code(request.user)
            if not employee_code:
                return Response({'detail': 'Tài khoản chưa được gán hồ sơ nhân viên.'}, status=status.HTTP_403_FORBIDDEN)
            if employee_code != data.get('NV_Ma'):
                return Response({'detail': 'Chỉ được mở ca cho nhân viên đang đăng nhập.'}, status=status.HTTP_403_FORBIDDEN)
        if CashShift.objects.filter(NV_Ma=data.get('NV_Ma'), TrangThai=CashShift.Status.OPEN).exists():
            return Response({'detail': 'Nhân viên đã có ca đang mở.'}, status=status.HTTP_400_BAD_REQUEST)
        serializer = CashShiftSerializer(data=data)
        serializer.is_valid(raise_exception=True)
        shift = serializer.save()
        return Response(CashShiftSerializer(shift).data, status=status.HTTP_201_CREATED)


class CashShiftSubmitAPIView(APIView):
    permission_classes = (IsSalesOrOwner,)

    def post(self, request, pk, *args, **kwargs):
        shift = CashShift.objects.get(Ca_Ma=pk)
        if not _owns_shift(request.user, shift):
            return Response({'detail': 'Chỉ nhân viên sở hữu ca hoặc chủ cửa hàng được kết ca.'}, status=status.HTTP_403_FORBIDDEN)
        if shift.TrangThai != CashShift.Status.OPEN:
            return Response({'detail': 'Ca này đã kết thúc hoặc đã gửi đối soát.'}, status=status.HTTP_400_BAD_REQUEST)

        counted_cash = int(request.data.get('TienMatThucDem', request.data.get('countedCash', 0)))
        explanation = str(request.data.get('GiaiTrinh', request.data.get('explanation', ''))).strip()
        cash_sales = SalePayment.objects.filter(
            invoice__employee__code=shift.NV_Ma,
            invoice__location__code=shift.DD_Ma,
            invoice__status=SaleInvoice.Status.CONFIRMED,
            payment_date__gte=shift.GioMo,
            status=SalePayment.Status.SUCCESS,
            method=SalePayment.Method.CASH,
        )
        if shift.GioDong:
            cash_sales = cash_sales.filter(payment_date__lte=shift.GioDong)
        expected_cash = int(shift.TienMatDauCa) + sum(payment.amount for payment in cash_sales)
        if counted_cash < 0:
            return Response({'detail': 'Tiền mặt thực đếm không hợp lệ.'}, status=status.HTTP_400_BAD_REQUEST)
        variance = counted_cash - expected_cash
        if variance != 0 and not explanation:
            return Response({'detail': 'Cần nhập giải trình khi tiền thực đếm không khớp tiền dự kiến.'}, status=status.HTTP_400_BAD_REQUEST)

        shift.GioDong = timezone.now()
        shift.TienMatThucDem = counted_cash
        shift.TienMatDuKien = expected_cash
        shift.ChenhLech = variance
        shift.GiaiTrinh = explanation
        shift.ThoiDiemGuiDoiSoat = timezone.now()
        shift.TrangThai = CashShift.Status.PENDING_RECONCILE
        shift.save(update_fields=['GioDong', 'TienMatThucDem', 'TienMatDuKien', 'ChenhLech', 'GiaiTrinh', 'ThoiDiemGuiDoiSoat', 'TrangThai'])
        return Response(CashShiftSerializer(shift).data, status=status.HTTP_200_OK)


class CashShiftRequestExplanationAPIView(APIView):
    permission_classes = (IsAccountantOrOwner,)

    def post(self, request, pk, *args, **kwargs):
        shift = CashShift.objects.get(Ca_Ma=pk)
        if shift.TrangThai not in [CashShift.Status.PENDING_RECONCILE, CashShift.Status.NEEDS_EXPLANATION]:
            return Response({'detail': 'Chỉ yêu cầu giải trình cho ca đang chờ đối soát.'}, status=status.HTTP_400_BAD_REQUEST)
        reason = str(request.data.get('GhiChuKeToan') or request.data.get('note', '')).strip()
        if not reason:
            return Response({'detail': 'Cần ghi rõ nội dung yêu cầu giải trình.'}, status=status.HTTP_400_BAD_REQUEST)
        shift.TrangThai = CashShift.Status.NEEDS_EXPLANATION
        shift.NguoiYeuCauGiaiTrinh = str(request.data.get('employeeId', ''))
        shift.ThoiDiemYeuCauGiaiTrinh = timezone.now()
        shift.GhiChuKeToan = reason
        shift.save(update_fields=['TrangThai', 'NguoiYeuCauGiaiTrinh', 'ThoiDiemYeuCauGiaiTrinh', 'GhiChuKeToan'])
        return Response(CashShiftSerializer(shift).data, status=status.HTTP_200_OK)


class CashShiftReconcileAPIView(APIView):
    permission_classes = (IsAccountantOrOwner,)

    def post(self, request, pk, *args, **kwargs):
        shift = CashShift.objects.get(Ca_Ma=pk)
        if shift.TrangThai != CashShift.Status.PENDING_RECONCILE:
            return Response({'detail': 'Ca chưa ở trạng thái chờ đối soát.'}, status=status.HTTP_400_BAD_REQUEST)
        if shift.ChenhLech not in (None, 0) and not str(shift.GiaiTrinh or '').strip():
            return Response({'detail': 'Chưa có giải trình cho chênh lệch ca.'}, status=status.HTTP_400_BAD_REQUEST)
        shift.NguoiDoiSoat = str(request.data.get('employeeId', ''))
        shift.ThoiDiemDoiSoat = timezone.now()
        shift.GhiChuKeToan = str(request.data.get('note', '') or shift.GhiChuKeToan).strip()
        shift.TrangThai = CashShift.Status.RECONCILED
        shift.save(update_fields=['NguoiDoiSoat', 'ThoiDiemDoiSoat', 'GhiChuKeToan', 'TrangThai'])
        return Response(CashShiftSerializer(shift).data, status=status.HTTP_200_OK)


class CashShiftHandoverAPIView(APIView):
    permission_classes = (IsAccountantOrOwner,)

    def post(self, request, pk, *args, **kwargs):
        shift = CashShift.objects.get(Ca_Ma=pk)
        if shift.TrangThai != CashShift.Status.RECONCILED or shift.ThoiDiemXacNhanBanGiao:
            return Response({'detail': 'Chỉ xác nhận bàn giao một lần sau khi ca đã đối soát.'}, status=status.HTTP_400_BAD_REQUEST)
        handover_amount = int(request.data.get('TienMatBanGiao', request.data.get('amount', 0)))
        handover_note = str(request.data.get('GhiChuBanGiao') or request.data.get('note', '')).strip()
        if handover_amount != (shift.TienMatThucDem or 0) and not handover_note:
            return Response({'detail': 'Cần ghi chú khi số tiền bàn giao khác số tiền thực đếm.'}, status=status.HTTP_400_BAD_REQUEST)
        shift.TienMatBanGiao = handover_amount
        shift.NguoiNhanBanGiao = str(request.data.get('employeeId', ''))
        shift.ThoiDiemXacNhanBanGiao = timezone.now()
        shift.GhiChuBanGiao = handover_note
        shift.TrangThai = CashShift.Status.HANDED_OVER
        shift.save(update_fields=['TienMatBanGiao', 'NguoiNhanBanGiao', 'ThoiDiemXacNhanBanGiao', 'GhiChuBanGiao', 'TrangThai'])
        return Response(CashShiftSerializer(shift).data, status=status.HTTP_200_OK)


class CashShiftSearchAPIView(generics.ListAPIView):
    serializer_class = CashShiftSerializer
    permission_classes = (IsAccountantOrOwner,)

    def get_queryset(self):
        queryset = CashShift.objects.all()
        query = (self.request.query_params.get('q') or '').strip()
        status = (self.request.query_params.get('status') or '').strip()
        employee_id = (self.request.query_params.get('employeeId') or '').strip()
        location_id = (self.request.query_params.get('locationId') or '').strip()
        if query:
            queryset = queryset.filter(
                Q(Ca_Ma__icontains=query) |
                Q(NV_Ma__icontains=query) |
                Q(DD_Ma__icontains=query)
            )
        if status:
            queryset = queryset.filter(TrangThai=status)
        if employee_id:
            queryset = queryset.filter(NV_Ma=employee_id)
        if location_id:
            queryset = queryset.filter(DD_Ma=location_id)
        return queryset.order_by('-GioMo')
