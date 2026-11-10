from rest_framework.permissions import IsAuthenticated

from apps.accounts.permissions import IsStoreOwnerOrAdmin


class PurchaseOrderPermissionsMixin:
    def get_permissions(self):
        if self.action in ("list", "retrieve"):
            return [IsAuthenticated()]
        return [IsStoreOwnerOrAdmin()]
