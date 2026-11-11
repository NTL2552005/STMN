from rest_framework import serializers
from django.utils import timezone

from apps.catalog.models import Product

from .models import (
    MAX_SAFE_INTEGER,
    GoodsReceipt,
    GoodsReceiptLine,
    StockCount,
    StockCountLine,
    StockBalance,
    StockMovement,
    StockTransfer,
    StockTransferLine,
    SupplierReturn,
    SupplierReturnLine,
    StorageLocation,
)


class SafeIntegerField(serializers.IntegerField):
    def to_internal_value(self, data):
        if isinstance(data, (bool, float)):
            self.fail("invalid")
        value = super().to_internal_value(data)
        if abs(value) > MAX_SAFE_INTEGER:
            raise serializers.ValidationError(
                f"Giá trị không được vượt quá {MAX_SAFE_INTEGER}."
            )
        return value


class OptionalDateField(serializers.DateField):
    def to_internal_value(self, value):
        if value == "":
            return None
        return super().to_internal_value(value)


class OptionalSafeIntegerField(SafeIntegerField):
    def to_internal_value(self, data):
        if data == "":
            return None
        return super().to_internal_value(data)


class GoodsReceiptLineInputSerializer(serializers.Serializer):
    HH_Ma = serializers.CharField(max_length=20)
    PNCT_SL = SafeIntegerField(min_value=1)
    PNCT_DonGia = SafeIntegerField(min_value=0)
    PNCT_DViNhap = SafeIntegerField(
        min_value=1, max_value=MAX_SAFE_INTEGER, required=False, default=1
    )
    PNCT_NSX = OptionalDateField(required=False, allow_null=True)
    PNCT_HSD = OptionalDateField(required=False, allow_null=True)
    PNCT_HSDToiThieu = OptionalSafeIntegerField(
        min_value=0, required=False, allow_null=True
    )

    def validate_HH_Ma(self, value):
        if not Product.objects.filter(code=value).exists():
            raise serializers.ValidationError("Mặt hàng trong phiếu nhập không tồn tại.")
        return value

    def validate(self, attrs):
        production = attrs.get("PNCT_NSX")
        expiry = attrs.get("PNCT_HSD")
        if production and expiry and expiry < production:
            raise serializers.ValidationError(
                {"PNCT_HSD": "Hạn sử dụng không được trước ngày sản xuất."}
            )
        return attrs


class GoodsReceiptWriteSerializer(serializers.Serializer):
    DT_Ma = serializers.CharField(max_length=20, required=False)
    DD_Ma = serializers.CharField(max_length=20, required=False)
    DH_Ma = serializers.CharField(max_length=20, allow_blank=True, required=False)
    NV_Ma = serializers.CharField(max_length=20, required=False, allow_blank=True)
    PN_Ngay = serializers.DateField(required=False)
    lines = GoodsReceiptLineInputSerializer(many=True, required=False, allow_empty=False)

    def validate(self, attrs):
        if not self.partial:
            required_fields = ("DT_Ma", "DD_Ma", "PN_Ngay", "lines")
            missing = [field for field in required_fields if field not in attrs]
            if missing:
                raise serializers.ValidationError(
                    {field: "Trường này là bắt buộc." for field in missing}
                )
        return attrs


class GoodsReceiptLineSerializer(serializers.ModelSerializer):
    PNCT_Ma = serializers.CharField(source="code")
    HH_Ma = serializers.CharField(source="product.code")
    HH_Ten = serializers.CharField(source="product.name")
    PNCT_NSX = OptionalDateField(source="production_date", allow_null=True)
    PNCT_HSD = OptionalDateField(source="expiry_date", allow_null=True)
    PNCT_HSDToiThieu = OptionalSafeIntegerField(
        source="minimum_expiry_days", allow_null=True
    )
    PNCT_SL = serializers.IntegerField(source="quantity")
    PNCT_DonGia = serializers.IntegerField(source="unit_price")
    PNCT_TTien = serializers.IntegerField(source="amount")

    class Meta:
        model = GoodsReceiptLine
        fields = (
            "PNCT_Ma",
            "HH_Ma",
            "HH_Ten",
            "PNCT_NSX",
            "PNCT_HSD",
            "PNCT_HSDToiThieu",
            "PNCT_SL",
            "PNCT_DonGia",
            "PNCT_TTien",
        )


