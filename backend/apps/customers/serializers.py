import re

from rest_framework import serializers

from .models import DoiTacKinhDoanh


class PhoneNumberField(serializers.CharField):
    def to_internal_value(self, data):
        if data is not None and not isinstance(data, str):
            raise serializers.ValidationError('Số điện thoại phải được gửi dưới dạng chuỗi.')
        return super().to_internal_value(data)


class DoiTacKinhDoanhSerializer(serializers.ModelSerializer):
    DT_SDT = PhoneNumberField(required=False, allow_blank=True, allow_null=True, max_length=30)

    class Meta:
        model = DoiTacKinhDoanh
        fields = [
            'DT_Ma',
            'DT_Ten',
            'DT_SDT',
            'DT_DChi',
            'DT_Loai',
            'DT_STK',
            'DT_TrangThai',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['created_at', 'updated_at']

    def validate_DT_Ten(self, value):
        return str(value or '').strip()

    def validate_DT_SDT(self, value):
        phone = str(value or '').strip()
        return phone or None

    def validate_DT_DChi(self, value):
        return str(value or '').strip()

    def validate_DT_STK(self, value):
        return str(value or '').strip()

    def validate(self, attrs):
        name = attrs.get('DT_Ten', getattr(self.instance, 'DT_Ten', ''))
        errors = {}
        if not name:
            errors['DT_Ten'] = 'Tên đối tác không được để trống.'

        partner_type = attrs.get('DT_Loai', getattr(self.instance, 'DT_Loai', DoiTacKinhDoanh.Loai.KHACH_HANG))
        if partner_type not in DoiTacKinhDoanh.Loai.values:
            errors['DT_Loai'] = 'Loại đối tác không hợp lệ.'

        status = attrs.get('DT_TrangThai', getattr(self.instance, 'DT_TrangThai', DoiTacKinhDoanh.TrangThai.HOAT_DONG))
        if status not in DoiTacKinhDoanh.TrangThai.values:
            errors['DT_TrangThai'] = 'Trạng thái đối tác không hợp lệ.'

        if partner_type == DoiTacKinhDoanh.Loai.NHA_CUNG_CAP:
            address = attrs.get('DT_DChi', getattr(self.instance, 'DT_DChi', ''))
            if not str(address or '').strip():
                errors['DT_DChi'] = 'Vui lòng nhập địa chỉ nhà cung cấp.'
            account = attrs.get('DT_STK', getattr(self.instance, 'DT_STK', ''))
            if not str(account or '').strip():
                errors['DT_STK'] = 'Vui lòng nhập số tài khoản nhà cung cấp.'

        phone = attrs.get('DT_SDT', getattr(self.instance, 'DT_SDT', ''))
        if not phone and partner_type == DoiTacKinhDoanh.Loai.NHA_CUNG_CAP:
            errors['DT_SDT'] = 'Vui lòng nhập số điện thoại nhà cung cấp.'
        elif phone and not re.fullmatch(r'[0-9]{10,11}', phone):
            errors['DT_SDT'] = 'Số điện thoại phải gồm 10 hoặc 11 chữ số.'
        elif phone:
            existing = DoiTacKinhDoanh.objects.filter(DT_SDT=phone)
            if self.instance:
                existing = existing.exclude(pk=self.instance.pk)
            if existing.exists():
                errors['DT_SDT'] = 'Số điện thoại này đã được gắn với một đối tác khác.'

        if errors:
            raise serializers.ValidationError(errors)

        return attrs

    def create(self, validated_data):
        return super().create(validated_data)

    def update(self, instance, validated_data):
        return super().update(instance, validated_data)
