from rest_framework import serializers

from apps.accounts.models import Employee
from apps.catalog.models import Product
from apps.catalog.services import (
    to_base_quantity,
    to_base_unit_price,
)
from apps.partners.models import Partner

from .models import MAX_SAFE_INTEGER, PurchaseOrder


class SafeIntegerField(serializers.IntegerField):
    def to_internal_value(self, data):
        if isinstance(data, bool) or isinstance(data, float):
            self.fail("invalid")
        value = super().to_internal_value(data)
        if abs(value) > MAX_SAFE_INTEGER:
            raise serializers.ValidationError(
                f"Giá trị không được vượt quá {MAX_SAFE_INTEGER}."
            )
        return value


class PurchaseOrderLineInputSerializer(serializers.Serializer):
    HH_Ma = serializers.CharField(max_length=20)
    DN_SL = SafeIntegerField(min_value=1)
    DN_DonGia = SafeIntegerField(min_value=0)
    DN_DonVi = SafeIntegerField(
        min_value=1, max_value=MAX_SAFE_INTEGER, required=False, default=1
    )

    def validate_HH_Ma(self, value):
        try:
            product = Product.objects.get(code=value)
        except Product.DoesNotExist as error:
            raise serializers.ValidationError("Mặt hàng không tồn tại.") from error
        if product.status != Product.Status.ACTIVE:
            raise serializers.ValidationError("Chỉ chọn hàng hóa đang kinh doanh.")
        return value

    def validate(self, attrs):
        product = Product.objects.get(code=attrs["HH_Ma"])
        factor = attrs.get("DN_DonVi", 1)
        if factor != 1 and factor != product.package_ratio:
            raise serializers.ValidationError(
                {"DN_DonVi": "Đơn vị quy đổi không hợp lệ với mặt hàng."}
            )
        try:
            quantity = to_base_quantity(attrs["DN_SL"], factor)
            unit_price = to_base_unit_price(attrs["DN_DonGia"], factor)
        except ValueError as error:
            raise serializers.ValidationError({"DN_DonVi": str(error)}) from error
        amount = quantity * unit_price
        if amount > MAX_SAFE_INTEGER:
            raise serializers.ValidationError(
                {"DN_DonGia": "Thành tiền vượt giới hạn số chính xác."}
            )
        attrs["quantity"] = quantity
        attrs["unit_price"] = unit_price
        attrs["amount"] = amount
        return attrs


class PurchaseOrderWriteSerializer(serializers.Serializer):
    DT_Ma = serializers.CharField(max_length=20)
    NV_Ma = serializers.CharField(max_length=20)
    DH_Ngay = serializers.DateField()
    lines = PurchaseOrderLineInputSerializer(many=True, allow_empty=False)

    def validate_DT_Ma(self, value):
        try:
            supplier = Partner.objects.get(code=value)
        except Partner.DoesNotExist as error:
            raise serializers.ValidationError(
                "Chọn nhà cung cấp đang hoạt động."
            ) from error
        if (
            supplier.role not in (Partner.Role.SUPPLIER, Partner.Role.BOTH)
            or supplier.status != Partner.Status.ACTIVE
        ):
            raise serializers.ValidationError("Chọn nhà cung cấp đang hoạt động.")
        return value

    def validate_NV_Ma(self, value):
        try:
            employee = Employee.objects.get(code=value)
        except Employee.DoesNotExist as error:
            raise serializers.ValidationError(
                "Nhân viên lập đơn không hợp lệ."
            ) from error
        if not employee.is_active:
            raise serializers.ValidationError("Nhân viên lập đơn không hợp lệ.")
        return value

    def validate_lines(self, lines):
        codes = [line["HH_Ma"] for line in lines]
        if len(codes) != len(set(codes)):
            raise serializers.ValidationError(
                "Mỗi mặt hàng chỉ được có một dòng trong đơn đặt hàng."
            )
        total_quantity = sum(line["quantity"] for line in lines)
        total_amount = sum(line["amount"] for line in lines)
        if total_quantity > MAX_SAFE_INTEGER or total_amount > MAX_SAFE_INTEGER:
            raise serializers.ValidationError(
                "Tổng số lượng hoặc tổng tiền vượt giới hạn chính xác."
            )
        return lines


class PurchaseOrderLineSerializer(serializers.Serializer):
    HH_Ma = serializers.CharField(source="product.code")
    HH_Ten = serializers.CharField(source="product.name")
    DN_DVi = serializers.CharField(source="product.base_unit")
    DN_SL = serializers.IntegerField(source="quantity")
    DN_DonGia = serializers.IntegerField(source="unit_price")
    DN_TTien = serializers.IntegerField(source="amount")


class PurchaseOrderSerializer(serializers.ModelSerializer):
    DH_Ma = serializers.CharField(source="code")
    DT_Ma = serializers.CharField(source="supplier.code")
    DT_Ten = serializers.CharField(source="supplier.name")
    NV_Ma = serializers.CharField(source="employee.code")
    NV_Ten = serializers.CharField(source="employee.full_name")
    DH_Ngay = serializers.DateField(source="ordered_on")
    DH_TongSL = serializers.IntegerField(source="total_quantity")
    DH_TongTien = serializers.IntegerField(source="total_amount")
    DH_TrangThai = serializers.CharField(source="status")
    lines = PurchaseOrderLineSerializer(many=True, read_only=True)

    class Meta:
        model = PurchaseOrder
        fields = (
            "id",
            "DH_Ma",
            "DT_Ma",
            "DT_Ten",
            "NV_Ma",
            "NV_Ten",
            "DH_Ngay",
            "DH_TongSL",
            "DH_TongTien",
            "DH_TrangThai",
            "lines",
        )