class GoodsReceiptSerializer(serializers.ModelSerializer):
    PN_Ma = serializers.CharField(source="code")
    DH_Ma = serializers.CharField(
        source="purchase_order.code", allow_null=True, read_only=True
    )
    DT_Ma = serializers.CharField(source="supplier.code")
    DT_Ten = serializers.CharField(source="supplier.name")
    DD_Ma = serializers.CharField(source="location.code")
    DD_Ten = serializers.CharField(source="location.name")
    NV_Ma = serializers.CharField(source="employee.code")
    NV_Ten = serializers.CharField(source="employee.full_name")
    NV_Duyet = serializers.CharField(
        source="confirmed_by.code", allow_null=True, read_only=True
    )
    PN_Ngay = serializers.DateField(source="received_on")
    PN_TongSL = serializers.IntegerField(source="total_quantity")
    PN_TongTien = serializers.IntegerField(source="total_amount")
    PN_TrangThai = serializers.CharField(source="status")
    lines = GoodsReceiptLineSerializer(many=True, read_only=True)

    class Meta:
        model = GoodsReceipt
        fields = (
            "PN_Ma",
            "DH_Ma",
            "DT_Ma",
            "DT_Ten",
            "DD_Ma",
            "DD_Ten",
            "NV_Ma",
            "NV_Ten",
            "NV_Duyet",
            "PN_Ngay",
            "PN_TongSL",
            "PN_TongTien",
            "PN_TrangThai",
            "lines",
        )


class StockCountLineInputSerializer(serializers.Serializer):
    PNCT_Ma = serializers.CharField(max_length=20)
    PKKCT_SLSoSach = SafeIntegerField(min_value=0)
    PKKCT_SLThucTe = SafeIntegerField(min_value=0)
    PKKCT_LyDo = serializers.CharField(
        max_length=255, required=False, allow_blank=True, default=""
    )


class StockCountWriteSerializer(serializers.Serializer):
    DD_Ma = serializers.CharField(max_length=20)
    NV_Ma = serializers.CharField(
        max_length=20, required=False, allow_blank=True, default=""
    )
    PKK_Ngay = serializers.DateField()
    PKK_GhiChu = serializers.CharField(
        max_length=255, required=False, allow_blank=True, default=""
    )
    lines = StockCountLineInputSerializer(many=True, allow_empty=False)


class StockCountLineSerializer(serializers.ModelSerializer):
    PKKCT_Ma = serializers.CharField(source="code")
    PNCT_Ma = serializers.CharField(source="receipt_line.code")
    HH_Ma = serializers.CharField(source="receipt_line.product.code")
    HH_Ten = serializers.CharField(source="receipt_line.product.name")
    PNCT_HSD = OptionalDateField(
        source="receipt_line.expiry_date", allow_null=True, read_only=True
    )
    PKKCT_SLSoSach = serializers.IntegerField(source="book_quantity")
    PKKCT_SLThucTe = serializers.IntegerField(source="actual_quantity")
    PKKCT_ChenhLech = serializers.IntegerField(source="difference")
    PKKCT_LyDo = serializers.CharField(source="reason")

    class Meta:
        model = StockCountLine
        fields = (
            "PKKCT_Ma",
            "PNCT_Ma",
            "HH_Ma",
            "HH_Ten",
            "PNCT_HSD",
            "PKKCT_SLSoSach",
            "PKKCT_SLThucTe",
            "PKKCT_ChenhLech",
            "PKKCT_LyDo",
        )


class StockCountSerializer(serializers.ModelSerializer):
    PKK_Ma = serializers.CharField(source="code")
    DD_Ma = serializers.CharField(source="location.code")
    DD_Ten = serializers.CharField(source="location.name")
    NV_Ma = serializers.CharField(source="employee.code")
    NV_Ten = serializers.CharField(source="employee.full_name")
    NV_Duyet = serializers.CharField(
        source="approved_by.code", allow_null=True, read_only=True
    )
    NV_DuyetTen = serializers.CharField(
        source="approved_by.full_name", allow_null=True, read_only=True
    )
    PKK_Ngay = serializers.DateField(source="count_date")
    PKK_NgayDuyet = serializers.SerializerMethodField()
    PKK_TrangThai = serializers.CharField(source="status")
    PKK_GhiChu = serializers.CharField(source="note")
    lines = StockCountLineSerializer(many=True, read_only=True)

    class Meta:
        model = StockCount
        fields = (
            "PKK_Ma",
            "DD_Ma",
            "DD_Ten",
            "NV_Ma",
            "NV_Ten",
            "NV_Duyet",
            "NV_DuyetTen",
            "PKK_Ngay",
            "PKK_NgayDuyet",
            "PKK_TrangThai",
            "PKK_GhiChu",
            "lines",
        )

    def get_PKK_NgayDuyet(self, obj):
        if not obj.approved_at:
            return None
        return timezone.localtime(obj.approved_at).date()


