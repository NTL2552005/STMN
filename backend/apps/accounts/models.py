from django.conf import settings
from django.db import models
from django.utils import timezone


class Employee(models.Model):
    code = models.CharField(max_length=20, unique=True, blank=True)
    full_name = models.CharField(max_length=150)
    phone = models.CharField(max_length=20, blank=True)
    address = models.CharField(max_length=255, blank=True)
    birth_date = models.DateField(null=True, blank=True)
    gender = models.CharField(max_length=20, blank=True)
    hired_date = models.DateField(default=timezone.localdate)
    is_active = models.BooleanField(default=True)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        related_name="employee",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("code",)
        verbose_name = "nhân viên"
        verbose_name_plural = "nhân viên"

    def __str__(self):
        return f"{self.code} - {self.full_name}"

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        if not self.code:
            self.code = f"NV{self.pk:04d}"
            super().save(update_fields=("code", "updated_at"))
