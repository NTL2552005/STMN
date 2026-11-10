const day = (offset) => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

export const DEMO_THRESHOLD_DAYS = 30;

export function createInitialState() {
  const lines = [
    { PNCT_Ma: "PNCT0001", PN_Ma: "PN0001", HH_Ma: "HH001", PNCT_NSX: day(-90), PNCT_HSD: day(120), PNCT_HSDToiThieu: 30, PNCT_SL: 100, PNCT_DonGia: 8500, PNCT_TTien: 850000 },
    { PNCT_Ma: "PNCT0002", PN_Ma: "PN0002", HH_Ma: "HH001", PNCT_NSX: day(-160), PNCT_HSD: day(-12), PNCT_HSDToiThieu: 30, PNCT_SL: 10, PNCT_DonGia: 8500, PNCT_TTien: 85000 },
    { PNCT_Ma: "PNCT0003", PN_Ma: "PN0002", HH_Ma: "HH002", PNCT_NSX: day(-50), PNCT_HSD: day(150), PNCT_HSDToiThieu: 30, PNCT_SL: 50, PNCT_DonGia: 4000, PNCT_TTien: 200000 },
    { PNCT_Ma: "PNCT0004", PN_Ma: "PN0002", HH_Ma: "HH003", PNCT_NSX: day(-20), PNCT_HSD: day(15), PNCT_HSDToiThieu: 30, PNCT_SL: 30, PNCT_DonGia: 12500, PNCT_TTien: 375000 },
    { PNCT_Ma: "PNCT0005", PN_Ma: "PN0003", HH_Ma: "HH004", PNCT_NSX: "", PNCT_HSD: "", PNCT_HSDToiThieu: null, PNCT_SL: 60, PNCT_DonGia: 3200, PNCT_TTien: 192000 },
    { PNCT_Ma: "PNCT0006", PN_Ma: "PN0003", HH_Ma: "HH005", PNCT_NSX: day(-120), PNCT_HSD: day(8), PNCT_HSDToiThieu: 20, PNCT_SL: 24, PNCT_DonGia: 18000, PNCT_TTien: 432000 },
    { PNCT_Ma: "PNCT0007", PN_Ma: "PN0004", HH_Ma: "HH002", PNCT_NSX: day(-60), PNCT_HSD: day(140), PNCT_HSDToiThieu: 30, PNCT_SL: 20, PNCT_DonGia: 4000, PNCT_TTien: 80000 }
  ];
  const receipts = [
    { PN_Ma: "PN0001", DH_Ma: "DH0001", DT_Ma: "DT001", NV_Ma: "NV002", DD_Ma: "DD001", PN_Ngay: day(-14), PN_TongSL: 100, PN_TongTien: 850000, PN_TrangThai: "Đã xác nhận" },
    { PN_Ma: "PN0002", DH_Ma: null, DT_Ma: "DT002", NV_Ma: "NV002", DD_Ma: "DD001", PN_Ngay: day(-8), PN_TongSL: 90, PN_TongTien: 660000, PN_TrangThai: "Đã xác nhận" },
    { PN_Ma: "PN0003", DH_Ma: null, DT_Ma: "DT003", NV_Ma: "NV002", DD_Ma: "DD001", PN_Ngay: day(-5), PN_TongSL: 84, PN_TongTien: 624000, PN_TrangThai: "Đã xác nhận" },
    { PN_Ma: "PN0004", DH_Ma: "DH0002", DT_Ma: "DT001", NV_Ma: "NV002", DD_Ma: "DD001", PN_Ngay: day(0), PN_TongSL: 20, PN_TongTien: 80000, PN_TrangThai: "Nháp" }
  ];
  const stock = [
    { DD_Ma: "DD001", PNCT_Ma: "PNCT0001", TK_SL: 78 },
    { DD_Ma: "DD002", PNCT_Ma: "PNCT0001", TK_SL: 15 },
    { DD_Ma: "DD001", PNCT_Ma: "PNCT0002", TK_SL: 10 },
    { DD_Ma: "DD001", PNCT_Ma: "PNCT0003", TK_SL: 22 },
    { DD_Ma: "DD002", PNCT_Ma: "PNCT0003", TK_SL: 25 },
    { DD_Ma: "DD001", PNCT_Ma: "PNCT0004", TK_SL: 26 },
    { DD_Ma: "DD001", PNCT_Ma: "PNCT0005", TK_SL: 60 },
    { DD_Ma: "DD001", PNCT_Ma: "PNCT0006", TK_SL: 24 }
  ];
  const movements = [
    { BDK_Ma: "BDK0001", DD_Ma: "DD001", PNCT_Ma: "PNCT0001", NV_Ma: "NV002", BDK_Ngay: `${day(-14)}T09:00:00`, BDK_Loai: "Nhập kho", BDK_SoLuong: 100, BDK_Nguon: "PhieuNhap", BDK_MaChungTu: "PN0001", BDK_GhiChu: "" },
    { BDK_Ma: "BDK0002", DD_Ma: "DD001", PNCT_Ma: "PNCT0001", NV_Ma: "NV002", BDK_Ngay: `${day(-10)}T10:00:00`, BDK_Loai: "Xuất chuyển nội bộ", BDK_SoLuong: -20, BDK_Nguon: "PhieuXuatChuyenNoiBo", BDK_MaChungTu: "PXCN0001", BDK_GhiChu: "Chuyển tới cửa hàng" },
    { BDK_Ma: "BDK0003", DD_Ma: "DD002", PNCT_Ma: "PNCT0001", NV_Ma: "NV004", BDK_Ngay: `${day(-9)}T08:30:00`, BDK_Loai: "Nhận chuyển nội bộ", BDK_SoLuong: 20, BDK_Nguon: "PhieuXuatChuyenNoiBo", BDK_MaChungTu: "PXCN0001", BDK_GhiChu: "Nhận đủ hàng" },
    { BDK_Ma: "BDK0004", DD_Ma: "DD002", PNCT_Ma: "PNCT0001", NV_Ma: null, BDK_Ngay: `${day(-7)}T17:00:00`, BDK_Loai: "Bán hàng", BDK_SoLuong: -5, BDK_Nguon: "HoaDonBanHang", BDK_MaChungTu: "BH0001", BDK_GhiChu: "Bán 5 chai Coca-Cola" },
    { BDK_Ma: "BDK0005", DD_Ma: "DD001", PNCT_Ma: "PNCT0001", NV_Ma: "NV003", BDK_Ngay: `${day(-4)}T14:00:00`, BDK_Loai: "Điều chỉnh kiểm kê", BDK_SoLuong: -2, BDK_Nguon: "PhieuKiemKeKho", BDK_MaChungTu: "PKK0001", BDK_GhiChu: "Thiếu 2 chai" },
    { BDK_Ma: "BDK0006", DD_Ma: "DD001", PNCT_Ma: "PNCT0003", NV_Ma: "NV002", BDK_Ngay: `${day(-8)}T11:00:00`, BDK_Loai: "Nhập kho", BDK_SoLuong: 50, BDK_Nguon: "PhieuNhap", BDK_MaChungTu: "PN0002", BDK_GhiChu: "" },
    { BDK_Ma: "BDK0007", DD_Ma: "DD001", PNCT_Ma: "PNCT0003", NV_Ma: "NV002", BDK_Ngay: `${day(-6)}T09:00:00`, BDK_Loai: "Xuất chuyển nội bộ", BDK_SoLuong: -10, BDK_Nguon: "PhieuXuatChuyenNoiBo", BDK_MaChungTu: "PXCN0002", BDK_GhiChu: "Cửa hàng nhận thiếu 1" },
    { BDK_Ma: "BDK0008", DD_Ma: "DD002", PNCT_Ma: "PNCT0003", NV_Ma: "NV004", BDK_Ngay: `${day(-5)}T09:30:00`, BDK_Loai: "Nhận chuyển nội bộ", BDK_SoLuong: 9, BDK_Nguon: "PhieuXuatChuyenNoiBo", BDK_MaChungTu: "PXCN0002", BDK_GhiChu: "Chênh lệch 1 đơn vị, chờ đối chiếu" },
    { BDK_Ma: "BDK0009", DD_Ma: "DD001", PNCT_Ma: "PNCT0004", NV_Ma: "NV002", BDK_Ngay: `${day(-8)}T11:00:00`, BDK_Loai: "Nhập kho", BDK_SoLuong: 30, BDK_Nguon: "PhieuNhap", BDK_MaChungTu: "PN0002", BDK_GhiChu: "" },
    { BDK_Ma: "BDK0010", DD_Ma: "DD001", PNCT_Ma: "PNCT0005", NV_Ma: "NV002", BDK_Ngay: `${day(-5)}T11:00:00`, BDK_Loai: "Nhập kho", BDK_SoLuong: 60, BDK_Nguon: "PhieuNhap", BDK_MaChungTu: "PN0003", BDK_GhiChu: "" },
    { BDK_Ma: "BDK0011", DD_Ma: "DD001", PNCT_Ma: "PNCT0006", NV_Ma: "NV002", BDK_Ngay: `${day(-5)}T11:00:00`, BDK_Loai: "Nhập kho", BDK_SoLuong: 24, BDK_Nguon: "PhieuNhap", BDK_MaChungTu: "PN0003", BDK_GhiChu: "" },
    { BDK_Ma: "BDK0012", DD_Ma: "DD001", PNCT_Ma: "PNCT0002", NV_Ma: "NV002", BDK_Ngay: `${day(-8)}T11:00:00`, BDK_Loai: "Nhập kho", BDK_SoLuong: 10, BDK_Nguon: "PhieuNhap", BDK_MaChungTu: "PN0002", BDK_GhiChu: "" },
    { BDK_Ma: "BDK0013", DD_Ma: "DD001", PNCT_Ma: "PNCT0004", NV_Ma: "NV002", BDK_Ngay: `${day(-3)}T10:00:00`, BDK_Loai: "Xuất chuyển nội bộ", BDK_SoLuong: -4, BDK_Nguon: "PhieuXuatChuyenNoiBo", BDK_MaChungTu: "PXCN0004", BDK_GhiChu: "Đang vận chuyển tới cửa hàng" },
    { BDK_Ma: "BDK0014", DD_Ma: "DD002", PNCT_Ma: "PNCT0003", NV_Ma: "NV004", BDK_Ngay: `${day(-2)}T15:00:00`, BDK_Loai: "Bán hàng", BDK_SoLuong: -2, BDK_Nguon: "HoaDonBanHang", BDK_MaChungTu: "BH0002", BDK_GhiChu: "Bán chịu cho khách hàng đã lưu" },
    { BDK_Ma: "BDK0015", DD_Ma: "DD001", PNCT_Ma: "PNCT0003", NV_Ma: "NV002", BDK_Ngay: `${day(-1)}T09:00:00`, BDK_Loai: "Xuất chuyển nội bộ", BDK_SoLuong: -18, BDK_Nguon: "PhieuXuatChuyenNoiBo", BDK_MaChungTu: "PXCN0005", BDK_GhiChu: "Bổ sung hàng cho cửa hàng" },
    { BDK_Ma: "BDK0016", DD_Ma: "DD002", PNCT_Ma: "PNCT0003", NV_Ma: "NV004", BDK_Ngay: `${day(-1)}T10:00:00`, BDK_Loai: "Nhận chuyển nội bộ", BDK_SoLuong: 18, BDK_Nguon: "PhieuXuatChuyenNoiBo", BDK_MaChungTu: "PXCN0005", BDK_GhiChu: "Nhận đủ hàng" }
  ];
  return {
    DanhMuc: [
      { DM_Ma: "DM001", DM_Ten: "Nước giải khát", DM_MoTa: "" },
      { DM_Ma: "DM002", DM_Ten: "Sữa và dinh dưỡng", DM_MoTa: "" },
      { DM_Ma: "DM003", DM_Ten: "Thực phẩm khô", DM_MoTa: "" },
      { DM_Ma: "DM004", DM_Ten: "Cà phê và trà", DM_MoTa: "" }
    ],
    HangHoa: [
      { HH_Ma: "HH001", DM_Ma: "DM001", HH_MaVach: "8934588063071", HH_Ten: "Coca-Cola chai 390ml", HH_DVi: "Chai", HH_DViDongGoi: null, HH_TyLeQuyDoi: null, HH_Hinh: "", HH_TrangThai: "Đang kinh doanh" },
      { HH_Ma: "HH002", DM_Ma: "DM001", HH_MaVach: "0123456789012", HH_Ten: "Nước suối Aqua 500ml", HH_DVi: "Chai", HH_DViDongGoi: null, HH_TyLeQuyDoi: null, HH_Hinh: "", HH_TrangThai: "Đang kinh doanh" },
      { HH_Ma: "HH003", DM_Ma: "DM002", HH_Ten: "Sữa tươi tiệt trùng 180ml", HH_DVi: "Hộp", HH_DViDongGoi: null, HH_TyLeQuyDoi: null, HH_Hinh: "", HH_TrangThai: "Đang kinh doanh" },
      { HH_Ma: "HH004", DM_Ma: "DM003", HH_Ten: "Mì ăn liền vị bò", HH_DVi: "Gói", HH_DViDongGoi: null, HH_TyLeQuyDoi: null, HH_Hinh: "", HH_TrangThai: "Đang kinh doanh" },
      { HH_Ma: "HH005", DM_Ma: "DM004", HH_Ten: "Cà phê hòa tan", HH_DVi: "Hộp", HH_DViDongGoi: null, HH_TyLeQuyDoi: null, HH_Hinh: "", HH_TrangThai: "Đang kinh doanh" }
    ],
    DiaDiem: [
      { DD_Ma: "DD001", DD_Ten: "Kho trung tâm", DD_Loai: "Kho", DD_DiaChi: "Quận 1, TP. Hồ Chí Minh", DD_TrangThai: "Hoạt động" },
      { DD_Ma: "DD002", DD_Ten: "Cửa hàng Quận 3", DD_Loai: "Cửa hàng", DD_DiaChi: "Quận 3, TP. Hồ Chí Minh", DD_TrangThai: "Hoạt động" }
    ],
    DoiTacKinhDoanh: [
      { DT_Ma: "DT001", DT_Ten: "Công ty TNHH Nước giải khát Việt", DT_SDT: "0901000001", DT_DChi: "", DT_Loai: "Nhà cung cấp", DT_STK: "", DT_TrangThai: "Hoạt động" },
      { DT_Ma: "DT002", DT_Ten: "Thực phẩm An Phát", DT_SDT: "0901000002", DT_DChi: "", DT_Loai: "Nhà cung cấp", DT_STK: "", DT_TrangThai: "Hoạt động" },
      { DT_Ma: "DT003", DT_Ten: "Đồ uống và tiêu dùng Minh Long", DT_SDT: "0901000003", DT_DChi: "", DT_Loai: "Nhà cung cấp", DT_STK: "", DT_TrangThai: "Hoạt động" },
      { DT_Ma: "DT004", DT_Ten: "Nguyễn Thị Mai", DT_SDT: "0902000001", DT_DChi: "Quận 3, TP. Hồ Chí Minh", DT_Loai: "Khách hàng", DT_STK: "", DT_TrangThai: "Hoạt động" }
    ],
    NhanVien: [
      { NV_Ma: "NV001", NV_Ten: "Nguyễn Minh Anh", NV_SDT: "", NV_DChi: "", NV_NgaySinh: "", NV_GioiTinh: "", NV_NgayVaoLam: day(-400), NV_TrangThai: "Đang làm" },
      { NV_Ma: "NV002", NV_Ten: "Trần Quốc Bảo", NV_SDT: "", NV_DChi: "", NV_NgaySinh: "", NV_GioiTinh: "", NV_NgayVaoLam: day(-300), NV_TrangThai: "Đang làm" },
      { NV_Ma: "NV003", NV_Ten: "Lê Thu Hà", NV_SDT: "", NV_DChi: "", NV_NgaySinh: "", NV_GioiTinh: "", NV_NgayVaoLam: day(-200), NV_TrangThai: "Đang làm" },
      { NV_Ma: "NV004", NV_Ten: "Phạm Gia Huy", NV_SDT: "", NV_DChi: "", NV_NgaySinh: "", NV_GioiTinh: "", NV_NgayVaoLam: day(-100), NV_TrangThai: "Đang làm" }
    ],
    VaiTro: [
      { VT_Ma: "VT001", VT_Ten: "Chủ cửa hàng", VT_MoTa: "Quản lý và giám sát toàn bộ hoạt động cửa hàng." },
      { VT_Ma: "VT002", VT_Ten: "Nhân viên kho", VT_MoTa: "Quản lý phiếu nhập, xuất chuyển và kiểm kê theo quyền." },
      { VT_Ma: "VT003", VT_Ten: "Nhân viên bán hàng", VT_MoTa: "Sử dụng POS, hóa đơn và chức năng khách hàng." },
      { VT_Ma: "VT004", VT_Ten: "Nhân viên kế toán", VT_MoTa: "Quản lý công nợ, thanh toán, thu chi và đối soát." }
    ],
    TaiKhoan: [],
    DatHang: [
      { DH_Ma: "DH0001", DT_Ma: "DT001", NV_Ma: "NV002", DH_Ngay: day(-15), DH_TongSL: 100, DH_TongTien: 850000, DH_TrangThai: "Đã nhận đủ" },
      { DH_Ma: "DH0002", DT_Ma: "DT001", NV_Ma: "NV001", DH_Ngay: day(-1), DH_TongSL: 20, DH_TongTien: 80000, DH_TrangThai: "Đang giao" }
    ],
    DatChiTiet: [
      { DH_Ma: "DH0001", HH_Ma: "HH001", DN_DonGia: 8500, DN_SL: 100, DN_TTien: 850000 },
      { DH_Ma: "DH0002", HH_Ma: "HH002", DN_DonGia: 4000, DN_SL: 20, DN_TTien: 80000 }
    ],
    GiaBan: [
      { GB_Ma: "GB001", HH_Ma: "HH001", GB_DonGia: 12000, GB_NgayBD: day(-30), GB_NgayKT: day(365), GB_TrangThai: "Đang áp dụng" },
      { GB_Ma: "GB002", HH_Ma: "HH002", GB_DonGia: 10000, GB_NgayBD: day(-30), GB_NgayKT: day(365), GB_TrangThai: "Đang áp dụng" },
      { GB_Ma: "GB003", HH_Ma: "HH003", GB_DonGia: 16000, GB_NgayBD: day(-30), GB_NgayKT: day(365), GB_TrangThai: "Đang áp dụng" },
      { GB_Ma: "GB004", HH_Ma: "HH004", GB_DonGia: 5000, GB_NgayBD: day(-30), GB_NgayKT: day(365), GB_TrangThai: "Đang áp dụng" },
      { GB_Ma: "GB005", HH_Ma: "HH005", GB_DonGia: 25000, GB_NgayBD: day(-30), GB_NgayKT: day(365), GB_TrangThai: "Đang áp dụng" }
    ],
    PhieuNhap: receipts,
    PhieuNhapChiTiet: lines,
    TonKho: stock,
    PhieuXuatChuyenNoiBo: [
      { PXCN_Ma: "PXCN0001", DD_Xuat: "DD001", DD_Nhan: "DD002", NV_Ma: "NV002", PXCN_Ngay: day(-10), PXCN_TongSL: 20, PXCN_TrangThai: "Hoàn tất", PXCN_NguoiNhan: "Phạm Gia Huy" },
      { PXCN_Ma: "PXCN0002", DD_Xuat: "DD001", DD_Nhan: "DD002", NV_Ma: "NV002", PXCN_Ngay: day(-6), PXCN_TongSL: 10, PXCN_TrangThai: "Chờ đối chiếu", PXCN_NguoiNhan: "Phạm Gia Huy" },
      { PXCN_Ma: "PXCN0003", DD_Xuat: "DD001", DD_Nhan: "DD002", NV_Ma: "NV001", PXCN_Ngay: day(0), PXCN_TongSL: 4, PXCN_TrangThai: "Chờ xuất", PXCN_NguoiNhan: "Phạm Gia Huy" },
      { PXCN_Ma: "PXCN0004", DD_Xuat: "DD001", DD_Nhan: "DD002", NV_Ma: "NV002", PXCN_Ngay: day(-3), PXCN_TongSL: 4, PXCN_TrangThai: "Đang chuyển", PXCN_NguoiNhan: "Phạm Gia Huy" },
      { PXCN_Ma: "PXCN0005", DD_Xuat: "DD001", DD_Nhan: "DD002", NV_Ma: "NV002", PXCN_Ngay: day(-1), PXCN_TongSL: 18, PXCN_TrangThai: "Hoàn tất", PXCN_NguoiNhan: "Phạm Gia Huy" }
    ],
    PhieuXuatChuyenNoiBoChiTiet: [
      { PXCN_Ma: "PXCN0001", PNCT_Ma: "PNCT0001", PXCN_SL: 20, PXCN_SLThucNhan: 20 },
      { PXCN_Ma: "PXCN0002", PNCT_Ma: "PNCT0003", PXCN_SL: 10, PXCN_SLThucNhan: 9 },
      { PXCN_Ma: "PXCN0003", PNCT_Ma: "PNCT0003", PXCN_SL: 4, PXCN_SLThucNhan: null },
      { PXCN_Ma: "PXCN0004", PNCT_Ma: "PNCT0004", PXCN_SL: 4, PXCN_SLThucNhan: null },
      { PXCN_Ma: "PXCN0005", PNCT_Ma: "PNCT0003", PXCN_SL: 18, PXCN_SLThucNhan: 18 }
    ],
    PhieuKiemKeKho: [
      { PKK_Ma: "PKK0001", DD_Ma: "DD001", NV_Ma: "NV003", NV_Duyet: "NV001", PKK_Ngay: day(-4), PKK_NgayDuyet: day(-4), PKK_TrangThai: "Đã duyệt", PKK_GhiChu: "Kiểm kê định kỳ" },
      { PKK_Ma: "PKK0002", DD_Ma: "DD001", NV_Ma: "NV002", NV_Duyet: null, PKK_Ngay: day(-1), PKK_NgayDuyet: null, PKK_TrangThai: "Chờ duyệt", PKK_GhiChu: "Phát hiện thừa hàng" },
      { PKK_Ma: "PKK0003", DD_Ma: "DD002", NV_Ma: "NV004", NV_Duyet: null, PKK_Ngay: day(-1), PKK_NgayDuyet: null, PKK_TrangThai: "Nháp", PKK_GhiChu: "" }
    ],
    PhieuKiemKeKhoChiTiet: [
      { PKKCT_Ma: "PKKCT0001", PKK_Ma: "PKK0001", PNCT_Ma: "PNCT0001", PKKCT_SLSoSach: 80, PKKCT_SLThucTe: 78, PKKCT_ChenhLech: -2, PKKCT_LyDo: "Thiếu hàng" },
      { PKKCT_Ma: "PKKCT0002", PKK_Ma: "PKK0002", PNCT_Ma: "PNCT0003", PKKCT_SLSoSach: 40, PKKCT_SLThucTe: 42, PKKCT_ChenhLech: 2, PKKCT_LyDo: "Đếm thừa" },
      { PKKCT_Ma: "PKKCT0003", PKK_Ma: "PKK0003", PNCT_Ma: "PNCT0001", PKKCT_SLSoSach: 15, PKKCT_SLThucTe: 15, PKKCT_ChenhLech: 0, PKKCT_LyDo: "" }
    ],
    BienDongKho: movements,
    HoaDonBanHang: [
      { BH_Ma: "BH0001", DT_Ma: null, NV_Ma: "NV004", DD_Ma: "DD002", BH_Ngay: day(-7), BH_TongSL: 5, BH_TongCong: 60000, BH_TrangThai: "Đã xác nhận" },
      { BH_Ma: "BH0002", DT_Ma: "DT004", NV_Ma: "NV004", DD_Ma: "DD002", BH_Ngay: day(-2), BH_TongSL: 2, BH_TongCong: 20000, BH_TrangThai: "Đã xác nhận" }
    ],
    HoaDonBanHangChiTiet: [
      { BH_Ma: "BH0001", PNCT_Ma: "PNCT0001", BH_SL: 5, BH_DonGia: 12000, BH_TTien: 60000 },
      { BH_Ma: "BH0002", PNCT_Ma: "PNCT0003", BH_SL: 2, BH_DonGia: 10000, BH_TTien: 20000 }
    ],
    CongNoKhachHang: [
      { CNKH_Ma: "CNKH0001", BH_Ma: "BH0002", CNKH_TrangThai: "Còn nợ" }
    ],
    ThanhToanBanHang: [
      { TTBH_Ma: "TTBH0001", BH_Ma: "BH0001", TTBH_Ngay: `${day(-7)}T17:00:00`, TTBH_SoTien: 60000, TTBH_PhuongThuc: "Tiền mặt", TTBH_TrangThai: "Thành công" },
      { TTBH_Ma: "TTBH0002", BH_Ma: "BH0002", TTBH_Ngay: `${day(-2)}T15:00:00`, TTBH_SoTien: 5000, TTBH_PhuongThuc: "Tiền mặt", TTBH_TrangThai: "Thành công" }
    ],
    CongNoNCC: [],
    ChiTietNoNCC: [],
    ThanhToanNCC: [],
    PhieuThu: [],
    PhieuChi: []
  };
}
