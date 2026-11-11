from django.urls import path

from .views import close_payment, confirm_payment, create_payment, list_payments

urlpatterns = [
    path("", list_payments, name="payments-list"),
    path("invoices/<str:code>/", create_payment, name="invoice-payment-create"),
    path("<str:code>/confirm/", confirm_payment, name="payment-confirm"),
    path("<str:code>/cancel/", close_payment, name="payment-cancel"),
]