class SupplierReturnLineInputSerializer(serializers.Serializer):
    PNCT_Ma = serializers.CharField(max_length=20)
    TRNCC_SL = SafeIntegerField(min_value=1, required=False)
    TRNCC_SLNhap = SafeIntegerField(min_value=1, required=False)
    TRNCC_HeSo = SafeIntegerField(min_value=1, required=False, default=1)
    TRNCC_LyDoChiTiet = serializers.CharField(
        max_length=80, required=False, allow_blank=True, default=""
    )

    def validate(self, attrs):
        if "TRNCC_SL" not in attrs and "TRNCC_SLNhap" not in attrs:
            raise serializers.ValidationError(
                "Cần truyền TRNCC_SL hoặc TRNCC_SLNhap."
            )
        return attrs


class SupplierReturnWriteSerializer(serializers.Serializer):
    DT_Ma = serializers.CharField(max_length=20, required=False)
    PN_Ma = serializers.CharField(max_length=20, required=False)
    DD_Ma = serializers.CharField(max_length=20, required=False)
    NV_Ma = serializers.CharField(
        max_length=20, required=False, allow_blank=True, default=""
    )
    TRNCC_Ngay = serializers.DateField(required=False)
    TRNCC_LyDo = serializers.ChoiceField(
        choices=(
            "Hàng hư hỏng",
            "Hàng lỗi chất lượng",
            "Hàng giao sai",
            "Hàng không đúng quy cách",
            "Hàng gần hết hạn",
            "Lý do khác",
        ),
        required=False,
    )
    TRNCC_GhiChu = serializers.CharField(
        max_length=255, required=False, allow_blank=True, default=""
    )
    lines = SupplierReturnLineInputSerializer(
        many=True, required=False, allow_empty=False
    )

    def validate(self, attrs):
        if not self.partial:
            required_fields = (
                "DT_Ma",
                "PN_Ma",
                "DD_Ma",
                "TRNCC_Ngay",
                "TRNCC_LyDo",
                "lines",
            )
            missing = [field for field in required_fields if field not in attrs]
            if missing:
                raise serializers.ValidationError(
                    {field: "Trường này là bắt buộc." for field in missing}
                )
        return attrs


class SupplierReturnLineSerializer(serializers.ModelSerializer):
    PNCT_Ma = serializers.CharField(source="receipt_line.code")
    PN_Ma = serializers.CharField(source="receipt_line.receipt.code")
    HH_Ma = serializers.CharField(source="receipt_line.product.code")
    HH_Ten = serializers.CharField(source="receipt_line.product.name")
    PNCT_NSX = OptionalDateField(
        source="receipt_line.production_date", allow_null=True, read_only=True
    )
    PNCT_HSD = OptionalDateField(
        source="receipt_line.expiry_date", allow_null=True, read_only=True
    )
    TRNCC_SL = serializers.IntegerField(source="quantity")
    TRNCC_SLNhap = serializers.IntegerField(source="entered_quantity")
    TRNCC_HeSo = serializers.IntegerField(source="conversion_factor")
    TRNCC_DonGia = serializers.IntegerField(source="unit_price")
    TRNCC_TTien = serializers.IntegerField(source="amount")
    TRNCC_LyDoChiTiet = serializers.CharField(source="reason")

    class Meta:
        model = SupplierReturnLine
        fields = (
            "PNCT_Ma",
            "PN_Ma",
            "HH_Ma",
            "HH_Ten",
            "PNCT_NSX",
            "PNCT_HSD",
            "TRNCC_SL",
            "TRNCC_SLNhap",
            "TRNCC_HeSo",
            "TRNCC_DonGia",
            "TRNCC_TTien",
            "TRNCC_LyDoChiTiet",
        )


