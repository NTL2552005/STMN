from django.http import HttpResponse
from django.urls import path


urlpatterns = [
    path('', lambda request: HttpResponse('Payments API ready'), name='payments-home'),
]
