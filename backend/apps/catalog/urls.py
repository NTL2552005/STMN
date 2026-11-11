from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import CategoryViewSet, ProductViewSet, SalePriceViewSet

router = DefaultRouter()
router.register("categories", CategoryViewSet, basename="catalog-category")
router.register("products", ProductViewSet, basename="catalog-product")
router.register("prices", SalePriceViewSet, basename="catalog-price")

app_name = "catalog"

urlpatterns = [path("", include(router.urls))]
