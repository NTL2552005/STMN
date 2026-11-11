import { createInitialState } from "../data/kho-mock-data.js";
import {
  getPurchaseOrderReceiptSummary, PURCHASE_ORDER_STATUSES, validateOrderReceiptLines
} from "./purchase-order-utils.js";

const STORAGE_KEY = "stmn-kho-demo-v1";
const clone = (value) => JSON.parse(JSON.stringify(value));
const stamp = () => new Date().toISOString();

function assertValidState(state) {
  if (!state || !Array.isArray(state.TonKho) || !Array.isArray(state.BienDongKho)) {
    throw new Error("Dữ liệu kho không hợp lệ. Hãy khôi phục dữ liệu demo để tiếp tục.");
  }
  const keys = new Set();
  for (const row of state.TonKho) {
    if (!Number.isFinite(row.TK_SL) || row.TK_SL < 0) {
      throw new Error(`Tồn kho không hợp lệ tại ${row.DD_Ma}/${row.PNCT_Ma}.`);
    }
    const key = `${row.DD_Ma}|${row.PNCT_Ma}`;
    if (keys.has(key)) throw new Error(`Dữ liệu tồn kho bị trùng khóa ${key}.`);
    keys.add(key);
  }
}

function nextId(prefix, list, field) {
  const max = list.reduce((highest, row) => {
    const match = String(row[field] || "").match(/(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

function nextNumber(list, field) {
  return list.reduce((highest, row) => {
    const match = String(row[field] || "").match(/(\d+)$/);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;
}

function changeStock(state, { DD_Ma, PNCT_Ma, amount, BDK_Loai, BDK_Nguon, BDK_MaChungTu, NV_Ma = null, BDK_GhiChu = "" }) {
  if (!Number.isFinite(amount) || amount === 0) throw new Error("Số lượng biến động phải khác 0.");
  const row = state.TonKho.find((item) => item.DD_Ma === DD_Ma && item.PNCT_Ma === PNCT_Ma);
  const current = row?.TK_SL || 0;
  if (current + amount < 0) throw new Error(`Tồn khả dụng không đủ (còn ${current}).`);
  if (row) row.TK_SL = current + amount;
  else state.TonKho.push({ DD_Ma, PNCT_Ma, TK_SL: amount });
  state.BienDongKho.push({
    BDK_Ma: nextId("BDK", state.BienDongKho, "BDK_Ma"),
    DD_Ma, PNCT_Ma, NV_Ma, BDK_Ngay: stamp(), BDK_Loai,
    BDK_SoLuong: amount, BDK_Nguon, BDK_MaChungTu, BDK_GhiChu
  });
}

function transact(mutator) {
  const draft = clone(getState());
  const result = mutator(draft);
  assertValidState(draft);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  return result;
}

export function getState() {
  const stored = localStorage.getItem(STORAGE_KEY);
  const state = stored ? JSON.parse(stored) : createInitialState();
  let migrated = !stored;
  if (!Array.isArray(state.GiaBan)) {
    state.GiaBan = createInitialState().GiaBan;
    migrated = true;
  }
  for (const table of [
    "HoaDonBanHang", "HoaDonBanHangChiTiet", "ThanhToanBanHang", "CongNoKhachHang",
    "VaiTro", "TaiKhoan", "CongNoNCC", "ChiTietNoNCC", "ThanhToanNCC", "PhieuThu", "PhieuChi"
  ]) {
    if (!Array.isArray(state[table])) {
      state[table] = [];
      migrated = true;
    }
  }
  for (const voucher of state.PhieuThu) {
    if (voucher.TTBH_Ma === undefined) {
      voucher.TTBH_Ma = null;
      migrated = true;
    }
  }
  const qrSalesPaymentIds = new Set();
  for (const payment of state.ThanhToanBanHang) {
    if (payment.TTBH_PhuongThuc === "QR") {
      payment.TTBH_PhuongThuc = "Chuyển khoản";
      qrSalesPaymentIds.add(payment.TTBH_Ma);
      migrated = true;
    }
  }
  for (const voucher of state.PhieuThu) {
    if (qrSalesPaymentIds.has(voucher.TTBH_Ma) && voucher.PT_PhuongThuc === "QR") {
      voucher.PT_PhuongThuc = "Chuyển khoản";
      migrated = true;
    }
  }
  if (!Array.isArray(state.TraHangNCC)) {
    state.TraHangNCC = [];
    migrated = true;
  }
  if (Array.isArray(state.NhanVien)) {
    const employeeDefaults = {
      NV_SDT: "", NV_DChi: "", NV_NgaySinh: "", NV_GioiTinh: "",
      NV_NgayVaoLam: "", NV_TrangThai: "Đang làm"
    };
    for (const employee of state.NhanVien) {
      for (const [field, value] of Object.entries(employeeDefaults)) {
        if (employee[field] === undefined) {
          employee[field] = value;
          migrated = true;
        }
      }
    }
  }
  if (Array.isArray(state.HangHoa)) {
    for (const item of state.HangHoa) {
      if (item.HH_MaVach === undefined || item.HH_MaVach === null) {
        item.HH_MaVach = "";
        migrated = true;
      } else if (typeof item.HH_MaVach !== "string") {
        item.HH_MaVach = String(item.HH_MaVach).trim();
        migrated = true;
      }
      if (item.HH_DViDongGoi === undefined) {
        item.HH_DViDongGoi = null;
        migrated = true;
      } else if (item.HH_DViDongGoi !== null && typeof item.HH_DViDongGoi !== "string") {
        item.HH_DViDongGoi = String(item.HH_DViDongGoi).trim();
        migrated = true;
      }
      if (item.HH_TyLeQuyDoi === undefined) {
        item.HH_TyLeQuyDoi = null;
        migrated = true;
      } else if (item.HH_TyLeQuyDoi !== null && item.HH_TyLeQuyDoi !== "") {
        const ratio = Number(item.HH_TyLeQuyDoi);
        if (Number.isSafeInteger(ratio) && ratio > 0 && item.HH_TyLeQuyDoi !== ratio) {
          item.HH_TyLeQuyDoi = ratio;
          migrated = true;
        }
      }
    }
  }
  if (!state.VaiTro.length) {
    state.VaiTro = createInitialState().VaiTro;
    migrated = true;
  }
  if (Array.isArray(state.DoiTacKinhDoanh) && !state.DoiTacKinhDoanh.some((row) => row.DT_Ma === "DT004")) {
    const demoCustomer = createInitialState().DoiTacKinhDoanh.find((row) => row.DT_Ma === "DT004");
    state.DoiTacKinhDoanh.push(demoCustomer);
    migrated = true;
  }
  if (Array.isArray(state.HoaDonBanHang) && state.HoaDonBanHang.some((row) => row.BH_Ma === "BH0001") && !state.ThanhToanBanHang.length) {
    state.ThanhToanBanHang.push({
      TTBH_Ma: "TTBH0001", BH_Ma: "BH0001", TTBH_Ngay: `${state.HoaDonBanHang.find((row) => row.BH_Ma === "BH0001").BH_Ngay}T17:00:00`,
      TTBH_SoTien: 60000, TTBH_PhuongThuc: "Tiền mặt", TTBH_TrangThai: "Thành công"
    });
    migrated = true;
  }
  assertValidState(state);
  if (migrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

export function runDemoTransaction(mutator) {
  return transact(mutator);
}

export function applyStockMovement(state, movement) {
  changeStock(state, movement);
}

export function generateDemoId(prefix, rows, field) {
  return nextId(prefix, rows, field);
}

export function resetDemoData() {
  const state = createInitialState();
  assertValidState(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  localStorage.removeItem("stmn-pos-draft-meta-v1");
  localStorage.removeItem("stmn-cash-register-shifts-demo-v1");
  return state;
}

export function saveInbound({ PN_Ma, DT_Ma, DD_Ma, DH_Ma, PN_Ngay, NV_Ma, lines }) {
  return transact((state) => {
    const existing = PN_Ma ? state.PhieuNhap.find((item) => item.PN_Ma === PN_Ma) : null;
    if (existing && existing.PN_TrangThai !== "Nháp") throw new Error("Chỉ được chỉnh sửa phiếu nhập ở trạng thái Nháp.");
    if (!DT_Ma || !DD_Ma || !PN_Ngay || !lines.length) throw new Error("Vui lòng nhập đủ thông tin phiếu và ít nhất một dòng hàng.");
    if (DH_Ma) {
      const order = state.DatHang.find((item) => item.DH_Ma === DH_Ma);
      if (!order) throw new Error("Không tìm thấy đơn đặt hàng đã chọn.");
      if (order.DT_Ma !== DT_Ma) throw new Error("Nhà cung cấp của phiếu nhập phải trùng với đơn đặt hàng.");
      const status = getPurchaseOrderReceiptSummary(state, order).status;
      if (![PURCHASE_ORDER_STATUSES.waiting, PURCHASE_ORDER_STATUSES.partial].includes(status)) {
        throw new Error("Chỉ nhận hàng theo đơn đã xác nhận và chưa nhận đủ.");
      }
    }
    const PN = existing || { PN_Ma: nextId("PN", state.PhieuNhap, "PN_Ma") };
    let nextLineNumber = nextNumber(state.PhieuNhapChiTiet, "PNCT_Ma");
    const details = lines.map((line) => {
      const quantity = Number(line.PNCT_SL);
      const price = Number(line.PNCT_DonGia);
      if (!state.HangHoa.some((item) => item.HH_Ma === line.HH_Ma)) throw new Error("Mặt hàng trong phiếu nhập không hợp lệ.");
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Số lượng nhập theo đơn vị cơ bản phải là số nguyên dương.");
      if (!Number.isSafeInteger(price) || price < 0) throw new Error("Đơn giá theo đơn vị cơ bản phải là số nguyên VND không âm.");
      if (line.PNCT_NSX && line.PNCT_HSD && line.PNCT_HSD < line.PNCT_NSX) throw new Error("Hạn sử dụng không được trước ngày sản xuất.");
      const id = line.PNCT_Ma || `PNCT${String(nextLineNumber++).padStart(4, "0")}`;
      const row = {
        PNCT_Ma: id, PN_Ma: PN.PN_Ma, HH_Ma: line.HH_Ma,
        PNCT_NSX: line.PNCT_NSX || "", PNCT_HSD: line.PNCT_HSD || "",
        PNCT_HSDToiThieu: line.PNCT_HSDToiThieu === "" ? null : Number(line.PNCT_HSDToiThieu),
        PNCT_SL: quantity, PNCT_DonGia: price, PNCT_TTien: quantity * price
      };
      if (!Number.isSafeInteger(row.PNCT_TTien)) throw new Error("Thành tiền phiếu nhập vượt giới hạn số tiền chính xác.");
      return row;
    });
    const uniqueIds = new Set(details.map((row) => row.PNCT_Ma));
    if (uniqueIds.size !== details.length) throw new Error("Mã dòng nhập bị trùng.");
    const totalQuantity = details.reduce((sum, row) => sum + row.PNCT_SL, 0);
    const totalAmount = details.reduce((sum, row) => sum + row.PNCT_TTien, 0);
    if (!Number.isSafeInteger(totalQuantity) || !Number.isSafeInteger(totalAmount)) {
      throw new Error("Tổng số lượng hoặc thành tiền phiếu nhập vượt giới hạn số chính xác.");
    }
    if (DH_Ma) validateOrderReceiptLines(state, DH_Ma, details, PN?.PN_Ma || PN_Ma || "", false);
    state.PhieuNhapChiTiet = state.PhieuNhapChiTiet.filter((row) => row.PN_Ma !== PN.PN_Ma);
    state.PhieuNhapChiTiet.push(...details);
    Object.assign(PN, {
      DH_Ma: DH_Ma || null, DT_Ma, NV_Ma, DD_Ma, PN_Ngay,
      PN_TongSL: totalQuantity,
      PN_TongTien: totalAmount,
      PN_TrangThai: "Nháp"
    });
    if (!existing) state.PhieuNhap.push(PN);
    return PN.PN_Ma;
  });
}

export function submitInboundForReview(PN_Ma) {
  return transact((state) => {
    const receipt = state.PhieuNhap.find((item) => item.PN_Ma === PN_Ma);
    if (!receipt || receipt.PN_TrangThai !== "Nháp") throw new Error("Chỉ gửi phiếu nhập ở trạng thái Nháp.");
    const details = state.PhieuNhapChiTiet.filter((item) => item.PN_Ma === PN_Ma);
    if (!details.length) throw new Error("Phiếu nhập chưa có hàng hóa.");
    if (receipt.DH_Ma) validateOrderReceiptLines(state, receipt.DH_Ma, details, PN_Ma, false);
    receipt.PN_TrangThai = "Chờ kế toán xác nhận";
    return PN_Ma;
  });
}

export function confirmInboundInState(state, PN_Ma) {
  const receipt = state.PhieuNhap.find((item) => item.PN_Ma === PN_Ma);
  if (!receipt || receipt.PN_TrangThai !== "Chờ kế toán xác nhận") {
    throw new Error("Phiếu nhập chưa được gửi kế toán xác nhận hoặc đã xử lý.");
  }
  const details = state.PhieuNhapChiTiet.filter((item) => item.PN_Ma === PN_Ma);
  if (!details.length) throw new Error("Phiếu nhập chưa có hàng hóa.");
  if (receipt.DH_Ma) validateOrderReceiptLines(state, receipt.DH_Ma, details, PN_Ma, true);
  for (const line of details) {
    changeStock(state, {
      DD_Ma: receipt.DD_Ma, PNCT_Ma: line.PNCT_Ma, amount: line.PNCT_SL,
      BDK_Loai: "Nhập kho", BDK_Nguon: "PhieuNhap", BDK_MaChungTu: PN_Ma,
      NV_Ma: receipt.NV_Ma
    });
  }
  receipt.PN_TrangThai = "Đã xác nhận";
  const order = state.DatHang.find((row) => row.DH_Ma === receipt.DH_Ma);
  if (order) {
    const summary = getPurchaseOrderReceiptSummary(state, order);
    order.DH_TrangThai = summary.status;
  }
  return PN_Ma;
}

export function confirmInbound(PN_Ma) {
  return transact((state) => confirmInboundInState(state, PN_Ma));
}

export function cancelInbound(PN_Ma) {
  return transact((state) => {
    const receipt = state.PhieuNhap.find((item) => item.PN_Ma === PN_Ma);
    if (!receipt || receipt.PN_TrangThai !== "Nháp") throw new Error("Chỉ được hủy phiếu nhập chưa ghi nhận tồn.");
    receipt.PN_TrangThai = "Đã hủy";
  });
}

export function createTransfer({ DD_Xuat, DD_Nhan, NV_Ma, role = "", PXCN_Ngay, PXCN_NguoiNhan, lines }) {
  return transact((state) => {
    if (!["Chủ cửa hàng", "Nhân viên kế toán"].includes(role)) throw new Error("Vai trò hiện tại không được lập phiếu chuyển.");
    if (!DD_Xuat || !DD_Nhan || DD_Xuat === DD_Nhan) throw new Error("Địa điểm xuất phải khác địa điểm nhận.");
    if (!state.DiaDiem.some((row) => row.DD_Ma === DD_Xuat && row.DD_TrangThai === "Hoạt động") ||
      !state.DiaDiem.some((row) => row.DD_Ma === DD_Nhan && row.DD_TrangThai === "Hoạt động")) {
      throw new Error("Địa điểm xuất và nhận phải tồn tại, đang hoạt động.");
    }
    if (!NV_Ma || !state.NhanVien.some((row) => row.NV_Ma === NV_Ma)) throw new Error("Nhân viên lập phiếu không hợp lệ.");
    if (!PXCN_Ngay) throw new Error("Ngày chuyển không được để trống.");
    if (!Array.isArray(lines) || !lines.length) throw new Error("Phiếu chuyển cần ít nhất một dòng hàng.");
    const seen = new Set();
    const details = lines.map((line) => {
      const qty = Number(line.PXCN_SL);
      if (!Number.isInteger(qty) || qty <= 0) throw new Error("Số lượng chuyển phải là số nguyên lớn hơn 0.");
      if (seen.has(line.PNCT_Ma)) throw new Error("Không thể lặp lại cùng một dòng nhập trong phiếu chuyển.");
      seen.add(line.PNCT_Ma);
      const sourceLine = state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === line.PNCT_Ma);
      const receipt = sourceLine && state.PhieuNhap.find((row) => row.PN_Ma === sourceLine.PN_Ma);
      const item = sourceLine && state.HangHoa.find((row) => row.HH_Ma === sourceLine.HH_Ma);
      if (!sourceLine || receipt?.PN_TrangThai !== "Đã xác nhận" || item?.HH_TrangThai !== "Đang kinh doanh") {
        throw new Error(`Dòng nhập ${line.PNCT_Ma || "(chưa chọn)"} không phải hàng hợp lệ để chuyển.`);
      }
      if (sourceLine.PNCT_HSD && sourceLine.PNCT_HSD < new Date().toISOString().slice(0, 10)) {
        throw new Error(`Dòng nhập ${line.PNCT_Ma} đã hết hạn, không thể chuyển để bán.`);
      }
      const stock = state.TonKho.find((row) => row.DD_Ma === DD_Xuat && row.PNCT_Ma === line.PNCT_Ma)?.TK_SL || 0;
      if (qty > stock) throw new Error(`Số lượng chuyển vượt tồn khả dụng (${stock}).`);
      return { PXCN_Ma: "", PNCT_Ma: line.PNCT_Ma, PXCN_SL: qty, PXCN_SLThucNhan: null };
    });
    const transfer = {
      PXCN_Ma: nextId("PXCN", state.PhieuXuatChuyenNoiBo, "PXCN_Ma"),
      DD_Xuat, DD_Nhan, NV_Ma, PXCN_Ngay, PXCN_TongSL: details.reduce((sum, line) => sum + line.PXCN_SL, 0),
      PXCN_TrangThai: "Chờ xuất", PXCN_NguoiNhan: PXCN_NguoiNhan || ""
    };
    state.PhieuXuatChuyenNoiBo.push(transfer);
    state.PhieuXuatChuyenNoiBoChiTiet.push(...details.map((line) => ({ ...line, PXCN_Ma: transfer.PXCN_Ma })));
    return transfer.PXCN_Ma;
  });
}

export function dispatchTransfer(PXCN_Ma, NV_Ma, role = "") {
  return transact((state) => {
    if (!["Chủ cửa hàng", "Nhân viên kho"].includes(role)) throw new Error("Vai trò hiện tại không được xác nhận xuất chuyển.");
    if (!NV_Ma || !state.NhanVien.some((row) => row.NV_Ma === NV_Ma)) throw new Error("Nhân viên xuất chuyển không hợp lệ.");
    const transfer = state.PhieuXuatChuyenNoiBo.find((row) => row.PXCN_Ma === PXCN_Ma);
    if (!transfer || transfer.PXCN_TrangThai !== "Chờ xuất") throw new Error("Phiếu chuyển không ở trạng thái chờ xuất.");
    const lines = state.PhieuXuatChuyenNoiBoChiTiet.filter((row) => row.PXCN_Ma === PXCN_Ma);
    if (!lines.length) throw new Error("Phiếu chuyển không có chi tiết để xuất.");
    const seen = new Set();
    for (const line of lines) {
      const sourceLine = state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === line.PNCT_Ma);
      const receipt = sourceLine && state.PhieuNhap.find((row) => row.PN_Ma === sourceLine.PN_Ma);
      const item = sourceLine && state.HangHoa.find((row) => row.HH_Ma === sourceLine.HH_Ma);
      const available = state.TonKho.find((row) => row.DD_Ma === transfer.DD_Xuat && row.PNCT_Ma === line.PNCT_Ma)?.TK_SL || 0;
      if (seen.has(line.PNCT_Ma) || receipt?.PN_TrangThai !== "Đã xác nhận" || item?.HH_TrangThai !== "Đang kinh doanh" ||
        (sourceLine.PNCT_HSD && sourceLine.PNCT_HSD < new Date().toISOString().slice(0, 10))) {
        throw new Error(`Dòng nhập ${line.PNCT_Ma} không còn hợp lệ để xuất.`);
      }
      seen.add(line.PNCT_Ma);
      if (!Number.isInteger(line.PXCN_SL) || line.PXCN_SL <= 0 || available < line.PXCN_SL) {
        throw new Error(`Tồn khả dụng tại kho xuất không đủ cho dòng ${line.PNCT_Ma} (còn ${available}).`);
      }
    }
    for (const line of lines) {
      changeStock(state, {
        DD_Ma: transfer.DD_Xuat, PNCT_Ma: line.PNCT_Ma, amount: -line.PXCN_SL,
        BDK_Loai: "Xuất chuyển nội bộ", BDK_Nguon: "PhieuXuatChuyenNoiBo",
        BDK_MaChungTu: PXCN_Ma, NV_Ma
      });
    }
    transfer.PXCN_TrangThai = "Đang chuyển";
  });
}

export function receiveTransfer(PXCN_Ma, actualQuantities, NV_Ma, PXCN_NguoiNhan = "", role = "") {
  return transact((state) => {
    if (!["Chủ cửa hàng", "Nhân viên bán hàng"].includes(role)) throw new Error("Vai trò hiện tại không được xác nhận nhận chuyển.");
    if (!NV_Ma || !state.NhanVien.some((row) => row.NV_Ma === NV_Ma)) throw new Error("Nhân viên nhận hàng không hợp lệ.");
    const transfer = state.PhieuXuatChuyenNoiBo.find((row) => row.PXCN_Ma === PXCN_Ma);
    if (!transfer || transfer.PXCN_TrangThai !== "Đang chuyển") throw new Error("Chỉ xác nhận nhận hàng khi phiếu đang chuyển.");
    const lines = state.PhieuXuatChuyenNoiBoChiTiet.filter((row) => row.PXCN_Ma === PXCN_Ma);
    if (!lines.length || !actualQuantities || typeof actualQuantities !== "object") throw new Error("Thông tin thực nhận không hợp lệ.");
    const seen = new Set();
    for (const line of lines) {
      const received = Number(actualQuantities[line.PNCT_Ma]);
      if (seen.has(line.PNCT_Ma)) throw new Error(`Dòng nhập ${line.PNCT_Ma} bị lặp trong phiếu chuyển.`);
      seen.add(line.PNCT_Ma);
      if (!Number.isInteger(received) || received < 0 || received > line.PXCN_SL) throw new Error("Số lượng thực nhận phải từ 0 đến số lượng đã xuất.");
    }
    for (const line of lines) {
      const received = Number(actualQuantities[line.PNCT_Ma]);
      line.PXCN_SLThucNhan = received;
      if (received > 0) {
        changeStock(state, {
          DD_Ma: transfer.DD_Nhan, PNCT_Ma: line.PNCT_Ma, amount: received,
          BDK_Loai: "Nhận chuyển nội bộ", BDK_Nguon: "PhieuXuatChuyenNoiBo",
          BDK_MaChungTu: PXCN_Ma, NV_Ma,
          BDK_GhiChu: received === line.PXCN_SL ? "" : `Chênh lệch ${line.PXCN_SL - received} đơn vị, chờ đối chiếu`
        });
      }
    }
    if (PXCN_NguoiNhan.trim()) transfer.PXCN_NguoiNhan = PXCN_NguoiNhan.trim();
    transfer.PXCN_TrangThai = lines.every((line) => line.PXCN_SLThucNhan === line.PXCN_SL) ? "Hoàn tất" : "Chờ đối chiếu";
  });
}

export function createCount({ DD_Ma, NV_Ma, PKK_Ngay, PKK_GhiChu, lines }) {
  return transact((state) => {
    if (!DD_Ma || !lines.length) throw new Error("Chọn địa điểm và nhập ít nhất một dòng kiểm kê.");
    const seen = new Set();
    let nextCountLineNumber = nextNumber(state.PhieuKiemKeKhoChiTiet, "PKKCT_Ma");
    const doc = {
      PKK_Ma: nextId("PKK", state.PhieuKiemKeKho, "PKK_Ma"), DD_Ma, NV_Ma,
      NV_Duyet: null, PKK_Ngay, PKK_NgayDuyet: null, PKK_TrangThai: "Nháp", PKK_GhiChu: PKK_GhiChu || ""
    };
    const details = lines.map((line) => {
      if (seen.has(line.PNCT_Ma)) throw new Error("Một mã dòng nhập không được xuất hiện trùng trong phiếu kiểm kê.");
      seen.add(line.PNCT_Ma);
      const book = Number(line.PKKCT_SLSoSach);
      const actual = Number(line.PKKCT_SLThucTe);
      const now = state.TonKho.find((row) => row.DD_Ma === DD_Ma && row.PNCT_Ma === line.PNCT_Ma)?.TK_SL || 0;
      if (!Number.isInteger(actual) || actual < 0) throw new Error("Số lượng thực tế phải là số nguyên không âm.");
      if (book !== now) throw new Error("Số liệu tồn đã thay đổi sau khi chốt kiểm kê. Hãy tải lại và lập phiếu mới.");
      return {
        PKKCT_Ma: `PKKCT${String(nextCountLineNumber++).padStart(4, "0")}`,
        PKK_Ma: doc.PKK_Ma, PNCT_Ma: line.PNCT_Ma, PKKCT_SLSoSach: book,
        PKKCT_SLThucTe: actual, PKKCT_ChenhLech: actual - book, PKKCT_LyDo: line.PKKCT_LyDo || ""
      };
    });
    state.PhieuKiemKeKho.push(doc);
    state.PhieuKiemKeKhoChiTiet.push(...details);
    return doc.PKK_Ma;
  });
}

export function submitCount(PKK_Ma) {
  return transact((state) => {
    const count = state.PhieuKiemKeKho.find((row) => row.PKK_Ma === PKK_Ma);
    if (!count || count.PKK_TrangThai !== "Nháp") throw new Error("Chỉ gửi duyệt được phiếu kiểm kê ở trạng thái nháp.");
    const lines = state.PhieuKiemKeKhoChiTiet.filter((row) => row.PKK_Ma === PKK_Ma);
    if (!lines.length) throw new Error("Phiếu kiểm kê không có chi tiết.");
    count.PKK_TrangThai = "Chờ duyệt";
  });
}

export function approveCount(PKK_Ma, NV_Duyet, role = "") {
  return transact((state) => {
    if (role !== "Chủ cửa hàng") throw new Error("Chỉ chủ cửa hàng được duyệt phiếu kiểm kê.");
    const count = state.PhieuKiemKeKho.find((row) => row.PKK_Ma === PKK_Ma);
    if (!count || count.PKK_TrangThai !== "Chờ duyệt") throw new Error("Phiếu không chờ duyệt hoặc đã được duyệt.");
    const lines = state.PhieuKiemKeKhoChiTiet.filter((row) => row.PKK_Ma === PKK_Ma);
    for (const line of lines) {
      const current = state.TonKho.find((row) => row.DD_Ma === count.DD_Ma && row.PNCT_Ma === line.PNCT_Ma)?.TK_SL || 0;
      const laterMovement = state.BienDongKho.some((movement) =>
        movement.DD_Ma === count.DD_Ma && movement.PNCT_Ma === line.PNCT_Ma &&
        String(movement.BDK_Ngay).slice(0, 10) > count.PKK_Ngay
      );
      if (laterMovement) throw new Error(`Dòng nhập ${line.PNCT_Ma} có biến động kho sau ngày kiểm kê. Hãy kiểm tra lại và lập phiếu mới.`);
      if (current !== line.PKKCT_SLSoSach) throw new Error(`Tồn ${line.PNCT_Ma} đã thay đổi sau kiểm kê (${line.PKKCT_SLSoSach} → ${current}). Không thể duyệt phiếu.`);
    }
    for (const line of lines) {
      if (line.PKKCT_ChenhLech) {
        changeStock(state, {
          DD_Ma: count.DD_Ma, PNCT_Ma: line.PNCT_Ma, amount: line.PKKCT_ChenhLech,
          BDK_Loai: "Điều chỉnh kiểm kê", BDK_Nguon: "PhieuKiemKeKho",
          BDK_MaChungTu: PKK_Ma, NV_Ma: NV_Duyet, BDK_GhiChu: line.PKKCT_LyDo
        });
      }
    }
    count.NV_Duyet = NV_Duyet;
    count.PKK_NgayDuyet = new Date().toISOString().slice(0, 10);
    count.PKK_TrangThai = "Đã duyệt";
  });
}
