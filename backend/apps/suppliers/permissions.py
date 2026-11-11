from rest_framework.permissions import IsAuthenticated

from apps.accounts.permissions import IsStoreOwnerOrAdmin


class SupplierPermissionsMixin:
    def get_permissions(self):
        permission_class = (
            IsAuthenticated
            if self.action in ("list", "retrieve")
            else IsStoreOwnerOrAdmin
        )
        return [permission_class()]