class SupplierReturnSerializer(serializers.ModelSerializer):
    TRNCC_Ma = serializers.CharField(source="code")
    DT_Ma = serializers.CharField(source="supplier.code")
    DT_Ten = serializers.CharField(source="supplier.name")
    PN_Ma = serializers.CharField(source="receipt.code")
    DD_Ma = serializers.CharField(source="source_location.code")
    DD_Ten = serializers.CharField(source="source_location.name")
    NV_Ma = serializers.CharField(source="employee.code")
    NV_Ten = serializers.CharField(source="employee.full_name")
    NV_Duyet = serializers.CharField(
        source="reviewed_by.code", allow_null=True, read_only=True
    )
    NV_Xuat = serializers.CharField(
        source="confirmed_by.code", allow_null=True, read_only=True
    )
    TRNCC_NguoiDuyet = serializers.CharField(
        source="reviewed_by.code", allow_null=True, read_only=True
    )
    TRNCC_NguoiXuat = serializers.CharField(
        source="confirmed_by.code", allow_null=True, read_only=True
    )
    TRNCC_Ngay = serializers.DateField(source="return_date")
    TRNCC_TongSL = serializers.IntegerField(source="total_quantity")
    TRNCC_TongTien = serializers.IntegerField(source="total_amount")
    TRNCC_TrangThai = serializers.CharField(source="status")
    TRNCC_LyDo = serializers.CharField(source="reason")
    TRNCC_GhiChu = serializers.CharField(source="note")
    TRNCC_GhiChuDuyet = serializers.CharField(source="review_note")
    TRNCC_NgayGuiDuyet = serializers.DateTimeField(
        source="submitted_at", allow_null=True
    )
    TRNCC_NgayDuyet = serializers.DateTimeField(
        source="reviewed_at", allow_null=True
    )
    TRNCC_NgayXuat = serializers.DateTimeField(
        source="confirmed_at", allow_null=True
    )
    TRNCC_NgayHuy = serializers.DateTimeField(
        source="cancelled_at", allow_null=True
    )
    lines = SupplierReturnLineSerializer(many=True, read_only=True)

    class Meta:
        model = SupplierReturn
        fields = (
            "TRNCC_Ma",
            "DT_Ma",
            "DT_Ten",
            "PN_Ma",
            "DD_Ma",
            "DD_Ten",
            "NV_Ma",
            "NV_Ten",
            "NV_Duyet",
            "NV_Xuat",
            "TRNCC_NguoiDuyet",
            "TRNCC_NguoiXuat",
            "TRNCC_Ngay",
            "TRNCC_TongSL",
            "TRNCC_TongTien",
            "TRNCC_TrangThai",
            "TRNCC_LyDo",
            "TRNCC_GhiChu",
            "TRNCC_GhiChuDuyet",
            "TRNCC_NgayGuiDuyet",
            "TRNCC_NgayDuyet",
            "TRNCC_NgayXuat",
            "TRNCC_NgayHuy",
            "lines",
        )


class StockTransferLineInputSerializer(serializers.Serializer):
    PNCT_Ma = serializers.CharField(max_length=20)
    PXCN_SL = SafeIntegerField(min_value=1)


class StockTransferWriteSerializer(serializers.Serializer):
    DD_Xuat = serializers.CharField(max_length=20)
    DD_Nhan = serializers.CharField(max_length=20)
    NV_Ma = serializers.CharField(
        max_length=20, required=False, allow_blank=True, default=""
    )
    PXCN_Ngay = serializers.DateField()
    PXCN_NguoiNhan = serializers.CharField(
        max_length=150, required=False, allow_blank=True, default=""
    )
    lines = StockTransferLineInputSerializer(many=True, allow_empty=False)


class StockTransferReceiveLineInputSerializer(serializers.Serializer):
    PNCT_Ma = serializers.CharField(max_length=20)
    PXCN_SLThucNhan = SafeIntegerField(min_value=0)


class StockTransferReceiveSerializer(serializers.Serializer):
    PXCN_NguoiNhan = serializers.CharField(
        max_length=150, required=False, allow_blank=True, default=""
    )
    lines = StockTransferReceiveLineInputSerializer(many=True, allow_empty=False)


class StockTransferLineSerializer(serializers.ModelSerializer):
    PNCT_Ma = serializers.CharField(source="receipt_line.code")
    HH_Ma = serializers.CharField(source="receipt_line.product.code")
    HH_Ten = serializers.CharField(source="receipt_line.product.name")
    PNCT_NSX = OptionalDateField(
        source="receipt_line.production_date", allow_null=True, read_only=True
    )
    PNCT_HSD = OptionalDateField(
        source="receipt_line.expiry_date", allow_null=True, read_only=True
    )
    PXCN_SL = serializers.IntegerField(source="quantity")
    PXCN_SLThucNhan = serializers.IntegerField(
        source="received_quantity", allow_null=True
    )

    class Meta:
        model = StockTransferLine
        fields = (
            "PNCT_Ma",
            "HH_Ma",
            "HH_Ten",
            "PNCT_NSX",
            "PNCT_HSD",
            "PXCN_SL",
            "PXCN_SLThucNhan",
        )


