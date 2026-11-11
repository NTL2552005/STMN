from django.db.models import Q, Sum
from django.utils.dateparse import parse_date
from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.inventory.models import (
    GoodsReceipt,
    GoodsReceiptLine,
    StockBalance,
    StockMovement,
)
from apps.customers.models import DoiTacKinhDoanh
from apps.partners.models import Partner
from apps.purchasing.models import PurchaseOrderLine
from apps.sales.models import SaleInvoice, SalePayment

from .models import ExpenseVoucher, ReceiptVoucher, SupplierDebt, SupplierPayment
from .permissions import IsAccountantOrOwner
from .serializers import (
    ExpenseVoucherSerializer,
    ReceiptVoucherSerializer,
    SupplierDebtSerializer,
    SupplierPaymentSerializer,
)
from .services import (
    create_sales_receipt,
    create_supplier_expense_voucher,
    create_supplier_payment,
    record_supplier_debt_for_receipt,
    save_manual_voucher,
    set_manual_voucher_status,
    update_supplier_payment,
)


class AccountingAPIView(APIView):
    permission_classes = (IsAccountantOrOwner,)


class AccountingRootAPIView(AccountingAPIView):
    def get(self, request):
        return Response(
            {
                "status": "Accounting API ready",
                "endpoints": [
                    "dashboard/",
                    "supplier-debts/",
                    "supplier-payments/",
                    "receipts/",
                    "expenses/",
                    "customer-receivables/",
                    "revenue-reconciliation/",
                    "purchase-reconciliation/",
                    "payment-reconciliation/",
                    "cashbook/",
                    "reports/",
                ],
            }
        )


def _date_filters(queryset, field, params):
    for key, operator in (("from", "gte"), ("to", "lte")):
        value = params.get(key)
        if value:
            parsed = parse_date(value)
            if not parsed:
                raise ValidationError({"date": "Ngày phải có định dạng YYYY-MM-DD."})
            queryset = queryset.filter(**{f"{field}__date__{operator}": parsed})
    return queryset


def _date_only_filters(queryset, field, params):
    for key, operator in (("from", "gte"), ("to", "lte")):
        value = params.get(key)
        if value:
            parsed = parse_date(value)
            if not parsed:
                raise ValidationError({"date": "Ngày phải có định dạng YYYY-MM-DD."})
            queryset = queryset.filter(**{f"{field}__{operator}": parsed})
    return queryset


class SupplierDebtListAPIView(AccountingAPIView):
    def get(self, request):
        debts = SupplierDebt.objects.select_related("receipt", "supplier").prefetch_related(
            "payments", "return_adjustments"
        )
        supplier = request.query_params.get("supplier") or request.query_params.get("DT_Ma")
        if supplier:
            debts = debts.filter(supplier__code=supplier)
        search = (request.query_params.get("q") or "").strip()
        if search:
            debts = debts.filter(
                Q(receipt__code__icontains=search)
                | Q(supplier__code__icontains=search)
                | Q(supplier__name__icontains=search)
            )
        return Response(SupplierDebtSerializer(debts, many=True).data)


class SupplierDebtCreateAPIView(AccountingAPIView):
    def post(self, request, receipt_code):
        already_exists = SupplierDebt.objects.filter(
            receipt__code=receipt_code
        ).exists()
        try:
            debt = record_supplier_debt_for_receipt(receipt_code)
        except GoodsReceipt.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu nhập.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        if debt is None:
            return Response({"detail": "Phiếu nhập không phát sinh công nợ."}, status=200)
        return Response(
            SupplierDebtSerializer(debt).data,
            status=status.HTTP_200_OK if already_exists else status.HTTP_201_CREATED,
        )


