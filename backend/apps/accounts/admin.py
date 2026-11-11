from django.contrib import admin

from .models import Employee


@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display = ("code", "full_name", "phone", "is_active", "user")
    list_filter = ("is_active", "gender")
    search_fields = ("code", "full_name", "phone")
