from datetime import date, timedelta

from django.apps import apps
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .models import Product, SalePrice

ACTIVE_PRICE_STATUSES = frozenset(
    (SalePrice.Status.ACTIVE, "Có hiệu lực", "Đang hiệu lực")
)


def has_product_history(product):
    for model in apps.get_models():
        if model._meta.app_label == "catalog":
            continue
        for field in model._meta.get_fields():
            if (
                not getattr(field, "many_to_one", False)
                or getattr(field, "auto_created", False)
                or field.remote_field.model is not product.__class__
            ):
                continue
            if model._default_manager.filter(**{field.name: product}).exists():
                return True
    return False


def _overlaps(left, right):
    left_end = left.ends_on or date.max
    right_end = right.ends_on or date.max
    return left.starts_on <= right_end and right.starts_on <= left_end


@transaction.atomic
def save_sale_price(*, product, amount, starts_on, ends_on, status, instance=None):
    candidate = SalePrice(
        product=product,
        amount=amount,
        starts_on=starts_on,
        ends_on=ends_on,
        status=status,
    )
    if status in ACTIVE_PRICE_STATUSES:
        previous_prices = SalePrice.objects.select_for_update().filter(
            product=product, status__in=ACTIVE_PRICE_STATUSES
        )
        if instance:
            previous_prices = previous_prices.exclude(pk=instance.pk)
        previous_prices = previous_prices.order_by("starts_on", "pk")
        for previous in previous_prices:
            if not _overlaps(previous, candidate):
                continue
            if previous.starts_on < starts_on:
                previous.ends_on = starts_on - timedelta(days=1)
                previous.save(update_fields=("ends_on",))
            else:
                raise ValueError(
                    f"Khoảng giá bị chồng với {previous.code}; hãy điều chỉnh ngày hiệu lực."
                )

    if instance is None:
        return SalePrice.objects.create(
            product=product,
            amount=amount,
            starts_on=starts_on,
            ends_on=ends_on,
            status=status,
        )
    instance.product = product
    instance.amount = amount
    instance.starts_on = starts_on
    instance.ends_on = ends_on
    instance.status = status
    instance.save(
        update_fields=("product", "amount", "starts_on", "ends_on", "status")
    )
    return instance


def get_product(product_code):
    return Product.objects.get(code=product_code)


def get_active_price(product, on_date=None):
    on_date = on_date or timezone.localdate()
    prices = list(
        SalePrice.objects.filter(
            product=product,
            status__in=ACTIVE_PRICE_STATUSES,
            starts_on__lte=on_date,
        )
        .filter(Q(ends_on__isnull=True) | Q(ends_on__gte=on_date))
        .order_by("starts_on", "pk")[:2]
    )
    if len(prices) != 1:
        message = (
            "Có nhiều giá bán cùng hiệu lực; cần xử lý."
            if prices
            else "Không có giá bán hợp lệ tại ngày bán."
        )
        return {"price": None, "record": None, "error": message}
    price = prices[0]
    return {"price": price.amount, "record": price, "error": ""}


def to_base_quantity(quantity, factor):
    if isinstance(quantity, bool) or isinstance(factor, bool):
        raise ValueError("Số lượng và tỷ lệ quy đổi phải là số nguyên dương.")
    if not isinstance(quantity, int) or quantity <= 0:
        raise ValueError("Số lượng và tỷ lệ quy đổi phải là số nguyên dương.")
    if not isinstance(factor, int) or factor <= 0:
        raise ValueError("Số lượng và tỷ lệ quy đổi phải là số nguyên dương.")
    converted = quantity * factor
    if converted > 9_007_199_254_740_991:
        raise ValueError("Số lượng quy đổi vượt giới hạn cho phép.")
    return converted


def to_base_unit_price(amount, factor):
    if (
        isinstance(amount, bool)
        or not isinstance(amount, int)
        or amount < 0
        or amount > 9_007_199_254_740_991
        or isinstance(factor, bool)
        or not isinstance(factor, int)
        or factor <= 0
        or factor > 9_007_199_254_740_991
    ):
        raise ValueError("Đơn giá và tỷ lệ quy đổi không hợp lệ.")
    if amount % factor:
        raise ValueError(
            f"Giá đóng gói {amount} VND không chia hết cho tỷ lệ {factor}; "
            "hãy nhập giá theo đơn vị cơ bản hoặc điều chỉnh giá đóng gói."
        )
    return amount // factor
