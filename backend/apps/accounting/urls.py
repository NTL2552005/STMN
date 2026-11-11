from django.urls import path

from .views import (
    AccountingRootAPIView,
    AccountingDashboardAPIView,
    CashbookAPIView,
    CustomerReceivablesAPIView,
    ExpenseVoucherListCreateAPIView,
    PaymentReconciliationAPIView,
    ReceiptVoucherListCreateAPIView,
    PurchaseReconciliationAPIView,
    SalesRevenueReconciliationAPIView,
    AccountingReportsAPIView,
    SalesReceiptSyncAPIView,
    SupplierDebtCreateAPIView,
    SupplierDebtListAPIView,
    SupplierPaymentActionAPIView,
    SupplierPaymentListCreateAPIView,
    VoucherStatusAPIView,
)

urlpatterns = [
    path("", AccountingRootAPIView.as_view(), name="accounting-home"),
    path("dashboard/", AccountingDashboardAPIView.as_view(), name="dashboard"),
    path(
        "purchase-reconciliation/",
        PurchaseReconciliationAPIView.as_view(),
        name="purchase-reconciliation",
    ),
    path(
        "revenue-reconciliation/",
        SalesRevenueReconciliationAPIView.as_view(),
        name="revenue-reconciliation",
    ),
    path("reports/", AccountingReportsAPIView.as_view(), name="reports"),
    path("supplier-debts/", SupplierDebtListAPIView.as_view(), name="supplier-debts"),
    path(
        "supplier-debts/from-receipt/<str:receipt_code>/",
        SupplierDebtCreateAPIView.as_view(),
        name="supplier-debt-from-receipt",
    ),
    path(
        "supplier-debts/<str:debt_code>/payments/",
        SupplierPaymentListCreateAPIView.as_view(),
        name="supplier-debt-payments",
    ),
    path(
        "supplier-payments/",
        SupplierPaymentListCreateAPIView.as_view(),
        name="supplier-payments",
    ),
    path(
        "supplier-payments/<str:code>/<str:action>/",
        SupplierPaymentActionAPIView.as_view(),
        name="supplier-payment-action",
    ),
    path("receipts/", ReceiptVoucherListCreateAPIView.as_view(), name="receipts"),
    path(
        "receipts/<str:code>/status/",
        VoucherStatusAPIView.as_view(),
        {"kind": "receipts"},
        name="receipt-status",
    ),
    path(
        "sales-payments/<str:payment_code>/receipt/",
        SalesReceiptSyncAPIView.as_view(),
        name="sales-receipt-sync",
    ),
    path("expenses/", ExpenseVoucherListCreateAPIView.as_view(), name="expenses"),
    path(
        "expenses/<str:code>/status/",
        VoucherStatusAPIView.as_view(),
        {"kind": "expenses"},
        name="expense-status",
    ),
    path(
        "customer-receivables/",
        CustomerReceivablesAPIView.as_view(),
        name="customer-receivables",
    ),
    path(
        "payment-reconciliation/",
        PaymentReconciliationAPIView.as_view(),
        name="payment-reconciliation",
    ),
    path("cashbook/", CashbookAPIView.as_view(), name="cashbook"),
]
