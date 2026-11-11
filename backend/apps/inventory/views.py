from datetime import date

from django.db.models import Q
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.generics import ListAPIView
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsStoreOwnerOrAdmin
from apps.partners.models import Partner
from apps.purchasing.models import PurchaseOrder

from .models import (
    GoodsReceipt,
    StockCount,
    StockMovement,
    StockTransfer,
    SupplierReturn,
    StorageLocation,
)
from .pagination import InventoryPagination
from .permissions import (
    IsAccountantOrOwner,
    IsSalesOrOwner,
    IsWarehouseOrOwner,
    InventoryReadPermission,
)
from .serializers import (
    GoodsReceiptSerializer,
    GoodsReceiptWriteSerializer,
    StockCountSerializer,
    StockCountWriteSerializer,
    StockMovementSerializer,
    StockTransferReceiveSerializer,
    StockTransferSerializer,
    StockTransferWriteSerializer,
    SupplierReturnSerializer,
    SupplierReturnWriteSerializer,
    StorageLocationSerializer,
)
from .services import (
    cancel_goods_receipt,
    approve_stock_count,
    confirm_goods_receipt,
    create_stock_count,
    create_stock_transfer,
    dispatch_stock_transfer,
    get_expiry_rows,
    get_inventory_overview,
    get_order_progress,
    get_receipt,
    get_stock_count,
    get_stock_transfer,
    get_stock_ledger,
    get_stock_lot_rows,
    get_stock_summary_rows,
    cancel_supplier_return,
    confirm_supplier_return,
    delete_draft_supplier_return,
    get_supplier_return,
    save_goods_receipt,
    save_supplier_return,
    submit_supplier_return,
    review_supplier_return,
    submit_goods_receipt,
    submit_stock_count,
    receive_stock_transfer,
)


class GoodsReceiptViewSet(viewsets.GenericViewSet):
    queryset = GoodsReceipt.objects.select_related(
        "purchase_order", "supplier", "location", "employee", "confirmed_by"
    ).prefetch_related("lines__product")
    serializer_class = GoodsReceiptSerializer
    pagination_class = InventoryPagination
    lookup_field = "code"
    lookup_value_regex = "[^/]+"
    http_method_names = ("get", "post", "patch", "head", "options")
    permission_classes = (InventoryReadPermission,)

    def get_permissions(self):
        if self.action in ("create", "partial_update", "submit", "cancel"):
            return [IsWarehouseOrOwner()]
        if self.action == "confirm":
            return [IsAccountantOrOwner()]
        return [InventoryReadPermission()]

    def get_queryset(self):
        queryset = self.queryset
        params = self.request.query_params
        search = params.get("search") or params.get("q")
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(supplier__code__icontains=search)
                | Q(supplier__name__icontains=search)
                | Q(purchase_order__code__icontains=search)
            )
        supplier_code = params.get("DT_Ma")
        if supplier_code:
            queryset = queryset.filter(
                supplier__code=supplier_code,
                supplier__role__in=(Partner.Role.SUPPLIER, Partner.Role.BOTH),
            )
        location_code = params.get("DD_Ma")
        if location_code:
            queryset = queryset.filter(location__code=location_code)
        purchase_order_code = params.get("DH_Ma")
        if purchase_order_code:
            queryset = queryset.filter(purchase_order__code=purchase_order_code)
        receipt_status = params.get("status") or params.get("PN_TrangThai")
        if receipt_status:
            queryset = queryset.filter(status=receipt_status)
        date_from = params.get("from") or params.get("date_from")
        date_to = params.get("to") or params.get("date_to")
        if date_from:
            queryset = queryset.filter(received_on__gte=self._parse_date(date_from))
        if date_to:
            queryset = queryset.filter(received_on__lte=self._parse_date(date_to))
        return queryset.order_by("-received_on", "-id")

    @staticmethod
    def _parse_date(value):
        try:
            return date.fromisoformat(value)
        except ValueError as error:
            raise ValidationError(
                {"date": "Ngày phải có định dạng YYYY-MM-DD."}
            ) from error

    def list(self, request, *args, **kwargs):
        page = self.paginate_queryset(self.get_queryset())
        return self.get_paginated_response(
            self.get_serializer(page, many=True).data
        )

    def retrieve(self, request, *args, **kwargs):
        return Response(self.get_serializer(self.get_object()).data)

    def create(self, request, *args, **kwargs):
        serializer = GoodsReceiptWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return self._save(serializer.validated_data, request)

    def partial_update(self, request, *args, **kwargs):
        receipt = self.get_object()
        serializer = GoodsReceiptWriteSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        return self._save(serializer.validated_data, request, receipt.code)

    def _save(self, values, request, receipt_code=""):
        try:
            receipt = save_goods_receipt(
                user=request.user,
                supplier_code=values.get("DT_Ma"),
                location_code=values.get("DD_Ma"),
                received_on=values.get("PN_Ngay"),
                lines=values.get("lines"),
                purchase_order_code=values.get("DH_Ma"),
                receipt_code=receipt_code,
                employee_code=values.get("NV_Ma", ""),
            )
        except GoodsReceipt.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu nhập.") from error
        except PurchaseOrder.DoesNotExist as error:
            raise ValidationError({"DH_Ma": "Đơn đặt hàng không tồn tại hoặc không thể nhận."}) from error
        except (ValueError, TypeError) as error:
            raise ValidationError({"detail": str(error)}) from error
        response_status = (
            status.HTTP_201_CREATED if not receipt_code else status.HTTP_200_OK
        )
        return Response(
            self.get_serializer(get_receipt(receipt.code)).data,
            status=response_status,
        )

    @action(detail=True, methods=("post",), url_path="submit")
    def submit(self, request, code=None):
        try:
            receipt = submit_goods_receipt(code)
        except GoodsReceipt.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu nhập.") from error
        except PurchaseOrder.DoesNotExist as error:
            raise ValidationError({"DH_Ma": "Đơn đặt hàng không tồn tại hoặc không thể nhận."}) from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(get_receipt(receipt.code)).data)

    @action(detail=True, methods=("post",), url_path="confirm")
    def confirm(self, request, code=None):
        try:
            receipt = confirm_goods_receipt(code, confirmed_by=request.user)
        except GoodsReceipt.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu nhập.") from error
        except PurchaseOrder.DoesNotExist as error:
            raise ValidationError({"DH_Ma": "Đơn đặt hàng không tồn tại hoặc không thể nhận."}) from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(get_receipt(receipt.code)).data)

    @action(detail=True, methods=("post",), url_path="cancel")
    def cancel(self, request, code=None):
        try:
            receipt = cancel_goods_receipt(code)
        except GoodsReceipt.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu nhập.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(get_receipt(receipt.code)).data)


