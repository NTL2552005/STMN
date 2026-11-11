from django.core.exceptions import ValidationError
from django.db import models

from apps.accounts.models import Employee
from apps.catalog.models import Product
from apps.partners.models import Partner
from apps.purchasing.models import PurchaseOrder


MAX_SAFE_INTEGER = 9_007_199_254_740_991


class InventoryMutationLock(models.Model):
    version = models.PositiveBigIntegerField(default=0)


class StorageLocation(models.Model):
    class Kind(models.TextChoices):
        WAREHOUSE = "Kho", "Kho"
        STORE = "Cửa hàng", "Cửa hàng"

    class Status(models.TextChoices):
        ACTIVE = "Hoạt động", "Hoạt động"
        INACTIVE = "Ngừng hoạt động", "Ngừng hoạt động"

    code = models.CharField(max_length=20, unique=True, blank=True)
    name = models.CharField(max_length=150)
    kind = models.CharField(max_length=30, choices=Kind.choices)
    address = models.CharField(max_length=255, blank=True)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.ACTIVE
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("code",)
        verbose_name = "địa điểm tồn kho"
        verbose_name_plural = "địa điểm tồn kho"

    def save(self, *args, **kwargs):
        if self.pk and not self._state.adding:
            old_code = type(self).objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if old_code and self.code != old_code:
                raise ValidationError({"code": "Mã địa điểm không được thay đổi."})
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"DD{self.pk:04d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return f"{self.code} - {self.name}"


class GoodsReceipt(models.Model):
    class Status(models.TextChoices):
        DRAFT = "Nháp", "Nháp"
        WAITING_ACCOUNTING = "Chờ kế toán xác nhận", "Chờ kế toán xác nhận"
        CONFIRMED = "Đã xác nhận", "Đã xác nhận"
        CANCELLED = "Đã hủy", "Đã hủy"

    code = models.CharField(max_length=20, unique=True, blank=True)
    purchase_order = models.ForeignKey(
        PurchaseOrder,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="goods_receipts",
    )
    supplier = models.ForeignKey(
        Partner, on_delete=models.PROTECT, related_name="goods_receipts"
    )
    location = models.ForeignKey(
        StorageLocation, on_delete=models.PROTECT, related_name="goods_receipts"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="goods_receipts_created"
    )
    confirmed_by = models.ForeignKey(
        Employee,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="goods_receipts_confirmed",
    )
    received_on = models.DateField()
    total_quantity = models.PositiveBigIntegerField(default=0)
    total_amount = models.PositiveBigIntegerField(default=0)
    status = models.CharField(
        max_length=40, choices=Status.choices, default=Status.DRAFT
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-received_on", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(total_quantity__lte=MAX_SAFE_INTEGER),
                name="inv_receipt_total_qty_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(total_amount__lte=MAX_SAFE_INTEGER),
                name="inv_receipt_total_amt_safe",
            ),
        ]
        indexes = [
            models.Index(
                fields=("purchase_order", "status"), name="inv_receipt_order_status"
            ),
            models.Index(fields=("received_on", "status"), name="inv_receipt_date_status"),
        ]

    def save(self, *args, **kwargs):
        if self.pk and not self._state.adding:
            old_code = type(self).objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if old_code and self.code != old_code:
                raise ValidationError({"code": "Mã phiếu nhập không được thay đổi."})
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"PN{self.pk:04d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return f"{self.code} - {self.supplier.name}"


