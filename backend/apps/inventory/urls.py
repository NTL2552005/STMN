from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    GoodsReceiptViewSet,
    InventoryOverviewView,
    ExpiryListView,
    OrderReceivingProgressView,
    StockCountViewSet,
    StockTransferViewSet,
    SupplierReturnViewSet,
    StockBalanceListView,
    StockMovementListView,
    StockLedgerView,
    StorageLocationListView,
)

router = DefaultRouter()
router.register("receipts", GoodsReceiptViewSet, basename="goods-receipt")
router.register("stock-counts", StockCountViewSet, basename="stock-count")
router.register("transfers", StockTransferViewSet, basename="stock-transfer")
router.register(
    "supplier-returns", SupplierReturnViewSet, basename="supplier-return"
)

app_name = "inventory"

urlpatterns = [
    path("", include(router.urls)),
    path(
        "orders/<str:order_code>/receiving-progress/",
        OrderReceivingProgressView.as_view(),
        name="order-receiving-progress",
    ),
    path("locations/", StorageLocationListView.as_view(), name="locations"),
    path("stock/", StockBalanceListView.as_view(), name="stock"),
    path("movements/", StockMovementListView.as_view(), name="movements"),
    path("stock-ledger/", StockLedgerView.as_view(), name="stock-ledger"),
    path("expiry/", ExpiryListView.as_view(), name="expiry"),
    path("overview/", InventoryOverviewView.as_view(), name="overview"),
]
