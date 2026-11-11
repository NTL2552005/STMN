from django.db import models
from django.utils import timezone

from apps.accounts.models import Employee
from apps.partners.models import Partner

MAX_SAFE_INTEGER = 9_007_199_254_740_991


class SupplierDebt(models.Model):
    receipt = models.OneToOneField(
        "inventory.GoodsReceipt",
        on_delete=models.PROTECT,
        related_name="accounting_debt",
    )
    supplier = models.ForeignKey(
        Partner, on_delete=models.PROTECT, related_name="accounting_debts"
    )
    amount = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-receipt__received_on", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0, amount__lte=MAX_SAFE_INTEGER),
                name="acct_supplier_debt_amount_valid",
            )
        ]

    @property
    def balance(self):
        returned = self.return_adjustments.aggregate(total=models.Sum("amount"))["total"] or 0
        paid = self.payments.filter(status=SupplierPayment.Status.SUCCESS).aggregate(
            total=models.Sum("amount")
        )["total"] or 0
        return max(0, self.amount - returned - paid)

    @property
    def supplier_credit(self):
        returned = self.return_adjustments.aggregate(total=models.Sum("amount"))["total"] or 0
        paid = self.payments.filter(status=SupplierPayment.Status.SUCCESS).aggregate(
            total=models.Sum("amount")
        )["total"] or 0
        return max(0, returned + paid - self.amount)

    def __str__(self):
        return f"{self.receipt.code} - {self.supplier.name}"


class SupplierReturnAdjustment(models.Model):
    supplier_return = models.OneToOneField(
        "inventory.SupplierReturn",
        on_delete=models.PROTECT,
        related_name="accounting_adjustment",
    )
    debt = models.ForeignKey(
        SupplierDebt, on_delete=models.PROTECT, related_name="return_adjustments"
    )
    amount = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0, amount__lte=MAX_SAFE_INTEGER),
                name="acct_return_adjustment_amount_valid",
            )
        ]


class SupplierPayment(models.Model):
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
    debt = models.ForeignKey(
        SupplierDebt, on_delete=models.PROTECT, related_name="payments"
    )
    payment_date = models.DateTimeField(default=timezone.now)
    amount = models.PositiveBigIntegerField()
    method = models.CharField(max_length=30, choices=Method.choices)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.PENDING
    )
    note = models.CharField(max_length=255, blank=True)
    idempotency_key = models.CharField(
        max_length=100, unique=True, null=True, blank=True
    )
    created_by = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="supplier_payments_created"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-payment_date", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0, amount__lte=MAX_SAFE_INTEGER),
                name="acct_supplier_payment_amount_valid",
            )
        ]

    def save(self, *args, **kwargs):
        if not self.code:
            super().save(*args, **kwargs)
            self.code = f"TTNCC{self.pk:04d}"
            type(self).objects.filter(pk=self.pk, code="").update(code=self.code)
            return
        super().save(*args, **kwargs)


class ReceiptVoucher(models.Model):
    class Method(models.TextChoices):
        CASH = "Tiền mặt", "Tiền mặt"
        BANK_TRANSFER = "Chuyển khoản", "Chuyển khoản"

    class Status(models.TextChoices):
        DRAFT = "Nháp", "Nháp"
        CONFIRMED = "Đã xác nhận", "Đã xác nhận"
        CANCELLED = "Đã hủy", "Đã hủy"

    code = models.CharField(max_length=20, unique=True, blank=True)
    sale_payment = models.OneToOneField(
        "sales.SalePayment",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="receipt_voucher",
    )
    customer = models.ForeignKey(
        "customers.DoiTacKinhDoanh",
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="receipt_vouchers",
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="receipt_vouchers_created"
    )
    voucher_date = models.DateTimeField(default=timezone.now)
    amount = models.PositiveBigIntegerField()
    reason = models.CharField(max_length=255)
    method = models.CharField(max_length=30, choices=Method.choices)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.DRAFT
    )
    note = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-voucher_date", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0, amount__lte=MAX_SAFE_INTEGER),
                name="acct_receipt_amount_valid",
            )
        ]

    def save(self, *args, **kwargs):
        if not self.code:
            super().save(*args, **kwargs)
            self.code = f"PT{self.pk:04d}"
            type(self).objects.filter(pk=self.pk, code="").update(code=self.code)
            return
        super().save(*args, **kwargs)


class ExpenseVoucher(models.Model):
    class Status(models.TextChoices):
        DRAFT = "Nháp", "Nháp"
        CONFIRMED = "Đã xác nhận", "Đã xác nhận"
        CANCELLED = "Đã hủy", "Đã hủy"

    code = models.CharField(max_length=20, unique=True, blank=True)
    supplier_payment = models.OneToOneField(
        SupplierPayment,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="expense_voucher",
    )
    supplier = models.ForeignKey(
        Partner,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="expense_vouchers",
    )
    employee = models.ForeignKey(
        Employee, on_delete=models.PROTECT, related_name="expense_vouchers_created"
    )
    voucher_date = models.DateTimeField(default=timezone.now)
    amount = models.PositiveBigIntegerField()
    reason = models.CharField(max_length=255)
    method = models.CharField(
        max_length=30, choices=SupplierPayment.Method.choices
    )
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.DRAFT
    )
    note = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-voucher_date", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0, amount__lte=MAX_SAFE_INTEGER),
                name="acct_expense_amount_valid",
            )
        ]

    def save(self, *args, **kwargs):
        if not self.code:
            super().save(*args, **kwargs)
            self.code = f"PC{self.pk:04d}"
            type(self).objects.filter(pk=self.pk, code="").update(code=self.code)
            return
        super().save(*args, **kwargs)
