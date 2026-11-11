from collections import defaultdict

from django.db import transaction
from django.db.models import Sum

from apps.accounts.models import Employee
from apps.catalog.models import Product
from apps.catalog.services import to_base_quantity, to_base_unit_price
from apps.partners.models import Partner

from .models import MAX_SAFE_INTEGER, PurchaseOrder, PurchaseOrderLine

RECEIPT_CONFIRMED = "Đã xác nhận"
RECEIPT_RESERVED_STATUSES = frozenset(("Nháp", "Chờ kế toán xác nhận"))
RECEIPT_CANCELLED = "Đã hủy"


def _receipt_status(receipt):
    return receipt.get("PN_TrangThai", receipt.get("status", ""))


def _receipt_lines(receipt):
    return receipt.get("lines", ())


def _line_product_code(line):
    return line.get("HH_Ma", line.get("product_code", ""))


def _line_quantity(line):
    return line.get("PNCT_SL", line.get("quantity", 0))


def get_receipt_progress(order, receipts=()):
    confirmed = defaultdict(int)
    reserved = defaultdict(int)
    order_quantities = {
        line.product.code: line.quantity for line in order.lines.select_related("product")
    }
    for receipt in receipts:
        receipt_status = _receipt_status(receipt)
        if receipt_status == RECEIPT_CANCELLED:
            continue
        if receipt_status not in RECEIPT_RESERVED_STATUSES | {RECEIPT_CONFIRMED}:
            continue
        target = confirmed if receipt_status == RECEIPT_CONFIRMED else reserved
        for line in _receipt_lines(receipt):
            product_code = _line_product_code(line)
            quantity = _line_quantity(line)
            if product_code not in order_quantities:
                raise ValueError(f"{product_code} không thuộc đơn {order.code}.")
            if isinstance(quantity, bool) or not isinstance(quantity, int) or quantity < 0:
                raise ValueError("Số lượng nhận phải là số nguyên không âm.")
            target[product_code] += quantity
            if target[product_code] > order_quantities[product_code]:
                raise ValueError(
                    f"Số lượng {product_code} vượt số lượng đã đặt."
                )

    lines = []
    for code, ordered in order_quantities.items():
        received = confirmed[code]
        pending = reserved[code]
        lines.append(
            {
                "HH_Ma": code,
                "ordered": ordered,
                "received": received,
                "pending": pending,
                "remaining": max(0, ordered - received),
                "available_to_receive": max(0, ordered - received - pending),
            }
        )

    received_total = sum(confirmed.values())
    if order.status in (PurchaseOrder.Status.DRAFT, PurchaseOrder.Status.CANCELLED):
        status = order.status
    elif lines and all(line["received"] >= line["ordered"] for line in lines):
        status = PurchaseOrder.Status.COMPLETE
    elif received_total:
        status = PurchaseOrder.Status.PARTIAL
    else:
        status = PurchaseOrder.Status.WAITING
    return {
        "status": status,
        "received_quantity": received_total,
        "lines": lines,
    }


def _receipt_dependencies(order):
    for relation in order._meta.related_objects:
        model = relation.related_model
        if model._meta.app_label == "purchasing":
            continue
        field_name = relation.field.name
        for receipt in model._base_manager.filter(
            **{f"{field_name}_id": order.pk}
        ):
            status_field = next(
                (
                    field
                    for field in ("PN_TrangThai", "status")
                    if hasattr(receipt, field)
                ),
                None,
            )
            yield receipt, getattr(receipt, status_field) if status_field else ""


def _validate_no_receipts(order):
    for _, status in _receipt_dependencies(order):
        if status != RECEIPT_CANCELLED:
            raise ValueError("Không thể sửa đơn đã phát sinh phiếu nhập.")


def _validate_can_cancel(order):
    if order.status not in (PurchaseOrder.Status.DRAFT, PurchaseOrder.Status.WAITING):
        raise ValueError("Đơn đặt hàng không ở trạng thái có thể hủy.")
    for _, status in _receipt_dependencies(order):
        if status == RECEIPT_CONFIRMED:
            raise ValueError("Không thể hủy đơn đã có phiếu nhập xác nhận.")
        if status != RECEIPT_CANCELLED:
            raise ValueError(
                "Hãy hủy hoặc xử lý các phiếu nhập đang chờ trước khi hủy đơn."
            )
    progress = get_receipt_progress(order)
    if progress["received_quantity"]:
        raise ValueError("Không thể hủy đơn đã có số lượng nhận xác nhận.")