class StockCountViewSet(viewsets.GenericViewSet):
    queryset = StockCount.objects.select_related(
        "location", "employee", "approved_by"
    ).prefetch_related(
        "lines__receipt_line__product",
        "lines__receipt_line__receipt",
    )
    serializer_class = StockCountSerializer
    pagination_class = InventoryPagination
    lookup_field = "code"
    lookup_value_regex = "[^/]+"
    http_method_names = ("get", "post", "head", "options")
    permission_classes = (InventoryReadPermission,)

    def get_permissions(self):
        if self.action in ("create", "submit"):
            return [IsWarehouseOrOwner()]
        if self.action == "approve":
            return [IsStoreOwnerOrAdmin()]
        return [InventoryReadPermission()]

    def get_queryset(self):
        queryset = self.queryset
        params = self.request.query_params
        search = (params.get("search") or params.get("q") or "").strip()
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(location__code__icontains=search)
                | Q(location__name__icontains=search)
                | Q(employee__code__icontains=search)
            )
        location_code = params.get("DD_Ma")
        if location_code:
            queryset = queryset.filter(location__code=location_code)
        count_status = params.get("status") or params.get("PKK_TrangThai")
        if count_status:
            if count_status not in StockCount.Status.values:
                raise ValidationError({"status": "Trạng thái kiểm kê không hợp lệ."})
            queryset = queryset.filter(status=count_status)
        date_from = params.get("from") or params.get("date_from")
        date_to = params.get("to") or params.get("date_to")
        if date_from:
            queryset = queryset.filter(count_date__gte=self._parse_date(date_from))
        if date_to:
            queryset = queryset.filter(count_date__lte=self._parse_date(date_to))
        return queryset.order_by("-count_date", "-id")

    @staticmethod
    def _parse_date(value):
        try:
            return date.fromisoformat(value)
        except ValueError as error:
            raise ValidationError(
                {"date": "Ngày phải có định dạng YYYY-MM-DD."}
            ) from error

    def list(self, request, *args, **kwargs):
        page = self.paginate_queryset(self.get_queryset())
        return self.get_paginated_response(
            self.get_serializer(page, many=True).data
        )

    def retrieve(self, request, *args, **kwargs):
        return Response(self.get_serializer(self.get_object()).data)

    def create(self, request, *args, **kwargs):
        serializer = StockCountWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        try:
            count = create_stock_count(
                user=request.user,
                location_code=values["DD_Ma"],
                count_date=values["PKK_Ngay"],
                note=values.get("PKK_GhiChu", ""),
                lines=values["lines"],
                employee_code=values.get("NV_Ma", ""),
            )
        except (ValueError, TypeError) as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(
            self.get_serializer(count).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=("post",), url_path="submit")
    def submit(self, request, code=None):
        try:
            count = submit_stock_count(code)
        except StockCount.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu kiểm kê.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(count).data)

    @action(detail=True, methods=("post",), url_path="approve")
    def approve(self, request, code=None):
        try:
            count = approve_stock_count(code, approved_by=request.user)
        except StockCount.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu kiểm kê.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(count).data)


