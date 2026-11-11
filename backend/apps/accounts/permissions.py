from rest_framework.permissions import BasePermission

from .constants import ROLE_NAMES, STORE_OWNER_ROLE


def user_has_any_role(user, role_names):
    return bool(
        user
        and user.is_authenticated
        and user.groups.filter(name__in=role_names).exists()
    )


class IsStoreOwnerOrAdmin(BasePermission):
    message = "Chỉ chủ cửa hàng hoặc quản trị viên được thực hiện thao tác này."

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (
                user.is_staff
                or user.is_superuser
                or user_has_any_role(user, (STORE_OWNER_ROLE,))
            )
        )


def user_has_role(user, role_name):
    return user_has_any_role(user, (role_name,))


def user_has_business_role(user, role_code_or_name):
    from .constants import ROLE_BY_CODE

    role_name = ROLE_BY_CODE.get(role_code_or_name, role_code_or_name)
    return role_name in ROLE_NAMES and user_has_role(user, role_name)


class HasAnyRole(BasePermission):
    message = "Bạn không có vai trò cần thiết để thực hiện thao tác này."
    allowed_roles = ()

    def has_permission(self, request, view):
        return user_has_any_role(request.user, self.allowed_roles)
