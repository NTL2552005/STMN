from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.accounts.models import Employee
from apps.customers.models import DoiTacKinhDoanh
from apps.inventory.models import StorageLocation, StockMovement
from apps.inventory.services import get_available_stock
from apps.shifts.models import CashShift

from .models import MAX_SAFE_INTEGER, SaleInvoice, SaleInvoiceLine, SalePayment
from .services import (
    acquire_inventory_write_lock,
    allocate_and_decrement_stock,
    normalize_sale_lines,
)

SELLING_ROLES = {"Chủ cửa hàng", "Nhân viên bán hàng"}
CREDIT_ROLES = {"Chủ cửa hàng", "Nhân viên kế toán"}
ALLOWED_ROLES = SELLING_ROLES | CREDIT_ROLES
ALLOWED_PAYMENT_METHODS = {
    SalePayment.Method.CASH,
    SalePayment.Method.BANK_TRANSFER,
    SalePayment.Method.QR,
}


def _payload(request):
    return request.data if isinstance(request.data, dict) else {}


def _as_text(value, field_name):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field_name} không hợp lệ.")
    return value.strip()


def _roles_for_request(request):
    user = request.user
    roles = set(user.groups.filter(name__in=ALLOWED_ROLES).values_list("name", flat=True))
    if user.is_staff or user.is_superuser:
        roles.add("Chủ cửa hàng")
    return roles


def _active_role(request, data):
    roles = _roles_for_request(request)
    requested = data.get("role") or ""
    if not isinstance(requested, str):
        return None
    requested = requested.strip()
    if requested:
        return requested if requested in roles else None
    if "Chủ cửa hàng" in roles:
        return "Chủ cửa hàng"
    return next(iter(roles)) if len(roles) == 1 else None


def _as_bool(value, field_name):
    if value is None:
        return False
    if not isinstance(value, bool):
        raise ValueError(f"{field_name} không hợp lệ.")
    return value


def _as_int(value, field_name, *, allow_zero=True):
    if isinstance(value, bool):
        raise ValueError(f"{field_name} phải là số nguyên VND hợp lệ.")
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError(f"{field_name} phải là số nguyên VND hợp lệ.") from error
    if str(value).strip() != str(number):
        raise ValueError(f"{field_name} phải là số nguyên VND hợp lệ.")
    if (
        number < 0
        or (not allow_zero and number == 0)
        or number > MAX_SAFE_INTEGER
    ):
        raise ValueError(
            f"{field_name} phải là số nguyên VND "
            f"{'lớn hơn 0' if not allow_zero else 'không âm'}."
        )
    return number


def _employee_from_payload(data, request):
    employee_code = _as_text(
        data.get("NV_Ma")
        or data.get("employee_code")
        or data.get("employeeId")
        or data.get("cashierId"),
        "Mã nhân viên",
    )
    try:
        employee = request.user.employee
    except (AttributeError, Employee.DoesNotExist) as error:
        raise ValueError("Tài khoản chưa được gán hồ sơ nhân viên.") from error
    if not employee.is_active:
        raise ValueError("Nhân viên không còn hoạt động.")
    if employee_code and employee_code != employee.code:
        raise ValueError("Mã nhân viên phải khớp với tài khoản đang đăng nhập.")
    return employee


def _location_from_payload(data):
    location_code = _as_text(
        data.get("DD_Ma") or data.get("location_code") or data.get("locationId"),
        "Mã địa điểm",
    )
    if not location_code:
        raise ValueError("Cần chọn địa điểm bán hàng.")
    try:
        location = StorageLocation.objects.get(
            code=location_code,
            kind=StorageLocation.Kind.STORE,
            status=StorageLocation.Status.ACTIVE,
        )
    except StorageLocation.DoesNotExist as error:
        raise ValueError("Địa điểm bán không tồn tại hoặc không hoạt động.") from error
    return location