class SupplierReturnViewSet(viewsets.GenericViewSet):
    queryset = SupplierReturn.objects.select_related(
        "supplier",
        "receipt",
        "source_location",
        "employee",
        "reviewed_by",
        "confirmed_by",
    ).prefetch_related("lines__receipt_line__product")
    serializer_class = SupplierReturnSerializer
    pagination_class = InventoryPagination
    lookup_field = "code"
    lookup_value_regex = "[^/]+"
    http_method_names = ("get", "post", "patch", "delete", "head", "options")
    permission_classes = (InventoryReadPermission,)

    def get_permissions(self):
        if self.action in (
            "create",
            "partial_update",
            "destroy",
            "submit",
            "cancel",
            "confirm",
        ):
            return [IsWarehouseOrOwner()]
        if self.action in ("approve", "reject"):
            return [IsStoreOwnerOrAdmin()]
        return [InventoryReadPermission()]

    def get_queryset(self):
        queryset = self.queryset
        params = self.request.query_params
        search = (params.get("search") or params.get("q") or "").strip()
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(supplier__code__icontains=search)
                | Q(supplier__name__icontains=search)
                | Q(receipt__code__icontains=search)
                | Q(source_location__code__icontains=search)
                | Q(source_location__name__icontains=search)
            )
        supplier_code = params.get("DT_Ma")
        if supplier_code:
            queryset = queryset.filter(supplier__code=supplier_code)
        receipt_code = params.get("PN_Ma")
        if receipt_code:
            queryset = queryset.filter(receipt__code=receipt_code)
        location_code = params.get("DD_Ma")
        if location_code:
            queryset = queryset.filter(source_location__code=location_code)
        return_status = params.get("status") or params.get("TRNCC_TrangThai")
        if return_status:
            if return_status not in SupplierReturn.Status.values:
                raise ValidationError({"status": "Trạng thái phiếu trả không hợp lệ."})
            queryset = queryset.filter(status=return_status)
        date_from = params.get("from") or params.get("date_from")
        date_to = params.get("to") or params.get("date_to")
        if date_from:
            queryset = queryset.filter(return_date__gte=self._parse_date(date_from))
        if date_to:
            queryset = queryset.filter(return_date__lte=self._parse_date(date_to))
        return queryset.order_by("-return_date", "-id")

    @staticmethod
    def _parse_date(value):
        try:
            return date.fromisoformat(value)
        except ValueError as error:
            raise ValidationError(
                {"date": "Ngày phải có định dạng YYYY-MM-DD."}
            ) from error

    def list(self, request, *args, **kwargs):
        page = self.paginate_queryset(self.get_queryset())
        return self.get_paginated_response(
            self.get_serializer(page, many=True).data
        )

    def retrieve(self, request, *args, **kwargs):
        return Response(self.get_serializer(self.get_object()).data)

    def create(self, request, *args, **kwargs):
        serializer = SupplierReturnWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        return self._save(serializer.validated_data, request)

    def partial_update(self, request, *args, **kwargs):
        supplier_return = self.get_object()
        serializer = SupplierReturnWriteSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        return self._save(
            serializer.validated_data, request, supplier_return.code
        )

    def _save(self, values, request, return_code=""):
        lines = values.get("lines")
        if lines is not None:
            lines = [dict(line) for line in lines]
            default_reason = values.get("TRNCC_LyDo", "")
            for line in lines:
                if not line.get("TRNCC_LyDoChiTiet"):
                    line["TRNCC_LyDoChiTiet"] = default_reason
        try:
            supplier_return = save_supplier_return(
                user=request.user,
                supplier_code=values.get("DT_Ma"),
                receipt_code=values.get("PN_Ma"),
                location_code=values.get("DD_Ma"),
                return_date=values.get("TRNCC_Ngay"),
                reason=values.get("TRNCC_LyDo"),
                note=values.get("TRNCC_GhiChu"),
                lines=lines,
                return_code=return_code,
                employee_code=values.get("NV_Ma", ""),
            )
        except SupplierReturn.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu trả NCC.") from error
        except (ValueError, TypeError) as error:
            raise ValidationError({"detail": str(error)}) from error
        response_status = (
            status.HTTP_201_CREATED if not return_code else status.HTTP_200_OK
        )
        return Response(
            self.get_serializer(get_supplier_return(supplier_return.code)).data,
            status=response_status,
        )

    @action(detail=True, methods=("post",), url_path="submit")
    def submit(self, request, code=None):
        try:
            supplier_return = submit_supplier_return(code)
        except SupplierReturn.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu trả NCC.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(supplier_return).data)

    @action(detail=True, methods=("post",), url_path="approve")
    def approve(self, request, code=None):
        return self._review(code, request, approve=True)

    @action(detail=True, methods=("post",), url_path="reject")
    def reject(self, request, code=None):
        return self._review(code, request, approve=False)

    def _review(self, code, request, *, approve):
        try:
            supplier_return = review_supplier_return(
                code, reviewed_by=request.user, approve=approve
            )
        except SupplierReturn.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu trả NCC.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(supplier_return).data)

    @action(detail=True, methods=("post",), url_path="cancel")
    def cancel(self, request, code=None):
        try:
            supplier_return = cancel_supplier_return(code)
        except SupplierReturn.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu trả NCC.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(supplier_return).data)

    @action(detail=True, methods=("post",), url_path="confirm")
    def confirm(self, request, code=None):
        try:
            supplier_return = confirm_supplier_return(
                code, confirmed_by=request.user
            )
        except SupplierReturn.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu trả NCC.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(supplier_return).data)

    def destroy(self, request, *args, **kwargs):
        code = self.get_object().code
        try:
            delete_draft_supplier_return(code)
        except SupplierReturn.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu trả NCC.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(status=status.HTTP_204_NO_CONTENT)


