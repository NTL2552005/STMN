from datetime import date

from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import Category, Product, SalePrice
from .pagination import CatalogPagination
from .permissions import CatalogModelPermissionsMixin
from .serializers import CategorySerializer, ProductSerializer, SalePriceSerializer
from .services import get_active_price


class CategoryViewSet(CatalogModelPermissionsMixin, viewsets.ModelViewSet):
    serializer_class = CategorySerializer
    pagination_class = CatalogPagination
    http_method_names = ("get", "post", "put", "patch", "head", "options")
    lookup_field = "code"
    lookup_value_regex = "[^/]+"

    def get_queryset(self):
        queryset = Category.objects.annotate(product_count=Count("products")).order_by(
            "code", "pk"
        )
        search = self.request.query_params.get("search") or self.request.query_params.get("q")
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search) | Q(name__icontains=search)
            )
        return queryset


class ProductViewSet(CatalogModelPermissionsMixin, viewsets.ModelViewSet):
    serializer_class = ProductSerializer
    pagination_class = CatalogPagination
    http_method_names = ("get", "post", "put", "patch", "head", "options")
    lookup_field = "code"
    lookup_value_regex = "[^/]+"

    def get_queryset(self):
        queryset = Product.objects.select_related("category")
        search = self.request.query_params.get("search") or self.request.query_params.get("q")
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(name__icontains=search)
                | Q(barcode__icontains=search)
            )
        category_code = (
            self.request.query_params.get("category")
            or self.request.query_params.get("DM_Ma")
        )
        if category_code:
            queryset = queryset.filter(category__code=category_code)
        status_filter = (
            self.request.query_params.get("status")
            or self.request.query_params.get("HH_TrangThai")
        )
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        allowed_ordering = {
            "code": "code",
            "-code": "-code",
            "name": "name",
            "-name": "-name",
        }
        ordering = self.request.query_params.get("ordering", "code")
        return queryset.order_by(allowed_ordering.get(ordering, "code"))

    @action(detail=True, methods=("get",), url_path="active-price")
    def active_price(self, request, code=None):
        product = self.get_object()
        raw_date = request.query_params.get("date")
        if raw_date:
            try:
                on_date = date.fromisoformat(raw_date)
            except ValueError as error:
                raise ValidationError(
                    {"date": "Ngày phải có định dạng YYYY-MM-DD."}
                ) from error
        else:
            on_date = timezone.localdate()
        result = get_active_price(product, on_date)
        return Response(
            {
                "HH_Ma": product.code,
                "date": on_date,
                "GB_Ma": result["record"].code if result["record"] else None,
                "GB_DonGia": result["price"],
                "error": result["error"],
            }
        )

    def get_permissions(self):
        if self.action in ("list", "retrieve", "active_price"):
            return [IsAuthenticated()]
        return super().get_permissions()

    def destroy(self, request, *args, **kwargs):
        raise ValidationError(
            {"detail": "Không hỗ trợ xóa vật lý hàng hóa; hãy ngừng kinh doanh."}
        )


class EndPriceSerializer(serializers.Serializer):
    GB_NgayKT = serializers.DateField()


class SalePriceViewSet(CatalogModelPermissionsMixin, viewsets.ModelViewSet):
    serializer_class = SalePriceSerializer
    pagination_class = CatalogPagination
    http_method_names = ("get", "post", "put", "patch", "head", "options")
    lookup_field = "code"
    lookup_value_regex = "[^/]+"

    def get_queryset(self):
        queryset = SalePrice.objects.select_related("product")
        search = self.request.query_params.get("search") or self.request.query_params.get("q")
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(product__code__icontains=search)
                | Q(product__name__icontains=search)
            )
        product_code = (
            self.request.query_params.get("HH_Ma")
            or self.request.query_params.get("product")
        )
        if product_code:
            queryset = queryset.filter(product__code=product_code)
        status_filter = (
            self.request.query_params.get("status")
            or self.request.query_params.get("GB_TrangThai")
        )
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        return queryset

    def perform_create(self, serializer):
        self._save_price(serializer)

    def perform_update(self, serializer):
        self._save_price(serializer)

    @staticmethod
    def _save_price(serializer):
        try:
            serializer.save()
        except ValueError as error:
            raise serializers.ValidationError(
                {"GB_NgayBD": str(error)}
            ) from error

    @action(detail=True, methods=("post",), url_path="end")
    def end_price(self, request, code=None):
        price = self.get_object()
        serializer = EndPriceSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        ends_on = serializer.validated_data["GB_NgayKT"]
        if ends_on < price.starts_on:
            raise ValidationError(
                {"GB_NgayKT": "Ngày kết thúc không được trước ngày bắt đầu."}
            )
        if price.status in ("Đang áp dụng", "Có hiệu lực", "Đang hiệu lực"):
            overlaps = SalePrice.objects.filter(
                product=price.product,
                status__in=("Đang áp dụng", "Có hiệu lực", "Đang hiệu lực"),
                starts_on__lte=ends_on,
            ).filter(Q(ends_on__isnull=True) | Q(ends_on__gte=price.starts_on))
            if overlaps.exclude(pk=price.pk).exists():
                raise ValidationError(
                    {"GB_NgayKT": "Ngày kết thúc làm chồng lấn với mức giá hiệu lực khác."}
                )
        price.ends_on = ends_on
        price.save(update_fields=("ends_on",))
        return Response(self.get_serializer(price).data)

    def destroy(self, request, *args, **kwargs):
        raise ValidationError(
            {"detail": "Không hỗ trợ xóa lịch sử giá bán."}
        )