class StockTransferSerializer(serializers.ModelSerializer):
    PXCN_Ma = serializers.CharField(source="code")
    PXCN_Loai = serializers.CharField(source="transfer_type")
    DD_Xuat = serializers.CharField(source="source_location.code")
    DD_XuatTen = serializers.CharField(source="source_location.name")
    DD_Nhan = serializers.CharField(source="destination_location.code")
    DD_NhanTen = serializers.CharField(source="destination_location.name")
    NV_Ma = serializers.CharField(source="employee.code")
    NV_Ten = serializers.CharField(source="employee.full_name")
    NV_Xuat = serializers.CharField(
        source="dispatched_by.code", allow_null=True, read_only=True
    )
    NV_Nhan = serializers.CharField(
        source="received_by.code", allow_null=True, read_only=True
    )
    PXCN_Ngay = serializers.DateField(source="transfer_date")
    PXCN_TongSL = serializers.IntegerField(source="total_quantity")
    PXCN_TrangThai = serializers.CharField(source="status")
    PXCN_NguoiNhan = serializers.CharField(source="receiver_name")
    PXCN_NgayXuat = serializers.SerializerMethodField()
    PXCN_NgayNhan = serializers.SerializerMethodField()
    lines = StockTransferLineSerializer(many=True, read_only=True)

    class Meta:
        model = StockTransfer
        fields = (
            "PXCN_Ma",
            "PXCN_Loai",
            "DD_Xuat",
            "DD_XuatTen",
            "DD_Nhan",
            "DD_NhanTen",
            "NV_Ma",
            "NV_Ten",
            "NV_Xuat",
            "NV_Nhan",
            "PXCN_Ngay",
            "PXCN_TongSL",
            "PXCN_TrangThai",
            "PXCN_NguoiNhan",
            "PXCN_NgayXuat",
            "PXCN_NgayNhan",
            "lines",
        )

    @staticmethod
    def _local_date(value):
        return timezone.localtime(value).date() if value else None

    def get_PXCN_NgayXuat(self, obj):
        return self._local_date(obj.dispatched_at)

    def get_PXCN_NgayNhan(self, obj):
        return self._local_date(obj.received_at)


class StorageLocationSerializer(serializers.ModelSerializer):
    DD_Ma = serializers.CharField(source="code")
    DD_Ten = serializers.CharField(source="name")
    DD_Loai = serializers.CharField(source="kind")
    DD_DiaChi = serializers.CharField(source="address")
    DD_TrangThai = serializers.CharField(source="status")

    class Meta:
        model = StorageLocation
        fields = ("DD_Ma", "DD_Ten", "DD_Loai", "DD_DiaChi", "DD_TrangThai")


class StockBalanceSerializer(serializers.ModelSerializer):
    DD_Ma = serializers.CharField(source="location.code")
    DD_Ten = serializers.CharField(source="location.name")
    PNCT_Ma = serializers.CharField(source="receipt_line.code")
    PN_Ma = serializers.CharField(source="receipt_line.receipt.code")
    HH_Ma = serializers.CharField(source="receipt_line.product.code")
    HH_Ten = serializers.CharField(source="receipt_line.product.name")
    PNCT_NSX = OptionalDateField(source="receipt_line.production_date", allow_null=True)
    PNCT_HSD = OptionalDateField(source="receipt_line.expiry_date", allow_null=True)
    TK_SL = serializers.IntegerField(source="quantity")

    class Meta:
        model = StockBalance
        fields = (
            "DD_Ma",
            "DD_Ten",
            "PNCT_Ma",
            "PN_Ma",
            "HH_Ma",
            "HH_Ten",
            "PNCT_NSX",
            "PNCT_HSD",
            "TK_SL",
        )


class StockMovementSerializer(serializers.ModelSerializer):
    BDK_Ma = serializers.CharField(source="code")
    DD_Ma = serializers.CharField(source="location.code")
    PNCT_Ma = serializers.CharField(source="receipt_line.code")
    NV_Ma = serializers.CharField(source="employee.code")
    BDK_Ngay = serializers.DateTimeField(source="occurred_at")
    BDK_Loai = serializers.CharField(source="movement_type")
    BDK_SoLuong = serializers.IntegerField(source="quantity_delta")
    BDK_Nguon = serializers.CharField(source="source")
    BDK_MaChungTu = serializers.CharField(source="document_code")
    BDK_GhiChu = serializers.CharField(source="note")
    HH_Ma = serializers.CharField(source="receipt_line.product.code")
    HH_Ten = serializers.CharField(source="receipt_line.product.name")

    class Meta:
        model = StockMovement
        fields = (
            "BDK_Ma",
            "DD_Ma",
            "PNCT_Ma",
            "NV_Ma",
            "BDK_Ngay",
            "BDK_Loai",
            "BDK_SoLuong",
            "BDK_Nguon",
            "BDK_MaChungTu",
            "BDK_GhiChu",
            "HH_Ma",
            "HH_Ten",
        )