def _normalize_lines(raw_lines):
    if not raw_lines:
        raise ValueError("Đơn đặt hàng cần ít nhất một sản phẩm.")
    normalized = []
    seen = set()
    for line in raw_lines:
        product_code = line["HH_Ma"]
        if product_code in seen:
            raise ValueError(
                "Mỗi mặt hàng chỉ được có một dòng trong đơn đặt hàng."
            )
        seen.add(product_code)
        try:
            product = Product.objects.select_for_update().get(code=product_code)
        except Product.DoesNotExist as error:
            raise ValueError("Mặt hàng không tồn tại.") from error
        if product.status != Product.Status.ACTIVE:
            raise ValueError("Chỉ chọn hàng hóa đang kinh doanh.")
        factor = line.get("DN_DonVi", 1)
        if factor != 1 and factor != product.package_ratio:
            raise ValueError("Đơn vị quy đổi không hợp lệ với mặt hàng.")
        quantity = to_base_quantity(line["DN_SL"], factor)
        unit_price = to_base_unit_price(line["DN_DonGia"], factor)
        amount = quantity * unit_price
        if amount > MAX_SAFE_INTEGER:
            raise ValueError(
                f"Thành tiền của {product.name} vượt giới hạn số chính xác."
            )
        normalized.append(
            {
                "product": product,
                "quantity": quantity,
                "unit_price": unit_price,
                "amount": amount,
            }
        )
    total_quantity = sum(line["quantity"] for line in normalized)
    total_amount = sum(line["amount"] for line in normalized)
    if total_quantity > MAX_SAFE_INTEGER or total_amount > MAX_SAFE_INTEGER:
        raise ValueError("Tổng số lượng hoặc tổng tiền vượt giới hạn chính xác.")
    return normalized, total_quantity, total_amount


def _active_supplier(code):
    try:
        supplier = Partner.objects.select_for_update().get(code=code)
    except Partner.DoesNotExist as error:
        raise ValueError("Chọn nhà cung cấp đang hoạt động.") from error
    if (
        supplier.role not in (Partner.Role.SUPPLIER, Partner.Role.BOTH)
        or supplier.status != Partner.Status.ACTIVE
    ):
        raise ValueError("Chọn nhà cung cấp đang hoạt động.")
    return supplier


def _active_employee(code):
    try:
        employee = Employee.objects.select_for_update().get(code=code)
    except Employee.DoesNotExist as error:
        raise ValueError("Nhân viên lập đơn không hợp lệ.") from error
    if not employee.is_active:
        raise ValueError("Nhân viên lập đơn không hợp lệ.")
    return employee


def _replace_lines(order, lines):
    order.lines.all().delete()
    PurchaseOrderLine.objects.bulk_create(
        [PurchaseOrderLine(order=order, **line) for line in lines]
    )


def _recalculate_totals(order):
    totals = order.lines.aggregate(quantity=Sum("quantity"), amount=Sum("amount"))
    quantity = totals["quantity"] or 0
    amount = totals["amount"] or 0
    if quantity > MAX_SAFE_INTEGER or amount > MAX_SAFE_INTEGER:
        raise ValueError("Tổng số lượng hoặc tổng tiền vượt giới hạn chính xác.")
    order.total_quantity = quantity
    order.total_amount = amount
    order.save(update_fields=("total_quantity", "total_amount", "updated_at"))


@transaction.atomic
def create_purchase_order(*, supplier_code, employee_code, ordered_on, lines):
    supplier = _active_supplier(supplier_code)
    employee = _active_employee(employee_code)
    normalized, _, _ = _normalize_lines(lines)
    order = PurchaseOrder.objects.create(
        supplier=supplier,
        employee=employee,
        ordered_on=ordered_on,
        status=PurchaseOrder.Status.DRAFT,
    )
    _replace_lines(order, normalized)
    _recalculate_totals(order)
    return order


