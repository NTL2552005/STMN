from django.db import transaction
from rest_framework import serializers

from .models import Category, Product, SalePrice, normalize_name
from .services import has_product_history, save_sale_price


class BlankableDateField(serializers.DateField):
    def to_internal_value(self, value):
        if value == "":
            return None
        return super().to_internal_value(value)


class CategorySerializer(serializers.ModelSerializer):
    DM_Ma = serializers.CharField(source="code", read_only=True)
    DM_Ten = serializers.CharField(source="name", max_length=150, required=True)
    DM_MoTa = serializers.CharField(
        source="description", required=False, allow_blank=True
    )
    product_count = serializers.SerializerMethodField()

    class Meta:
        model = Category
        fields = ("id", "DM_Ma", "DM_Ten", "DM_MoTa", "product_count")

    def get_product_count(self, category):
        if hasattr(category, "product_count"):
            return category.product_count
        return category.products.count()

    def validate_DM_Ten(self, value):
        name = value.strip()
        categories = Category.objects.filter(name_key=normalize_name(name))
        if self.instance:
            categories = categories.exclude(pk=self.instance.pk)
        if categories.exists():
            raise serializers.ValidationError("Tên danh mục đã tồn tại.")
        return name

    def create(self, validated_data):
        return Category.objects.create(**validated_data)


