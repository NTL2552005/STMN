from rest_framework.permissions import IsAuthenticated

from apps.accounts.permissions import IsStoreOwnerOrAdmin


class CatalogModelPermissionsMixin:
    def get_permissions(self):
        permission_classes = (
            (IsAuthenticated,)
            if self.action in ("list", "retrieve")
            else (IsStoreOwnerOrAdmin,)
        )
        return [permission() for permission in permission_classes]
