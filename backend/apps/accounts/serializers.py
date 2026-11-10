from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import transaction
from rest_framework import serializers

from .constants import ROLE_BY_CODE, ROLE_DEFINITIONS, ROLE_NAMES
from .models import Employee

User = get_user_model()


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField(trim_whitespace=False, write_only=True)


class BlankableDateField(serializers.DateField):
    def to_internal_value(self, value):
        if value == "":
            return None
        return super().to_internal_value(value)


class EmployeeSerializer(serializers.ModelSerializer):
    NV_Ma = serializers.CharField(source="code", read_only=True)
    NV_Ten = serializers.CharField(source="full_name", max_length=150, required=True)
    NV_SDT = serializers.CharField(
        source="phone", max_length=20, required=False, allow_blank=True
    )
    NV_DChi = serializers.CharField(
        source="address", max_length=255, required=False, allow_blank=True
    )
    NV_NgaySinh = BlankableDateField(
        source="birth_date", required=False, allow_null=True
    )
    NV_GioiTinh = serializers.CharField(
        source="gender", max_length=20, required=False, allow_blank=True
    )
    NV_NgayVaoLam = serializers.DateField(
        source="hired_date", required=False
    )
    NV_TrangThai = serializers.CharField(write_only=True, required=False)
    user_id = serializers.IntegerField(read_only=True)

    class Meta:
        model = Employee
        fields = (
            "id",
            "NV_Ma",
            "NV_Ten",
            "NV_SDT",
            "NV_DChi",
            "NV_NgaySinh",
            "NV_GioiTinh",
            "NV_NgayVaoLam",
            "NV_TrangThai",
            "is_active",
            "user_id",
        )
        extra_kwargs = {
            "is_active": {"required": False},
        }

    def validate(self, attrs):
        status = attrs.pop("NV_TrangThai", None)
        if status is not None:
            statuses = {"Đang làm": True, "Nghỉ việc": False}
            if status not in statuses:
                raise serializers.ValidationError(
                    {"NV_TrangThai": "Trạng thái phải là 'Đang làm' hoặc 'Nghỉ việc'."}
                )
            status_is_active = statuses[status]
            if "is_active" in attrs and attrs["is_active"] != status_is_active:
                raise serializers.ValidationError(
                    {"is_active": "Giá trị không khớp với NV_TrangThai."}
                )
            attrs["is_active"] = status_is_active

        if (
            self.instance
            and attrs.get("is_active") is False
            and self.instance.user_id
            and self.instance.user_id == self.context["request"].user.pk
        ):
            raise serializers.ValidationError(
                {"is_active": "Không thể vô hiệu hóa hồ sơ của tài khoản đang đăng nhập."}
            )

        phone = attrs.get("phone")
        if phone:
            employees = Employee.objects.filter(phone=phone)
            if self.instance:
                employees = employees.exclude(pk=self.instance.pk)
            if employees.exists():
                raise serializers.ValidationError(
                    {"NV_SDT": "Số điện thoại đã được sử dụng."}
                )
        return attrs

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data["NV_TrangThai"] = "Đang làm" if instance.is_active else "Nghỉ việc"
        return data

    @transaction.atomic
    def update(self, instance, validated_data):
        employee = super().update(instance, validated_data)
        if not employee.is_active and employee.user_id:
            employee.user.is_active = False
            employee.user.save(update_fields=("is_active",))
            from rest_framework.authtoken.models import Token

            Token.objects.filter(user=employee.user).delete()
        return employee


