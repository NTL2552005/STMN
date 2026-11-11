from django.http import HttpResponse
from django.urls import path


urlpatterns = [
    path('', lambda request: HttpResponse('Accounting API ready'), name='accounting-home'),
]