class GoodsReceiptLine(models.Model):
    code = models.CharField(max_length=20, unique=True, blank=True)
    receipt = models.ForeignKey(
        GoodsReceipt, on_delete=models.PROTECT, related_name="lines"
    )
    product = models.ForeignKey(
        Product, on_delete=models.PROTECT, related_name="goods_receipt_lines"
    )
    production_date = models.DateField(null=True, blank=True)
    expiry_date = models.DateField(null=True, blank=True)
    minimum_expiry_days = models.PositiveBigIntegerField(null=True, blank=True)
    quantity = models.PositiveBigIntegerField()
    unit_price = models.PositiveBigIntegerField()
    amount = models.PositiveBigIntegerField()

    class Meta:
        ordering = ("id",)
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    quantity__gt=0, quantity__lte=MAX_SAFE_INTEGER
                ),
                name="inv_receipt_line_qty_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    unit_price__lte=MAX_SAFE_INTEGER,
                    amount__lte=MAX_SAFE_INTEGER,
                ),
                name="inv_receipt_line_money_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(amount=models.F("quantity") * models.F("unit_price")),
                name="inv_receipt_line_amount_matches",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(production_date__isnull=True)
                    | models.Q(expiry_date__isnull=True)
                    | models.Q(expiry_date__gte=models.F("production_date"))
                ),
                name="inv_receipt_expiry_after_production",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(minimum_expiry_days__isnull=True)
                    | models.Q(minimum_expiry_days__lte=MAX_SAFE_INTEGER)
                ),
                name="inv_receipt_min_expiry_safe",
            ),
        ]

    def save(self, *args, **kwargs):
        if self.pk and not self._state.adding:
            old_code = type(self).objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if old_code and self.code != old_code:
                raise ValidationError({"code": "Mã dòng nhập không được thay đổi."})
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"PNCT{self.pk:04d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return f"{self.code} - {self.product.code}"


class StockBalance(models.Model):
    location = models.ForeignKey(
        StorageLocation, on_delete=models.PROTECT, related_name="stock_balances"
    )
    receipt_line = models.ForeignKey(
        GoodsReceiptLine, on_delete=models.PROTECT, related_name="stock_balances"
    )
    quantity = models.PositiveBigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("location__code", "receipt_line__code")
        constraints = [
            models.UniqueConstraint(
                fields=("location", "receipt_line"), name="inv_stock_location_lot_unique"
            ),
            models.CheckConstraint(
                condition=models.Q(quantity__lte=MAX_SAFE_INTEGER),
                name="inv_stock_qty_safe",
            ),
        ]


class StockMovement(models.Model):
    class Kind(models.TextChoices):
        INBOUND = "Nhập kho", "Nhập kho"
        COUNT_ADJUSTMENT = "Điều chỉnh kiểm kê", "Điều chỉnh kiểm kê"
        SALE = "Bán hàng", "Bán hàng"
        TRANSFER_OUT = "Xuất chuyển nội bộ", "Xuất chuyển nội bộ"
        TRANSFER_IN = "Nhận chuyển nội bộ", "Nhận chuyển nội bộ"
        SUPPLIER_RETURN = "Trả NCC", "Trả NCC"

    code = models.CharField(max_length=20, unique=True, blank=True)
    location = models.ForeignKey(
        StorageLocation, on_delete=models.PROTECT, related_name="stock_movements"
    )
    receipt_line = models.ForeignKey(
        GoodsReceiptLine, on_delete=models.PROTECT, related_name="stock_movements"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="stock_movements"
    )
    movement_type = models.CharField(max_length=40, choices=Kind.choices)
    quantity_delta = models.BigIntegerField()
    source = models.CharField(max_length=40, default="PhieuNhap")
    document_code = models.CharField(max_length=20)
    occurred_at = models.DateTimeField(auto_now_add=True)
    note = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ("occurred_at", "id")
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(
                        movement_type="Nhập kho",
                        quantity_delta__gt=0,
                    )
                    | models.Q(
                        ~models.Q(quantity_delta=0),
                        movement_type="Điều chỉnh kiểm kê",
                        quantity_delta__gte=-MAX_SAFE_INTEGER,
                        quantity_delta__lte=MAX_SAFE_INTEGER,
                    )
                    | models.Q(
                        movement_type="Bán hàng",
                        quantity_delta__lt=0,
                        quantity_delta__gte=-MAX_SAFE_INTEGER,
                    )
                    | models.Q(
                        movement_type="Xuất chuyển nội bộ",
                        quantity_delta__lt=0,
                        quantity_delta__gte=-MAX_SAFE_INTEGER,
                    )
                    | models.Q(
                        movement_type="Nhận chuyển nội bộ",
                        quantity_delta__gt=0,
                        quantity_delta__lte=MAX_SAFE_INTEGER,
                    )
                    | models.Q(
                        movement_type="Trả NCC",
                        quantity_delta__lt=0,
                        quantity_delta__gte=-MAX_SAFE_INTEGER,
                    )
                ),
                name="inv_movement_kind_delta_valid",
            ),
            models.UniqueConstraint(
                fields=("receipt_line",),
                condition=models.Q(movement_type="Nhập kho"),
                name="inv_inbound_movement_once",
            ),
            models.UniqueConstraint(
                fields=("location", "receipt_line", "source", "document_code"),
                condition=models.Q(source="PhieuKiemKeKho"),
                name="inv_count_movement_once",
            ),
            models.UniqueConstraint(
                fields=(
                    "location",
                    "receipt_line",
                    "source",
                    "document_code",
                    "movement_type",
                ),
                condition=models.Q(source="PhieuXuatChuyenNoiBo"),
                name="inv_transfer_movement_once",
            ),
            models.UniqueConstraint(
                fields=("location", "receipt_line", "source", "document_code"),
                condition=models.Q(source="TraHangNCC"),
                name="inv_supplier_return_movement_once",
            ),
            models.UniqueConstraint(
                fields=("location", "receipt_line", "source", "document_code"),
                condition=models.Q(source="HoaDonBanHang"),
                name="inv_sales_movement_once",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(quantity_delta__gte=-MAX_SAFE_INTEGER)
                    & models.Q(quantity_delta__lt=0)
                    | models.Q(
                        quantity_delta__gt=0,
                        quantity_delta__lte=MAX_SAFE_INTEGER,
                    )
                ),
                name="inv_movement_delta_valid",
            ),
        ]
        indexes = [
            models.Index(fields=("location", "occurred_at"), name="inv_movement_loc_date")
        ]

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"BDK{self.pk:04d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return f"{self.code} - {self.movement_type}"


