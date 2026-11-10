from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
    ]

    operations = [
        migrations.CreateModel(
            name='DoiTacKinhDoanh',
            fields=[
                ('DT_Ma', models.CharField(max_length=20, primary_key=True, serialize=False)),
                ('DT_Ten', models.CharField(max_length=255)),
                ('DT_SDT', models.CharField(blank=True, max_length=30, null=True)),
                ('DT_DChi', models.TextField(blank=True, default='')),
                ('DT_Loai', models.CharField(choices=[('Khách hàng', 'Khách hàng'), ('Nhà cung cấp', 'Nhà cung cấp')], default='Khách hàng', max_length=20)),
                ('DT_STK', models.CharField(blank=True, default='', max_length=50)),
                ('DT_TrangThai', models.CharField(choices=[('Hoạt động', 'Hoạt động'), ('Ngừng hoạt động', 'Ngừng hoạt động')], default='Hoạt động', max_length=20)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'DoiTacKinhDoanh',
                'ordering': ['DT_Ten'],
            },
        ),
        migrations.AddConstraint(
            model_name='doitackinhdoanh',
            constraint=models.UniqueConstraint(condition=models.Q(('DT_SDT__isnull', False)), fields=('DT_SDT',), name='ux_partner_phone_non_null'),
        ),
    ]
