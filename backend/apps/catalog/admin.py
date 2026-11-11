from django.contrib import admin

from .models import Category, Product, SalePrice


@admin.register(Category)
class CategoryAdmin(admin.ModelAdmin):
    list_display = ("code", "name")
    search_fields = ("code", "name")


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "category", "barcode", "status")
    list_filter = ("status", "category")
    search_fields = ("code", "name", "barcode")


@admin.register(SalePrice)
class SalePriceAdmin(admin.ModelAdmin):
    list_display = ("code", "product", "amount", "starts_on", "ends_on", "status")
    list_filter = ("status", "product")
    search_fields = ("code", "product__code", "product__name")
