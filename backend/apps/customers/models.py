from django.db import models


class DoiTacKinhDoanh(models.Model):
    class Loai(models.TextChoices):
        KHACH_HANG = 'Khách hàng', 'Khách hàng'
        NHA_CUNG_CAP = 'Nhà cung cấp', 'Nhà cung cấp'

    class TrangThai(models.TextChoices):
        HOAT_DONG = 'Hoạt động', 'Hoạt động'
        NGUNG_HOAT_DONG = 'Ngừng hoạt động', 'Ngừng hoạt động'

    DT_Ma = models.CharField(max_length=20, primary_key=True)
    DT_Ten = models.CharField(max_length=255)
    DT_SDT = models.CharField(max_length=30, blank=True, null=True)
    DT_DChi = models.TextField(blank=True, default='')
    DT_Loai = models.CharField(
        max_length=20,
        choices=Loai.choices,
        default=Loai.KHACH_HANG,
    )
    DT_STK = models.CharField(max_length=50, blank=True, default='')
    DT_TrangThai = models.CharField(
        max_length=20,
        choices=TrangThai.choices,
        default=TrangThai.HOAT_DONG,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'DoiTacKinhDoanh'
        ordering = ['DT_Ten']
        constraints = [
            models.UniqueConstraint(
                fields=['DT_SDT'],
                condition=models.Q(DT_SDT__isnull=False),
                name='ux_partner_phone_non_null',
            )
        ]

    def __str__(self):
        return f'{self.DT_Ma} - {self.DT_Ten}'
