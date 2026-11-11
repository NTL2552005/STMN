from collections import defaultdict
from functools import wraps
from threading import RLock

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.accounts.models import Employee
from apps.catalog.models import Product
from apps.catalog.services import to_base_quantity, to_base_unit_price
from apps.partners.models import Partner
from apps.purchasing.models import PurchaseOrder
from apps.purchasing.services import (
    get_order,
    get_order_for_receiving,
    get_order_receiving_summary,
    get_receipt_progress,
    sync_receipt_progress,
)
from apps.suppliers.services import get_supplier

from .models import (
    MAX_SAFE_INTEGER,
    GoodsReceipt,
    GoodsReceiptLine,
    StockCount,
    StockCountLine,
    InventoryMutationLock,
    StockBalance,
    StockMovement,
    StockTransfer,
    StockTransferLine,
    SupplierReturn,
    SupplierReturnLine,
    StorageLocation,
)

LOW_STOCK_THRESHOLD = 10
DEFAULT_EXPIRY_WARNING_DAYS = 30


_sqlite_mutation_lock = RLock()


def _serialize_sqlite_mutations(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with _sqlite_mutation_lock:
            return function(*args, **kwargs)

    return wrapped


def _acquire_write_lock():
    InventoryMutationLock.objects.get_or_create(pk=1)
    changed = InventoryMutationLock.objects.filter(pk=1).update(
        version=F("version") + 1
    )
    if changed != 1:
        raise RuntimeError("Inventory write lock is missing; apply its migration.")


def _employee_for_user(user):
    try:
        employee = user.employee
    except (AttributeError, Employee.DoesNotExist) as error:
        raise ValueError("Tài khoản chưa được gán hồ sơ nhân viên.") from error
    if not employee.is_active:
        raise ValueError("Nhân viên không còn hoạt động.")
    return employee


def _validate_employee_code(employee, code):
    if code and code != employee.code:
        raise ValueError("Mã nhân viên phải khớp với tài khoản đang đăng nhập.")


def _load_supplier(code):
    try:
        return get_supplier(code)
    except Partner.DoesNotExist as error:
        raise ValueError(
            "Đối tác không tồn tại hoặc không có vai trò nhà cung cấp."
        ) from error


def _load_location(code):
    try:
        return StorageLocation.objects.get(code=code)
    except StorageLocation.DoesNotExist as error:
        raise ValueError("Địa điểm nhập không tồn tại.") from error


def _order_receipt_payloads(order_code, *, exclude_code=""):
    receipts = (
        GoodsReceipt.objects.filter(purchase_order__code=order_code)
        .exclude(code=exclude_code)
        .prefetch_related("lines__product")
        .order_by("pk")
    )
    return [
        {
            "PN_Ma": receipt.code,
            "PN_TrangThai": receipt.status,
            "lines": [
                {"HH_Ma": line.product.code, "PNCT_SL": line.quantity}
                for line in receipt.lines.all()
            ],
        }
        for receipt in receipts
    ]


def _lock_order(order_code):
    changed = PurchaseOrder.objects.filter(code=order_code).update(
        updated_at=timezone.now()
    )
    if changed != 1:
        raise PurchaseOrder.DoesNotExist(order_code)
    try:
        return get_order_for_receiving(order_code)
    except PurchaseOrder.DoesNotExist:
        raise


def _normalized_lines(raw_lines):
    if not raw_lines:
        raise ValueError("Phiếu nhập cần ít nhất một dòng hàng.")
    normalized = []
    total_quantity = 0
    total_amount = 0
    for raw in raw_lines:
        try:
            product = Product.objects.get(code=raw["HH_Ma"])
        except Product.DoesNotExist as error:
            raise ValueError("Mặt hàng trong phiếu nhập không tồn tại.") from error
        factor = raw.get("PNCT_DViNhap", 1)
        if factor != 1 and factor != product.package_ratio:
            raise ValueError("Đơn vị quy đổi không hợp lệ với mặt hàng.")
        try:
            quantity = to_base_quantity(raw["PNCT_SL"], factor)
            unit_price = to_base_unit_price(raw["PNCT_DonGia"], factor)
        except ValueError as error:
            raise ValueError(str(error)) from error
        amount = quantity * unit_price
        if amount > MAX_SAFE_INTEGER:
            raise ValueError(
                f"Thành tiền của {product.name} vượt giới hạn số chính xác."
            )
        total_quantity += quantity
        total_amount += amount
        if total_quantity > MAX_SAFE_INTEGER or total_amount > MAX_SAFE_INTEGER:
            raise ValueError("Tổng số lượng hoặc tổng tiền vượt giới hạn số chính xác.")
        normalized.append(
            {
                "product": product,
                "production_date": raw.get("PNCT_NSX"),
                "expiry_date": raw.get("PNCT_HSD"),
                "minimum_expiry_days": raw.get("PNCT_HSDToiThieu"),
                "quantity": quantity,
                "unit_price": unit_price,
                "amount": amount,
            }
        )
    return normalized, total_quantity, total_amount


def _check_order_allocation(order, lines, *, exclude_receipt_code=""):
    receipts = _order_receipt_payloads(
        order.code, exclude_code=exclude_receipt_code
    )
    summary = get_order_receiving_summary(order, receipts)
    progress = get_receipt_progress(order, receipts)
    if summary["status"] != progress["status"]:
        raise RuntimeError("Purchasing returned inconsistent receiving progress.")
    for row in progress["lines"]:
        if row["received"] + row["pending"] > row["ordered"]:
            raise ValueError(
                f"Số đã nhận và đang giữ chỗ của {row['HH_Ma']} "
                "vượt số lượng đã đặt."
            )
    available = {
        row["HH_Ma"]: row["available_to_receive"] for row in progress["lines"]
    }
    requested = defaultdict(int)
    for line in lines:
        requested[line["product"].code] += line["quantity"]
    for product_code, quantity in requested.items():
        remaining = available.get(product_code)
        if remaining is None:
            raise ValueError(
                f"{product_code} không thuộc đơn đặt hàng {order.code}."
            )
        if quantity > remaining:
            raise ValueError(
                f"Số lượng {product_code} vượt số còn được nhận: "
                f"còn {remaining}, đang nhập {quantity}."
            )


def _receipt_lines(receipt):
    return list(receipt.lines.select_related("product").order_by("pk"))


def _save_lines(receipt, normalized):
    receipt.lines.all().delete()
    for line in normalized:
        GoodsReceiptLine.objects.create(receipt=receipt, **line)


def _receipt_payloads(order_code):
    return _order_receipt_payloads(order_code)


def _sync_order(order_code):
    return sync_receipt_progress(order_code, _receipt_payloads(order_code))


def _stock_transfer_queryset():
    return StockTransfer.objects.select_related(
        "source_location",
        "destination_location",
        "employee",
        "dispatched_by",
        "received_by",
    ).prefetch_related(
        "lines__receipt_line__product",
        "lines__receipt_line__receipt",
    )


SUPPLIER_RETURN_REASONS = (
    "Hàng hư hỏng",
    "Hàng lỗi chất lượng",
    "Hàng giao sai",
    "Hàng không đúng quy cách",
    "Hàng gần hết hạn",
    "Lý do khác",
)


def _supplier_return_queryset():
    return SupplierReturn.objects.select_related(
        "supplier",
        "receipt",
        "source_location",
        "employee",
        "reviewed_by",
        "confirmed_by",
    ).prefetch_related("lines__receipt_line__product")


def get_supplier_return(return_code):
    return _supplier_return_queryset().get(code=return_code)


def get_supplier_return_lines(return_code):
    return list(
        SupplierReturnLine.objects.filter(
            supplier_return__code=return_code
        ).select_related(
            "receipt_line__product",
            "receipt_line__receipt",
            "supplier_return",
        )
    )


def get_supplier_return_total(return_code):
    return SupplierReturn.objects.values_list("total_amount", flat=True).get(
        code=return_code
    )


def _returned_quantity(receipt_line, *, excluding_return_id=None):
    returns = SupplierReturnLine.objects.filter(
        receipt_line=receipt_line,
        supplier_return__status=SupplierReturn.Status.SHIPPED,
    )
    if excluding_return_id:
        returns = returns.exclude(supplier_return_id=excluding_return_id)
    return sum(returns.values_list("quantity", flat=True))


def _normalize_supplier_return_lines(
    raw_lines,
    *,
    supplier,
    receipt,
    location,
    excluding_return_id=None,
    default_reason="",
):
    if not raw_lines:
        raise ValueError("Phiếu trả cần ít nhất một dòng hàng.")
    line_codes = [line.get("PNCT_Ma", "") for line in raw_lines]
    if any(not code for code in line_codes):
        raise ValueError("Mã dòng nhập là bắt buộc.")
    if len(line_codes) != len(set(line_codes)):
        raise ValueError("Không thể lặp lại cùng một dòng nhập trong phiếu trả.")
    source_lines = GoodsReceiptLine.objects.select_related(
        "receipt", "product"
    ).in_bulk(line_codes, field_name="code")
    if len(source_lines) != len(line_codes):
        raise ValueError("Dòng nhập trong phiếu trả không tồn tại.")

    normalized = []
    total_quantity = 0
    total_amount = 0
    for raw in raw_lines:
        source_line = source_lines[raw["PNCT_Ma"]]
        if source_line.receipt_id != receipt.pk:
            raise ValueError(
                f"Dòng nhập {source_line.code} không thuộc phiếu nhập gốc đã chọn."
            )
        if source_line.receipt.status != GoodsReceipt.Status.CONFIRMED:
            raise ValueError(
                f"Dòng nhập {source_line.code} không thuộc phiếu nhập đã xác nhận."
            )
        if source_line.receipt.supplier_id != supplier.pk:
            raise ValueError("NCC của phiếu nhập phải trùng NCC trên phiếu trả.")

        quantity = raw.get("TRNCC_SL")
        entered_quantity = raw.get("TRNCC_SLNhap", quantity)
        factor = raw.get("TRNCC_HeSo", 1)
        for value in (entered_quantity, factor):
            if not isinstance(value, int) or isinstance(value, bool):
                raise ValueError("Số lượng và hệ số quy đổi phải là số nguyên.")
        if entered_quantity <= 0 or factor <= 0:
            raise ValueError("Số lượng trả và hệ số quy đổi phải lớn hơn 0.")
        if entered_quantity > MAX_SAFE_INTEGER or factor > MAX_SAFE_INTEGER:
            raise ValueError("Số lượng hoặc hệ số quy đổi vượt giới hạn cho phép.")
        if factor not in (1, source_line.product.package_ratio):
            raise ValueError(
                f"Đơn vị quy đổi của dòng {source_line.code} không hợp lệ."
            )
        converted_quantity = entered_quantity * factor
        if converted_quantity > MAX_SAFE_INTEGER:
            raise ValueError("Số lượng quy đổi vượt giới hạn số chính xác.")
        if quantity is not None and quantity != converted_quantity:
            raise ValueError(
                f"Số lượng quy đổi của dòng {source_line.code} không khớp."
            )

        reason = str(raw.get("TRNCC_LyDoChiTiet") or default_reason).strip()
        if reason not in SUPPLIER_RETURN_REASONS:
            raise ValueError(f"Lý do trả của dòng {source_line.code} không hợp lệ.")
        returned = _returned_quantity(
            source_line, excluding_return_id=excluding_return_id
        )
        outstanding_quantity = source_line.quantity - returned
        if converted_quantity > outstanding_quantity:
            raise ValueError(
                f"Số lượng trả dòng {source_line.code} vượt số lượng nhập còn "
                f"có thể trả (còn {max(0, outstanding_quantity)})."
            )
        current_stock = StockBalance.objects.filter(
            location=location, receipt_line=source_line
        ).values_list("quantity", flat=True).first() or 0
        available = min(outstanding_quantity, current_stock)
        if converted_quantity > available:
            raise ValueError(
                f"Tồn khả dụng dòng {source_line.code} tại địa điểm đã chọn "
                f"không đủ (còn {max(0, available)})."
            )

        amount = converted_quantity * source_line.unit_price
        if amount > MAX_SAFE_INTEGER:
            raise ValueError(
                f"Giá trị trả của dòng {source_line.code} vượt giới hạn số chính xác."
            )
        total_quantity += converted_quantity
        total_amount += amount
        if total_quantity > MAX_SAFE_INTEGER or total_amount > MAX_SAFE_INTEGER:
            raise ValueError("Tổng số lượng hoặc tổng giá trị vượt giới hạn cho phép.")
        normalized.append(
            {
                "receipt_line": source_line,
                "quantity": converted_quantity,
                "entered_quantity": entered_quantity,
                "conversion_factor": factor,
                "unit_price": source_line.unit_price,
                "amount": amount,
                "reason": reason,
            }
        )
    return normalized, total_quantity, total_amount


def _replace_supplier_return_lines(supplier_return, normalized):
    supplier_return.lines.all().delete()
    SupplierReturnLine.objects.bulk_create(
        [
            SupplierReturnLine(supplier_return=supplier_return, **line)
            for line in normalized
        ]
    )


@_serialize_sqlite_mutations
@transaction.atomic
def save_supplier_return(
    *,
    user,
    supplier_code=None,
    receipt_code=None,
    location_code=None,
    return_date=None,
    reason=None,
    note=None,
    lines=None,
    return_code="",
    employee_code="",
):
    _acquire_write_lock()
    employee = _employee_for_user(user)
    _validate_employee_code(employee, employee_code)

    existing = None
    if return_code:
        try:
            existing = _supplier_return_queryset().get(code=return_code)
        except SupplierReturn.DoesNotExist as error:
            raise SupplierReturn.DoesNotExist(return_code) from error
        if existing.status != SupplierReturn.Status.DRAFT:
            raise ValueError("Chỉ được chỉnh sửa phiếu trả ở trạng thái Nháp.")

    supplier_code = supplier_code or (
        existing.supplier.code if existing else ""
    )
    receipt_code = receipt_code or (existing.receipt.code if existing else "")
    location_code = location_code or (
        existing.source_location.code if existing else ""
    )
    return_date = return_date or (existing.return_date if existing else None)
    reason = reason if reason is not None else (existing.reason if existing else "")
    note = note if note is not None else (existing.note if existing else "")
    if lines is None:
        lines = (
            [
                {
                    "PNCT_Ma": line.receipt_line.code,
                    "TRNCC_SL": line.quantity,
                    "TRNCC_SLNhap": line.entered_quantity,
                    "TRNCC_HeSo": line.conversion_factor,
                    "TRNCC_LyDoChiTiet": line.reason,
                }
                for line in existing.lines.select_related("receipt_line")
            ]
            if existing
            else []
        )
    if reason not in SUPPLIER_RETURN_REASONS:
        raise ValueError("Vui lòng chọn lý do trả hàng hợp lệ.")
    if len(note) > 255:
        raise ValueError("Ghi chú không được vượt quá 255 ký tự.")
    try:
        supplier = _load_supplier(supplier_code)
    except Partner.DoesNotExist as error:
        raise ValueError(
            "Chỉ chọn đối tác có loại Nhà cung cấp hoặc Cả hai."
        ) from error
    try:
        receipt = GoodsReceipt.objects.select_related("supplier").get(
            code=receipt_code
        )
    except GoodsReceipt.DoesNotExist as error:
        raise ValueError("Phiếu nhập gốc không tồn tại.") from error
    if (
        receipt.status != GoodsReceipt.Status.CONFIRMED
        or receipt.supplier_id != supplier.pk
    ):
        raise ValueError(
            "Chỉ chọn phiếu nhập đã xác nhận thuộc đúng nhà cung cấp."
        )
    location = _load_location(location_code)
    if location.status != StorageLocation.Status.ACTIVE:
        raise ValueError("Địa điểm xuất trả không hợp lệ hoặc đã ngừng hoạt động.")
    if return_date is None:
        raise ValueError("Ngày lập phiếu trả là bắt buộc.")
    normalized, total_quantity, total_amount = _normalize_supplier_return_lines(
        lines,
        supplier=supplier,
        receipt=receipt,
        location=location,
        excluding_return_id=existing.pk if existing else None,
        default_reason=reason,
    )

    supplier_return = existing or SupplierReturn(
        employee=employee,
        supplier=supplier,
        receipt=receipt,
        source_location=location,
        return_date=return_date,
        reason=reason,
    )
    supplier_return.supplier = supplier
    supplier_return.receipt = receipt
    supplier_return.source_location = location
    supplier_return.return_date = return_date
    supplier_return.reason = reason
    supplier_return.note = note.strip()
    supplier_return.total_quantity = total_quantity
    supplier_return.total_amount = total_amount
    supplier_return.status = SupplierReturn.Status.DRAFT
    supplier_return.save()
    _replace_supplier_return_lines(supplier_return, normalized)
    return get_supplier_return(supplier_return.code)


@_serialize_sqlite_mutations
@transaction.atomic
def submit_supplier_return(return_code):
    _acquire_write_lock()
    try:
        supplier_return = _supplier_return_queryset().get(code=return_code)
    except SupplierReturn.DoesNotExist as error:
        raise SupplierReturn.DoesNotExist(return_code) from error
    if supplier_return.status != SupplierReturn.Status.DRAFT:
        raise ValueError("Chỉ gửi duyệt phiếu trả ở trạng thái Nháp.")
    lines, total_quantity, total_amount = _normalize_supplier_return_lines(
        [
            {
                "PNCT_Ma": line.receipt_line.code,
                "TRNCC_SL": line.quantity,
                "TRNCC_SLNhap": line.entered_quantity,
                "TRNCC_HeSo": line.conversion_factor,
                "TRNCC_LyDoChiTiet": line.reason,
            }
            for line in supplier_return.lines.select_related(
                "receipt_line__product", "receipt_line__receipt"
            )
        ],
        supplier=supplier_return.supplier,
        receipt=supplier_return.receipt,
        location=supplier_return.source_location,
        excluding_return_id=supplier_return.pk,
        default_reason=supplier_return.reason,
    )
    changed = SupplierReturn.objects.filter(
        pk=supplier_return.pk, status=SupplierReturn.Status.DRAFT
    ).update(
        status=SupplierReturn.Status.WAITING_APPROVAL,
        submitted_at=timezone.now(),
        total_quantity=total_quantity,
        total_amount=total_amount,
        updated_at=timezone.now(),
    )
    if changed != 1:
        raise ValueError("Phiếu trả đã được xử lý bởi một thao tác khác.")
    _replace_supplier_return_lines(supplier_return, lines)
    return get_supplier_return(return_code)


@_serialize_sqlite_mutations
@transaction.atomic
def review_supplier_return(return_code, *, reviewed_by, approve):
    _acquire_write_lock()
    employee = _employee_for_user(reviewed_by)
    try:
        supplier_return = _supplier_return_queryset().get(code=return_code)
    except SupplierReturn.DoesNotExist as error:
        raise SupplierReturn.DoesNotExist(return_code) from error
    if supplier_return.status != SupplierReturn.Status.WAITING_APPROVAL:
        raise ValueError("Chỉ xử lý phiếu trả đang ở trạng thái Chờ duyệt.")
    if approve:
        lines, total_quantity, total_amount = _normalize_supplier_return_lines(
            [
                {
                    "PNCT_Ma": line.receipt_line.code,
                    "TRNCC_SL": line.quantity,
                    "TRNCC_SLNhap": line.entered_quantity,
                    "TRNCC_HeSo": line.conversion_factor,
                    "TRNCC_LyDoChiTiet": line.reason,
                }
                for line in supplier_return.lines.select_related(
                    "receipt_line__product", "receipt_line__receipt"
                )
            ],
            supplier=supplier_return.supplier,
            receipt=supplier_return.receipt,
            location=supplier_return.source_location,
            excluding_return_id=supplier_return.pk,
            default_reason=supplier_return.reason,
        )
        next_status = SupplierReturn.Status.APPROVED
        updates = {
            "status": next_status,
            "reviewed_by": employee,
            "reviewed_at": timezone.now(),
            "review_note": "",
            "total_quantity": total_quantity,
            "total_amount": total_amount,
            "updated_at": timezone.now(),
        }
    else:
        lines = None
        next_status = SupplierReturn.Status.REJECTED
        updates = {
            "status": next_status,
            "reviewed_by": employee,
            "reviewed_at": timezone.now(),
            "review_note": "Chủ cửa hàng từ chối yêu cầu.",
            "updated_at": timezone.now(),
        }
    changed = SupplierReturn.objects.filter(
        pk=supplier_return.pk,
        status=SupplierReturn.Status.WAITING_APPROVAL,
    ).update(**updates)
    if changed != 1:
        raise ValueError("Phiếu trả đã được xử lý bởi một thao tác khác.")
    if lines is not None:
        _replace_supplier_return_lines(supplier_return, lines)
    return get_supplier_return(return_code)


@_serialize_sqlite_mutations
@transaction.atomic
def cancel_supplier_return(return_code):
    _acquire_write_lock()
    changed = SupplierReturn.objects.filter(
        code=return_code,
        status__in=(
            SupplierReturn.Status.DRAFT,
            SupplierReturn.Status.WAITING_APPROVAL,
            SupplierReturn.Status.APPROVED,
        ),
    ).update(
        status=SupplierReturn.Status.CANCELLED,
        cancelled_at=timezone.now(),
        updated_at=timezone.now(),
    )
    if changed != 1:
        if not SupplierReturn.objects.filter(code=return_code).exists():
            raise SupplierReturn.DoesNotExist(return_code)
        raise ValueError("Không thể hủy phiếu đã xuất trả, đã hủy hoặc bị từ chối.")
    return get_supplier_return(return_code)


@_serialize_sqlite_mutations
@transaction.atomic
def delete_draft_supplier_return(return_code):
    _acquire_write_lock()
    try:
        supplier_return = SupplierReturn.objects.get(code=return_code)
    except SupplierReturn.DoesNotExist as error:
        raise SupplierReturn.DoesNotExist(return_code) from error
    if supplier_return.status != SupplierReturn.Status.DRAFT:
        raise ValueError("Chỉ xóa được phiếu trả ở trạng thái Nháp.")
    supplier_return.delete()


@_serialize_sqlite_mutations
@transaction.atomic
def confirm_supplier_return(return_code, *, confirmed_by):
    _acquire_write_lock()
    employee = _employee_for_user(confirmed_by)
    try:
        supplier_return = _supplier_return_queryset().get(code=return_code)
    except SupplierReturn.DoesNotExist as error:
        raise SupplierReturn.DoesNotExist(return_code) from error
    if supplier_return.status != SupplierReturn.Status.APPROVED:
        raise ValueError(
            "Chỉ xuất trả phiếu đã được Chủ cửa hàng duyệt."
        )
    lines, total_quantity, total_amount = _normalize_supplier_return_lines(
        [
            {
                "PNCT_Ma": line.receipt_line.code,
                "TRNCC_SL": line.quantity,
                "TRNCC_SLNhap": line.entered_quantity,
                "TRNCC_HeSo": line.conversion_factor,
                "TRNCC_LyDoChiTiet": line.reason,
            }
            for line in supplier_return.lines.select_related(
                "receipt_line__product", "receipt_line__receipt"
            )
        ],
        supplier=supplier_return.supplier,
        receipt=supplier_return.receipt,
        location=supplier_return.source_location,
        excluding_return_id=supplier_return.pk,
        default_reason=supplier_return.reason,
    )
    for line in lines:
        receipt_line = line["receipt_line"]
        quantity = line["quantity"]
        if StockMovement.objects.filter(
            location=supplier_return.source_location,
            receipt_line=receipt_line,
            source="TraHangNCC",
            document_code=supplier_return.code,
            movement_type=StockMovement.Kind.SUPPLIER_RETURN,
        ).exists():
            raise ValueError(
                f"Dòng nhập {receipt_line.code} đã có biến động trả của phiếu này."
            )
        changed = StockBalance.objects.filter(
            location=supplier_return.source_location,
            receipt_line=receipt_line,
            quantity__gte=quantity,
        ).update(
            quantity=F("quantity") - quantity,
            updated_at=timezone.now(),
        )
        if changed != 1:
            current = StockBalance.objects.filter(
                location=supplier_return.source_location,
                receipt_line=receipt_line,
            ).values_list("quantity", flat=True).first() or 0
            raise ValueError(
                f"Tồn khả dụng dòng {receipt_line.code} không đủ để xuất trả "
                f"(còn {current})."
            )
        StockMovement.objects.create(
            location=supplier_return.source_location,
            receipt_line=receipt_line,
            employee=employee,
            movement_type=StockMovement.Kind.SUPPLIER_RETURN,
            quantity_delta=-quantity,
            source="TraHangNCC",
            document_code=supplier_return.code,
            note=line["reason"],
        )

    changed = SupplierReturn.objects.filter(
        pk=supplier_return.pk, status=SupplierReturn.Status.APPROVED
    ).update(
        status=SupplierReturn.Status.SHIPPED,
        confirmed_by=employee,
        confirmed_at=timezone.now(),
        total_quantity=total_quantity,
        total_amount=total_amount,
        updated_at=timezone.now(),
    )
    if changed != 1:
        raise ValueError("Phiếu trả đã được xử lý bởi một thao tác khác.")
    _replace_supplier_return_lines(supplier_return, lines)
    return get_supplier_return(return_code)


def get_stock_transfer(transfer_code):
    return _stock_transfer_queryset().get(code=transfer_code)


@_serialize_sqlite_mutations
@transaction.atomic
def create_stock_transfer(
    *,
    user,
    source_location_code,
    destination_location_code,
    transfer_date,
    lines,
    receiver_name="",
    employee_code="",
):
    _acquire_write_lock()
    employee = _employee_for_user(user)
    _validate_employee_code(employee, employee_code)
    if source_location_code == destination_location_code:
        raise ValueError("Địa điểm xuất phải khác địa điểm nhận.")
    locations = {
        location.code: location
        for location in StorageLocation.objects.filter(
            code__in=(source_location_code, destination_location_code),
            status=StorageLocation.Status.ACTIVE,
        )
    }
    if len(locations) != 2:
        raise ValueError("Địa điểm xuất và nhận phải tồn tại, đang hoạt động.")
    if not lines:
        raise ValueError("Phiếu chuyển cần ít nhất một dòng hàng.")

    line_codes = [line["PNCT_Ma"] for line in lines]
    if len(line_codes) != len(set(line_codes)):
        raise ValueError("Không thể lặp lại cùng một dòng nhập trong phiếu chuyển.")
    receipt_lines = GoodsReceiptLine.objects.select_related(
        "receipt", "product"
    ).in_bulk(line_codes, field_name="code")
    if len(receipt_lines) != len(line_codes):
        raise ValueError("Dòng nhập trong phiếu chuyển không tồn tại.")

    today = timezone.localdate()
    normalized = []
    total_quantity = 0
    for raw_line in lines:
        receipt_line = receipt_lines[raw_line["PNCT_Ma"]]
        quantity = raw_line["PXCN_SL"]
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
            raise ValueError("Số lượng chuyển phải là số nguyên lớn hơn 0.")
        if receipt_line.receipt.status != GoodsReceipt.Status.CONFIRMED:
            raise ValueError(
                f"Dòng nhập {receipt_line.code} không thuộc phiếu nhập đã xác nhận."
            )
        if receipt_line.product.status != Product.Status.ACTIVE:
            raise ValueError(f"Mặt hàng của dòng nhập {receipt_line.code} đã ngừng kinh doanh.")
        if receipt_line.expiry_date and receipt_line.expiry_date < today:
            raise ValueError(
                f"Dòng nhập {receipt_line.code} đã hết hạn, không thể chuyển để bán."
            )
        current = StockBalance.objects.filter(
            location=locations[source_location_code],
            receipt_line=receipt_line,
        ).values_list("quantity", flat=True).first() or 0
        if quantity > current:
            raise ValueError(
                f"Số lượng chuyển vượt tồn khả dụng tại địa điểm xuất "
                f"(còn {current})."
            )
        total_quantity += quantity
        if total_quantity > MAX_SAFE_INTEGER:
            raise ValueError("Tổng số lượng chuyển vượt giới hạn số chính xác.")
        normalized.append((receipt_line, quantity))

    transfer = StockTransfer.objects.create(
        source_location=locations[source_location_code],
        destination_location=locations[destination_location_code],
        employee=employee,
        transfer_date=transfer_date,
        total_quantity=total_quantity,
        receiver_name=receiver_name.strip(),
        status=StockTransfer.Status.WAITING_DISPATCH,
    )
    StockTransferLine.objects.bulk_create(
        [
            StockTransferLine(
                transfer=transfer,
                receipt_line=receipt_line,
                quantity=quantity,
            )
            for receipt_line, quantity in normalized
        ]
    )
    return get_stock_transfer(transfer.code)


@_serialize_sqlite_mutations
@transaction.atomic
def dispatch_stock_transfer(transfer_code, *, dispatched_by):
    _acquire_write_lock()
    employee = _employee_for_user(dispatched_by)
    try:
        transfer = _stock_transfer_queryset().get(code=transfer_code)
    except StockTransfer.DoesNotExist as error:
        raise StockTransfer.DoesNotExist(transfer_code) from error
    if transfer.status != StockTransfer.Status.WAITING_DISPATCH:
        raise ValueError("Phiếu chuyển không ở trạng thái Chờ xuất.")
    lines = list(transfer.lines.select_related("receipt_line__receipt", "receipt_line__product"))
    if not lines:
        raise ValueError("Phiếu chuyển không có chi tiết để xuất.")
    today = timezone.localdate()
    for line in lines:
        receipt_line = line.receipt_line
        if (
            receipt_line.receipt.status != GoodsReceipt.Status.CONFIRMED
            or receipt_line.product.status != Product.Status.ACTIVE
            or (receipt_line.expiry_date and receipt_line.expiry_date < today)
        ):
            raise ValueError(
                f"Dòng nhập {receipt_line.code} không còn hợp lệ để xuất."
            )
        if StockMovement.objects.filter(
            location=transfer.source_location,
            receipt_line=receipt_line,
            source="PhieuXuatChuyenNoiBo",
            document_code=transfer.code,
            movement_type=StockMovement.Kind.TRANSFER_OUT,
        ).exists():
            raise ValueError(f"Dòng nhập {receipt_line.code} đã được xuất chuyển.")

    for line in lines:
        changed = StockBalance.objects.filter(
            location=transfer.source_location,
            receipt_line=line.receipt_line,
            quantity__gte=line.quantity,
        ).update(
            quantity=F("quantity") - line.quantity,
            updated_at=timezone.now(),
        )
        if changed != 1:
            current = StockBalance.objects.filter(
                location=transfer.source_location,
                receipt_line=line.receipt_line,
            ).values_list("quantity", flat=True).first() or 0
            raise ValueError(
                f"Tồn khả dụng tại địa điểm xuất không đủ cho dòng "
                f"{line.receipt_line.code} (còn {current})."
            )
        StockMovement.objects.create(
            location=transfer.source_location,
            receipt_line=line.receipt_line,
            employee=employee,
            movement_type=StockMovement.Kind.TRANSFER_OUT,
            quantity_delta=-line.quantity,
            source="PhieuXuatChuyenNoiBo",
            document_code=transfer.code,
        )

    changed = StockTransfer.objects.filter(
        pk=transfer.pk, status=StockTransfer.Status.WAITING_DISPATCH
    ).update(
        status=StockTransfer.Status.IN_TRANSIT,
        dispatched_by=employee,
        dispatched_at=timezone.now(),
        updated_at=timezone.now(),
    )
    if changed != 1:
        raise ValueError("Phiếu chuyển đã được xử lý bởi một thao tác khác.")
    return get_stock_transfer(transfer.code)


@_serialize_sqlite_mutations
@transaction.atomic
def receive_stock_transfer(
    transfer_code,
    *,
    received_by,
    lines,
    receiver_name="",
):
    _acquire_write_lock()
    employee = _employee_for_user(received_by)
    try:
        transfer = _stock_transfer_queryset().get(code=transfer_code)
    except StockTransfer.DoesNotExist as error:
        raise StockTransfer.DoesNotExist(transfer_code) from error
    if transfer.status != StockTransfer.Status.IN_TRANSIT:
        raise ValueError("Chỉ xác nhận nhận hàng khi phiếu đang ở trạng thái Đang chuyển.")
    transfer_lines = list(
        transfer.lines.select_related("receipt_line__product", "receipt_line__receipt")
    )
    if not transfer_lines:
        raise ValueError("Phiếu chuyển không có chi tiết để nhận.")
    received_by_lot = {}
    for raw_line in lines:
        lot_code = raw_line["PNCT_Ma"]
        if lot_code in received_by_lot:
            raise ValueError(f"Dòng nhập {lot_code} bị lặp trong thông tin thực nhận.")
        received_by_lot[lot_code] = raw_line["PXCN_SLThucNhan"]
    expected_codes = {line.receipt_line.code for line in transfer_lines}
    if set(received_by_lot) != expected_codes:
        raise ValueError("Cần khai báo đúng một số lượng thực nhận cho từng dòng chuyển.")

    for line in transfer_lines:
        received_quantity = received_by_lot[line.receipt_line.code]
        if (
            not isinstance(received_quantity, int)
            or isinstance(received_quantity, bool)
            or received_quantity < 0
            or received_quantity > line.quantity
        ):
            raise ValueError(
                "Số lượng thực nhận phải là số nguyên từ 0 đến số lượng đã xuất."
            )
        if StockMovement.objects.filter(
            location=transfer.destination_location,
            receipt_line=line.receipt_line,
            source="PhieuXuatChuyenNoiBo",
            document_code=transfer.code,
            movement_type=StockMovement.Kind.TRANSFER_IN,
        ).exists():
            raise ValueError(f"Dòng nhập {line.receipt_line.code} đã được nhận.")

    for line in transfer_lines:
        received_quantity = received_by_lot[line.receipt_line.code]
        line.received_quantity = received_quantity
        line.save(update_fields=("received_quantity",))
        if not received_quantity:
            continue
        balance, _ = StockBalance.objects.get_or_create(
            location=transfer.destination_location,
            receipt_line=line.receipt_line,
            defaults={"quantity": 0},
        )
        changed = StockBalance.objects.filter(
            pk=balance.pk,
            quantity__lte=MAX_SAFE_INTEGER - received_quantity,
        ).update(
            quantity=F("quantity") + received_quantity,
            updated_at=timezone.now(),
        )
        if changed != 1:
            raise ValueError(
                f"Tồn lô {line.receipt_line.code} tại địa điểm nhận "
                "vượt giới hạn số chính xác."
            )
        note = (
            ""
            if received_quantity == line.quantity
            else f"Chênh lệch {line.quantity - received_quantity} đơn vị, chờ đối chiếu"
        )
        StockMovement.objects.create(
            location=transfer.destination_location,
            receipt_line=line.receipt_line,
            employee=employee,
            movement_type=StockMovement.Kind.TRANSFER_IN,
            quantity_delta=received_quantity,
            source="PhieuXuatChuyenNoiBo",
            document_code=transfer.code,
            note=note,
        )

    final_status = (
        StockTransfer.Status.COMPLETE
        if all(line.received_quantity == line.quantity for line in transfer_lines)
        else StockTransfer.Status.DISCREPANCY
    )
    changed = StockTransfer.objects.filter(
        pk=transfer.pk, status=StockTransfer.Status.IN_TRANSIT
    ).update(
        status=final_status,
        received_by=employee,
        receiver_name=receiver_name.strip() or transfer.receiver_name,
        received_at=timezone.now(),
        updated_at=timezone.now(),
    )
    if changed != 1:
        raise ValueError("Phiếu chuyển đã được xử lý bởi một thao tác khác.")
    return get_stock_transfer(transfer.code)


@_serialize_sqlite_mutations
@transaction.atomic
def save_goods_receipt(
    *,
    user,
    supplier_code,
    location_code,
    received_on,
    lines,
    purchase_order_code="",
    receipt_code="",
    employee_code="",
):
    _acquire_write_lock()
    employee = _employee_for_user(user)
    _validate_employee_code(employee, employee_code)
    existing = None
    if receipt_code:
        try:
            existing = GoodsReceipt.objects.select_related(
                "purchase_order", "supplier", "location"
            ).get(code=receipt_code)
        except GoodsReceipt.DoesNotExist as error:
            raise GoodsReceipt.DoesNotExist(receipt_code) from error
        if existing.status != GoodsReceipt.Status.DRAFT:
            raise ValueError("Chỉ được chỉnh sửa phiếu nhập ở trạng thái Nháp.")

    old_order_code = existing.purchase_order.code if existing and existing.purchase_order_id else ""
    if existing:
        supplier_code = supplier_code or existing.supplier.code
        location_code = location_code or existing.location.code
        received_on = received_on or existing.received_on
        if purchase_order_code is None:
            purchase_order_code = old_order_code
        if lines is None:
            lines = [
                {
                    "HH_Ma": line.product.code,
                    "PNCT_SL": line.quantity,
                    "PNCT_DonGia": line.unit_price,
                    "PNCT_NSX": line.production_date,
                    "PNCT_HSD": line.expiry_date,
                    "PNCT_HSDToiThieu": line.minimum_expiry_days,
                }
                for line in _receipt_lines(existing)
            ]
    order_code = purchase_order_code or ""
    for code in sorted({value for value in (old_order_code, order_code) if value}):
        PurchaseOrder.objects.filter(code=code).update(updated_at=timezone.now())

    supplier = _load_supplier(supplier_code)
    location = _load_location(location_code)
    normalized, total_quantity, total_amount = _normalized_lines(lines)
    order = None
    if order_code:
        order = _lock_order(order_code)
        if order.supplier_id != supplier.pk:
            raise ValueError("Nhà cung cấp của phiếu nhập phải trùng với đơn đặt hàng.")
        _check_order_allocation(
            order, normalized, exclude_receipt_code=receipt_code
        )

    receipt = existing or GoodsReceipt(
        supplier=supplier,
        location=location,
        employee=employee,
        received_on=received_on,
    )
    receipt.purchase_order = order
    receipt.supplier = supplier
    receipt.location = location
    receipt.employee = employee
    receipt.received_on = received_on
    receipt.total_quantity = total_quantity
    receipt.total_amount = total_amount
    receipt.status = GoodsReceipt.Status.DRAFT
    receipt.save()
    _save_lines(receipt, normalized)
    return receipt


@_serialize_sqlite_mutations
@transaction.atomic
def submit_goods_receipt(receipt_code):
    _acquire_write_lock()
    try:
        receipt = GoodsReceipt.objects.select_related(
            "purchase_order"
        ).get(code=receipt_code)
    except GoodsReceipt.DoesNotExist as error:
        raise GoodsReceipt.DoesNotExist(receipt_code) from error
    if receipt.status != GoodsReceipt.Status.DRAFT:
        raise ValueError("Chỉ gửi phiếu nhập ở trạng thái Nháp.")
    lines = _receipt_lines(receipt)
    if not lines:
        raise ValueError("Phiếu nhập chưa có hàng hóa.")
    if receipt.purchase_order_id:
        order = _lock_order(receipt.purchase_order.code)
        _check_order_allocation(
            order,
            [
                {"product": line.product, "quantity": line.quantity}
                for line in lines
            ],
            exclude_receipt_code=receipt.code,
        )
    changed = GoodsReceipt.objects.filter(
        pk=receipt.pk, status=GoodsReceipt.Status.DRAFT
    ).update(
        status=GoodsReceipt.Status.WAITING_ACCOUNTING,
        updated_at=timezone.now(),
    )
    if changed != 1:
        raise ValueError("Phiếu nhập đã được xử lý bởi một thao tác khác.")
    receipt.status = GoodsReceipt.Status.WAITING_ACCOUNTING
    return receipt


@_serialize_sqlite_mutations
@transaction.atomic
def cancel_goods_receipt(receipt_code):
    _acquire_write_lock()
    try:
        receipt = GoodsReceipt.objects.select_related(
            "purchase_order"
        ).get(code=receipt_code)
    except GoodsReceipt.DoesNotExist as error:
        raise GoodsReceipt.DoesNotExist(receipt_code) from error
    if receipt.status != GoodsReceipt.Status.DRAFT:
        raise ValueError("Chỉ được hủy phiếu nhập nháp chưa ghi nhận tồn.")
    if receipt.purchase_order_id:
        PurchaseOrder.objects.filter(code=receipt.purchase_order.code).update(
            updated_at=timezone.now()
        )
    changed = GoodsReceipt.objects.filter(
        pk=receipt.pk, status=GoodsReceipt.Status.DRAFT
    ).update(status=GoodsReceipt.Status.CANCELLED, updated_at=timezone.now())
    if changed != 1:
        raise ValueError("Phiếu nhập đã được xử lý bởi một thao tác khác.")
    receipt.status = GoodsReceipt.Status.CANCELLED
    if receipt.purchase_order_id:
        _sync_order(receipt.purchase_order.code)
    return receipt


def _stock_count_queryset():
    return StockCount.objects.select_related(
        "location", "employee", "approved_by"
    ).prefetch_related(
        "lines__receipt_line__product",
        "lines__receipt_line__receipt",
    )


def get_stock_count(count_code):
    return _stock_count_queryset().get(code=count_code)


def _assert_stock_count_snapshot_current(count):
    for line in count.lines.all():
        if line.receipt_line.receipt.status != GoodsReceipt.Status.CONFIRMED:
            raise ValueError(
                f"Lô {line.receipt_line.code} không thuộc phiếu nhập đã xác nhận."
            )
        current = StockBalance.objects.filter(
            location=count.location, receipt_line=line.receipt_line
        ).values_list("quantity", flat=True).first()
        current = current or 0
        if current != line.book_quantity:
            raise ValueError(
                f"Tồn {line.receipt_line.code} đã thay đổi "
                f"({line.book_quantity} → {current}). Hãy lập phiếu kiểm kê mới."
            )
        later_movements = StockMovement.objects.filter(
            location=count.location, receipt_line=line.receipt_line
        ).values_list("occurred_at", flat=True)
        if any(
            occurred_at > count.created_at
            or timezone.localtime(occurred_at).date() > count.count_date
            for occurred_at in later_movements
        ):
            raise ValueError(
                f"Dòng {line.receipt_line.code} có biến động kho sau thời điểm "
                "kiểm kê. Hãy kiểm tra lại và lập phiếu mới."
            )


@_serialize_sqlite_mutations
@transaction.atomic
def create_stock_count(
    *,
    user,
    location_code,
    count_date,
    note="",
    lines,
    employee_code="",
):
    _acquire_write_lock()
    employee = _employee_for_user(user)
    _validate_employee_code(employee, employee_code)
    try:
        location = StorageLocation.objects.get(code=location_code)
    except StorageLocation.DoesNotExist as error:
        raise ValueError("Địa điểm kiểm kê không tồn tại.") from error
    if not lines:
        raise ValueError("Phiếu kiểm kê cần ít nhất một dòng hàng.")

    line_codes = [line["PNCT_Ma"] for line in lines]
    if len(line_codes) != len(set(line_codes)):
        raise ValueError("Một lô không được xuất hiện trùng trong phiếu kiểm kê.")
    receipt_lines = GoodsReceiptLine.objects.select_related(
        "receipt", "product"
    ).in_bulk(line_codes, field_name="code")
    if len(receipt_lines) != len(line_codes):
        raise ValueError("Mã dòng nhập trong phiếu kiểm kê không tồn tại.")

    count = StockCount.objects.create(
        location=location,
        employee=employee,
        count_date=count_date,
        note=note,
        status=StockCount.Status.DRAFT,
    )
    for raw_line in lines:
        receipt_line = receipt_lines[raw_line["PNCT_Ma"]]
        if receipt_line.receipt.status != GoodsReceipt.Status.CONFIRMED:
            raise ValueError(
                f"Chỉ kiểm kê được lô đã nhập kho xác nhận ({receipt_line.code})."
            )
        book_quantity = raw_line["PKKCT_SLSoSach"]
        actual_quantity = raw_line["PKKCT_SLThucTe"]
        if actual_quantity < 0:
            raise ValueError("Số lượng thực tế phải là số nguyên không âm.")
        if max(book_quantity, actual_quantity) > MAX_SAFE_INTEGER:
            raise ValueError("Số lượng kiểm kê vượt giới hạn số chính xác.")
        current = StockBalance.objects.filter(
            location=location, receipt_line=receipt_line
        ).values_list("quantity", flat=True).first()
        current = current or 0
        if book_quantity != current:
            raise ValueError(
                f"Tồn {receipt_line.code} đã thay đổi "
                f"({book_quantity} → {current}). Hãy tải lại và lập phiếu mới."
            )
        StockCountLine.objects.create(
            count=count,
            receipt_line=receipt_line,
            book_quantity=book_quantity,
            actual_quantity=actual_quantity,
            difference=actual_quantity - book_quantity,
            reason=raw_line.get("PKKCT_LyDo", ""),
        )
    return get_stock_count(count.code)


@_serialize_sqlite_mutations
@transaction.atomic
def submit_stock_count(count_code):
    _acquire_write_lock()
    try:
        count = _stock_count_queryset().get(code=count_code)
    except StockCount.DoesNotExist as error:
        raise StockCount.DoesNotExist(count_code) from error
    if count.status != StockCount.Status.DRAFT:
        raise ValueError("Chỉ gửi duyệt được phiếu kiểm kê ở trạng thái Nháp.")
    if not count.lines.exists():
        raise ValueError("Phiếu kiểm kê không có chi tiết.")
    _assert_stock_count_snapshot_current(count)
    changed = StockCount.objects.filter(
        pk=count.pk, status=StockCount.Status.DRAFT
    ).update(
        status=StockCount.Status.WAITING_APPROVAL,
        updated_at=timezone.now(),
    )
    if changed != 1:
        raise ValueError("Phiếu kiểm kê đã được xử lý bởi một thao tác khác.")
    return get_stock_count(count.code)


@_serialize_sqlite_mutations
@transaction.atomic
def approve_stock_count(count_code, *, approved_by):
    _acquire_write_lock()
    approver = _employee_for_user(approved_by)
    try:
        count = _stock_count_queryset().get(code=count_code)
    except StockCount.DoesNotExist as error:
        raise StockCount.DoesNotExist(count_code) from error
    if count.status != StockCount.Status.WAITING_APPROVAL:
        raise ValueError("Phiếu không chờ duyệt hoặc đã được duyệt.")
    lines = list(count.lines.select_related("receipt_line__receipt"))
    if not lines:
        raise ValueError("Phiếu kiểm kê không có chi tiết.")
    _assert_stock_count_snapshot_current(count)

    for line in lines:
        if not line.difference:
            continue
        if StockMovement.objects.filter(
            location=count.location,
            receipt_line=line.receipt_line,
            source="PhieuKiemKeKho",
            document_code=count.code,
        ).exists():
            raise ValueError(f"Dòng {line.receipt_line.code} đã được điều chỉnh.")
        balance = StockBalance.objects.filter(
            location=count.location, receipt_line=line.receipt_line
        ).first()
        if balance:
            changed = StockBalance.objects.filter(
                pk=balance.pk, quantity=line.book_quantity
            ).update(
                quantity=line.actual_quantity,
                updated_at=timezone.now(),
            )
            if changed != 1:
                raise ValueError(
                    f"Tồn {line.receipt_line.code} vừa thay đổi. "
                    "Hãy kiểm kê lại trước khi duyệt."
                )
        elif line.book_quantity == 0 and line.actual_quantity > 0:
            StockBalance.objects.create(
                location=count.location,
                receipt_line=line.receipt_line,
                quantity=line.actual_quantity,
            )
        elif line.actual_quantity:
            raise ValueError(
                f"Không thể điều chỉnh tồn lô {line.receipt_line.code}."
            )
        StockMovement.objects.create(
            location=count.location,
            receipt_line=line.receipt_line,
            employee=approver,
            movement_type=StockMovement.Kind.COUNT_ADJUSTMENT,
            quantity_delta=line.difference,
            source="PhieuKiemKeKho",
            document_code=count.code,
            note=line.reason,
        )

    changed = StockCount.objects.filter(
        pk=count.pk, status=StockCount.Status.WAITING_APPROVAL
    ).update(
        status=StockCount.Status.APPROVED,
        approved_by=approver,
        approved_at=timezone.now(),
        updated_at=timezone.now(),
    )
    if changed != 1:
        raise ValueError("Phiếu kiểm kê đã được xử lý bởi một thao tác khác.")
    return get_stock_count(count.code)


@_serialize_sqlite_mutations
@transaction.atomic
def confirm_goods_receipt(receipt_code, *, confirmed_by):
    _acquire_write_lock()
    approver = _employee_for_user(confirmed_by)
    try:
        receipt = GoodsReceipt.objects.select_related(
            "purchase_order", "location", "employee"
        ).get(code=receipt_code)
    except GoodsReceipt.DoesNotExist as error:
        raise GoodsReceipt.DoesNotExist(receipt_code) from error
    if receipt.status != GoodsReceipt.Status.WAITING_ACCOUNTING:
        raise ValueError(
            "Phiếu nhập chưa được gửi kế toán xác nhận hoặc đã được xử lý."
        )
    lines = _receipt_lines(receipt)
    if not lines:
        raise ValueError("Phiếu nhập chưa có hàng hóa.")
    order = None
    if receipt.purchase_order_id:
        order = _lock_order(receipt.purchase_order.code)
        _check_order_allocation(order, [], exclude_receipt_code="")
        receipts = _receipt_payloads(order.code)
        summary = get_order_receiving_summary(order, receipts)
        calculated = get_receipt_progress(order, receipts)
        if summary["status"] != calculated["status"]:
            raise RuntimeError("Purchasing returned inconsistent receiving progress.")

    changed = GoodsReceipt.objects.filter(
        pk=receipt.pk, status=GoodsReceipt.Status.WAITING_ACCOUNTING
    ).update(
        status=GoodsReceipt.Status.CONFIRMED,
        confirmed_by=approver,
        updated_at=timezone.now(),
    )
    if changed != 1:
        raise ValueError("Phiếu nhập đã được xử lý bởi một thao tác khác.")
    receipt.status = GoodsReceipt.Status.CONFIRMED
    receipt.confirmed_by = approver

    for line in lines:
        if StockMovement.objects.filter(
            receipt_line=line, movement_type=StockMovement.Kind.INBOUND
        ).exists():
            raise ValueError(f"Dòng nhập {line.code} đã được ghi nhận tồn.")
        balance, _ = StockBalance.objects.get_or_create(
            location=receipt.location,
            receipt_line=line,
            defaults={"quantity": 0},
        )
        if balance.quantity + line.quantity > MAX_SAFE_INTEGER:
            raise ValueError(f"Tồn kho dòng {line.code} vượt giới hạn số chính xác.")
        StockBalance.objects.filter(pk=balance.pk).update(
            quantity=F("quantity") + line.quantity,
            updated_at=timezone.now(),
        )
        StockMovement.objects.create(
            location=receipt.location,
            receipt_line=line,
            employee=receipt.employee,
            movement_type=StockMovement.Kind.INBOUND,
            quantity_delta=line.quantity,
            source="PhieuNhap",
            document_code=receipt.code,
        )

    if order:
        _sync_order(order.code)
    return receipt


def get_receipt(receipt_code):
    return GoodsReceipt.objects.select_related(
        "purchase_order", "supplier", "location", "employee", "confirmed_by"
    ).prefetch_related("lines__product").get(code=receipt_code)


def get_order_progress(order_code):
    order = get_order(order_code)
    receipts = _receipt_payloads(order.code)
    if order.status in (PurchaseOrder.Status.WAITING, PurchaseOrder.Status.PARTIAL):
        _check_order_allocation(order, [])
    progress = get_receipt_progress(order, receipts)
    return {
        "DH_Ma": order.code,
        "DH_TrangThai": progress["status"],
        "lines": progress["lines"],
        "total_received": progress["received_quantity"],
    }


def get_stock_for_sale(product_code, location_code, *, on_date=None):
    """Return read-only, FEFO-ordered lots currently eligible for sale."""
    on_date = on_date or timezone.localdate()
    product = Product.objects.get(code=product_code)
    if product.status != Product.Status.ACTIVE:
        return []
    balances = (
        StockBalance.objects.filter(
            quantity__gt=0,
            location__code=location_code,
            receipt_line__product=product,
            receipt_line__receipt__status=GoodsReceipt.Status.CONFIRMED,
        )
        .filter(
            Q(receipt_line__expiry_date__isnull=True)
            | Q(receipt_line__expiry_date__gte=on_date)
        )
        .select_related(
            "location",
            "receipt_line__product",
            "receipt_line__receipt",
        )
        .order_by(
            _expiry_ordering(),
            "receipt_line__code",
        )
    )
    return [
        {
            "PNCT_Ma": balance.receipt_line.code,
            "HH_Ma": product.code,
            "HH_Ten": product.name,
            "PN_Ma": balance.receipt_line.receipt.code,
            "DD_Ma": balance.location.code,
            "HSD": balance.receipt_line.expiry_date,
            "quantity": balance.quantity,
            "base_unit": product.base_unit,
            "package_unit": product.package_unit,
            "package_ratio": product.package_ratio,
        }
        for balance in balances
    ]


def get_available_stock(product_code, location_code, *, on_date=None):
    """Return sellable quantity; this is not a reservation or stock hold."""
    return sum(
        lot["quantity"]
        for lot in get_stock_for_sale(
            product_code, location_code, on_date=on_date
        )
    )


def _expiry_ordering():
    from django.db.models import F

    return F("receipt_line__expiry_date").asc(nulls_last=True)


def _stock_balances(*, product_code="", location_code="", confirmed_only=True):
    rows = StockBalance.objects.select_related(
        "location",
        "receipt_line__product",
        "receipt_line__product__category",
        "receipt_line__receipt",
    )
    if confirmed_only:
        rows = rows.filter(
            receipt_line__receipt__status=GoodsReceipt.Status.CONFIRMED
        )
    if product_code:
        rows = rows.filter(receipt_line__product__code=product_code)
    if location_code:
        rows = rows.filter(location__code=location_code)
    return rows.order_by(
        "location__code",
        "receipt_line__product__code",
        _expiry_ordering(),
        "receipt_line__code",
    )


def _days_to_expiry(line, on_date):
    return (line.expiry_date - on_date).days if line.expiry_date else None


def _expiry_status(line, on_date):
    days = _days_to_expiry(line, on_date)
    if days is None:
        return "Không áp dụng HSD", None, None
    threshold = (
        line.minimum_expiry_days
        if line.minimum_expiry_days is not None
        else DEFAULT_EXPIRY_WARNING_DAYS
    )
    if days < 0:
        return "Đã hết hạn", days, threshold
    if days <= threshold:
        return "Sắp hết hạn", days, threshold
    return "Còn hạn", days, threshold


def get_stock_lot_rows(*, product_code="", location_code="", search=""):
    today = timezone.localdate()
    rows = []
    for balance in _stock_balances(
        product_code=product_code, location_code=location_code
    ):
        if balance.quantity <= 0:
            continue
        line = balance.receipt_line
        product = line.product
        status_value, days, threshold = _expiry_status(line, today)
        available = 0
        if (
            product.status == Product.Status.ACTIVE
            and status_value != "Đã hết hạn"
        ):
            available = balance.quantity
        row = {
            "DD_Ma": balance.location.code,
            "DD_Ten": balance.location.name,
            "DD_Loai": balance.location.kind,
            "PN_Ma": line.receipt.code,
            "PN_Ngay": line.receipt.received_on,
            "PNCT_Ma": line.code,
            "HH_Ma": product.code,
            "HH_MaVach": product.barcode or "",
            "HH_Ten": product.name,
            "DM_Ma": product.category.code,
            "DM_Ten": product.category.name,
            "HH_DVi": product.base_unit,
            "HH_DViDongGoi": product.package_unit,
            "HH_TyLeQuyDoi": product.package_ratio,
            "HH_TrangThai": product.status,
            "PNCT_NSX": line.production_date,
            "PNCT_HSD": line.expiry_date,
            "PNCT_HSDToiThieu": line.minimum_expiry_days,
            "HSD_SoNgayConLai": days,
            "HSD_NguongCanhBao": threshold,
            "HSD_TrangThai": status_value,
            "TK_SL": balance.quantity,
            "TK_SLThucTe": balance.quantity,
            "TK_SLCoTheBan": available,
            "TK_SLKhongKhaDung": balance.quantity - available,
            "TK_TrangThai": (
                "Sắp hết"
                if balance.quantity <= LOW_STOCK_THRESHOLD
                else "Đang có tồn"
            ),
        }
        search_text = " ".join(
            str(row[key] or "")
            for key in (
                "DD_Ma",
                "DD_Ten",
                "PN_Ma",
                "PNCT_Ma",
                "HH_Ma",
                "HH_MaVach",
                "HH_Ten",
                "DM_Ten",
            )
        ).casefold()
        if search and search.casefold() not in search_text:
            continue
        rows.append(row)
    return rows


def get_stock_summary_rows(*, product_code="", location_code="", category_code="", search=""):
    lots = get_stock_lot_rows(
        product_code=product_code,
        location_code=location_code,
        search=search,
    )
    grouped = {}
    for lot in lots:
        if category_code and lot["DM_Ma"] != category_code:
            continue
        key = (lot["DD_Ma"], lot["HH_Ma"])
        row = grouped.get(key)
        if row is None:
            row = {
                key_name: lot[key_name]
                for key_name in (
                    "DD_Ma", "DD_Ten", "DD_Loai", "HH_Ma", "HH_MaVach",
                    "HH_Ten", "DM_Ma", "DM_Ten", "HH_DVi",
                    "HH_DViDongGoi", "HH_TyLeQuyDoi", "HH_TrangThai",
                )
            }
            row.update(
                {
                    "TK_SLThucTe": 0,
                    "TK_SLCoTheBan": 0,
                    "TK_SLHetHan": 0,
                    "TK_SLKhongKhaDung": 0,
                    "TK_SoLo": 0,
                    "TK_TrangThai": "Đang có tồn",
                }
            )
            grouped[key] = row
        row["TK_SLThucTe"] += lot["TK_SLThucTe"]
        row["TK_SLCoTheBan"] += lot["TK_SLCoTheBan"]
        row["TK_SLKhongKhaDung"] += lot["TK_SLKhongKhaDung"]
        row["TK_SoLo"] += 1
        if lot["HSD_TrangThai"] == "Đã hết hạn":
            row["TK_SLHetHan"] += lot["TK_SL"]
    for row in grouped.values():
        row["TK_SL"] = row["TK_SLThucTe"]
        row["TK_TrangThai"] = (
            "Sắp hết"
            if row["TK_SLThucTe"] <= LOW_STOCK_THRESHOLD
            else "Đang có tồn"
        )
    return sorted(
        grouped.values(), key=lambda row: (row["DD_Ma"], row["HH_Ma"])
    )


def get_expiry_rows(*, product_code="", location_code="", expiry_status="", search=""):
    rows = get_stock_lot_rows(
        product_code=product_code,
        location_code=location_code,
        search=search,
    )
    return [
        row
        for row in rows
        if not expiry_status or row["HSD_TrangThai"] == expiry_status
    ]


def get_inventory_overview(*, location_code=""):
    today = timezone.localdate()
    lots = get_stock_lot_rows(location_code=location_code)
    quantities_by_product = defaultdict(int)
    available_by_product = defaultdict(int)
    for lot in lots:
        quantities_by_product[lot["HH_Ma"]] += lot["TK_SLThucTe"]
        available_by_product[lot["HH_Ma"]] += lot["TK_SLCoTheBan"]
    soon_expiring = [
        lot for lot in lots
        if lot["HSD_SoNgayConLai"] is not None
        and 0 <= lot["HSD_SoNgayConLai"] <= lot["HSD_NguongCanhBao"]
    ]
    expired = [lot for lot in lots if lot["HSD_TrangThai"] == "Đã hết hạn"]
    metrics = {
        "HH_SoMatHangCoTon": len(quantities_by_product),
        "TK_TongSoLuongThucTe": sum(quantities_by_product.values()),
        "HH_SoMatHangDuoiNguong": sum(
            0 < quantity <= LOW_STOCK_THRESHOLD
            for quantity in available_by_product.values()
        ),
        "TK_SoLoSapHetHan": len(soon_expiring),
        "TK_SoLoDaHetHan": len(expired),
        "PN_SoPhieuChoXuLy": GoodsReceipt.objects.filter(
            status=GoodsReceipt.Status.DRAFT
        ).count(),
    }
    location_filter = {"location__code": location_code} if location_code else {}
    recent_movements = list(
        StockMovement.objects.filter(**location_filter)
        .select_related("location", "receipt_line__product", "employee")
        .order_by("-occurred_at", "-id")[:6]
    )
    return {
        "as_of": today,
        "DD_Ma": location_code or None,
        "thresholds": {
            "low_stock_quantity": LOW_STOCK_THRESHOLD,
            "default_expiry_warning_days": DEFAULT_EXPIRY_WARNING_DAYS,
        },
        "metrics": metrics,
        "expiring_lots": soon_expiring[:5],
        "recent_movements": recent_movements,
    }


def get_stock_ledger(
    *, product_code, location_code, date_from, date_to, lot_code=""
):
    if date_from > date_to:
        raise ValueError("Ngày bắt đầu không được sau ngày kết thúc.")
    if not product_code or not location_code:
        raise ValueError("Cần chọn sản phẩm và địa điểm để xem thẻ kho.")
    try:
        product = Product.objects.select_related("category").get(code=product_code)
    except Product.DoesNotExist as error:
        raise ValueError("Sản phẩm không tồn tại.") from error
    try:
        location = StorageLocation.objects.get(code=location_code)
    except StorageLocation.DoesNotExist as error:
        raise ValueError("Địa điểm không tồn tại.") from error

    balances = list(
        StockBalance.objects.filter(
            location=location,
            receipt_line__product=product,
            receipt_line__receipt__status=GoodsReceipt.Status.CONFIRMED,
        )
        .select_related("receipt_line")
        .order_by("receipt_line__code")
    )
    if lot_code:
        balances = [row for row in balances if row.receipt_line.code == lot_code]
        if not balances and not GoodsReceiptLine.objects.filter(
            code=lot_code, product=product
        ).exists():
            raise ValueError("Dòng nhập không thuộc sản phẩm đã chọn.")

    confirmed_lines = list(
        GoodsReceiptLine.objects.filter(
            product=product,
            receipt__location=location,
            receipt__status=GoodsReceipt.Status.CONFIRMED,
        ).values_list("code", flat=True)
    )
    if lot_code:
        confirmed_lines = [code for code in confirmed_lines if code == lot_code]
    balance_by_lot = {
        row.receipt_line.code: row.quantity for row in balances
    }
    movements = list(
        StockMovement.objects.filter(
            location=location, receipt_line__product=product
        )
        .select_related("employee", "receipt_line__receipt")
        .order_by("occurred_at", "id")
    )
    if lot_code:
        movements = [row for row in movements if row.receipt_line.code == lot_code]
    movement_by_lot = defaultdict(int)
    for movement in movements:
        movement_by_lot[movement.receipt_line.code] += movement.quantity_delta

    line_ids = set(confirmed_lines) | set(balance_by_lot) | set(movement_by_lot)
    complete = all(
        balance_by_lot.get(code, 0) == movement_by_lot.get(code, 0)
        for code in line_ids
    ) and all(
        any(
            movement.receipt_line.code == code
            and movement.movement_type == StockMovement.Kind.INBOUND
            for movement in movements
        )
        for code in confirmed_lines
    )
    current = sum(balance_by_lot.values())
    opening = sum(
        movement.quantity_delta
        for movement in movements
        if timezone.localtime(movement.occurred_at).date() < date_from
    )
    period = [
        movement
        for movement in movements
        if date_from
        <= timezone.localtime(movement.occurred_at).date()
        <= date_to
    ]
    inbound = sum(movement.quantity_delta for movement in period if movement.quantity_delta > 0)
    outbound = sum(abs(movement.quantity_delta) for movement in period if movement.quantity_delta < 0)
    running = opening
    period_rows = []
    for movement in period:
        running += movement.quantity_delta
        period_rows.append(
            {
                "BDK_Ma": movement.code,
                "BDK_Ngay": timezone.localtime(movement.occurred_at),
                "BDK_Loai": movement.movement_type,
                "BDK_Nguon": movement.source,
                "BDK_MaChungTu": movement.document_code,
                "PNCT_Ma": movement.receipt_line.code,
                "HH_Ma": product.code,
                "HH_Ten": product.name,
                "HH_DVi": product.base_unit,
                "DD_Ma": location.code,
                "NV_Ma": movement.employee.code,
                "NV_Ten": movement.employee.full_name,
                "BDK_SoLuong": movement.quantity_delta,
                "BDK_SoDuSau": running,
                "BDK_GhiChu": movement.note,
            }
        )
    return {
        "complete": complete,
        "error": (
            ""
            if complete
            else "Không đủ dữ liệu để đối chiếu biến động với tồn hiện tại."
        ),
        "HH_Ma": product.code,
        "HH_Ten": product.name,
        "HH_DVi": product.base_unit,
        "DD_Ma": location.code,
        "DD_Ten": location.name,
        "PNCT_Ma": lot_code or None,
        "from": date_from,
        "to": date_to,
        "current": current,
        "opening": opening if complete else None,
        "inbound": inbound,
        "outbound": outbound,
        "closing": running if complete else None,
        "line_count": len(line_ids),
        "rows": period_rows,
    }


def get_stock_rows(*, product_code="", location_code=""):
    return _stock_balances(
        product_code=product_code, location_code=location_code
    ).filter(quantity__gt=0)