class StockTransferViewSet(viewsets.GenericViewSet):
    queryset = StockTransfer.objects.select_related(
        "source_location",
        "destination_location",
        "employee",
        "dispatched_by",
        "received_by",
    ).prefetch_related(
        "lines__receipt_line__product",
        "lines__receipt_line__receipt",
    )
    serializer_class = StockTransferSerializer
    pagination_class = InventoryPagination
    lookup_field = "code"
    lookup_value_regex = "[^/]+"
    http_method_names = ("get", "post", "head", "options")
    permission_classes = (InventoryReadPermission,)

    def get_permissions(self):
        if self.action == "create":
            return [IsAccountantOrOwner()]
        if self.action == "confirm_dispatch":
            return [IsWarehouseOrOwner()]
        if self.action == "receive":
            return [IsSalesOrOwner()]
        return [InventoryReadPermission()]

    def get_queryset(self):
        queryset = self.queryset
        params = self.request.query_params
        search = (params.get("search") or params.get("q") or "").strip()
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(source_location__code__icontains=search)
                | Q(source_location__name__icontains=search)
                | Q(destination_location__code__icontains=search)
                | Q(destination_location__name__icontains=search)
            )
        source_code = params.get("DD_Xuat") or params.get("DD_Ma")
        destination_code = params.get("DD_Nhan")
        if source_code:
            queryset = queryset.filter(source_location__code=source_code)
        if destination_code:
            queryset = queryset.filter(destination_location__code=destination_code)
        transfer_status = params.get("status") or params.get("PXCN_TrangThai")
        if transfer_status:
            if transfer_status not in StockTransfer.Status.values:
                raise ValidationError({"status": "Trạng thái chuyển kho không hợp lệ."})
            queryset = queryset.filter(status=transfer_status)
        date_from = params.get("from") or params.get("date_from")
        date_to = params.get("to") or params.get("date_to")
        if date_from:
            queryset = queryset.filter(transfer_date__gte=self._parse_date(date_from))
        if date_to:
            queryset = queryset.filter(transfer_date__lte=self._parse_date(date_to))
        return queryset.order_by("-transfer_date", "-id")

    @staticmethod
    def _parse_date(value):
        try:
            return date.fromisoformat(value)
        except ValueError as error:
            raise ValidationError(
                {"date": "Ngày phải có định dạng YYYY-MM-DD."}
            ) from error

    def list(self, request, *args, **kwargs):
        page = self.paginate_queryset(self.get_queryset())
        return self.get_paginated_response(
            self.get_serializer(page, many=True).data
        )

    def retrieve(self, request, *args, **kwargs):
        return Response(self.get_serializer(self.get_object()).data)

    def create(self, request, *args, **kwargs):
        serializer = StockTransferWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        try:
            transfer = create_stock_transfer(
                user=request.user,
                source_location_code=values["DD_Xuat"],
                destination_location_code=values["DD_Nhan"],
                transfer_date=values["PXCN_Ngay"],
                lines=values["lines"],
                receiver_name=values.get("PXCN_NguoiNhan", ""),
                employee_code=values.get("NV_Ma", ""),
            )
        except (ValueError, TypeError) as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(
            self.get_serializer(transfer).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=("post",), url_path="dispatch")
    def confirm_dispatch(self, request, code=None):
        try:
            transfer = dispatch_stock_transfer(code, dispatched_by=request.user)
        except StockTransfer.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu chuyển.") from error
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(transfer).data)

    @action(detail=True, methods=("post",), url_path="receive")
    def receive(self, request, code=None):
        serializer = StockTransferReceiveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        values = serializer.validated_data
        try:
            transfer = receive_stock_transfer(
                code,
                received_by=request.user,
                lines=values["lines"],
                receiver_name=values.get("PXCN_NguoiNhan", ""),
            )
        except StockTransfer.DoesNotExist as error:
            raise NotFound("Không tìm thấy phiếu chuyển.") from error
        except (ValueError, TypeError) as error:
            raise ValidationError({"detail": str(error)}) from error
        return Response(self.get_serializer(transfer).data)


