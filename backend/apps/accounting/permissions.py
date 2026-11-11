from rest_framework.permissions import BasePermission

from apps.accounts.permissions import user_has_any_role


ACCOUNTING_ROLES = ("Chủ cửa hàng", "Nhân viên kế toán")


class IsAccountantOrOwner(BasePermission):
    message = "Chỉ kế toán hoặc chủ cửa hàng được thực hiện nghiệp vụ kế toán."

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (
                user.is_staff
                or user.is_superuser
                or user_has_any_role(user, ACCOUNTING_ROLES)
            )
        )