class StockCount(models.Model):
    class Status(models.TextChoices):
        DRAFT = "Nháp", "Nháp"
        WAITING_APPROVAL = "Chờ duyệt", "Chờ duyệt"
        APPROVED = "Đã duyệt", "Đã duyệt"

    code = models.CharField(max_length=20, unique=True, blank=True)
    location = models.ForeignKey(
        StorageLocation, on_delete=models.PROTECT, related_name="stock_counts"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="stock_counts_created"
    )
    approved_by = models.ForeignKey(
        Employee,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="stock_counts_approved",
    )
    count_date = models.DateField()
    approved_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.DRAFT
    )
    note = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-count_date", "-id")
        indexes = [
            models.Index(fields=("location", "status"), name="inv_count_loc_status"),
            models.Index(fields=("count_date", "status"), name="inv_count_date_status"),
        ]

    def save(self, *args, **kwargs):
        if self.pk and not self._state.adding:
            old_code = type(self).objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if old_code and self.code != old_code:
                raise ValidationError({"code": "Mã phiếu kiểm kê không được thay đổi."})
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"PKK{self.pk:04d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return f"{self.code} - {self.location.name}"


class StockCountLine(models.Model):
    code = models.CharField(max_length=20, unique=True, blank=True)
    count = models.ForeignKey(
        StockCount, on_delete=models.PROTECT, related_name="lines"
    )
    receipt_line = models.ForeignKey(
        GoodsReceiptLine, on_delete=models.PROTECT, related_name="stock_count_lines"
    )
    book_quantity = models.PositiveBigIntegerField()
    actual_quantity = models.PositiveBigIntegerField()
    difference = models.BigIntegerField()
    reason = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ("id",)
        constraints = [
            models.UniqueConstraint(
                fields=("count", "receipt_line"), name="inv_count_lot_unique"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    book_quantity__lte=MAX_SAFE_INTEGER,
                    actual_quantity__lte=MAX_SAFE_INTEGER,
                ),
                name="inv_count_line_qty_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    difference=models.F("actual_quantity")
                    - models.F("book_quantity")
                ),
                name="inv_count_line_delta_matches",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        difference__gte=-MAX_SAFE_INTEGER,
                        difference__lt=0,
                    )
                    | models.Q(
                        difference__gt=0,
                        difference__lte=MAX_SAFE_INTEGER,
                    )
                    | models.Q(difference=0)
                ),
                name="inv_count_line_delta_safe",
            ),
        ]

    def save(self, *args, **kwargs):
        if self.pk and not self._state.adding:
            old_code = type(self).objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if old_code and self.code != old_code:
                raise ValidationError(
                    {"code": "Mã dòng kiểm kê không được thay đổi."}
                )
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"PKKCT{self.pk:04d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return f"{self.code} - {self.receipt_line.code}"


