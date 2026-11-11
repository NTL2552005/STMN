import re

from django.db.models import Q
from rest_framework import generics, status
from rest_framework.response import Response

from .models import DoiTacKinhDoanh
from .serializers import DoiTacKinhDoanhSerializer


class PartnerListCreateAPIView(generics.ListCreateAPIView):
    serializer_class = DoiTacKinhDoanhSerializer

    def get_queryset(self):
        queryset = DoiTacKinhDoanh.objects.all()
        query = (self.request.query_params.get('q') or '').strip()
        partner_type = (self.request.query_params.get('type') or '').strip()
        status = (self.request.query_params.get('status') or '').strip()

        if query:
            queryset = queryset.filter(
                Q(DT_Ma__icontains=query)
                | Q(DT_Ten__icontains=query)
                | Q(DT_SDT__icontains=query)
            )
        if partner_type and partner_type != 'Tất cả':
            queryset = queryset.filter(DT_Loai=partner_type)
        if status:
            queryset = queryset.filter(DT_TrangThai=status)
        return queryset.order_by('DT_Ten')

    def create(self, request, *args, **kwargs):
        data = request.data.copy()
        if not str(data.get('DT_Ma') or '').strip():
            data['DT_Ma'] = self.generate_partner_code()
        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        partner = serializer.save()
        return Response(self.get_serializer(partner).data, status=status.HTTP_201_CREATED)

    @staticmethod
    def generate_partner_code():
        existing_codes = DoiTacKinhDoanh.objects.values_list('DT_Ma', flat=True)
        sequence = max(
            (int(match.group(1)) for code in existing_codes if (match := re.fullmatch(r'DT(\d+)', code))),
            default=0,
        ) + 1
        return f'DT{sequence:04d}'


class PartnerDetailAPIView(generics.RetrieveUpdateAPIView):
    queryset = DoiTacKinhDoanh.objects.all()
    serializer_class = DoiTacKinhDoanhSerializer
    lookup_field = 'pk'


class CustomerListAPIView(generics.ListAPIView):
    serializer_class = DoiTacKinhDoanhSerializer

    def get_queryset(self):
        queryset = DoiTacKinhDoanh.objects.filter(
            DT_Loai=DoiTacKinhDoanh.Loai.KHACH_HANG
        )
        query = (self.request.query_params.get('q') or '').strip()
        if query:
            queryset = queryset.filter(
                Q(DT_Ma__icontains=query)
                | Q(DT_Ten__icontains=query)
                | Q(DT_SDT__icontains=query)
            )
        status = (self.request.query_params.get('status') or '').strip()
        if status:
            queryset = queryset.filter(DT_TrangThai=status)
        return queryset.order_by('DT_Ten')
