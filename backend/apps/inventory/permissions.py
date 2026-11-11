from rest_framework.permissions import BasePermission, IsAuthenticated

from apps.accounts.constants import STORE_OWNER_ROLE
from apps.accounts.permissions import user_has_any_role


class InventoryReadPermission(IsAuthenticated):
    pass


class IsWarehouseOrOwner(BasePermission):
    message = "Chỉ nhân viên kho, chủ cửa hàng hoặc quản trị viên được thực hiện thao tác này."

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (
                user.is_staff
                or user.is_superuser
                or user_has_any_role(
                    user, ("Nhân viên kho", STORE_OWNER_ROLE)
                )
            )
        )


class IsAccountantOrOwner(BasePermission):
    message = "Chỉ kế toán, chủ cửa hàng hoặc quản trị viên được xác nhận phiếu nhập."

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (
                user.is_staff
                or user.is_superuser
                or user_has_any_role(
                    user, ("Nhân viên kế toán", STORE_OWNER_ROLE)
                )
            )
        )


class IsSalesOrOwner(BasePermission):
    message = "Chỉ nhân viên bán hàng, chủ cửa hàng hoặc quản trị viên được xác nhận nhận chuyển."

    def has_permission(self, request, view):
        user = request.user
        return bool(
            user
            and user.is_authenticated
            and (
                user.is_staff
                or user.is_superuser
                or user_has_any_role(
                    user, ("Nhân viên bán hàng", STORE_OWNER_ROLE)
                )
            )
        )
