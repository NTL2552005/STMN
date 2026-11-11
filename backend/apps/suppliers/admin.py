from django.contrib import admin

from .models import Supplier


@admin.register(Supplier)
class SupplierAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "phone", "status")
    list_filter = ("status",)
    search_fields = ("code", "name", "phone", "address", "bank_account")
    readonly_fields = ("code", "role", "created_at", "updated_at")

    def has_delete_permission(self, request, obj=None):
        return False
