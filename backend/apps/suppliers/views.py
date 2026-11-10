from django.db.models import Q
from rest_framework import viewsets

from .models import Supplier
from .pagination import SupplierPagination
from .permissions import SupplierPermissionsMixin
from .serializers import SupplierSerializer


class SupplierViewSet(SupplierPermissionsMixin, viewsets.ModelViewSet):
    serializer_class = SupplierSerializer
    queryset = Supplier.objects.all()
    pagination_class = SupplierPagination
    lookup_field = "code"
    lookup_value_regex = "[^/]+"
    http_method_names = ("get", "post", "put", "patch", "head", "options")

    def get_queryset(self):
        queryset = Supplier.objects.all()
        search = self.request.query_params.get("search") or self.request.query_params.get("q")
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(name__icontains=search)
                | Q(phone__icontains=search)
            )
        status_filter = (
            self.request.query_params.get("status")
            or self.request.query_params.get("DT_TrangThai")
        )
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        return queryset
