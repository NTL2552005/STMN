from django.db import IntegrityError, transaction

from apps.accounts.constants import STORE_OWNER_ROLE
from apps.accounts.permissions import user_has_any_role

from .models import Partner


def _can_manage_partners(user):
    return bool(
        user
        and user.is_authenticated
        and (
            user.is_staff
            or user.is_superuser
            or user_has_any_role(user, (STORE_OWNER_ROLE,))
        )
    )


def _can_manage_customers(user):
    return bool(
        user
        and user.is_authenticated
        and (
            user.is_staff
            or user.is_superuser
            or user_has_any_role(user, (STORE_OWNER_ROLE, "Nhân viên bán hàng"))
        )
    )


def get_partner(code):
    return Partner.objects.get(code=code)


def find_partner_by_phone(phone):
    normalized = str(phone or "").strip()
    if not normalized:
        return None
    return Partner.objects.filter(phone=normalized).first()


def _validate_phone(phone, *, exclude_code=""):
    normalized = str(phone or "").strip()
    if normalized and Partner.objects.filter(
        phone_key=normalized.casefold()
    ).exclude(code=exclude_code).exists():
        raise ValueError("Số điện thoại đối tác đã được sử dụng.")
    return normalized or None


def _create_partner(*, name, phone="", address="", bank_account="", role, status):
    phone = _validate_phone(phone)
    try:
        with transaction.atomic():
            return Partner.objects.create(
                name=name,
                phone=phone,
                address=address,
                bank_account=bank_account,
                role=role,
                status=status,
            )
    except IntegrityError:
        if phone and Partner.objects.filter(phone_key=phone.casefold()).exists():
            raise ValueError("Số điện thoại đối tác đã được sử dụng.") from None
        raise


def _save_partner(partner):
    try:
        with transaction.atomic():
            partner.save()
    except IntegrityError:
        if partner.phone and Partner.objects.filter(
            phone_key=partner.phone.casefold()
        ).exclude(pk=partner.pk).exists():
            raise ValueError("Số điện thoại đối tác đã được sử dụng.") from None
        raise
    return partner


def create_partner(
    *,
    user,
    name,
    phone="",
    address="",
    bank_account="",
    role,
    status=Partner.Status.ACTIVE,
):
    if not _can_manage_partners(user):
        raise PermissionError("Chỉ chủ cửa hàng hoặc quản trị viên được quản lý đối tác.")
    if role not in Partner.Role.values:
        raise ValueError("Loại đối tác không hợp lệ.")
    if status not in Partner.Status.values:
        raise ValueError("Trạng thái đối tác không hợp lệ.")
    if not str(name or "").strip():
        raise ValueError("Tên đối tác không được để trống.")
    if find_partner_by_phone(phone):
        raise ValueError("Số điện thoại đối tác đã được sử dụng.")
    return _create_partner(
        name=name.strip(),
        phone=phone,
        address=address,
        bank_account=bank_account,
        role=role,
        status=status,
    )


def update_partner(
    *,
    user,
    code,
    name=None,
    phone=None,
    address=None,
    bank_account=None,
    role=None,
    status=None,
):
    if not _can_manage_partners(user):
        raise PermissionError("Chỉ chủ cửa hàng hoặc quản trị viên được quản lý đối tác.")
    partner = get_partner(code)
    if name is not None:
        if not str(name).strip():
            raise ValueError("Tên đối tác không được để trống.")
        partner.name = name.strip()
    if phone is not None:
        partner.phone = _validate_phone(phone, exclude_code=code)
    if address is not None:
        partner.address = address
    if bank_account is not None:
        partner.bank_account = bank_account
    if role is not None:
        if role not in Partner.Role.values:
            raise ValueError("Loại đối tác không hợp lệ.")
        partner.role = role
    if status is not None:
        if status not in Partner.Status.values:
            raise ValueError("Trạng thái đối tác không hợp lệ.")
        partner.status = status
    return _save_partner(partner)


def save_customer_partner(
    *,
    user,
    name,
    code="",
    phone="",
    address="",
    bank_account="",
    role=Partner.Role.CUSTOMER,
    status=Partner.Status.ACTIVE,
):
    if not _can_manage_customers(user):
        raise PermissionError(
            "Vai trò hiện tại không được thêm hoặc chỉnh sửa khách hàng."
        )
    if role not in (Partner.Role.CUSTOMER, Partner.Role.BOTH):
        raise ValueError("Loại đối tác phải là Khách hàng hoặc Cả hai.")
    if status not in Partner.Status.values:
        raise ValueError("Trạng thái đối tác không hợp lệ.")
    if not str(name or "").strip():
        raise ValueError("Tên khách hàng không được để trống.")

    normalized_phone = str(phone or "").strip()
    if code:
        partner = get_partner(code)
        if partner.role not in (Partner.Role.CUSTOMER, Partner.Role.BOTH):
            raise ValueError("Đối tác chưa có vai trò khách hàng.")
        partner.phone = _validate_phone(normalized_phone, exclude_code=code)
        partner.name = name.strip()
        partner.address = address
        partner.bank_account = bank_account
        partner.role = (
            Partner.Role.BOTH
            if role == Partner.Role.BOTH or partner.role == Partner.Role.BOTH
            else Partner.Role.CUSTOMER
        )
        partner.status = status
        return _save_partner(partner)

    matching = find_partner_by_phone(normalized_phone)
    if matching:
        if matching.role in (Partner.Role.CUSTOMER, Partner.Role.BOTH):
            raise ValueError("Số điện thoại này đã được gắn với một khách hàng.")
        matching.role = Partner.Role.BOTH
        matching.name = name.strip()
        matching.address = address
        matching.bank_account = bank_account
        matching.status = status
        return _save_partner(matching)

    return _create_partner(
        name=name.strip(),
        phone=normalized_phone,
        address=address,
        bank_account=bank_account,
        role=role,
        status=status,
    )
