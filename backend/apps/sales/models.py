from django.db import models
from django.utils import timezone

from apps.accounts.models import Employee
from apps.catalog.models import Product
from apps.customers.models import DoiTacKinhDoanh
from apps.inventory.models import StorageLocation

MAX_SAFE_INTEGER = 9_007_199_254_740_991


class SaleInvoice(models.Model):
    class Status(models.TextChoices):
        DRAFT = "Nháp", "Nháp"
        CONFIRMED = "Đã xác nhận", "Đã xác nhận"
        CANCELLED = "Đã hủy", "Đã hủy"

    code = models.CharField(max_length=20, unique=True, blank=True)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name="sales_invoices",
    )
    location = models.ForeignKey(
        StorageLocation,
        on_delete=models.PROTECT,
        related_name="sales_invoices",
    )
    customer = models.ForeignKey(
        DoiTacKinhDoanh,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="sales_invoices",
    )
    invoice_date = models.DateTimeField(default=timezone.now)
    total_quantity = models.PositiveBigIntegerField(default=0)
    total_amount = models.PositiveBigIntegerField(default=0)
    status = models.CharField(
        max_length=30,
        choices=Status.choices,
        default=Status.DRAFT,
    )
    allow_credit = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-invoice_date", "-id")
        verbose_name = "hóa đơn bán hàng"
        verbose_name_plural = "hóa đơn bán hàng"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(total_quantity__lte=MAX_SAFE_INTEGER),
                name="sales_invoice_qty_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(total_amount__lte=MAX_SAFE_INTEGER),
                name="sales_invoice_amount_safe",
            ),
        ]

    def __str__(self):
        return f"{self.code} - {self.status}"

    def save(self, *args, **kwargs):
        if not self.code:
            super().save(*args, **kwargs)
            self.code = f"BH{self.pk:04d}"
            type(self).objects.filter(pk=self.pk, code="").update(code=self.code)
            return
        super().save(*args, **kwargs)


class SaleInvoiceLine(models.Model):
    invoice = models.ForeignKey(
        SaleInvoice,
        related_name="lines",
        on_delete=models.CASCADE,
    )
    product = models.ForeignKey(
        Product,
        on_delete=models.PROTECT,
        related_name="sales_invoice_lines",
    )
    lot_code = models.CharField(max_length=50, blank=True)
    quantity = models.PositiveBigIntegerField()
    unit_price = models.PositiveBigIntegerField()
    amount = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("id",)
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    quantity__gt=0,
                    quantity__lte=MAX_SAFE_INTEGER,
                    unit_price__lte=MAX_SAFE_INTEGER,
                    amount__lte=MAX_SAFE_INTEGER,
                ),
                name="sales_invoice_line_values_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    amount=models.F("quantity") * models.F("unit_price")
                ),
                name="sales_invoice_line_amount_matches",
            ),
        ]

    def __str__(self):
        return f"{self.invoice.code} - {self.product.code}"


class SalePayment(models.Model):
    class Method(models.TextChoices):
        CASH = "Tiền mặt", "Tiền mặt"
        BANK_TRANSFER = "Chuyển khoản", "Chuyển khoản"
        QR = "QR", "QR"

    class Status(models.TextChoices):
        SUCCESS = "Thành công", "Thành công"
        PENDING = "Chờ xác nhận", "Chờ xác nhận"
        FAILED = "Thất bại", "Thất bại"
        CANCELLED = "Đã hủy", "Đã hủy"

    code = models.CharField(max_length=20, unique=True, blank=True)
    invoice = models.ForeignKey(
        SaleInvoice,
        related_name="payments",
        on_delete=models.PROTECT,
    )
    payment_date = models.DateTimeField(default=timezone.now)
    amount = models.PositiveBigIntegerField()
    method = models.CharField(
        max_length=30,
        choices=Method.choices,
        default=Method.CASH,
    )
    status = models.CharField(
        max_length=30,
        choices=Status.choices,
        default=Status.PENDING,
    )
    idempotency_key = models.CharField(
        max_length=100, unique=True, null=True, blank=True
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-payment_date", "-id")
        verbose_name = "thanh toán bán hàng"
        verbose_name_plural = "thanh toán bán hàng"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0, amount__lte=MAX_SAFE_INTEGER),
                name="sales_payment_amount_valid",
            )
        ]

    def __str__(self):
        return f"{self.code} - {self.invoice.code}"

    def save(self, *args, **kwargs):
        if not self.code:
            super().save(*args, **kwargs)
            self.code = f"TTBH{self.pk:04d}"
            type(self).objects.filter(pk=self.pk, code="").update(code=self.code)
            return
        super().save(*args, **kwargs)
