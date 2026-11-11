from django.contrib import admin

from .models import (
    GoodsReceipt,
    GoodsReceiptLine,
    StockTransfer,
    StockTransferLine,
    StockBalance,
    StockMovement,
    StorageLocation,
)


class GoodsReceiptLineInline(admin.TabularInline):
    model = GoodsReceiptLine
    extra = 0
    readonly_fields = tuple(field.name for field in GoodsReceiptLine._meta.fields)
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False


class StockTransferLineInline(admin.TabularInline):
    model = StockTransferLine
    extra = 0
    readonly_fields = tuple(field.name for field in StockTransferLine._meta.fields)
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(StockTransfer)
class StockTransferAdmin(admin.ModelAdmin):
    list_display = (
        "code",
        "transfer_date",
        "source_location",
        "destination_location",
        "total_quantity",
        "status",
    )
    list_filter = ("status", "transfer_date", "source_location", "destination_location")
    search_fields = ("code", "source_location__code", "destination_location__code")
    readonly_fields = tuple(field.name for field in StockTransfer._meta.fields)
    inlines = (StockTransferLineInline,)

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(GoodsReceipt)
class GoodsReceiptAdmin(admin.ModelAdmin):
    list_display = (
        "code",
        "received_on",
        "supplier",
        "location",
        "total_quantity",
        "total_amount",
        "status",
    )
    list_filter = ("status", "received_on", "location")
    search_fields = ("code", "supplier__code", "supplier__name", "purchase_order__code")
    readonly_fields = tuple(field.name for field in GoodsReceipt._meta.fields)
    inlines = (GoodsReceiptLineInline,)

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(StorageLocation)
class StorageLocationAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "kind", "status")
    list_filter = ("kind", "status")
    search_fields = ("code", "name", "address")
    readonly_fields = ("code", "created_at", "updated_at")


@admin.register(StockBalance)
class StockBalanceAdmin(admin.ModelAdmin):
    list_display = ("location", "receipt_line", "quantity", "updated_at")
    list_filter = ("location",)
    search_fields = ("receipt_line__code", "receipt_line__product__code")
    readonly_fields = ("location", "receipt_line", "quantity", "updated_at")

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(StockMovement)
class StockMovementAdmin(admin.ModelAdmin):
    list_display = (
        "code",
        "occurred_at",
        "movement_type",
        "location",
        "receipt_line",
        "quantity_delta",
        "document_code",
    )
    list_filter = ("movement_type", "location", "occurred_at")
    search_fields = ("code", "document_code", "receipt_line__code")
    readonly_fields = tuple(field.name for field in StockMovement._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(GoodsReceiptLine)
class GoodsReceiptLineAdmin(admin.ModelAdmin):
    list_display = ("code", "receipt", "product", "quantity", "unit_price", "amount")
    search_fields = ("code", "receipt__code", "product__code", "product__name")
    readonly_fields = tuple(field.name for field in GoodsReceiptLine._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
