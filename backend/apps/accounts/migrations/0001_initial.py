import django.utils.timezone
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


ROLE_NAMES = (
    "Chủ cửa hàng",
    "Nhân viên kho",
    "Nhân viên bán hàng",
    "Nhân viên kế toán",
)


def create_roles(apps, schema_editor):
    Group = apps.get_model("auth", "Group")
    database = schema_editor.connection.alias
    for role_name in ROLE_NAMES:
        Group.objects.using(database).get_or_create(name=role_name)


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("auth", "0012_alter_user_first_name_max_length"),
    ]

    operations = [
        migrations.CreateModel(
            name="Employee",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("code", models.CharField(blank=True, max_length=20, unique=True)),
                ("full_name", models.CharField(max_length=150)),
                ("phone", models.CharField(blank=True, max_length=20)),
                ("address", models.CharField(blank=True, max_length=255)),
                ("birth_date", models.DateField(blank=True, null=True)),
                ("gender", models.CharField(blank=True, max_length=20)),
                (
                    "hired_date",
                    models.DateField(default=django.utils.timezone.localdate),
                ),
                ("is_active", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "user",
                    models.OneToOneField(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="employee",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "nhân viên",
                "verbose_name_plural": "nhân viên",
                "ordering": ("code",),
            },
        ),
        migrations.RunPython(create_roles, migrations.RunPython.noop),
    ]