def _customer_from_payload(customer_code):
    if not customer_code:
        return None
    customer_code = _as_text(customer_code, "Mã khách hàng")
    try:
        customer = DoiTacKinhDoanh.objects.get(DT_Ma=customer_code)
    except DoiTacKinhDoanh.DoesNotExist as error:
        raise ValueError("Khách hàng không tồn tại.") from error
    if customer.DT_Loai != DoiTacKinhDoanh.Loai.KHACH_HANG:
        raise ValueError("Đối tượng được chọn không phải khách hàng.")
    if customer.DT_TrangThai != DoiTacKinhDoanh.TrangThai.HOAT_DONG:
        raise ValueError("Khách hàng không còn hoạt động.")
    return customer


def _customer_from_payload_data(data, fallback=None):
    if "DT_Ma" not in data and "customer_code" not in data:
        return fallback
    return _customer_from_payload(
        _as_text(data.get("DT_Ma") or data.get("customer_code"), "Mã khách hàng")
    )


def _invoice_paid(invoice):
    return sum(
        payment.amount
        for payment in invoice.payments.filter(status=SalePayment.Status.SUCCESS)
    )


def _invoice_reserved(invoice):
    return sum(
        payment.amount
        for payment in invoice.payments.filter(
            status__in=(SalePayment.Status.SUCCESS, SalePayment.Status.PENDING)
        )
    )


def _shift_for_employee_and_location(employee, location):
    return CashShift.objects.filter(
        NV_Ma=employee.code,
        DD_Ma=location.code,
        TrangThai=CashShift.Status.OPEN,
    ).first()


def _shift_for_payment(payment_code, *, open_only=False):
    shifts = CashShift.objects.all()
    if open_only:
        shifts = shifts.filter(TrangThai=CashShift.Status.OPEN)
    return next(
        (
            shift
            for shift in shifts
            if payment_code in (shift.payment_ids or [])
        ),
        None,
    )


def _serialize_payment(payment):
    return {
        "TTBH_Ma": payment.code,
        "BH_Ma": payment.invoice.code,
        "DT_Ma": payment.invoice.customer.DT_Ma if payment.invoice.customer else None,
        "TTBH_Ngay": payment.payment_date.isoformat(),
        "TTBH_SoTien": payment.amount,
        "TTBH_PhuongThuc": payment.method,
        "TTBH_TrangThai": payment.status,
    }


def _serialize_invoice(invoice):
    return {
        "BH_Ma": invoice.code,
        "DD_Ma": invoice.location.code,
        "NV_Ma": invoice.employee.code,
        "DT_Ma": invoice.customer.DT_Ma if invoice.customer else None,
        "BH_Ngay": invoice.invoice_date.isoformat(),
        "BH_TrangThai": invoice.status,
        "BH_TongSL": invoice.total_quantity,
        "BH_TongCong": invoice.total_amount,
        "allowCredit": invoice.allow_credit,
        "lines": [
            {
                "HH_Ma": line.product.code,
                "PNCT_Ma": line.lot_code,
                "BH_SL": line.quantity,
                "BH_DonGia": line.unit_price,
                "BH_TTien": line.amount,
            }
            for line in invoice.lines.select_related("product").all()
        ],
        "payments": [
            _serialize_payment(payment)
            for payment in invoice.payments.all()
        ],
    }


def _serialize_invoice_queryset():
    return SaleInvoice.objects.select_related(
        "employee", "location", "customer"
    ).prefetch_related("lines__product", "payments")


def _payment_allocations(data):
    payment = data.get("payment", data)
    if not isinstance(payment, dict):
        raise ValueError("Thông tin thanh toán không hợp lệ.")
    allocations = payment.get("allocations")
    if allocations is None:
        raw_allocations = [payment] if (
            "amount" in payment or "TTBH_SoTien" in payment
        ) else []
    else:
        if not isinstance(allocations, list):
            raise ValueError("Danh sách phân bổ thanh toán không hợp lệ.")
        raw_allocations = allocations

    normalized = []
    for allocation in raw_allocations:
        if not isinstance(allocation, dict):
            raise ValueError("Phân bổ thanh toán không hợp lệ.")
        amount = _as_int(
            allocation.get("amount", allocation.get("TTBH_SoTien", 0)),
            "Số tiền thanh toán",
        )
        method = _as_text(
            allocation.get("method")
            or allocation.get("TTBH_PhuongThuc")
            or SalePayment.Method.CASH,
            "Phương thức thanh toán",
        )
        if method not in ALLOWED_PAYMENT_METHODS:
            raise ValueError("Phương thức thanh toán không hợp lệ.")
        if amount:
            normalized.append({"amount": amount, "method": method})
    return normalized


