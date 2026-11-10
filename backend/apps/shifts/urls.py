from django.urls import path

from .views import (
    CashShiftDetailAPIView,
    CashShiftHandoverAPIView,
    CashShiftListCreateAPIView,
    CashShiftOpenAPIView,
    CashShiftReconcileAPIView,
    CashShiftRequestExplanationAPIView,
    CashShiftSearchAPIView,
    CashShiftSubmitAPIView,
)

urlpatterns = [
    path('', CashShiftListCreateAPIView.as_view(), name='shift-list-create'),
    path('open/', CashShiftOpenAPIView.as_view(), name='shift-open'),
    path('search/', CashShiftSearchAPIView.as_view(), name='shift-search'),
    path('<str:pk>/', CashShiftDetailAPIView.as_view(), name='shift-detail'),
    path('<str:pk>/submit/', CashShiftSubmitAPIView.as_view(), name='shift-submit'),
    path('<str:pk>/request-explanation/', CashShiftRequestExplanationAPIView.as_view(), name='shift-request-explanation'),
    path('<str:pk>/reconcile/', CashShiftReconcileAPIView.as_view(), name='shift-reconcile'),
    path('<str:pk>/handover/', CashShiftHandoverAPIView.as_view(), name='shift-handover'),
]
