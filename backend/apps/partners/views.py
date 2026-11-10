from django.db.models import Q
from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated

from .models import Partner
from .pagination import PartnerPagination
from .serializers import PartnerSerializer


class PartnerViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = PartnerSerializer
    permission_classes = (IsAuthenticated,)
    pagination_class = PartnerPagination
    queryset = Partner.objects.all()
    lookup_field = "code"
    lookup_value_regex = "[^/]+"

    def get_queryset(self):
        queryset = Partner.objects.all()
        search = self.request.query_params.get("search") or self.request.query_params.get("q")
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(name__icontains=search)
                | Q(phone__icontains=search)
            )
        role = self.request.query_params.get("role") or self.request.query_params.get("DT_Loai")
        if role:
            queryset = queryset.filter(role=role)
        state = self.request.query_params.get("status") or self.request.query_params.get("DT_TrangThai")
        if state:
            queryset = queryset.filter(status=state)
        return queryset