def _save_shift_links(shift, *, invoice_code=None, payment_codes=()):
    invoice_ids = list(shift.invoice_ids or [])
    payment_ids = list(shift.payment_ids or [])
    if invoice_code and invoice_code not in invoice_ids:
        invoice_ids.append(invoice_code)
    for payment_code in payment_codes:
        if payment_code not in payment_ids:
            payment_ids.append(payment_code)
    shift.invoice_ids = invoice_ids
    shift.payment_ids = payment_ids
    shift.save(update_fields=("invoice_ids", "payment_ids"))


def _draft_line_payloads(invoice):
    return [
        {
            "HH_Ma": line.product.code,
            "BH_SL": line.quantity,
            "BH_DonGia": line.unit_price,
        }
        for line in invoice.lines.select_related("product").all()
    ]


def _check_draft_stock(lines, location):
    required = {}
    product_names = {}
    for line in lines:
        code = line["product"].code
        required[code] = required.get(code, 0) + line["quantity"]
        product_names[code] = line["product"].name
    for code, quantity in required.items():
        available = get_available_stock(code, location.code)
        if quantity > available:
            raise ValueError(
                f"{product_names[code]}: tồn có thể bán tại cửa hàng là "
                f"{available}, không đủ {quantity}."
            )


@api_view(["GET"])
def list_invoices(request):
    status_filter = (request.query_params.get("status") or "").strip()
    queryset = _serialize_invoice_queryset()
    if status_filter:
        queryset = queryset.filter(status=status_filter)
    return Response(
        [_serialize_invoice(invoice) for invoice in queryset.order_by("-invoice_date")]
    )


@api_view(["GET"])
def list_payments(request):
    if not _roles_for_request(request).intersection(ALLOWED_ROLES):
        return Response(
            {"detail": "Vai trò hiện tại không được xem giao dịch bán hàng."},
            status=status.HTTP_403_FORBIDDEN,
        )
    queryset = SalePayment.objects.select_related(
        "invoice", "invoice__customer"
    )
    invoice_code = (request.query_params.get("invoice") or "").strip()
    status_filter = (request.query_params.get("status") or "").strip()
    if invoice_code:
        queryset = queryset.filter(invoice__code=invoice_code)
    if status_filter:
        queryset = queryset.filter(status=status_filter)
    return Response(
        [
            _serialize_payment(payment)
            for payment in queryset.order_by("-payment_date", "-id")
        ]
    )


