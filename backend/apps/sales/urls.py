from django.urls import path

from .views import (
    close_payment,
    confirm_invoice,
    confirm_payment,
    create_payment,
    invoice_detail,
    list_invoices,
    list_payments,
    open_shift,
    open_shift_status,
    save_draft_invoice,
)

urlpatterns = [
    path("invoices/", list_invoices, name="sales-invoices-list"),
    path("invoices/create/", save_draft_invoice, name="sales-invoice-save-draft"),
    path("invoices/<str:code>/", invoice_detail, name="sales-invoice-detail"),
    path("invoices/<str:code>/confirm/", confirm_invoice, name="sales-invoice-confirm"),
    path("invoices/<str:code>/payments/", create_payment, name="sales-invoice-payment-create"),
    path("payments/", list_payments, name="sales-payments-list"),
    path("payments/<str:code>/confirm/", confirm_payment, name="sales-payment-confirm"),
    path("payments/<str:code>/cancel/", close_payment, name="sales-payment-close"),
    path("shifts/open/", open_shift, name="sales-shift-open"),
    path("shifts/<str:employee_code>/<str:location_code>/", open_shift_status, name="sales-shift-status"),
]