class StockTransfer(models.Model):
    class Status(models.TextChoices):
        WAITING_DISPATCH = "Chờ xuất", "Chờ xuất"
        IN_TRANSIT = "Đang chuyển", "Đang chuyển"
        COMPLETE = "Hoàn tất", "Hoàn tất"
        DISCREPANCY = "Chờ đối chiếu", "Chờ đối chiếu"

    code = models.CharField(max_length=20, unique=True, blank=True)
    transfer_type = models.CharField(
        max_length=40, default="Chuyển nội bộ", editable=False
    )
    source_location = models.ForeignKey(
        StorageLocation, on_delete=models.PROTECT, related_name="transfers_out"
    )
    destination_location = models.ForeignKey(
        StorageLocation, on_delete=models.PROTECT, related_name="transfers_in"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="transfers_created"
    )
    dispatched_by = models.ForeignKey(
        Employee,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="transfers_dispatched",
    )
    received_by = models.ForeignKey(
        Employee,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="transfers_received",
    )
    transfer_date = models.DateField()
    total_quantity = models.PositiveBigIntegerField(default=0)
    status = models.CharField(
        max_length=30,
        choices=Status.choices,
        default=Status.WAITING_DISPATCH,
    )
    receiver_name = models.CharField(max_length=150, blank=True)
    dispatched_at = models.DateTimeField(null=True, blank=True)
    received_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-transfer_date", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    total_quantity__lte=MAX_SAFE_INTEGER,
                ),
                name="inv_transfer_total_qty_safe",
            ),
            models.CheckConstraint(
                condition=~models.Q(source_location=models.F("destination_location")),
                name="inv_transfer_distinct_locations",
            ),
        ]
        indexes = [
            models.Index(
                fields=("source_location", "status"),
                name="inv_transfer_src_status",
            ),
            models.Index(
                fields=("transfer_date", "status"),
                name="inv_transfer_date_status",
            ),
        ]

    def save(self, *args, **kwargs):
        if self.pk and not self._state.adding:
            old_code = type(self).objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if old_code and self.code != old_code:
                raise ValidationError({"code": "Mã phiếu chuyển không được thay đổi."})
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"PXCN{self.pk:04d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return f"{self.code} - {self.source_location.code} → {self.destination_location.code}"


class StockTransferLine(models.Model):
    transfer = models.ForeignKey(
        StockTransfer, on_delete=models.PROTECT, related_name="lines"
    )
    receipt_line = models.ForeignKey(
        GoodsReceiptLine,
        on_delete=models.PROTECT,
        related_name="stock_transfer_lines",
    )
    quantity = models.PositiveBigIntegerField()
    received_quantity = models.PositiveBigIntegerField(null=True, blank=True)

    class Meta:
        ordering = ("id",)
        constraints = [
            models.UniqueConstraint(
                fields=("transfer", "receipt_line"),
                name="inv_transfer_lot_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0, quantity__lte=MAX_SAFE_INTEGER),
                name="inv_transfer_line_qty_valid",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(received_quantity__isnull=True)
                    | models.Q(received_quantity__lte=models.F("quantity"))
                ),
                name="inv_transfer_received_lte_sent",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(received_quantity__isnull=True)
                    | models.Q(received_quantity__lte=MAX_SAFE_INTEGER)
                ),
                name="inv_transfer_received_qty_safe",
            ),
        ]

    def __str__(self):
        return f"{self.transfer.code} - {self.receipt_line.code}"