class StorageLocationListView(ListAPIView):
    permission_classes = (InventoryReadPermission,)
    serializer_class = StorageLocationSerializer
    queryset = StorageLocation.objects.all()


class StockBalanceListView(APIView):
    permission_classes = (InventoryReadPermission,)

    def get(self, request):
        params = request.query_params
        location_code = params.get("DD_Ma") or params.get("location", "")
        product_code = params.get("HH_Ma") or params.get("item", "")
        search = params.get("search", "").strip()
        category_code = params.get("DM_Ma") or params.get("category", "")
        mode = params.get("view", params.get("mode", "summary"))
        if mode not in ("summary", "detail"):
            raise ValidationError({"view": "Giá trị phải là summary hoặc detail."})
        if mode == "summary":
            rows = get_stock_summary_rows(
                product_code=product_code,
                location_code=location_code,
                category_code=category_code,
                search=search,
            )
        else:
            rows = get_stock_lot_rows(
                product_code=product_code,
                location_code=location_code,
                search=search,
            )
            if category_code:
                rows = [row for row in rows if row["DM_Ma"] == category_code]
        status_filter = params.get("status", "")
        if status_filter:
            rows = [
                row
                for row in rows
                if status_filter
                in (
                    row.get("TK_TrangThai"),
                    row.get("HSD_TrangThai"),
                )
            ]
        paginator = InventoryPagination()
        page = paginator.paginate_queryset(rows, request, view=self)
        return paginator.get_paginated_response(page)


