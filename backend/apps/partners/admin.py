from django.contrib import admin

from .models import Partner


@admin.register(Partner)
class PartnerAdmin(admin.ModelAdmin):
    list_display = ("code", "name", "phone", "role", "status")
    list_filter = ("role", "status")
    search_fields = ("code", "name", "phone", "address", "bank_account")
    readonly_fields = ("code", "created_at", "updated_at")
