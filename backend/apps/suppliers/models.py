from django.db import models

from apps.partners.models import Partner


class SupplierManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(
            role__in=(Partner.Role.SUPPLIER, Partner.Role.BOTH)
        )

    def create(self, **kwargs):
        kwargs.setdefault("role", Partner.Role.SUPPLIER)
        return super().create(**kwargs)


class Supplier(Partner):
    Status = Partner.Status

    objects = SupplierManager()

    class Meta:
        proxy = True
        ordering = ("code",)
        verbose_name = "nhà cung cấp"
        verbose_name_plural = "nhà cung cấp"
