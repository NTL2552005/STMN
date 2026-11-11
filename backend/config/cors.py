from django.conf import settings
from django.http import HttpResponse
from django.utils.cache import patch_vary_headers


class SimpleCorsMiddleware:
    allowed_methods = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    allowed_headers = "Authorization, Content-Type"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        origin = request.headers.get("Origin")
        allowed = origin in settings.STMN_CORS_ALLOWED_ORIGINS
        if (
            allowed
            and request.method == "OPTIONS"
            and request.headers.get("Access-Control-Request-Method")
        ):
            response = HttpResponse(status=204)
            response["Access-Control-Allow-Methods"] = self.allowed_methods
            response["Access-Control-Allow-Headers"] = self.allowed_headers
            response["Access-Control-Max-Age"] = "600"
        else:
            response = self.get_response(request)

        if allowed:
            response["Access-Control-Allow-Origin"] = origin
            patch_vary_headers(response, ("Origin",))
        return response
