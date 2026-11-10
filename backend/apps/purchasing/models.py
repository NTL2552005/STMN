from django.core.exceptions import ValidationError
from django.db import models

from apps.accounts.models import Employee
from apps.catalog.models import Product
from apps.partners.models import Partner

MAX_SAFE_INTEGER = 9_007_199_254_740_991


class PurchaseOrder(models.Model):
    class Status(models.TextChoices):
        DRAFT = "Nháp", "Nháp"
        WAITING = "Chờ giao", "Chờ giao"
        PARTIAL = "Đã nhận một phần", "Đã nhận một phần"
        COMPLETE = "Đã nhận đủ", "Đã nhận đủ"
        CANCELLED = "Đã hủy", "Đã hủy"

    code = models.CharField(max_length=20, unique=True, null=True, blank=True)
    supplier = models.ForeignKey(
        Partner, on_delete=models.PROTECT, related_name="purchase_orders"
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="purchase_orders"
    )
    ordered_on = models.DateField()
    total_quantity = models.PositiveBigIntegerField(default=0)
    total_amount = models.PositiveBigIntegerField(default=0)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.DRAFT
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-ordered_on", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(total_quantity__lte=MAX_SAFE_INTEGER),
                name="purch_order_total_qty_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(total_amount__lte=MAX_SAFE_INTEGER),
                name="purch_order_total_amt_safe",
            ),
        ]

    def save(self, *args, **kwargs):
        if self.pk and not self._state.adding:
            old_code = type(self).objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if old_code and self.code != old_code:
                raise ValidationError({"code": "Mã đơn đặt hàng không được thay đổi."})
        if self.code or self.pk is None:
            super().save(*args, **kwargs)
            if not self.code:
                self.code = f"DH{self.pk:04d}"
                type(self).objects.filter(pk=self.pk).update(code=self.code)
            return
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.code} - {self.supplier.name}"


class PurchaseOrderLine(models.Model):
    order = models.ForeignKey(
        PurchaseOrder, on_delete=models.PROTECT, related_name="lines"
    )
    product = models.ForeignKey(
        Product, on_delete=models.PROTECT, related_name="purchase_order_lines"
    )
    quantity = models.PositiveBigIntegerField()
    unit_price = models.PositiveBigIntegerField()
    amount = models.PositiveBigIntegerField()

    class Meta:
        ordering = ("id",)
        constraints = [
            models.UniqueConstraint(
                fields=("order", "product"), name="purch_order_unique_product"
            ),
            models.CheckConstraint(
                condition=models.Q(quantity__gt=0, quantity__lte=MAX_SAFE_INTEGER),
                name="purch_order_line_qty_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    unit_price__lte=MAX_SAFE_INTEGER,
                    amount__lte=MAX_SAFE_INTEGER,
                ),
                name="purch_order_line_money_safe",
            ),
            models.CheckConstraint(
                condition=models.Q(amount=models.F("quantity") * models.F("unit_price")),
                name="purch_order_line_amount_matches",
            ),
        ]

    def __str__(self):
        return f"{self.order.code} - {self.product.code}"
