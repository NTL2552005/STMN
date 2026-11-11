from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import PartnerViewSet

router = DefaultRouter()
router.register("", PartnerViewSet, basename="partner")

app_name = "partners"

urlpatterns = [path("", include(router.urls))]