class StockMovementListView(ListAPIView):
    permission_classes = (InventoryReadPermission,)
    serializer_class = StockMovementSerializer
    pagination_class = InventoryPagination

    def get_queryset(self):
        queryset = StockMovement.objects.select_related(
            "location", "receipt_line__product", "employee"
        )
        params = self.request.query_params
        location_code = params.get("DD_Ma")
        product_code = params.get("HH_Ma")
        line_code = params.get("PNCT_Ma")
        movement_kind = params.get("BDK_Loai")
        source_code = params.get("BDK_MaChungTu")
        search = params.get("search") or params.get("q")
        date_from = params.get("from") or params.get("date_from")
        date_to = params.get("to") or params.get("date_to")
        if location_code:
            queryset = queryset.filter(location__code=location_code)
        if product_code:
            queryset = queryset.filter(receipt_line__product__code=product_code)
        if line_code:
            queryset = queryset.filter(receipt_line__code=line_code)
        if movement_kind:
            queryset = queryset.filter(movement_type=movement_kind)
        if source_code:
            queryset = queryset.filter(document_code=source_code)
        if search:
            queryset = queryset.filter(
                Q(code__icontains=search)
                | Q(document_code__icontains=search)
                | Q(receipt_line__code__icontains=search)
                | Q(receipt_line__product__code__icontains=search)
                | Q(receipt_line__product__name__icontains=search)
            )
        if date_from:
            queryset = queryset.filter(occurred_at__date__gte=self._parse_date(date_from))
        if date_to:
            queryset = queryset.filter(occurred_at__date__lte=self._parse_date(date_to))
        return queryset.order_by("-occurred_at", "-id")

    @staticmethod
    def _parse_date(value):
        try:
            return date.fromisoformat(value)
        except ValueError as error:
            raise ValidationError(
                {"date": "Ngày phải có định dạng YYYY-MM-DD."}
            ) from error


class OrderReceivingProgressView(APIView):
    permission_classes = (InventoryReadPermission,)

    def get(self, request, order_code):
        try:
            return Response(get_order_progress(order_code))
        except PurchaseOrder.DoesNotExist as error:
            raise NotFound("Không tìm thấy đơn đặt hàng.") from error


class ExpiryListView(APIView):
    permission_classes = (InventoryReadPermission,)

    def get(self, request):
        params = request.query_params
        expiry_status = params.get("expiry") or params.get("status", "")
        valid_statuses = {
            "Sắp hết hạn",
            "Đã hết hạn",
            "Còn hạn",
            "Không áp dụng HSD",
        }
        if expiry_status and expiry_status not in valid_statuses:
            raise ValidationError({"status": "Tình trạng hạn sử dụng không hợp lệ."})
        rows = get_expiry_rows(
            product_code=params.get("HH_Ma") or params.get("item", ""),
            location_code=params.get("DD_Ma") or params.get("location", ""),
            expiry_status=expiry_status,
            search=(params.get("search") or params.get("q", "")).strip(),
        )
        paginator = InventoryPagination()
        page = paginator.paginate_queryset(rows, request, view=self)
        return paginator.get_paginated_response(page)


class InventoryOverviewView(APIView):
    permission_classes = (InventoryReadPermission,)

    def get(self, request):
        data = get_inventory_overview(
            location_code=request.query_params.get("DD_Ma", "")
        )
        data["recent_movements"] = StockMovementSerializer(
            data["recent_movements"], many=True
        ).data
        return Response(data)


class StockLedgerView(APIView):
    permission_classes = (InventoryReadPermission,)
    pagination_class = InventoryPagination

    def get(self, request):
        params = request.query_params
        date_from = params.get("from") or params.get("date_from")
        date_to = params.get("to") or params.get("date_to")
        if not date_from or not date_to:
            raise ValidationError(
                {"date": "Cần truyền khoảng ngày from và to theo định dạng YYYY-MM-DD."}
            )
        try:
            parsed_from = date.fromisoformat(date_from)
            parsed_to = date.fromisoformat(date_to)
        except ValueError as error:
            raise ValidationError(
                {"date": "Ngày phải có định dạng YYYY-MM-DD."}
            ) from error
        try:
            report = get_stock_ledger(
                product_code=params.get("HH_Ma") or params.get("item", ""),
                location_code=params.get("DD_Ma") or params.get("location", ""),
                date_from=parsed_from,
                date_to=parsed_to,
                lot_code=params.get("PNCT_Ma") or params.get("line", ""),
            )
        except ValueError as error:
            raise ValidationError({"detail": str(error)}) from error
        rows = report.pop("rows")
        paginator = InventoryPagination()
        page = paginator.paginate_queryset(rows, request, view=self)
        pagination = paginator.get_paginated_response(page).data
        return Response({**report, **pagination})
