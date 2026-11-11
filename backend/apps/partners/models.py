import re

from django.core.exceptions import ValidationError
from django.db import models


class Partner(models.Model):
    class Role(models.TextChoices):
        CUSTOMER = "Khách hàng", "Khách hàng"
        SUPPLIER = "Nhà cung cấp", "Nhà cung cấp"
        BOTH = "Cả hai", "Cả hai"

    class Status(models.TextChoices):
        ACTIVE = "Hoạt động", "Hoạt động"
        INACTIVE = "Ngừng hoạt động", "Ngừng hoạt động"

    code = models.CharField(max_length=20, unique=True, blank=True)
    name = models.CharField(max_length=200)
    phone = models.CharField(max_length=20, null=True, blank=True)
    phone_key = models.CharField(
        max_length=40, unique=True, null=True, blank=True, editable=False
    )
    address = models.CharField(max_length=255, blank=True)
    bank_account = models.CharField(max_length=50, blank=True)
    role = models.CharField(max_length=30, choices=Role.choices)
    status = models.CharField(
        max_length=30, choices=Status.choices, default=Status.ACTIVE
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = models.Manager()

    class Meta:
        ordering = ("code",)
        verbose_name = "đối tác"
        verbose_name_plural = "đối tác"

    def save(self, *args, **kwargs):
        self.name = self.name.strip()
        self.phone = (self.phone or "").strip() or None
        self.phone_key = self.phone.casefold() if self.phone else None
        self.address = self.address.strip()
        self.bank_account = self.bank_account.strip()
        if self.pk and not self._state.adding:
            existing_code = Partner.objects.filter(pk=self.pk).values_list(
                "code", flat=True
            ).first()
            if existing_code and self.code != existing_code:
                raise ValidationError({"code": "Mã đối tác không được thay đổi."})
        if not self.code:
            codes = Partner.objects.values_list("code", flat=True)
            maximum = max(
                (
                    int(match.group(1))
                    for code in codes
                    if (match := re.search(r"(\d+)$", code or ""))
                ),
                default=0,
            )
            self.code = f"DT{maximum + 1:04d}"
            while Partner.objects.filter(code=self.code).exists():
                maximum += 1
                self.code = f"DT{maximum + 1:04d}"
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.code} - {self.name}"
