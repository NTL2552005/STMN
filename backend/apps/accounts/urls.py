from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import EmployeeViewSet, LoginView, LogoutView, MeView, RoleViewSet, UserViewSet

router = DefaultRouter()
router.register("employees", EmployeeViewSet, basename="employee")
router.register("users", UserViewSet, basename="user")
router.register("roles", RoleViewSet, basename="role")

app_name = "accounts"

urlpatterns = [
    path("login/", LoginView.as_view(), name="login"),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("me/", MeView.as_view(), name="me"),
    path("", include(router.urls)),
]