@transaction.atomic
def update_purchase_order(
    order_code, *, supplier_code=None, employee_code=None, ordered_on=None, lines=None
):
    try:
        order = PurchaseOrder.objects.select_for_update().get(code=order_code)
    except PurchaseOrder.DoesNotExist as error:
        raise PurchaseOrder.DoesNotExist(order_code) from error
    if order.status != PurchaseOrder.Status.DRAFT:
        raise ValueError("Chỉ chỉnh sửa đơn đặt hàng ở trạng thái Nháp.")
    _validate_no_receipts(order)
    if supplier_code is not None:
        order.supplier = _active_supplier(supplier_code)
    if employee_code is not None:
        order.employee = _active_employee(employee_code)
    if ordered_on is not None:
        order.ordered_on = ordered_on
    if lines is not None:
        normalized, _, _ = _normalize_lines(lines)
        _replace_lines(order, normalized)
    order.save()
    _recalculate_totals(order)
    return order


@transaction.atomic
def confirm_purchase_order(order_code):
    try:
        order = PurchaseOrder.objects.select_for_update().get(code=order_code)
    except PurchaseOrder.DoesNotExist as error:
        raise PurchaseOrder.DoesNotExist(order_code) from error
    if order.status != PurchaseOrder.Status.DRAFT:
        raise ValueError("Chỉ xác nhận đơn đặt hàng ở trạng thái Nháp.")
    if not order.lines.exists():
        raise ValueError("Đơn đặt hàng chưa có sản phẩm.")
    changed = PurchaseOrder.objects.filter(
        pk=order.pk, status=PurchaseOrder.Status.DRAFT
    ).update(status=PurchaseOrder.Status.WAITING)
    if changed != 1:
        raise ValueError("Đơn đặt hàng đã được thay đổi bởi thao tác khác.")
    order.status = PurchaseOrder.Status.WAITING
    return order


@transaction.atomic
def cancel_purchase_order(order_code):
    try:
        order = PurchaseOrder.objects.select_for_update().get(code=order_code)
    except PurchaseOrder.DoesNotExist as error:
        raise PurchaseOrder.DoesNotExist(order_code) from error
    _validate_can_cancel(order)
    changed = PurchaseOrder.objects.filter(pk=order.pk).exclude(
        status__in=(PurchaseOrder.Status.COMPLETE, PurchaseOrder.Status.CANCELLED)
    ).update(status=PurchaseOrder.Status.CANCELLED)
    if changed != 1:
        raise ValueError("Đơn đặt hàng đã được thay đổi bởi thao tác khác.")
    order.status = PurchaseOrder.Status.CANCELLED
    return order


@transaction.atomic
def sync_receipt_progress(order_code, receipts):
    try:
        order = PurchaseOrder.objects.select_for_update().get(code=order_code)
    except PurchaseOrder.DoesNotExist as error:
        raise PurchaseOrder.DoesNotExist(order_code) from error
    progress = get_receipt_progress(order, receipts)
    if order.status not in (PurchaseOrder.Status.DRAFT, PurchaseOrder.Status.CANCELLED):
        order.status = progress["status"]
        order.save(update_fields=("status", "updated_at"))
    return progress


@transaction.atomic
def get_order_for_receiving(order_code):
    order = (
        PurchaseOrder.objects.select_for_update()
        .select_related("supplier", "employee")
        .prefetch_related("lines__product")
        .get(code=order_code)
    )
    if order.status not in (PurchaseOrder.Status.WAITING, PurchaseOrder.Status.PARTIAL):
        raise ValueError("Chỉ nhận hàng theo đơn đã xác nhận và chưa nhận đủ.")
    return order


def get_order_receiving_summary(order, receipts=()):
    if order.status not in (PurchaseOrder.Status.WAITING, PurchaseOrder.Status.PARTIAL):
        raise ValueError("Chỉ nhận hàng theo đơn đã xác nhận và chưa nhận đủ.")
    return get_receipt_progress(order, receipts)


def get_order(code):
    return PurchaseOrder.objects.select_related(
        "supplier", "employee"
    ).prefetch_related("lines__product").get(code=code)