class UserSerializer(serializers.ModelSerializer):
    TK_Ma = serializers.SerializerMethodField()
    TK_TenDangNhap = serializers.CharField(source="username", required=False)
    TK_TrangThai = serializers.SerializerMethodField()
    NV_Ma = serializers.SerializerMethodField()
    employee_id = serializers.PrimaryKeyRelatedField(
        source="employee",
        queryset=Employee.objects.all(),
        required=False,
        allow_null=True,
        write_only=True,
    )
    employee = serializers.SerializerMethodField()
    password = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    role = serializers.CharField(write_only=True, required=False)
    roles = serializers.SerializerMethodField()
    VT_Ma = serializers.SerializerMethodField()
    VT_Ten = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = (
            "id",
            "TK_Ma",
            "username",
            "TK_TenDangNhap",
            "email",
            "first_name",
            "last_name",
            "is_active",
            "TK_TrangThai",
            "employee_id",
            "employee",
            "NV_Ma",
            "password",
            "role",
            "roles",
            "VT_Ma",
            "VT_Ten",
        )
        extra_kwargs = {"username": {"required": False}}

    def to_internal_value(self, data):
        data = data.copy()
        if "username" not in data and "TK_TenDangNhap" in data:
            data["username"] = data["TK_TenDangNhap"]
        if "employee_id" not in data and "NV_Ma" in data:
            employee_code = data["NV_Ma"]
            employee = Employee.objects.filter(code=employee_code).first()
            if employee is None:
                raise serializers.ValidationError(
                    {"NV_Ma": "Không tìm thấy nhân viên."}
                )
            data["employee_id"] = employee.pk
        if "role" not in data and "VT_Ma" in data:
            data["role"] = data["VT_Ma"]
        if "TK_TrangThai" in data:
            statuses = {"Hoạt động": True, "Khóa": False}
            account_status = data["TK_TrangThai"]
            if account_status not in statuses:
                raise serializers.ValidationError(
                    {"TK_TrangThai": "Trạng thái phải là 'Hoạt động' hoặc 'Khóa'."}
                )
            status_is_active = statuses[account_status]
            if "is_active" in data and data["is_active"] != status_is_active:
                raise serializers.ValidationError(
                    {"is_active": "Giá trị không khớp với TK_TrangThai."}
                )
            data["is_active"] = status_is_active
        return super().to_internal_value(data)

    def get_employee(self, user):
        if not hasattr(user, "employee"):
            return None
        employee = user.employee
        return {
            "id": employee.pk,
            "NV_Ma": employee.code,
            "NV_Ten": employee.full_name,
        }

    def get_roles(self, user):
        return list(
            user.groups.filter(name__in=ROLE_NAMES)
            .order_by("name")
            .values_list("name", flat=True)
        )

    def get_VT_Ma(self, user):
        role_name = next(iter(self.get_roles(user)), None)
        return next(
            (role["code"] for role in ROLE_DEFINITIONS if role["name"] == role_name),
            None,
        )

    def get_VT_Ten(self, user):
        return next(iter(self.get_roles(user)), None)

    def get_TK_TrangThai(self, user):
        return "Hoạt động" if user.is_active else "Khóa"

    def get_TK_Ma(self, user):
        return f"TK{user.pk:04d}"

    def get_NV_Ma(self, user):
        employee = getattr(user, "employee", None)
        return employee.code if employee else None

    def validate_role(self, value):
        role_name = ROLE_BY_CODE.get(value, value)
        if role_name not in ROLE_NAMES:
            raise serializers.ValidationError("Vai trò không hợp lệ.")
        return role_name

    def validate(self, attrs):
        if self.instance is None:
            if not attrs.get("username"):
                raise serializers.ValidationError(
                    {"username": "Tên đăng nhập là bắt buộc."}
                )
            if not attrs.get("password"):
                raise serializers.ValidationError(
                    {"password": "Mật khẩu là bắt buộc khi tạo tài khoản."}
                )
            if not attrs.get("role"):
                raise serializers.ValidationError({"role": "Vai trò là bắt buộc."})
            if not attrs.get("employee"):
                raise serializers.ValidationError(
                    {"employee_id": "Nhân viên là bắt buộc khi tạo tài khoản."}
                )

        employee = attrs.get(
            "employee",
            getattr(self.instance, "employee", None) if self.instance else None,
        )
        if self.instance and "employee" in attrs and employee is None:
            raise serializers.ValidationError(
                {"employee_id": "Tài khoản phải được gán cho một nhân viên."}
            )
        is_active = attrs.get(
            "is_active", self.instance.is_active if self.instance else True
        )
        if employee and not employee.is_active and is_active:
            raise serializers.ValidationError(
                {"employee_id": "Không thể gán tài khoản đang hoạt động cho nhân viên đã nghỉ việc."}
            )
        if employee and employee.user_id and (
            self.instance is None or employee.user_id != self.instance.pk
        ):
            raise serializers.ValidationError(
                {"employee_id": "Nhân viên đã được gán cho tài khoản khác."}
            )
        username = attrs.get("username")
        if username:
            existing_users = User.objects.filter(username__iexact=username)
            if self.instance:
                existing_users = existing_users.exclude(pk=self.instance.pk)
            if existing_users.exists():
                raise serializers.ValidationError(
                    {"username": "Tên đăng nhập đã được sử dụng."}
                )
        password = attrs.get("password")
        if password:
            password_user = self.instance or User(
                username=attrs.get("username", ""),
                email=attrs.get("email", ""),
                first_name=attrs.get("first_name", ""),
                last_name=attrs.get("last_name", ""),
            )
            try:
                validate_password(password, user=password_user)
            except ValidationError as error:
                raise serializers.ValidationError({"password": error.messages}) from error
        if (
            self.instance
            and username
            and username != self.instance.username
            and not password
        ):
            raise serializers.ValidationError(
                {"password": "Đổi tên đăng nhập cần nhập mật khẩu mới."}
            )
        if self.instance and not is_active and self.instance.pk == self.context["request"].user.pk:
            raise serializers.ValidationError(
                {"is_active": "Không thể khóa tài khoản đang đăng nhập."}
            )
        if (
            self.instance
            and attrs.get("role")
            and self.instance.pk == self.context["request"].user.pk
            and not (
                self.context["request"].user.is_staff
                or self.context["request"].user.is_superuser
            )
            and attrs["role"] != "Chủ cửa hàng"
        ):
            raise serializers.ValidationError(
                {"role": "Không thể tự gỡ vai trò Chủ cửa hàng khỏi tài khoản đang dùng."}
            )
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        password = validated_data.pop("password")
        role_name = validated_data.pop("role")
        employee = validated_data.pop("employee", None)
        user = User.objects.create_user(password=password, **validated_data)
        if employee:
            employee.user = user
            employee.save(update_fields=("user", "updated_at"))
        user.groups.add(_get_role_group(role_name))
        return user

    @transaction.atomic
    def update(self, instance, validated_data):
        password = validated_data.pop("password", None)
        role_name = validated_data.pop("role", None)
        employee = validated_data.pop("employee", ...)
        old_employee = getattr(instance, "employee", None)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if password:
            instance.set_password(password)
        instance.save()

        if employee is not ... and employee != old_employee:
            if old_employee:
                old_employee.user = None
                old_employee.save(update_fields=("user", "updated_at"))
            if employee:
                employee.user = instance
                employee.save(update_fields=("user", "updated_at"))

        if role_name:
            _assign_role(instance, role_name)
        if not instance.is_active or password:
            from rest_framework.authtoken.models import Token

            Token.objects.filter(user=instance).delete()
        return instance


class PasswordChangeSerializer(serializers.Serializer):
    password = serializers.CharField(
        write_only=True, validators=(validate_password,), trim_whitespace=False
    )


class RoleAssignmentSerializer(serializers.Serializer):
    role = serializers.CharField()

    def validate_role(self, value):
        role_name = ROLE_BY_CODE.get(value, value)
        if role_name not in ROLE_NAMES:
            raise serializers.ValidationError("Vai trò không hợp lệ.")
        return role_name


class RoleSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    code = serializers.CharField()
    name = serializers.CharField()
    description = serializers.CharField()
    user_count = serializers.IntegerField()


def _get_role_group(role_name):
    from django.contrib.auth.models import Group

    return Group.objects.get(name=role_name)


def _assign_role(user, role_name):
    from django.contrib.auth.models import Group

    role_groups = Group.objects.filter(name__in=ROLE_NAMES)
    user.groups.remove(*role_groups)
    user.groups.add(_get_role_group(role_name))
