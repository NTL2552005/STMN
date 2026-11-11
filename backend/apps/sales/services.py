from collections import defaultdict

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from apps.catalog.models import Product
from apps.catalog.services import get_active_price
from apps.inventory.models import (
    GoodsReceipt,
    GoodsReceiptLine,
    InventoryMutationLock,
    StockBalance,
    StockMovement,
)

from .models import MAX_SAFE_INTEGER


def _integer(value, field_name, *, allow_zero=True):
    if isinstance(value, bool):
        raise ValueError(f"{field_name} phải là số nguyên VND hợp lệ.")
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError(f"{field_name} phải là số nguyên VND hợp lệ.") from error
    if str(value).strip() != str(number):
        raise ValueError(f"{field_name} phải là số nguyên VND hợp lệ.")
    if number < 0 or (not allow_zero and number == 0) or number > MAX_SAFE_INTEGER:
        suffix = "lớn hơn 0" if not allow_zero else "không âm"
        raise ValueError(f"{field_name} phải là số nguyên {suffix}.")
    return number


def normalize_sale_lines(raw_lines, location, *, on_date=None):
    if not isinstance(raw_lines, list) or not raw_lines:
        raise ValueError("Hóa đơn cần ít nhất một dòng hàng.")

    on_date = on_date or timezone.localdate()
    normalized = []
    grouped_quantities = defaultdict(int)
    total_quantity = 0
    total_amount = 0

    for raw in raw_lines:
        if not isinstance(raw, dict):
            raise ValueError("Dòng hàng không hợp lệ.")
        product_code = raw.get("HH_Ma") or raw.get("product_code") or raw.get("product")
        if not isinstance(product_code, str) or not product_code.strip():
            raise ValueError("Dòng hàng thiếu mã sản phẩm.")
        try:
            product = Product.objects.get(code=product_code.strip())
        except Product.DoesNotExist as error:
            raise ValueError(f"Mặt hàng {product_code} không tồn tại.") from error
        if product.status != Product.Status.ACTIVE:
            raise ValueError(f"Mặt hàng {product.name} đã ngừng kinh doanh.")

        quantity = _integer(
            raw.get("BH_SL", raw.get("quantity", raw.get("qty"))),
            "Số lượng bán",
            allow_zero=False,
        )
        price_info = get_active_price(product, on_date)
        if price_info["price"] is None:
            raise ValueError(
                f"{product.name}: {price_info.get('error') or 'Không có giá bán hợp lệ.'}"
            )
        if "GB_GiaGoc" in raw and raw["GB_GiaGoc"] is not None:
            base_price = _integer(raw["GB_GiaGoc"], "Giá hiện hành")
            if base_price != price_info["price"]:
                raise ValueError(
                    f"Giá hiện hành của {product.name} đã thay đổi. "
                    "Cập nhật giá và xác nhận lại hóa đơn."
                )

        supplied_price = raw.get("BH_DonGia", raw.get("unit_price", raw.get("price")))
        unit_price = (
            price_info["price"]
            if supplied_price is None
            else _integer(supplied_price, "Đơn giá")
        )
        if unit_price > price_info["price"]:
            raise ValueError(f"Đơn giá thực bán của {product.name} không hợp lệ.")

        amount = quantity * unit_price
        total_quantity += quantity
        total_amount += amount
        grouped_quantities[product.code] += quantity
        if (
            amount > MAX_SAFE_INTEGER
            or total_quantity > MAX_SAFE_INTEGER
            or total_amount > MAX_SAFE_INTEGER
            or grouped_quantities[product.code] > MAX_SAFE_INTEGER
        ):
            raise ValueError("Tổng số lượng hoặc tổng tiền hóa đơn vượt giới hạn số chính xác.")
        normalized.append(
            {
                "product": product,
                "quantity": quantity,
                "unit_price": unit_price,
                "amount": amount,
            }
        )

    return normalized


def _eligible_lots(product, location, on_date):
    return list(
        StockBalance.objects.filter(
            quantity__gt=0,
            location=location,
            receipt_line__product=product,
            receipt_line__receipt__status=GoodsReceipt.Status.CONFIRMED,
        )
        .filter(
            Q(receipt_line__expiry_date__isnull=True)
            | Q(receipt_line__expiry_date__gte=on_date)
        )
        .select_related("receipt_line")
        .order_by(
            F("receipt_line__expiry_date").asc(nulls_last=True),
            "receipt_line__code",
        )
    )


def acquire_inventory_write_lock():
    InventoryMutationLock.objects.get_or_create(pk=1)
    changed = InventoryMutationLock.objects.filter(pk=1).update(
        version=F("version") + 1
    )
    if changed != 1:
        raise RuntimeError("Inventory write lock is missing; apply its migration.")


@transaction.atomic
def allocate_and_decrement_stock(
    normalized_lines, *, location, employee, invoice_code, on_date=None
):
    on_date = on_date or timezone.localdate()
    lots_by_product = {}
    lot_indexes = defaultdict(int)
    lot_remaining = {}
    for line in normalized_lines:
        product = line["product"]
        if product.code not in lots_by_product:
            lots = _eligible_lots(product, location, on_date)
            lots_by_product[product.code] = lots
            lot_remaining[product.code] = [lot.quantity for lot in lots]
            available = sum(lot_remaining[product.code])
            requested = sum(
                row["quantity"]
                for row in normalized_lines
                if row["product"].code == product.code
            )
            if requested > available:
                raise ValueError(
                    f"{product.name}: tồn có thể bán tại cửa hàng là "
                    f"{available}, không đủ {requested}."
                )

    allocated = []
    quantities_by_lot = defaultdict(int)
    lot_by_id = {}
    for line in normalized_lines:
        product_code = line["product"].code
        lots = lots_by_product[product_code]
        remaining_to_allocate = line["quantity"]
        while remaining_to_allocate:
            index = lot_indexes[product_code]
            while index < len(lots) and lot_remaining[product_code][index] == 0:
                index += 1
            lot_indexes[product_code] = index
            if index >= len(lots):
                raise ValueError(f"Không thể phân bổ FEFO tồn kho cho {line['product'].name}.")

            lot = lots[index]
            quantity = min(remaining_to_allocate, lot_remaining[product_code][index])
            amount = quantity * line["unit_price"]
            if amount > MAX_SAFE_INTEGER:
                raise ValueError(f"Thành tiền {line['product'].name} vượt giới hạn số chính xác.")

            quantities_by_lot[lot.pk] += quantity
            lot_by_id[lot.pk] = lot
            allocated.append(
                {
                    "product": line["product"],
                    "lot_code": lot.receipt_line.code,
                    "quantity": quantity,
                    "unit_price": line["unit_price"],
                    "amount": amount,
                }
            )
            lot_remaining[product_code][index] -= quantity
            remaining_to_allocate -= quantity

    for lot_id, quantity in quantities_by_lot.items():
        lot = lot_by_id[lot_id]
        changed = StockBalance.objects.filter(
            pk=lot_id, quantity__gte=quantity
        ).update(quantity=F("quantity") - quantity)
        if changed != 1:
            raise ValueError(
                f"Tồn kho lô {lot.receipt_line.code} vừa thay đổi; "
                "hãy tải lại giỏ hàng và xác nhận lại."
            )
        StockMovement.objects.create(
            location=location,
            receipt_line=lot.receipt_line,
            employee=employee,
            movement_type=StockMovement.Kind.SALE,
            quantity_delta=-quantity,
            source="HoaDonBanHang",
            document_code=invoice_code,
            note=f"Xác nhận bán tại POS - hóa đơn {invoice_code}",
        )

    return allocated
