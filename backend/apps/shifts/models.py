from django.db import models
from django.utils import timezone


class CashShift(models.Model):
    class Status(models.TextChoices):
        OPEN = 'Đang mở', 'Đang mở'
        PENDING_RECONCILE = 'Chờ đối soát', 'Chờ đối soát'
        NEEDS_EXPLANATION = 'Cần giải trình', 'Cần giải trình'
        RECONCILED = 'Đã đối soát', 'Đã đối soát'
        HANDED_OVER = 'Đã bàn giao', 'Đã bàn giao'

    Ca_Ma = models.CharField(max_length=20, primary_key=True)
    NV_Ma = models.CharField(max_length=50)
    DD_Ma = models.CharField(max_length=50)
    GioMo = models.DateTimeField(default=timezone.now)
    GioDong = models.DateTimeField(null=True, blank=True)
    TienMatDauCa = models.BigIntegerField(default=0)
    TienMatThucDem = models.BigIntegerField(null=True, blank=True)
    TienMatDuKien = models.BigIntegerField(null=True, blank=True)
    ChenhLech = models.BigIntegerField(null=True, blank=True)
    GiaiTrinh = models.TextField(blank=True, default='')
    GhiChu = models.TextField(blank=True, default='')
    TrangThai = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    ThoiDiemGuiDoiSoat = models.DateTimeField(null=True, blank=True)
    NguoiYeuCauGiaiTrinh = models.CharField(max_length=50, blank=True, default='')
    ThoiDiemYeuCauGiaiTrinh = models.DateTimeField(null=True, blank=True)
    GhiChuKeToan = models.TextField(blank=True, default='')
    NguoiDoiSoat = models.CharField(max_length=50, blank=True, default='')
    ThoiDiemDoiSoat = models.DateTimeField(null=True, blank=True)
    TienMatBanGiao = models.BigIntegerField(null=True, blank=True)
    NguoiNhanBanGiao = models.CharField(max_length=50, blank=True, default='')
    ThoiDiemXacNhanBanGiao = models.DateTimeField(null=True, blank=True)
    GhiChuBanGiao = models.TextField(blank=True, default='')
    invoice_ids = models.JSONField(default=list, blank=True)
    payment_ids = models.JSONField(default=list, blank=True)

    class Meta:
        db_table = 'CashShift'
        ordering = ['-GioMo']

    def __str__(self):
        return f'{self.Ca_Ma} - {self.NV_Ma}'
