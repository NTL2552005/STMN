from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase, override_settings

from .cors import SimpleCorsMiddleware


@override_settings(STMN_CORS_ALLOWED_ORIGINS=("http://localhost:5500",))
class SimpleCorsMiddlewareTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.middleware = SimpleCorsMiddleware(lambda request: HttpResponse("ok"))

    def test_allowed_preflight_returns_explicit_origin_and_headers(self):
        request = self.factory.options(
            "/api/accounts/login/",
            HTTP_ORIGIN="http://localhost:5500",
            HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization,content-type",
        )

        response = self.middleware(request)

        self.assertEqual(response.status_code, 204)
        self.assertEqual(
            response["Access-Control-Allow-Origin"], "http://localhost:5500"
        )
        self.assertIn("Authorization", response["Access-Control-Allow-Headers"])
        self.assertIn("Origin", response["Vary"])

    def test_unlisted_origin_gets_no_cors_permission(self):
        request = self.factory.get(
            "/api/accounts/me/", HTTP_ORIGIN="http://evil.example"
        )

        response = self.middleware(request)

        self.assertNotIn("Access-Control-Allow-Origin", response)

    def test_allowed_origin_headers_are_added_to_api_responses(self):
        request = self.factory.get(
            "/api/accounts/me/", HTTP_ORIGIN="http://localhost:5500"
        )

        response = self.middleware(request)

        self.assertEqual(response["Access-Control-Allow-Origin"], "http://localhost:5500")
