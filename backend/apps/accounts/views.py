from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.models import Group
from django.db import transaction
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.authtoken.models import Token

from .constants import ROLE_DEFINITIONS, ROLE_NAMES, STORE_OWNER_ROLE
from .models import Employee
from .permissions import IsStoreOwnerOrAdmin
from .serializers import (
    EmployeeSerializer,
    LoginSerializer,
    PasswordChangeSerializer,
    RoleAssignmentSerializer,
    UserSerializer,
)

User = get_user_model()


class LoginView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = authenticate(
            request,
            username=serializer.validated_data["username"],
            password=serializer.validated_data["password"],
        )
        if user is None:
            return Response(
                {"detail": "Tên đăng nhập hoặc mật khẩu không chính xác."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        if hasattr(user, "employee") and not user.employee.is_active:
            return Response(
                {"detail": "Tài khoản không hoạt động."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        token, _ = Token.objects.get_or_create(user=user)
        return Response({"token": token.key, "user": UserSerializer(user).data})


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if isinstance(request.auth, Token):
            request.auth.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(UserSerializer(request.user).data)


class EmployeeViewSet(viewsets.ModelViewSet):
    queryset = Employee.objects.select_related("user").all()
    serializer_class = EmployeeSerializer
    permission_classes = [IsStoreOwnerOrAdmin]

    def destroy(self, request, *args, **kwargs):
        employee = self.get_object()
        if employee.user_id == request.user.pk:
            return Response(
                {"detail": "Không thể vô hiệu hóa hồ sơ của tài khoản đang đăng nhập."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)

    @transaction.atomic
    def perform_destroy(self, instance):
        instance.is_active = False
        instance.save(update_fields=("is_active", "updated_at"))
        if instance.user_id:
            instance.user.is_active = False
            instance.user.save(update_fields=("is_active",))
            Token.objects.filter(user=instance.user).delete()


class UserViewSet(viewsets.ModelViewSet):
    queryset = (
        User.objects.select_related("employee")
        .prefetch_related("groups")
        .order_by("id")
    )
    serializer_class = UserSerializer
    permission_classes = [IsStoreOwnerOrAdmin]

    def perform_update(self, serializer):
        user = serializer.save()
        if not user.is_active:
            Token.objects.filter(user=user).delete()

    def destroy(self, request, *args, **kwargs):
        user = self.get_object()
        if user.pk == request.user.pk:
            return Response(
                {"detail": "Không thể khóa tài khoản đang đăng nhập."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)

    def perform_destroy(self, instance):
        instance.is_active = False
        instance.save(update_fields=("is_active",))
        Token.objects.filter(user=instance).delete()

    @action(detail=True, methods=("post",), url_path="password")
    def change_password(self, request, pk=None):
        user = self.get_object()
        serializer = PasswordChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user.set_password(serializer.validated_data["password"])
        user.save(update_fields=("password",))
        Token.objects.filter(user=user).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=("put",), url_path="role")
    @transaction.atomic
    def assign_role(self, request, pk=None):
        user = self.get_object()
        serializer = RoleAssignmentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        role_name = serializer.validated_data["role"]
        if (
            user.pk == request.user.pk
            and not (request.user.is_staff or request.user.is_superuser)
            and role_name != STORE_OWNER_ROLE
        ):
            return Response(
                {"detail": "Không thể tự gỡ vai trò Chủ cửa hàng khỏi tài khoản đang dùng."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        role_groups = Group.objects.filter(name__in=ROLE_NAMES)
        user.groups.remove(*role_groups)
        user.groups.add(Group.objects.get(name=role_name))
        return Response(UserSerializer(user).data)


class RoleViewSet(viewsets.ReadOnlyModelViewSet):
    permission_classes = [IsStoreOwnerOrAdmin]
    queryset = Group.objects.filter(name__in=ROLE_NAMES).order_by("id")

    def list(self, request, *args, **kwargs):
        roles = []
        for definition in ROLE_DEFINITIONS:
            group = self.get_queryset().filter(name=definition["name"]).first()
            if group is None:
                continue
            roles.append(
                {
                    "id": group.pk,
                    **definition,
                    "user_count": group.user_set.count(),
                }
            )
        return Response(roles)

    def retrieve(self, request, *args, **kwargs):
        group = self.get_object()
        definition = next(
            role for role in ROLE_DEFINITIONS if role["name"] == group.name
        )
        return Response(
            {
                "id": group.pk,
                **definition,
                "user_count": group.user_set.count(),
            }
        )
