from rest_framework import serializers

from .models import Partner


class PartnerSerializer(serializers.ModelSerializer):
    DT_Ma = serializers.CharField(source="code", read_only=True)
    DT_Ten = serializers.CharField(source="name", read_only=True)
    DT_SDT = serializers.CharField(source="phone", read_only=True, allow_null=True)
    DT_DChi = serializers.CharField(source="address", read_only=True)
    DT_STK = serializers.CharField(source="bank_account", read_only=True)
    DT_Loai = serializers.CharField(source="role", read_only=True)
    DT_TrangThai = serializers.CharField(source="status", read_only=True)

    class Meta:
        model = Partner
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