class ProductSerializer(serializers.ModelSerializer):
    HH_Ma = serializers.CharField(source="code", read_only=True)
    DM_Ma = serializers.SlugRelatedField(
        source="category", slug_field="code", queryset=Category.objects.all()
    )
    HH_MaVach = serializers.CharField(
        source="barcode", max_length=32, required=False, allow_blank=True, allow_null=True
    )
    HH_Ten = serializers.CharField(source="name", max_length=200, required=True)
    HH_DVi = serializers.CharField(source="base_unit", max_length=50, required=True)
    HH_DViDongGoi = serializers.CharField(
        source="package_unit",
        max_length=50,
        required=False,
        allow_blank=True,
        allow_null=True,
    )
    HH_TyLeQuyDoi = serializers.IntegerField(
        source="package_ratio",
        required=False,
        allow_null=True,
        min_value=1,
        max_value=9_007_199_254_740_991,
    )
    HH_Hinh = serializers.CharField(
        source="image", max_length=500, required=False, allow_blank=True
    )
    HH_TrangThai = serializers.ChoiceField(
        source="status", choices=Product.Status.choices, required=False
    )
    HH_ConfirmUnitChange = serializers.BooleanField(
        write_only=True, required=False, default=False
    )

    class Meta:
        model = Product
        fields = (
            "id",
            "HH_Ma",
            "DM_Ma",
            "HH_MaVach",
            "HH_Ten",
            "HH_DVi",
            "HH_DViDongGoi",
            "HH_TyLeQuyDoi",
            "HH_Hinh",
            "HH_TrangThai",
            "HH_ConfirmUnitChange",
        )

    def to_internal_value(self, data):
        data = data.copy()
        if data.get("HH_MaVach") == "":
            data["HH_MaVach"] = None
        if data.get("HH_DViDongGoi") == "":
            data["HH_DViDongGoi"] = None
        if data.get("HH_TyLeQuyDoi") == "":
            data["HH_TyLeQuyDoi"] = None
        return super().to_internal_value(data)

    def validate_HH_Ten(self, value):
        name = value.strip()
        products = Product.objects.filter(name_key=normalize_name(name))
        if self.instance:
            products = products.exclude(pk=self.instance.pk)
        if products.exists():
            raise serializers.ValidationError("Tên hàng hóa đã tồn tại.")
        return name

    def validate_HH_DVi(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Đơn vị tính không được để trống.")
        return value

    def validate_HH_DViDongGoi(self, value):
        if value is None:
            return None
        value = value.strip()
        return value or None

    def validate_HH_MaVach(self, value):
        if value is None:
            return None
        value = value.strip()
        if not value:
            return None
        products = Product.objects.filter(barcode=value)
        if self.instance:
            products = products.exclude(pk=self.instance.pk)
        if products.exists():
            raise serializers.ValidationError(
                "Mã vạch này đã được sử dụng cho một mặt hàng khác."
            )
        return value

    def validate(self, attrs):
        package_unit = attrs.get(
            "package_unit",
            self.instance.package_unit if self.instance else None,
        )
        package_ratio = attrs.get(
            "package_ratio",
            self.instance.package_ratio if self.instance else None,
        )
        if bool(package_unit) != (package_ratio is not None):
            raise serializers.ValidationError(
                {
                    "HH_DViDongGoi": (
                        "Nhập tên đơn vị đóng gói và tỷ lệ quy đổi, "
                        "hoặc để trống cả hai."
                    )
                }
            )
        if package_ratio is not None and package_ratio <= 0:
            raise serializers.ValidationError(
                {"HH_TyLeQuyDoi": "Tỷ lệ quy đổi phải là số nguyên dương."}
            )

        confirmed = attrs.pop("HH_ConfirmUnitChange", False)
        if self.instance:
            base_unit = attrs.get("base_unit", self.instance.base_unit)
            next_unit = attrs.get("package_unit", self.instance.package_unit)
            next_ratio = attrs.get("package_ratio", self.instance.package_ratio)
            changed = (
                base_unit != self.instance.base_unit
                or next_unit != self.instance.package_unit
                or next_ratio != self.instance.package_ratio
            )
            if changed and has_product_history(self.instance) and not confirmed:
                raise serializers.ValidationError(
                    {
                        "HH_ConfirmUnitChange": (
                            "Hàng hóa đã được tham chiếu bởi chứng từ. "
                            "Cần xác nhận thay đổi quy cách để tránh diễn giải sai lịch sử."
                        )
                    }
                )
        return attrs


class SalePriceSerializer(serializers.ModelSerializer):
    GB_Ma = serializers.CharField(source="code", read_only=True)
    HH_Ma = serializers.SlugRelatedField(
        source="product", slug_field="code", queryset=Product.objects.all()
    )
    GB_DonGia = serializers.IntegerField(
        source="amount", min_value=0, max_value=9_007_199_254_740_991
    )
    GB_NgayBD = serializers.DateField(source="starts_on")
    GB_NgayKT = BlankableDateField(
        source="ends_on", required=False, allow_null=True
    )
    GB_TrangThai = serializers.ChoiceField(
        source="status",
        choices=SalePrice.Status.choices,
        required=False,
    )
    HH_Ten = serializers.CharField(source="product.name", read_only=True)

    class Meta:
        model = SalePrice
        fields = (
            "id",
            "GB_Ma",
            "HH_Ma",
            "HH_Ten",
            "GB_DonGia",
            "GB_NgayBD",
            "GB_NgayKT",
            "GB_TrangThai",
        )

    def validate(self, attrs):
        product = attrs.get("product", self.instance.product if self.instance else None)
        amount = attrs.get("amount", self.instance.amount if self.instance else None)
        starts_on = attrs.get(
            "starts_on", self.instance.starts_on if self.instance else None
        )
        ends_on = attrs.get(
            "ends_on", self.instance.ends_on if self.instance else None
        )
        status = attrs.get(
            "status",
            self.instance.status if self.instance else SalePrice.Status.ACTIVE,
        )
        if amount is not None and amount < 0:
            raise serializers.ValidationError(
                {"GB_DonGia": "Giá bán phải là số nguyên không âm."}
            )
        if ends_on is not None and starts_on is not None and ends_on < starts_on:
            raise serializers.ValidationError(
                {"GB_NgayKT": "Ngày kết thúc không được trước ngày bắt đầu."}
            )

        self._price_values = {
            "product": product,
            "amount": amount,
            "starts_on": starts_on,
            "ends_on": ends_on,
            "status": status,
        }
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        return save_sale_price(**self._price_values)

    @transaction.atomic
    def update(self, instance, validated_data):
        return save_sale_price(instance=instance, **self._price_values)