@api_view(["GET", "DELETE"])
def invoice_detail(request, code):
    if request.method == "DELETE":
        if _active_role(request, _payload(request)) not in SELLING_ROLES:
            return Response(
                {"detail": "Vai trò hiện tại không được xóa hóa đơn nháp."},
                status=status.HTTP_403_FORBIDDEN,
            )
        with transaction.atomic():
            acquire_inventory_write_lock()
            invoice = SaleInvoice.objects.filter(code=code).first()
            if not invoice:
                return Response(
                    {"detail": "Không tìm thấy hóa đơn."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            if invoice.status != SaleInvoice.Status.DRAFT:
                return Response(
                    {"detail": "Chỉ có thể xóa hóa đơn đang ở trạng thái nháp."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if invoice.payments.exists() or StockMovement.objects.filter(
                source="HoaDonBanHang", document_code=invoice.code
            ).exists():
                return Response(
                    {"detail": "Không thể xóa hóa đơn nháp đã phát sinh giao dịch."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            invoice.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    invoice = _serialize_invoice_queryset().filter(code=code).first()
    if not invoice:
        return Response(
            {"detail": "Không tìm thấy hóa đơn."},
            status=status.HTTP_404_NOT_FOUND,
        )
    return Response(_serialize_invoice(invoice))


@api_view(["POST"])
def save_draft_invoice(request):
    data = _payload(request)
    if _active_role(request, data) not in SELLING_ROLES:
        return Response(
            {"detail": "Vai trò hiện tại không được lưu hóa đơn nháp."},
            status=status.HTTP_403_FORBIDDEN,
        )
    try:
        with transaction.atomic():
            acquire_inventory_write_lock()
            employee = _employee_from_payload(data, request)
            location = _location_from_payload(data)
            customer = _customer_from_payload_data(data)
            raw_lines = data.get("lines") or []
            lines = normalize_sale_lines(raw_lines, location)
            _check_draft_stock(lines, location)
            total_quantity = sum(line["quantity"] for line in lines)
            total_amount = sum(line["amount"] for line in lines)
            if total_quantity > MAX_SAFE_INTEGER or total_amount > MAX_SAFE_INTEGER:
                raise ValueError("Tổng số lượng hoặc tổng tiền hóa đơn vượt giới hạn số chính xác.")

            code = _as_text(
                data.get("BH_Ma") or data.get("code"), "Mã hóa đơn"
            )
            invoice = SaleInvoice.objects.filter(code=code).first() if code else None
            if invoice and invoice.status != SaleInvoice.Status.DRAFT:
                return Response(
                    {"detail": "Chỉ có thể cập nhật hóa đơn đang ở trạng thái nháp."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if invoice and (
                invoice.payments.exists()
                or StockMovement.objects.filter(
                    source="HoaDonBanHang", document_code=invoice.code
                ).exists()
            ):
                return Response(
                    {"detail": "Hóa đơn nháp đã phát sinh giao dịch, không thể cập nhật."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            created = invoice is None
            if created:
                invoice = SaleInvoice(code=code)
            invoice.employee = employee
            invoice.location = location
            invoice.customer = customer
            invoice.invoice_date = timezone.now()
            invoice.allow_credit = _as_bool(
                data.get("allowCredit", data.get("allow_credit", False)),
                "Quyền ghi nợ",
            )
            invoice.status = SaleInvoice.Status.DRAFT
            invoice.total_quantity = total_quantity
            invoice.total_amount = total_amount
            invoice.save()
            invoice.lines.all().delete()
            SaleInvoiceLine.objects.bulk_create(
                [
                    SaleInvoiceLine(
                        invoice=invoice,
                        product=line["product"],
                        quantity=line["quantity"],
                        unit_price=line["unit_price"],
                        amount=line["amount"],
                    )
                    for line in lines
                ]
            )
        return Response(
            {"BH_Ma": invoice.code, "invoice": _serialize_invoice(invoice)},
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)


@api_view(["POST"])
def confirm_invoice(request, code):
    data = _payload(request)
    active_role = _active_role(request, data)
    if active_role not in SELLING_ROLES:
        return Response(
            {"detail": "Vai trò hiện tại không được xác nhận hóa đơn bán hàng."},
            status=status.HTTP_403_FORBIDDEN,
        )
    try:
        with transaction.atomic():
            acquire_inventory_write_lock()
            invoice = _serialize_invoice_queryset().filter(code=code).first()
            if not invoice:
                return Response(
                    {"detail": "Không tìm thấy hóa đơn."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            if invoice.status == SaleInvoice.Status.CONFIRMED:
                return Response(
                    {
                        "BH_Ma": invoice.code,
                        "BH_TrangThai": invoice.status,
                        "invoice": _serialize_invoice(invoice),
                    }
                )
            if invoice.status != SaleInvoice.Status.DRAFT:
                return Response(
                    {"detail": "Chỉ có thể xác nhận hóa đơn đang ở trạng thái nháp."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            employee = _employee_from_payload(data, request)
            location = _location_from_payload(data) if (
                "DD_Ma" in data or "location_code" in data
            ) else _location_from_payload({"DD_Ma": invoice.location.code})
            customer = _customer_from_payload_data(data, invoice.customer)
            shift = _shift_for_employee_and_location(employee, location)
            if not shift:
                return Response(
                    {"detail": "Hãy mở ca bán hàng tại đúng địa điểm trước khi xác nhận hóa đơn."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            raw_lines = data.get("lines")
            if raw_lines is None:
                raw_lines = _draft_line_payloads(invoice)
            normalized = normalize_sale_lines(raw_lines, location)
            allocations = _payment_allocations(data)
            total_quantity = sum(line["quantity"] for line in normalized)
            total_amount = sum(line["amount"] for line in normalized)
            if total_quantity > MAX_SAFE_INTEGER or total_amount > MAX_SAFE_INTEGER:
                raise ValueError("Tổng số lượng hoặc tổng tiền hóa đơn vượt giới hạn số chính xác.")
            reserved = sum(payment["amount"] for payment in allocations)
            if reserved > total_amount:
                raise ValueError("Tổng thanh toán không được vượt tổng hóa đơn.")

            allow_credit = _as_bool(
                data.get("allowCredit", data.get("allow_credit", invoice.allow_credit)),
                "Quyền ghi nợ",
            )
            due = total_amount - reserved
            if due > 0 and (
                not customer
                or not allow_credit
                or active_role not in CREDIT_ROLES
            ):
                raise ValueError(
                    "Hóa đơn chưa được thanh toán đủ. Cần khách hàng đã lưu, "
                    "quyền cho phép ghi nợ và vai trò được phép ghi nợ."
                )

            invoice.employee = employee
            invoice.location = location
            invoice.customer = customer
            invoice.allow_credit = allow_credit
            invoice.total_quantity = total_quantity
            invoice.total_amount = total_amount
            invoice.invoice_date = timezone.now()

            allocated = allocate_and_decrement_stock(
                normalized,
                location=location,
                employee=employee,
                invoice_code=invoice.code,
            )
            invoice.status = SaleInvoice.Status.CONFIRMED
            invoice.save()
            invoice.lines.all().delete()
            SaleInvoiceLine.objects.bulk_create(
                [
                    SaleInvoiceLine(
                        invoice=invoice,
                        product=line["product"],
                        lot_code=line["lot_code"],
                        quantity=line["quantity"],
                        unit_price=line["unit_price"],
                        amount=line["amount"],
                    )
                    for line in allocated
                ]
            )

            payments = []
            for allocation in allocations:
                payment = SalePayment.objects.create(
                    invoice=invoice,
                    amount=allocation["amount"],
                    method=allocation["method"],
                    payment_date=invoice.invoice_date,
                    status=(
                        SalePayment.Status.SUCCESS
                        if allocation["method"] == SalePayment.Method.CASH
                        else SalePayment.Status.PENDING
                    ),
                )
                payments.append(payment)
            _save_shift_links(
                shift,
                invoice_code=invoice.code,
                payment_codes=[payment.code for payment in payments],
            )
        invoice = _serialize_invoice_queryset().get(pk=invoice.pk)
        return Response(
            {
                "BH_Ma": invoice.code,
                "BH_TrangThai": invoice.status,
                "invoice": _serialize_invoice(invoice),
            }
        )
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)


@api_view(["POST"])
def create_payment(request, code):
    data = _payload(request)
    active_role = _active_role(request, data)
    if active_role not in SELLING_ROLES:
        return Response(
            {"detail": "Chỉ nhân viên bán hàng hoặc chủ cửa hàng được ghi nhận thanh toán."},
            status=status.HTTP_403_FORBIDDEN,
        )
    try:
        key = _as_text(
            request.headers.get("Idempotency-Key") or data.get("idempotency_key"),
            "Idempotency-Key",
        )
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)
    if not key:
        return Response(
            {"detail": "Cần gửi Idempotency-Key để tránh ghi nhận thanh toán trùng."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if len(key) > 100:
        return Response(
            {"detail": "Idempotency-Key vượt quá 100 ký tự."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    try:
        with transaction.atomic():
            acquire_inventory_write_lock()
            if key:
                existing = SalePayment.objects.select_related("invoice").filter(
                    idempotency_key=key
                ).first()
                if existing:
                    amount = _as_int(
                        data.get("TTBH_SoTien", data.get("amount")),
                        "Số tiền thanh toán",
                        allow_zero=False,
                    )
                    method = _as_text(
                        data.get("TTBH_PhuongThuc")
                        or data.get("method")
                        or SalePayment.Method.CASH,
                        "Phương thức thanh toán",
                    )
                    if (
                        existing.invoice.code != code
                        or existing.amount != amount
                        or existing.method != method
                    ):
                        return Response(
                            {"detail": "Idempotency-Key đã được dùng cho yêu cầu khác."},
                            status=status.HTTP_409_CONFLICT,
                        )
                    return Response(
                        _serialize_payment(existing),
                        status=status.HTTP_200_OK,
                    )

            invoice = _serialize_invoice_queryset().filter(code=code).first()
            if not invoice:
                return Response(
                    {"detail": "Không tìm thấy hóa đơn."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            if invoice.status != SaleInvoice.Status.CONFIRMED:
                return Response(
                    {"detail": "Chỉ có thể thanh toán hóa đơn đã xác nhận."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            employee = _employee_from_payload(data, request)
            shift = _shift_for_employee_and_location(employee, invoice.location)
            requested_location = _as_text(data.get("locationId"), "Mã địa điểm")
            if requested_location and requested_location != invoice.location.code:
                raise ValueError("Địa điểm thu tiền phải trùng địa điểm của hóa đơn.")
            if not shift:
                return Response(
                    {"detail": "Hãy mở ca bán hàng tại đúng địa điểm trước khi thu tiền."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            amount = _as_int(
                data.get("TTBH_SoTien", data.get("amount")),
                "Số tiền thanh toán",
                allow_zero=False,
            )
            method = _as_text(
                data.get("TTBH_PhuongThuc")
                or data.get("method")
                or SalePayment.Method.CASH,
                "Phương thức thanh toán",
            )
            if method not in ALLOWED_PAYMENT_METHODS:
                raise ValueError("Phương thức thanh toán không hợp lệ.")
            outstanding = max(0, invoice.total_amount - _invoice_reserved(invoice))
            if amount > outstanding:
                return Response(
                    {"detail": f"Số tiền vượt số còn phải thu ({outstanding} ₫)."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            payment = SalePayment.objects.create(
                invoice=invoice,
                amount=amount,
                method=method,
                status=(
                    SalePayment.Status.SUCCESS
                    if method == SalePayment.Method.CASH
                    else SalePayment.Status.PENDING
                ),
                idempotency_key=key or None,
            )
            _save_shift_links(shift, payment_codes=(payment.code,))
        return Response(
            _serialize_payment(payment), status=status.HTTP_201_CREATED
        )
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)


@api_view(["POST"])
def confirm_payment(request, code):
    active_role = _active_role(request, _payload(request))
    if active_role not in CREDIT_ROLES:
        return Response(
            {"detail": "Chỉ kế toán hoặc chủ cửa hàng được xác nhận thanh toán không dùng tiền mặt."},
            status=status.HTTP_403_FORBIDDEN,
        )
    try:
        with transaction.atomic():
            acquire_inventory_write_lock()
            payment = SalePayment.objects.select_related(
                "invoice", "invoice__location", "invoice__employee", "invoice__customer"
            ).filter(code=code).first()
            if not payment:
                return Response(
                    {"detail": "Không tìm thấy giao dịch thanh toán."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            if payment.status == SalePayment.Status.SUCCESS:
                return Response(
                    {"TTBH_Ma": payment.code, "TTBH_TrangThai": payment.status}
                )
            if payment.status != SalePayment.Status.PENDING:
                return Response(
                    {"detail": "Giao dịch không còn chờ xác nhận."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            shift = _shift_for_payment(payment.code, open_only=True)
            if not shift:
                return Response(
                    {"detail": "Thanh toán chưa gắn với ca đang mở; không thể xác nhận."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if payment.invoice.status != SaleInvoice.Status.CONFIRMED:
                return Response(
                    {"detail": "Chỉ được xác nhận thanh toán của hóa đơn đã xác nhận."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if _invoice_paid(payment.invoice) + payment.amount > payment.invoice.total_amount:
                return Response(
                    {"detail": "Xác nhận giao dịch sẽ làm tổng thu vượt hóa đơn."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            payment.status = SalePayment.Status.SUCCESS
            payment.save(update_fields=("status", "updated_at"))
        return Response(
            {"TTBH_Ma": payment.code, "TTBH_TrangThai": payment.status}
        )
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)


@api_view(["POST"])
def close_payment(request, code):
    data = _payload(request)
    if _active_role(request, data) not in CREDIT_ROLES:
        return Response(
            {"detail": "Chỉ kế toán hoặc chủ cửa hàng được đối chiếu giao dịch."},
            status=status.HTTP_403_FORBIDDEN,
        )
    try:
        status_value = _as_text(
            data.get("status") or data.get("TTBH_TrangThai") or "",
            "Trạng thái giao dịch",
        )
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)
    if status_value not in {
        SalePayment.Status.FAILED,
        SalePayment.Status.CANCELLED,
    }:
        return Response(
            {"detail": "Trạng thái giao dịch không được hỗ trợ."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    with transaction.atomic():
        acquire_inventory_write_lock()
        payment = SalePayment.objects.filter(code=code).first()
        if not payment:
            return Response(
                {"detail": "Không tìm thấy giao dịch thanh toán."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if payment.status == status_value:
            return Response(
                {"TTBH_Ma": payment.code, "TTBH_TrangThai": payment.status}
            )
        if payment.status != SalePayment.Status.PENDING:
            return Response(
                {"detail": "Chỉ được cập nhật giao dịch đang chờ xác nhận."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        payment.status = status_value
        payment.save(update_fields=("status", "updated_at"))
    return Response(
        {"TTBH_Ma": payment.code, "TTBH_TrangThai": payment.status}
    )


@api_view(["POST"])
def open_shift(request):
    data = _payload(request)
    if _active_role(request, data) not in SELLING_ROLES:
        return Response(
            {"detail": "Vai trò hiện tại không được mở ca bán hàng."},
            status=status.HTTP_403_FORBIDDEN,
        )
    try:
        with transaction.atomic():
            acquire_inventory_write_lock()
            employee = _employee_from_payload(data, request)
            location = _location_from_payload(data)
            opening_cash = _as_int(
                data.get(
                    "TienMatDauCa",
                    data.get("opening_cash", data.get("openingCash", 0)),
                ),
                "Tiền mặt đầu ca",
            )
            note = _as_text(
                data.get("GhiChu") or data.get("note"), "Ghi chú"
            )
            if CashShift.objects.filter(
                NV_Ma=employee.code, TrangThai=CashShift.Status.OPEN
            ).exists():
                return Response(
                    {"detail": "Nhân viên đã có ca đang mở tại địa điểm này."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            shift = CashShift.objects.create(
                Ca_Ma=f"CA{CashShift.objects.count() + 1:05d}",
                NV_Ma=employee.code,
                DD_Ma=location.code,
                GioMo=timezone.now(),
                TienMatDauCa=opening_cash,
                GhiChu=note,
                TrangThai=CashShift.Status.OPEN,
                invoice_ids=[],
                payment_ids=[],
            )
        return Response(
            {"Ca_Ma": shift.Ca_Ma, "TrangThai": shift.TrangThai},
            status=status.HTTP_201_CREATED,
        )
    except ValueError as error:
        return Response({"detail": str(error)}, status=status.HTTP_400_BAD_REQUEST)


@api_view(["GET"])
def open_shift_status(request, employee_code, location_code):
    if not _roles_for_request(request).intersection(SELLING_ROLES):
        return Response(
            {"detail": "Vai trò hiện tại không được xem ca bán hàng."},
            status=status.HTTP_403_FORBIDDEN,
        )
    employee = Employee.objects.filter(code=employee_code, is_active=True).first()
    if not employee:
        return Response(
            {"detail": "Nhân viên không hợp lệ."},
            status=status.HTTP_404_NOT_FOUND,
        )
    try:
        _employee_from_payload({"employee_code": employee_code}, request)
    except ValueError as error:
        return Response(
            {"detail": str(error)},
            status=status.HTTP_403_FORBIDDEN,
        )
    location = StorageLocation.objects.filter(
        code=location_code,
        kind=StorageLocation.Kind.STORE,
        status=StorageLocation.Status.ACTIVE,
    ).first()
    if not location:
        return Response(
            {"detail": "Địa điểm không tồn tại."},
            status=status.HTTP_404_NOT_FOUND,
        )
    shift = _shift_for_employee_and_location(employee, location)
    return Response(
        {
            "Ca_Ma": shift.Ca_Ma if shift else None,
            "TrangThai": shift.TrangThai if shift else None,
        }
    )
