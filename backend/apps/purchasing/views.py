from datetime import date

from django.db.models import Q
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response

from apps.partners.models import Partner

from .models import PurchaseOrder
from .pagination import PurchaseOrderPagination
from .permissions import PurchaseOrderPermissionsMixin
from .serializers import PurchaseOrderSerializer, PurchaseOrderWriteSerializer
from .services import (
    cancel_purchase_order,
    confirm_purchase_order,
    create_purchase_order,
    update_purchase_order,
)


class PurchaseOrderViewSet(PurchaseOrderPermissionsMixin, viewsets.GenericViewSet):
    queryset = PurchaseOrder.objects.select_related(
        "supplier", "employee"
    ).prefetch_related("lines__product")
    serializer_class = PurchaseOrderSerializer
    pagination_class = PurchaseOrderPagination
    lookup_field = "code"
    lookup_value_regex = "[^/]+"
    http_method_names = ("get", "post", "patch", "head", "options")

    def get_queryset(self):
        queryset = self.queryset
        params = self.request.query_params
        search = params.get("search") or params.get("q")
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(supplier__code__icontains=search)
                | Q(supplier__name__icontains=search)
            )
        supplier_code = params.get("DT_Ma")
        if supplier_code:
            queryset = queryset.filter(
                supplier__code=supplier_code,
                supplier__role__in=(Partner.Role.SUPPLIER, Partner.Role.BOTH),
            )
        order_status = params.get("status") or params.get("DH_TrangThai")
        if order_status:
            queryset = queryset.filter(status=order_status)
        date_from = params.get("from") or params.get("date_from")
        date_to = params.get("to") or params.get("date_to")
        if date_from:
            queryset = queryset.filter(ordered_on__gte=self._parse_date(date_from))
        if date_to:
            queryset = queryset.filter(ordered_on__lte=self._parse_date(date_to))
        return queryset.order_by("-ordered_on", "-id")

    @staticmethod
    def _parse_date(value):
        try:
            return date.fromisoformat(value)
        except ValueError as error:
            raise ValidationError(
                {"date": "Ngày phải có định dạng YYYY-MM-DD."}
            ) from error

    def list(self, request, *args, **kwargs):
        page = self.paginate_queryset(self.get_queryset())
        serializer = self.get_serializer(page, many=True)
        return self.get_paginated_response(serializer.data)

    def retrieve(self, request, *args, **kwargs):
        order = self.get_object()
        return Response(self.get_serializer(order).data)

    def create(self, request, *args, **kwargs):
        serializer = PurchaseOrderWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        try:
            order = create_purchase_order(
                supplier_code=values["DT_Ma"],
                employee_code=values["NV_Ma"],
                ordered_on=values["DH_Ngay"],
                lines=values["lines"],
            )
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(
            self.get_serializer(order).data,
            status=status.HTTP_201_CREATED,
        )

    def partial_update(self, request, *args, **kwargs):
        order = self.get_object()
        serializer = PurchaseOrderWriteSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        try:
            order = update_purchase_order(
                order.code,
                supplier_code=values.get("DT_Ma"),
                employee_code=values.get("NV_Ma"),
                ordered_on=values.get("DH_Ngay"),
                lines=values.get("lines"),
            )
        except PurchaseOrder.DoesNotExist as error:
            raise NotFound("Không tìm thấy đơn đặt hàng.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(order).data)

    @action(detail=True, methods=("post",), url_path="confirm")
    def confirm(self, request, code=None):
        try:
            order = confirm_purchase_order(code)
        except PurchaseOrder.DoesNotExist as error:
            raise NotFound("Không tìm thấy đơn đặt hàng.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(order).data)

    @action(detail=True, methods=("post",), url_path="cancel")
    def cancel(self, request, code=None):
        try:
            order = cancel_purchase_order(code)
        except PurchaseOrder.DoesNotExist as error:
            raise NotFound("Không tìm thấy đơn đặt hàng.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(order).data)
