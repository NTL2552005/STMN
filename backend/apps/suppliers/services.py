from apps.partners.models import Partner
from apps.partners.services import get_partner


def get_supplier(code):
    partner = get_partner(code)
    if partner.role not in (Partner.Role.SUPPLIER, Partner.Role.BOTH):
        raise Partner.DoesNotExist(f"Không tìm thấy nhà cung cấp {code}.")
    return partner


def get_active_supplier(code):
    partner = get_supplier(code)
    if partner.status != Partner.Status.ACTIVE:
        raise Partner.DoesNotExist(f"Không tìm thấy nhà cung cấp đang hoạt động {code}.")
    return partner


def supplier_is_selectable(code):
    return Partner.objects.filter(
        code=code,
        role__in=(Partner.Role.SUPPLIER, Partner.Role.BOTH),
        status=Partner.Status.ACTIVE,
    ).exists()
