from django.contrib import admin

from .models import PurchaseOrder, PurchaseOrderLine


class PurchaseOrderLineInline(admin.TabularInline):
    model = PurchaseOrderLine
    extra = 0
    can_delete = False


@admin.register(PurchaseOrder)
class PurchaseOrderAdmin(admin.ModelAdmin):
    list_display = (
        "code",
        "supplier",
        "employee",
        "ordered_on",
        "total_quantity",
        "total_amount",
        "status",
    )
    list_filter = ("status", "ordered_on")
    search_fields = ("code", "supplier__code", "supplier__name")
    readonly_fields = ("code", "total_quantity", "total_amount")
    inlines = (PurchaseOrderLineInline,)

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(PurchaseOrderLine)
class PurchaseOrderLineAdmin(admin.ModelAdmin):
    list_display = ("order", "product", "quantity", "unit_price", "amount")

    def has_delete_permission(self, request, obj=None):
        return False
