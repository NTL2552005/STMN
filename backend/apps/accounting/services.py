from datetime import datetime, time

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from apps.accounts.models import Employee
from apps.inventory.models import GoodsReceipt, SupplierReturn
from apps.partners.models import Partner
from apps.sales.models import SalePayment

from .models import (
    ExpenseVoucher,
    ReceiptVoucher,
    SupplierDebt,
    SupplierPayment,
    SupplierReturnAdjustment,
)


def _acquire_write_lock():
    from apps.sales.services import acquire_inventory_write_lock

    acquire_inventory_write_lock()


def _employee_for_user(user):
    try:
        employee = user.employee
    except (AttributeError, Employee.DoesNotExist) as error:
        raise ValueError("Tài khoản chưa được gán hồ sơ nhân viên.") from error
    if not employee.is_active:
        raise ValueError("Nhân viên không còn hoạt động.")
    return employee


def _date_time(value, field="Ngày"):
    if not value:
        return timezone.now()
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError) as error:
            try:
                parsed = datetime.combine(
                    datetime.strptime(str(value), "%Y-%m-%d").date(), time(12)
                )
            except (TypeError, ValueError):
                raise ValueError(f"{field} không hợp lệ.") from error
    if timezone.is_naive(parsed):
        return timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _amount(value, label="Số tiền", *, allow_zero=False):
    if isinstance(value, bool):
        raise ValueError(f"{label} phải là số nguyên VND hợp lệ.")
    try:
        amount = int(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError(f"{label} phải là số nguyên VND hợp lệ.") from error
    if str(value).strip() != str(amount) or amount < 0 or (not allow_zero and amount == 0):
        raise ValueError(
            f"{label} phải là số nguyên VND "
            f"{'không âm' if allow_zero else 'lớn hơn 0'}."
        )
    if amount > 9_007_199_254_740_991:
        raise ValueError(f"{label} vượt giới hạn cho phép.")
    return amount


@transaction.atomic
def record_supplier_debt_for_receipt(receipt_or_code):
    _acquire_write_lock()
    receipt = (
        receipt_or_code
        if isinstance(receipt_or_code, GoodsReceipt)
        else GoodsReceipt.objects.select_related("supplier").get(code=receipt_or_code)
    )
    if receipt.status != GoodsReceipt.Status.CONFIRMED:
        raise ValueError("Chỉ ghi nhận công nợ từ phiếu nhập đã xác nhận.")
    if receipt.total_amount <= 0:
        return None
    if receipt.supplier.role not in (Partner.Role.SUPPLIER, Partner.Role.BOTH):
        raise ValueError("Phiếu nhập không có nhà cung cấp hợp lệ.")
    debt, created = SupplierDebt.objects.get_or_create(
        receipt=receipt,
        defaults={"supplier": receipt.supplier, "amount": receipt.total_amount},
    )
    if not created and (
        debt.supplier_id != receipt.supplier_id or debt.amount != receipt.total_amount
    ):
        raise ValueError("Công nợ đã ghi nhận không khớp giá trị phiếu nhập.")
    return debt


@transaction.atomic
def record_supplier_return_adjustment(supplier_return_or_code):
    _acquire_write_lock()
    supplier_return = (
        supplier_return_or_code
        if isinstance(supplier_return_or_code, SupplierReturn)
        else SupplierReturn.objects.select_related("receipt", "supplier").get(
            code=supplier_return_or_code
        )
    )
    if supplier_return.status != SupplierReturn.Status.SHIPPED:
        raise ValueError("Chỉ ghi nhận giảm công nợ từ phiếu trả đã xuất.")
    debt = record_supplier_debt_for_receipt(supplier_return.receipt)
    if debt is None or supplier_return.total_amount <= 0:
        return None
    if debt.supplier_id != supplier_return.supplier_id:
        raise ValueError("Nhà cung cấp của phiếu trả không khớp công nợ phiếu nhập.")
    adjustment, created = SupplierReturnAdjustment.objects.get_or_create(
        supplier_return=supplier_return,
        defaults={"debt": debt, "amount": supplier_return.total_amount},
    )
    if not created and (
        adjustment.debt_id != debt.pk or adjustment.amount != supplier_return.total_amount
    ):
        raise ValueError("Giá trị điều chỉnh công nợ không khớp phiếu trả.")
    return adjustment


def _returned_amount(debt):
    return debt.return_adjustments.aggregate(total=Sum("amount"))["total"] or 0


def _paid_amount(debt, *, include_pending=False):
    statuses = [SupplierPayment.Status.SUCCESS]
    if include_pending:
        statuses.append(SupplierPayment.Status.PENDING)
    return debt.payments.filter(status__in=statuses).aggregate(total=Sum("amount"))["total"] or 0


def _available_payable(debt, *, include_pending=True):
    return max(
        0,
        debt.amount
        - _returned_amount(debt)
        - _paid_amount(debt, include_pending=include_pending),
    )


def create_supplier_payment(debt_code, values, user, idempotency_key=""):
    with transaction.atomic():
        _acquire_write_lock()
        debt = SupplierDebt.objects.select_for_update().select_related(
            "supplier", "receipt"
        ).filter(receipt__code=debt_code).first()
        if not debt:
            raise SupplierDebt.DoesNotExist(debt_code)
        key = str(idempotency_key or values.get("idempotency_key") or "").strip()
        if len(key) > 100:
            raise ValueError("Idempotency-Key vượt quá 100 ký tự.")
        if key:
            existing = SupplierPayment.objects.filter(idempotency_key=key).first()
            if existing:
                if (
                    existing.debt_id != debt.pk
                    or existing.amount != _amount(values.get("amount"))
                    or existing.method != values.get("method")
                ):
                    raise ValueError("Idempotency-Key đã được dùng cho yêu cầu khác.")
                return existing, False
        amount = _amount(values.get("amount"))
        method = str(values.get("method") or "")
        if method not in SupplierPayment.Method.values:
            raise ValueError("Phương thức thanh toán không hợp lệ.")
        available = _available_payable(debt)
        if amount > available:
            raise ValueError(
                f"Số tiền vượt số dư có thể thanh toán ({available} ₫), "
                "đã tính cả giao dịch đang chờ và hàng trả."
            )
        payment = SupplierPayment.objects.create(
            debt=debt,
            payment_date=_date_time(values.get("date"), "Ngày thanh toán"),
            amount=amount,
            method=method,
            status=(
                SupplierPayment.Status.SUCCESS
                if method == SupplierPayment.Method.CASH
                else SupplierPayment.Status.PENDING
            ),
            note=str(values.get("note") or "").strip()[:255],
            idempotency_key=key or None,
            created_by=_employee_for_user(user),
        )
        return payment, True


def update_supplier_payment(code, status):
    if status not in (SupplierPayment.Status.SUCCESS, SupplierPayment.Status.FAILED, SupplierPayment.Status.CANCELLED):
        raise ValueError("Trạng thái giao dịch không hợp lệ.")
    with transaction.atomic():
        _acquire_write_lock()
        payment = SupplierPayment.objects.select_for_update().select_related(
            "debt"
        ).filter(code=code).first()
        if not payment:
            raise SupplierPayment.DoesNotExist(code)
        if payment.status == status:
            return payment
        if payment.status != SupplierPayment.Status.PENDING:
            raise ValueError("Chỉ được cập nhật giao dịch đang chờ xác nhận.")
        if status == SupplierPayment.Status.SUCCESS:
            available_without_this = max(
                0,
                payment.debt.amount
                - _returned_amount(payment.debt)
                - _paid_amount(payment.debt, include_pending=True)
                + payment.amount,
            )
            if payment.amount > available_without_this:
                raise ValueError("Tổng thanh toán vượt công nợ còn lại sau khi tính hàng trả.")
        payment.status = status
        payment.save(update_fields=("status", "updated_at"))
        return payment


def create_supplier_expense_voucher(payment_code, user):
    with transaction.atomic():
        _acquire_write_lock()
        payment = SupplierPayment.objects.select_for_update().select_related(
            "debt__supplier"
        ).filter(code=payment_code).first()
        if not payment:
            raise SupplierPayment.DoesNotExist(payment_code)
        if payment.status != SupplierPayment.Status.SUCCESS:
            raise ValueError("Chỉ lập phiếu chi cho thanh toán NCC thành công.")
        if payment.method != SupplierPayment.Method.CASH:
            raise ValueError("Chỉ lập phiếu chi tiền mặt cho thanh toán NCC.")
        voucher, created = ExpenseVoucher.objects.get_or_create(
            supplier_payment=payment,
            defaults={
                "supplier": payment.debt.supplier,
                "employee": _employee_for_user(user),
                "voucher_date": payment.payment_date,
                "amount": payment.amount,
                "reason": f"Thanh toán NCC {payment.debt.receipt.code}",
                "method": payment.method,
                "status": ExpenseVoucher.Status.CONFIRMED,
                "note": payment.note,
            },
        )
        if not created and (
            voucher.amount != payment.amount
            or voucher.method != payment.method
            or voucher.status != ExpenseVoucher.Status.CONFIRMED
        ):
            raise ValueError("Phiếu chi liên kết không khớp giao dịch NCC.")
        return voucher, created


@transaction.atomic
def create_sales_receipt(payment, employee=None):
    _acquire_write_lock()
    if payment.status != SalePayment.Status.SUCCESS:
        raise ValueError("Chỉ tạo phiếu thu cho thanh toán bán hàng thành công.")
    invoice = payment.invoice
    if invoice.status != invoice.Status.CONFIRMED:
        raise ValueError("Hóa đơn của thanh toán chưa được xác nhận.")
    method = (
        ReceiptVoucher.Method.CASH
        if payment.method == SalePayment.Method.CASH
        else ReceiptVoucher.Method.BANK_TRANSFER
    )
    voucher, created = ReceiptVoucher.objects.get_or_create(
        sale_payment=payment,
        defaults={
            "customer": invoice.customer,
            "employee": employee or invoice.employee,
            "voucher_date": payment.payment_date,
            "amount": payment.amount,
            "reason": f"Thu tiền bán hàng - Hóa đơn {invoice.code}",
            "method": method,
            "status": ReceiptVoucher.Status.CONFIRMED,
            "note": f"Tự động tạo từ thanh toán {payment.code}.",
        },
    )
    if not created and (
        voucher.customer_id != invoice.customer_id
        or voucher.amount != payment.amount
        or voucher.method != method
        or voucher.status != ReceiptVoucher.Status.CONFIRMED
    ):
        raise ValueError(f"Phiếu thu {voucher.code} không khớp thanh toán {payment.code}.")
    return voucher, created


def save_manual_voucher(model, values, user, *, code=""):
    if model not in (ReceiptVoucher, ExpenseVoucher):
        raise ValueError("Loại phiếu kế toán không hợp lệ.")
    with transaction.atomic():
        _acquire_write_lock()
        employee = _employee_for_user(user)
        voucher = model.objects.select_for_update().filter(code=code).first() if code else None
        if code and not voucher:
            raise model.DoesNotExist(code)
        if voucher and (voucher.status != model.Status.DRAFT or getattr(voucher, "sale_payment_id", None) or getattr(voucher, "supplier_payment_id", None)):
            raise ValueError("Chỉ được sửa phiếu thủ công đang ở trạng thái nháp.")
        method = str(values.get("method") or "Tiền mặt")
        if method != "Tiền mặt":
            raise ValueError("Phiếu thu/chi thủ công chỉ được ghi nhận tiền mặt.")
        amount = _amount(values.get("amount"))
        reason = str(values.get("reason") or "").strip()
        if not reason:
            raise ValueError("Vui lòng nhập lý do thu/chi.")
        fields = {
            "employee": employee,
            "voucher_date": _date_time(values.get("date"), "Ngày chứng từ"),
            "amount": amount,
            "reason": reason[:255],
            "method": method,
            "note": str(values.get("note") or "").strip()[:255],
        }
        if model is ReceiptVoucher:
            customer_code = str(values.get("customer") or "").strip()
            if customer_code:
                from apps.customers.models import DoiTacKinhDoanh

                fields["customer"] = DoiTacKinhDoanh.objects.get(DT_Ma=customer_code)
            else:
                fields["customer"] = None
        else:
            supplier_code = str(values.get("supplier") or "").strip()
            if supplier_code:
                fields["supplier"] = Partner.objects.get(code=supplier_code)
            else:
                fields["supplier"] = None
        if voucher:
            for name, value in fields.items():
                setattr(voucher, name, value)
            voucher.save()
        else:
            voucher = model.objects.create(**fields, status=model.Status.DRAFT)
        return voucher


def set_manual_voucher_status(model, code, status):
    if model not in (ReceiptVoucher, ExpenseVoucher):
        raise ValueError("Loại phiếu kế toán không hợp lệ.")
    if status not in (model.Status.CONFIRMED, model.Status.CANCELLED):
        raise ValueError("Trạng thái phiếu không hợp lệ.")
    with transaction.atomic():
        _acquire_write_lock()
        voucher = model.objects.select_for_update().filter(code=code).first()
        if not voucher:
            raise model.DoesNotExist(code)
        if voucher.status != model.Status.DRAFT:
            raise ValueError("Chỉ xác nhận hoặc hủy phiếu thủ công ở trạng thái nháp.")
        if getattr(voucher, "sale_payment_id", None) or getattr(voucher, "supplier_payment_id", None):
            raise ValueError("Phiếu tự động liên kết không được sửa trạng thái thủ công.")
        voucher.status = status
        voucher.save(update_fields=("status", "updated_at"))
        return voucher