class SupplierPaymentListCreateAPIView(AccountingAPIView):
    def get(self, request, debt_code=""):
        payments = SupplierPayment.objects.select_related(
            "debt__receipt", "debt__supplier"
        )
        for key, value in (
            ("status", request.query_params.get("status")),
            ("method", request.query_params.get("method")),
        ):
            if value:
                payments = payments.filter(**{key: value})
        debt_code = debt_code or request.query_params.get("debt")
        if debt_code:
            payments = payments.filter(debt__receipt__code=debt_code)
        payments = _date_filters(payments, "payment_date", request.query_params)
        return Response(SupplierPaymentSerializer(payments, many=True).data)

    def post(self, request, debt_code=""):
        debt_code = str(
            debt_code or request.data.get("debt") or request.data.get("receipt") or ""
        ).strip()
        if not debt_code:
            raise ValidationError({"debt": "Cần mã phiếu nhập đang có công nợ."})
        try:
            payment, created = create_supplier_payment(
                debt_code,
                request.data,
                request.user,
                request.headers.get("Idempotency-Key", ""),
            )
        except SupplierDebt.DoesNotExist as error:
            raise NotFound("Không tìm thấy khoản công nợ NCC.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(
            SupplierPaymentSerializer(payment).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class SupplierPaymentActionAPIView(AccountingAPIView):
    def post(self, request, code, action):
        if action == "expense-voucher":
            try:
                voucher, created = create_supplier_expense_voucher(code, request.user)
            except SupplierPayment.DoesNotExist as error:
                raise NotFound("Không tìm thấy giao dịch thanh toán NCC.") from error
            except ValueError as error:
                raise ValidationError({"detail": str(error)}) from error
            return Response(
                ExpenseVoucherSerializer(voucher).data,
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            )
        status_by_action = {
            "confirm": SupplierPayment.Status.SUCCESS,
            "fail": SupplierPayment.Status.FAILED,
            "cancel": SupplierPayment.Status.CANCELLED,
        }
        if action == "status":
            next_status = request.data.get("status")
            if next_status not in (
                SupplierPayment.Status.FAILED,
                SupplierPayment.Status.CANCELLED,
            ):
                raise ValidationError(
                    {"status": "Chỉ được đánh dấu giao dịch chờ là thất bại hoặc đã hủy."}
                )
        else:
            next_status = status_by_action.get(action)
        if not next_status:
            raise NotFound("Thao tác thanh toán NCC không tồn tại.")
        try:
            payment = update_supplier_payment(code, next_status)
        except SupplierPayment.DoesNotExist as error:
            raise NotFound("Không tìm thấy giao dịch thanh toán NCC.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(SupplierPaymentSerializer(payment).data)


class VoucherListCreateAPIView(AccountingAPIView):
    model = None
    serializer_class = None

    def get(self, request):
        vouchers = self.model.objects.select_related("employee")
        status_filter = request.query_params.get("status")
        if status_filter:
            vouchers = vouchers.filter(status=status_filter)
        vouchers = _date_filters(vouchers, "voucher_date", request.query_params)
        if self.model is ReceiptVoucher:
            vouchers = vouchers.select_related("sale_payment", "customer")
        else:
            vouchers = vouchers.select_related("supplier_payment", "supplier")
        return Response(self.serializer_class(vouchers, many=True).data)

    def post(self, request):
        code = str(request.data.get("code") or "").strip()
        try:
            voucher = save_manual_voucher(
                self.model, request.data, request.user, code=code
            )
        except self.model.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        except DoiTacKinhDoanh.DoesNotExist as error:
            raise ValidationError({"customer": "Khách hàng không tồn tại."}) from error
        except Partner.DoesNotExist as error:
            raise ValidationError({"supplier": "Nhà cung cấp không tồn tại."}) from error
        return Response(
            self.serializer_class(voucher).data,
            status=status.HTTP_200_OK if code else status.HTTP_201_CREATED,
        )


class ReceiptVoucherListCreateAPIView(VoucherListCreateAPIView):
    model = ReceiptVoucher
    serializer_class = ReceiptVoucherSerializer


class ExpenseVoucherListCreateAPIView(VoucherListCreateAPIView):
    model = ExpenseVoucher
    serializer_class = ExpenseVoucherSerializer


class VoucherStatusAPIView(AccountingAPIView):
    def post(self, request, kind, code):
        model = ReceiptVoucher if kind == "receipts" else ExpenseVoucher
        serializer_class = (
            ReceiptVoucherSerializer if kind == "receipts" else ExpenseVoucherSerializer
        )
        try:
            voucher = set_manual_voucher_status(
                model, code, request.data.get("status")
            )
        except model.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(serializer_class(voucher).data)


class SalesReceiptSyncAPIView(AccountingAPIView):
    def post(self, request, payment_code):
        try:
            payment = SalePayment.objects.select_related(
                "invoice", "invoice__employee", "invoice__customer"
            ).get(code=payment_code)
        except SalePayment.DoesNotExist as error:
            raise NotFound("Không tìm thấy giao dịch thanh toán bán hàng.") from error
        try:
            voucher, created = create_sales_receipt(payment)
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(
            ReceiptVoucherSerializer(voucher).data,
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class CustomerReceivablesAPIView(AccountingAPIView):
    def get(self, request):
        invoices = SaleInvoice.objects.filter(status=SaleInvoice.Status.CONFIRMED).select_related(
            "customer"
        ).prefetch_related("payments")
        customer = request.query_params.get("customer")
        if customer:
            invoices = invoices.filter(customer__DT_Ma=customer)
        rows = []
        for invoice in invoices:
            paid = invoice.payments.filter(status=SalePayment.Status.SUCCESS).aggregate(
                total=Sum("amount")
            )["total"] or 0
            rows.append(
                {
                    "invoice": invoice.code,
                    "customer": invoice.customer.DT_Ma if invoice.customer_id else None,
                    "customer_name": invoice.customer.DT_Ten if invoice.customer_id else "",
                    "invoice_amount": invoice.total_amount,
                    "paid_amount": paid,
                    "balance": max(0, invoice.total_amount - paid),
                }
            )
        return Response([row for row in rows if row["balance"] > 0])


class SalesRevenueReconciliationAPIView(AccountingAPIView):
    def get(self, request):
        invoices = SaleInvoice.objects.select_related(
            "customer", "employee", "location"
        ).prefetch_related("lines", "payments")
        status_filter = request.query_params.get("status")
        if status_filter:
            invoices = invoices.filter(status=status_filter)
        if request.query_params.get("location"):
            invoices = invoices.filter(location__code=request.query_params["location"])
        if request.query_params.get("staff"):
            invoices = invoices.filter(employee__code=request.query_params["staff"])
        invoices = _date_filters(invoices, "invoice_date", request.query_params)
        rows = []
        for invoice in invoices:
            lines = list(invoice.lines.all())
            paid = sum(
                row.amount
                for row in invoice.payments.all()
                if row.status == SalePayment.Status.SUCCESS
            )
            pending = sum(
                row.amount
                for row in invoice.payments.all()
                if row.status == SalePayment.Status.PENDING
            )
            detail_amount = sum(line.amount for line in lines)
            detail_quantity = sum(line.quantity for line in lines)
            due = (
                max(0, invoice.total_amount - paid)
                if invoice.status == SaleInvoice.Status.CONFIRMED
                else 0
            )
            reasons = []
            if invoice.status == SaleInvoice.Status.CONFIRMED:
                if detail_amount != invoice.total_amount:
                    reasons.append("Tổng hóa đơn lệch tổng chi tiết")
                if detail_quantity != invoice.total_quantity:
                    reasons.append("Tổng số lượng lệch chi tiết")
            if paid > invoice.total_amount:
                reasons.append("Thanh toán thành công vượt tổng hóa đơn")
            if invoice.status == SaleInvoice.Status.CANCELLED and paid:
                reasons.append("Hóa đơn đã hủy nhưng còn thanh toán thành công")
            expected = {}
            for line in lines:
                expected[line.lot_code] = expected.get(line.lot_code, 0) - line.quantity
            actual = {}
            movements = StockMovement.objects.filter(
                source="HoaDonBanHang", document_code=invoice.code
            ).values("receipt_line__code").annotate(total=Sum("quantity_delta"))
            for movement in movements:
                actual[movement["receipt_line__code"]] = movement["total"]
            if any(expected.get(code, 0) != actual.get(code, 0) for code in expected.keys() | actual.keys()):
                reasons.append("Biến động kho không khớp chi tiết hóa đơn")
            if invoice.status == SaleInvoice.Status.CONFIRMED and not invoice.customer_id and due:
                reasons.append("Hóa đơn khách lẻ còn khoản phải thu không định danh")
            rows.append(
                {
                    "invoice": invoice.code,
                    "status": invoice.status,
                    "date": invoice.invoice_date,
                    "customer": invoice.customer.code if invoice.customer_id else None,
                    "customer_name": invoice.customer.DT_Ten if invoice.customer_id else "",
                    "employee": invoice.employee.code,
                    "location": invoice.location.code,
                    "invoice_amount": invoice.total_amount,
                    "detail_amount": detail_amount,
                    "invoice_quantity": invoice.total_quantity,
                    "detail_quantity": detail_quantity,
                    "paid": paid,
                    "pending": pending,
                    "due": due,
                    "reasons": reasons,
                    "reconciliation_status": (
                        "Bất thường cần kiểm tra"
                        if reasons
                        else "Đã hủy (không tính doanh thu)"
                        if invoice.status == SaleInvoice.Status.CANCELLED
                        else "Chờ xử lý thanh toán"
                        if pending
                        else "Khớp dữ liệu, còn phải thu hợp lệ"
                        if due
                        else "Khớp dữ liệu, đã thu đủ"
                    ),
                }
            )
        return Response(rows)


class PurchaseReconciliationAPIView(AccountingAPIView):
    def get(self, request):
        receipts = GoodsReceipt.objects.select_related(
            "supplier", "purchase_order", "location", "employee"
        ).prefetch_related("lines__product")
        if request.query_params.get("supplier"):
            receipts = receipts.filter(supplier__code=request.query_params["supplier"])
        if request.query_params.get("location"):
            receipts = receipts.filter(location__code=request.query_params["location"])
        receipts = _date_only_filters(receipts, "received_on", request.query_params)
        rows = []
        for receipt in receipts:
            order = receipt.purchase_order
            if not order:
                rows.append(
                    {
                        "receipt": receipt.code,
                        "supplier": receipt.supplier.code,
                        "date": receipt.received_on,
                        "status": receipt.status,
                        "order": None,
                        "progress": "Nhập không theo đơn đặt hàng",
                        "comparison": [],
                    }
                )
                continue
            ordered = {
                row.product_id: row
                for row in PurchaseOrderLine.objects.filter(order=order).select_related(
                    "product"
                )
            }
            delivered = {}
            for line in GoodsReceiptLine.objects.filter(
                receipt__purchase_order=order,
                receipt__status=GoodsReceipt.Status.CONFIRMED,
            ):
                entry = delivered.setdefault(
                    line.product_id, {"quantity": 0, "amount": 0}
                )
                entry["quantity"] += line.quantity
                entry["amount"] += line.amount
            comparison = []
            item_ids = set(ordered)
            item_ids.update(
                line.product_id for line in receipt.lines.all()
            )
            receipt_lines = {}
            for line in receipt.lines.all():
                entry = receipt_lines.setdefault(
                    line.product_id, {"quantity": 0, "amount": 0}
                )
                entry["quantity"] += line.quantity
                entry["amount"] += line.amount
            has_overage = False
            has_difference = False
            is_partial = False
            for product_id in item_ids:
                order_line = ordered.get(product_id)
                delivered_line = delivered.get(product_id, {"quantity": 0, "amount": 0})
                current_line = receipt_lines.get(
                    product_id, {"quantity": 0, "amount": 0}
                )
                ordered_qty = order_line.quantity if order_line else 0
                ordered_amount = order_line.amount if order_line else 0
                order_unit = ordered_amount / ordered_qty if ordered_qty else 0
                current_qty = current_line["quantity"]
                current_unit = (
                    current_line["amount"] / current_qty if current_qty else 0
                )
                overage = max(0, delivered_line["quantity"] - ordered_qty)
                has_overage = has_overage or overage > 0
                has_difference = has_difference or (
                    current_qty > 0 and round(current_unit - order_unit) != 0
                )
                is_partial = is_partial or delivered_line["quantity"] < ordered_qty
                comparison.append(
                    {
                        "product": order_line.product.code if order_line else "",
                        "product_name": order_line.product.name if order_line else "",
                        "order_quantity": ordered_qty,
                        "receipt_quantity": current_qty,
                        "delivered_quantity": delivered_line["quantity"],
                        "quantity_delta": overage,
                        "order_unit_price": order_unit,
                        "receipt_unit_price": current_unit,
                        "amount": current_line["amount"],
                    }
                )
            progress = (
                "Vượt số lượng đặt"
                if has_overage
                else "Lệch đơn giá"
                if has_difference
                else "Đang giao"
                if is_partial
                else "Đã nhận đủ"
            )
            rows.append(
                {
                    "receipt": receipt.code,
                    "supplier": receipt.supplier.code,
                    "date": receipt.received_on,
                    "status": receipt.status,
                    "order": order.code,
                    "progress": progress,
                    "comparison": comparison,
                }
            )
        return Response(rows)


class AccountingDashboardAPIView(AccountingAPIView):
    def get(self, request):
        debts = SupplierDebt.objects.select_related("receipt").prefetch_related(
            "payments", "return_adjustments"
        )
        payable = sum(debt.balance for debt in debts)
        receivables = CustomerReceivablesAPIView().get(request).data
        invoices = SaleInvoice.objects.filter(status=SaleInvoice.Status.CONFIRMED)
        invoices = _date_filters(invoices, "invoice_date", request.query_params)
        revenue = invoices.aggregate(total=Sum("total_amount"))["total"] or 0
        sales_payments = SalePayment.objects.filter(
            status=SalePayment.Status.SUCCESS
        ).select_related("invoice")
        sales_payments = _date_filters(sales_payments, "payment_date", request.query_params)
        sales_income = sales_payments.aggregate(total=Sum("amount"))["total"] or 0
        supplier_payments = SupplierPayment.objects.filter(
            status=SupplierPayment.Status.SUCCESS
        )
        supplier_payments = _date_filters(
            supplier_payments, "payment_date", request.query_params
        )
        supplier_expense = supplier_payments.aggregate(total=Sum("amount"))["total"] or 0
        receipts = ReceiptVoucher.objects.filter(
            status=ReceiptVoucher.Status.CONFIRMED, sale_payment__isnull=True
        )
        receipts = _date_filters(receipts, "voucher_date", request.query_params)
        other_income = receipts.aggregate(total=Sum("amount"))["total"] or 0
        expenses = ExpenseVoucher.objects.filter(
            status=ExpenseVoucher.Status.CONFIRMED, supplier_payment__isnull=True
        )
        expenses = _date_filters(expenses, "voucher_date", request.query_params)
        other_expense = expenses.aggregate(total=Sum("amount"))["total"] or 0
        pending_supplier = SupplierPayment.objects.filter(
            status=SupplierPayment.Status.PENDING
        )
        pending_sales = SalePayment.objects.filter(
            status=SalePayment.Status.PENDING
        )
        pending_supplier = _date_filters(
            pending_supplier, "payment_date", request.query_params
        )
        pending_sales = _date_filters(
            pending_sales, "payment_date", request.query_params
        )
        pending = pending_supplier.count() + pending_sales.count()
        return Response(
            {
                "revenue": revenue,
                "sales_collected": sales_income,
                "other_income": other_income,
                "supplier_paid": supplier_expense,
                "other_expense": other_expense,
                "receivable_balance": sum(row["balance"] for row in receivables),
                "payable_balance": payable,
                "pending_payments": pending,
            }
        )


class PaymentReconciliationAPIView(AccountingAPIView):
    def get(self, request):
        sales = SalePayment.objects.select_related("invoice")
        sales = _date_filters(sales, "payment_date", request.query_params)
        supplier = SupplierPayment.objects.select_related("debt__receipt", "debt__supplier")
        supplier = _date_filters(supplier, "payment_date", request.query_params)
        receipts = ReceiptVoucher.objects.select_related("sale_payment")
        receipts = _date_filters(receipts, "voucher_date", request.query_params)
        expenses = ExpenseVoucher.objects.select_related("supplier_payment")
        expenses = _date_filters(expenses, "voucher_date", request.query_params)
        alerts = []
        for payment in sales:
            if payment.status in (SalePayment.Status.PENDING, SalePayment.Status.FAILED):
                alerts.append(f"{payment.code}: {payment.status}")
            if payment.status == SalePayment.Status.SUCCESS and not ReceiptVoucher.objects.filter(
                sale_payment=payment
            ).exists():
                alerts.append(f"{payment.code}: thiếu phiếu thu liên kết")
        for payment in supplier:
            if payment.status in (SupplierPayment.Status.PENDING, SupplierPayment.Status.FAILED):
                alerts.append(f"{payment.code}: {payment.status}")
        return Response(
            {
                "sales": [
                    {
                        "code": row.code,
                        "invoice": row.invoice.code,
                        "amount": row.amount,
                        "method": row.method,
                        "status": row.status,
                        "date": row.payment_date,
                    }
                    for row in sales
                ],
                "supplier": SupplierPaymentSerializer(supplier, many=True).data,
                "receipts": ReceiptVoucherSerializer(receipts, many=True).data,
                "expenses": ExpenseVoucherSerializer(expenses, many=True).data,
                "alerts": alerts,
            }
        )


class CashbookAPIView(AccountingAPIView):
    def get(self, request):
        rows = []
        for voucher in ReceiptVoucher.objects.filter(
            status=ReceiptVoucher.Status.CONFIRMED
        ).select_related("sale_payment"):
            rows.append(
                {
                    "date": voucher.voucher_date,
                    "code": voucher.code,
                    "type": "Thu bán hàng" if voucher.sale_payment_id else "Thu khác",
                    "amount": voucher.amount,
                    "method": voucher.method,
                    "direction": "in",
                    "recognized": True,
                }
            )
        for payment in SupplierPayment.objects.filter(
            status=SupplierPayment.Status.SUCCESS
        ):
            rows.append(
                {
                    "date": payment.payment_date,
                    "code": payment.code,
                    "type": "Chi NCC",
                    "amount": payment.amount,
                    "method": payment.method,
                    "direction": "out",
                    "recognized": True,
                }
            )
        for voucher in ExpenseVoucher.objects.filter(
            status=ExpenseVoucher.Status.CONFIRMED
        ).select_related("supplier_payment"):
            if not voucher.supplier_payment_id:
                rows.append(
                    {
                        "date": voucher.voucher_date,
                        "code": voucher.code,
                        "type": "Chi khác",
                        "amount": voucher.amount,
                        "method": voucher.method,
                        "direction": "out",
                        "recognized": True,
                    }
                )
        date_from = request.query_params.get("from")
        date_to = request.query_params.get("to")
        if date_from:
            parsed = parse_date(date_from)
            if not parsed:
                raise ValidationError({"date": "Ngày phải có định dạng YYYY-MM-DD."})
            rows = [row for row in rows if row["date"].date() >= parsed]
        if date_to:
            parsed = parse_date(date_to)
            if not parsed:
                raise ValidationError({"date": "Ngày phải có định dạng YYYY-MM-DD."})
            rows = [row for row in rows if row["date"].date() <= parsed]
        method = request.query_params.get("method")
        if method:
            rows = [row for row in rows if row["method"] == method]
        rows.sort(key=lambda row: row["date"], reverse=True)
        return Response(
            {
                "rows": rows,
                "cash_income": sum(
                    row["amount"]
                    for row in rows
                    if row["direction"] == "in" and row["method"] == "Tiền mặt"
                ),
                "bank_income": sum(
                    row["amount"]
                    for row in rows
                    if row["direction"] == "in" and row["method"] != "Tiền mặt"
                ),
                "cash_expense": sum(
                    row["amount"]
                    for row in rows
                    if row["direction"] == "out" and row["method"] == "Tiền mặt"
                ),
                "bank_expense": sum(
                    row["amount"]
                    for row in rows
                    if row["direction"] == "out" and row["method"] != "Tiền mặt"
                ),
            }
        )


class AccountingReportsAPIView(AccountingAPIView):
    def get(self, request):
        invoices = SaleInvoice.objects.filter(status=SaleInvoice.Status.CONFIRMED)
        invoices = _date_filters(invoices, "invoice_date", request.query_params)
        revenue = invoices.aggregate(total=Sum("total_amount"))["total"] or 0
        lines = invoices.values("id", "total_quantity", "total_amount")
        invoice_ids = [row["id"] for row in lines]
        sale_lines = list(
            SaleInvoice.objects.filter(id__in=invoice_ids).values_list(
                "lines__lot_code",
                "lines__quantity",
                "lines__amount",
            )
        )
        lot_codes = {line[0] for line in sale_lines if line[0]}
        costs = dict(
            GoodsReceiptLine.objects.filter(code__in=lot_codes).values_list(
                "code", "unit_price"
            )
        )
        cost = sum(
            quantity * costs.get(lot_code, 0)
            for lot_code, quantity, _ in sale_lines
            if lot_code
        )
        inventory_value = sum(
            row.quantity * row.receipt_line.unit_price
            for row in StockBalance.objects.select_related("receipt_line")
        )
        sales_collected = SalePayment.objects.filter(
            invoice_id__in=invoice_ids, status=SalePayment.Status.SUCCESS
        ).aggregate(total=Sum("amount"))["total"] or 0
        supplier_paid = SupplierPayment.objects.filter(
            status=SupplierPayment.Status.SUCCESS
        ).aggregate(total=Sum("amount"))["total"] or 0
        other_income = ReceiptVoucher.objects.filter(
            sale_payment__isnull=True, status=ReceiptVoucher.Status.CONFIRMED
        ).aggregate(total=Sum("amount"))["total"] or 0
        other_expense = ExpenseVoucher.objects.filter(
            supplier_payment__isnull=True, status=ExpenseVoucher.Status.CONFIRMED
        ).aggregate(total=Sum("amount"))["total"] or 0
        debts = SupplierDebt.objects.select_related("receipt").prefetch_related(
            "payments", "return_adjustments"
        )
        receivables = CustomerReceivablesAPIView().get(request).data
        return Response(
            {
                "revenue": revenue,
                "invoice_count": len(invoice_ids),
                "sold_quantity": sum(row["total_quantity"] for row in lines),
                "cost": cost,
                "gross_profit": revenue - cost,
                "inventory_value": inventory_value,
                "sales_collected": sales_collected,
                "other_income": other_income,
                "supplier_paid": supplier_paid,
                "other_expense": other_expense,
                "cash_difference": sales_collected + other_income - supplier_paid - other_expense,
                "receivable_balance": sum(row["balance"] for row in receivables),
                "payable_balance": sum(debt.balance for debt in debts),
            }
        )
