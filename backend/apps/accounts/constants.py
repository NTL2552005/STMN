ROLE_DEFINITIONS = (
    {
        "code": "VT001",
        "name": "Chủ cửa hàng",
        "description": "Quản lý và giám sát toàn bộ hoạt động cửa hàng.",
    },
    {
        "code": "VT002",
        "name": "Nhân viên kho",
        "description": "Quản lý phiếu nhập, xuất chuyển và kiểm kê theo quyền.",
    },
    {
        "code": "VT003",
        "name": "Nhân viên bán hàng",
        "description": "Sử dụng POS, hóa đơn và chức năng khách hàng.",
    },
    {
        "code": "VT004",
        "name": "Nhân viên kế toán",
        "description": "Quản lý công nợ, thanh toán, thu chi và đối soát.",
    },
)

ROLE_BY_CODE = {role["code"]: role["name"] for role in ROLE_DEFINITIONS}
ROLE_NAMES = tuple(role["name"] for role in ROLE_DEFINITIONS)
STORE_OWNER_ROLE = ROLE_BY_CODE["VT001"]
