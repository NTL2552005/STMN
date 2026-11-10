from django.urls import path

from .views import CustomerListAPIView, PartnerDetailAPIView, PartnerListCreateAPIView

urlpatterns = [
    path('partners/', PartnerListCreateAPIView.as_view(), name='customer-partner-list-create'),
    path('partners/<str:pk>/', PartnerDetailAPIView.as_view(), name='customer-partner-detail'),
    path('customers/', CustomerListAPIView.as_view(), name='customer-list'),
]