class SupplierReturn(models.Model):
    class Status(models.TextChoices):
        DRAFT = "Nháp", "Nháp"
        WAITING_APPROVAL = "Chờ duyệt", "Chờ duyệt"
        APPROVED = "Đã duyệt", "Đã duyệt"
        REJECTED = "Từ chối", "Từ chối"
        SHIPPED = "Đã xuất trả", "Đã xuất trả"
        CANCELLED = "Đã hủy", "Đã hủy"

    code = models.CharField(max_length=20, unique=True, blank=True)
    supplier = models.ForeignKey(
        Partner, on_delete=models.PROTECT, related_name="supplier_returns"
    )
    receipt = models.ForeignKey(
        GoodsReceipt, on_delete=models.PROTECT, related_name="supplier_returns"
    )
    source_location = models.ForeignKey(
        StorageLocation, on_delete=models.PROTECT, related_name="supplier_returns"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="supplier_returns_created"
    )
    reviewed_by = models.ForeignKey(
        Employee,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="supplier_returns_reviewed",
    )
    confirmed_by = models.ForeignKey(
        Employee,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="supplier_returns_confirmed",
    )
    return_date = models.DateField()
    total_quantity = models.PositiveBigIntegerField(default=0)
    total_amount = models.PositiveBigIntegerField(default=0)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.DRAFT
    )
    reason = models.CharField(max_length=80)
    note = models.CharField(max_length=255, blank=True)
    review_note = models.CharField(max_length=255, blank=True)
    submitted_at = models.DateTimeField(null=True, blank=True)
    reviewed_at = models.DateTimeField(null=True, blank=True)
    confirmed_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-return_date", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(total_quantity__lte=MAX_SAFE_INTEGER),
                name="inv_return_total_qty_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(total_amount__lte=MAX_SAFE_INTEGER),
                name="inv_return_total_amt_safe",
            ),
        ]
        indexes = [
            models.Index(
                fields=("supplier", "status"), name="inv_return_supp_status"
            ),
            models.Index(
                fields=("return_date", "status"), name="inv_return_date_status"
            ),
        ]

    def save(self, *args, **kwargs):
        if self.pk and not self._state.adding:
            old_code = type(self).objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if old_code and self.code != old_code:
                raise ValidationError({"code": "Mã phiếu trả không được thay đổi."})
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"TRNCC{self.pk:04d}"
            type(self).objects.filter(pk=self.pk).update(code=self.code)

    def __str__(self):
        return f"{self.code} - {self.supplier.name}"


class SupplierReturnLine(models.Model):
    supplier_return = models.ForeignKey(
        SupplierReturn, on_delete=models.CASCADE, related_name="lines"
    )
    receipt_line = models.ForeignKey(
        GoodsReceiptLine,
        on_delete=models.PROTECT,
        related_name="supplier_return_lines",
    )
    quantity = models.PositiveBigIntegerField()
    entered_quantity = models.PositiveBigIntegerField()
    conversion_factor = models.PositiveBigIntegerField(default=1)
    unit_price = models.PositiveBigIntegerField()
    amount = models.PositiveBigIntegerField()
    reason = models.CharField(max_length=80)

    class Meta:
        ordering = ("id",)
        constraints = [
            models.UniqueConstraint(
                fields=("supplier_return", "receipt_line"),
                name="inv_return_lot_unique",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    quantity__gt=0,
                    quantity__lte=MAX_SAFE_INTEGER,
                    entered_quantity__gt=0,
                    entered_quantity__lte=MAX_SAFE_INTEGER,
                    conversion_factor__gt=0,
                    conversion_factor__lte=MAX_SAFE_INTEGER,
                ),
                name="inv_return_line_qty_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    unit_price__lte=MAX_SAFE_INTEGER,
                    amount__lte=MAX_SAFE_INTEGER,
                ),
                name="inv_return_line_money_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    quantity=models.F("entered_quantity")
                    * models.F("conversion_factor")
                ),
                name="inv_return_line_conversion_matches",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    amount=models.F("quantity") * models.F("unit_price")
                ),
                name="inv_return_line_amount_matches",
            ),
        ]

    def __str__(self):
        return f"{self.supplier_return.code} - {self.receipt_line.code}"
