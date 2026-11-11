from django.db import models


def normalize_name(value):
    return value.strip().lower()


class CodedModel(models.Model):
    code = models.CharField(max_length=20, unique=True, null=True, blank=True)
    code_prefix = ""

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if self.code or self.pk is None:
            super().save(*args, **kwargs)
            if not self.code:
                self.code = f"{self.code_prefix}{self.pk:04d}"
                super().save(update_fields=("code",))
            return
        super().save(*args, **kwargs)


class Category(CodedModel):
    code_prefix = "DM"
    name = models.CharField(max_length=150)
    name_key = models.CharField(max_length=150, unique=True, editable=False)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ("code",)
        verbose_name = "danh mục hàng hóa"
        verbose_name_plural = "danh mục hàng hóa"

    def save(self, *args, **kwargs):
        self.name_key = normalize_name(self.name)
        if kwargs.get("update_fields") is not None and "name" in kwargs["update_fields"]:
            kwargs["update_fields"] = set(kwargs["update_fields"]) | {"name_key"}
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.code} - {self.name}"


class Product(CodedModel):
    class Status(models.TextChoices):
        ACTIVE = "Đang kinh doanh", "Đang kinh doanh"
        INACTIVE = "Ngừng kinh doanh", "Ngừng kinh doanh"

    code_prefix = "HH"
    category = models.ForeignKey(
        Category, on_delete=models.PROTECT, related_name="products"
    )
    barcode = models.CharField(max_length=32, unique=True, null=True, blank=True)
    name = models.CharField(max_length=200)
    name_key = models.CharField(max_length=200, unique=True, editable=False)
    base_unit = models.CharField(max_length=50)
    package_unit = models.CharField(max_length=50, null=True, blank=True)
    package_ratio = models.PositiveBigIntegerField(null=True, blank=True)
    image = models.CharField(max_length=500, blank=True)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.ACTIVE
    )

    class Meta:
        ordering = ("code",)
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(package_unit__isnull=True, package_ratio__isnull=True)
                    | (
                        models.Q(package_unit__isnull=False)
                        & ~models.Q(package_unit="")
                        & models.Q(package_ratio__gt=0)
                        & models.Q(package_ratio__lte=9_007_199_254_740_991)
                    )
                ),
                name="catalog_product_package_conversion_consistent",
            ),
        ]
        verbose_name = "hàng hóa"
        verbose_name_plural = "hàng hóa"

    def save(self, *args, **kwargs):
        if self.barcode is not None:
            self.barcode = self.barcode.strip() or None
        self.name_key = normalize_name(self.name)
        if kwargs.get("update_fields") is not None and "name" in kwargs["update_fields"]:
            kwargs["update_fields"] = set(kwargs["update_fields"]) | {"name_key"}
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.code} - {self.name}"


class SalePrice(CodedModel):
    class Status(models.TextChoices):
        ACTIVE = "Đang áp dụng", "Đang áp dụng"
        INACTIVE = "Ngừng áp dụng", "Ngừng áp dụng"

    code_prefix = "GB"
    product = models.ForeignKey(
        Product, on_delete=models.PROTECT, related_name="sale_prices"
    )
    amount = models.PositiveBigIntegerField()
    starts_on = models.DateField()
    ends_on = models.DateField(null=True, blank=True)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.ACTIVE
    )

    class Meta:
        ordering = ("product__code", "-starts_on", "code")
        indexes = [
            models.Index(
                fields=("product", "status", "starts_on", "ends_on"),
                name="catalog_price_lookup_idx",
            )
        ]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__lte=9_007_199_254_740_991),
                name="catalog_price_amount_safe_integer",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(ends_on__isnull=True)
                    | models.Q(ends_on__gte=models.F("starts_on"))
                ),
                name="catalog_price_end_after_start",
            )
        ]
        verbose_name = "giá bán"
        verbose_name_plural = "giá bán"

    def __str__(self):
        return f"{self.code} - {self.product} ({self.amount} VND)"
