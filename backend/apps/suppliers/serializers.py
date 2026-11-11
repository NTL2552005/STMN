from rest_framework import serializers

from apps.partners.models import Partner

from .models import Supplier


class SupplierSerializer(serializers.ModelSerializer):
    DT_Ma = serializers.CharField(source="code", read_only=True)
    DT_Ten = serializers.CharField(source="name", max_length=200, required=True)
    DT_SDT = serializers.CharField(
        source="phone",
        max_length=20,
        required=False,
        allow_blank=True,
        allow_null=True,
    )
    DT_DChi = serializers.CharField(
        source="address", max_length=255, required=False, allow_blank=True
    )
    DT_STK = serializers.CharField(
        source="bank_account", max_length=50, required=False, allow_blank=True
    )
    DT_TrangThai = serializers.ChoiceField(
        source="status", choices=Supplier.Status.choices, required=False
    )
    DT_Loai = serializers.CharField(read_only=True, default=Partner.Role.SUPPLIER)

    class Meta:
        model = Supplier
        fields = (
            "id",
            "DT_Ma",
            "DT_Ten",
            "DT_SDT",
            "DT_DChi",
            "DT_STK",
            "DT_Loai",
            "DT_TrangThai",
        )

    def to_internal_value(self, data):
        data = data.copy()
        if data.get("DT_SDT") == "":
            data["DT_SDT"] = None
        return super().to_internal_value(data)

    def validate_DT_Ten(self, value):
        name = value.strip()
        if not name:
            raise serializers.ValidationError("Tên đối tác không được để trống.")
        return name

    def validate_DT_SDT(self, value):
        if value is None:
            return None
        phone = value.strip()
        if not phone:
            return None
        suppliers = Partner.objects.filter(phone_key=phone.casefold())
        if self.instance:
            suppliers = suppliers.exclude(pk=self.instance.pk)
        if suppliers.exists():
            raise serializers.ValidationError(
                "Số điện thoại đối tác đã được sử dụng."
            )
        return phone

    def validate_DT_DChi(self, value):
        return value.strip()

    def validate_DT_STK(self, value):
        return value.strip()

    def create(self, validated_data):
        validated_data.setdefault("role", Partner.Role.SUPPLIER)
        return super().create(validated_data)
