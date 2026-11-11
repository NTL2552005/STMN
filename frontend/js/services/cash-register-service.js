import { getState } from "./kho-service.js";

const STORAGE_KEY = "stmn-cash-register-shifts-demo-v1";
const cashierRoles = new Set(["Chủ cửa hàng", "Nhân viên bán hàng"]);
const accountantRoles = new Set(["Nhân viên kế toán"]);
const roleEmployees = { "Chủ cửa hàng": "NV001", "Nhân viên bán hàng": "NV004" };
const clone = (value) => JSON.parse(JSON.stringify(value));
const stamp = () => new Date().toISOString();
const safeAmount = (value, label, allowZero = true) => {
  if (value === "" || value === null || value === undefined) {
    throw new Error(`${label} phải là số nguyên VND.`);
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || (allowZero ? amount < 0 : amount <= 0)) {
    throw new Error(`${label} phải là số nguyên VND ${allowZero ? "không âm" : "lớn hơn 0"}.`);
  }
  return amount;
};

function readShifts() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const shifts = JSON.parse(raw);
  if (!Array.isArray(shifts)) throw new Error("Dữ liệu ca bán hàng demo không hợp lệ.");
  return shifts;
}

function writeShifts(shifts) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shifts));
}

function nextShiftId(shifts) {
  const number = shifts.reduce((max, shift) => {
    const match = String(shift.Ca_Ma || "").match(/(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  return `CA${String(number).padStart(5, "0")}`;
}

function updateShift(shiftId, update) {
  const shifts = readShifts();
  const shift = shifts.find((row) => row.Ca_Ma === shiftId);
  if (!shift) throw new Error("Không tìm thấy ca bán hàng.");
  const result = update(shift, shifts);
  writeShifts(shifts);
  return result;
}

function requireCashier(shift, role, employeeId) {
  if (!cashierRoles.has(role) || roleEmployees[role] !== employeeId || shift.NV_Ma !== employeeId) {
    throw new Error("Chỉ nhân viên bán hàng sở hữu ca mới được thực hiện thao tác này.");
  }
}

function requireAccountant(role) {
  if (!accountantRoles.has(role)) throw new Error("Chỉ nhân viên kế toán được đối soát hoặc xác nhận bàn giao.");
}

export function getCashShifts() {
  return readShifts().map(clone);
}

export function getCashShift(shiftId) {
  const shift = readShifts().find((row) => row.Ca_Ma === shiftId);
  return shift ? clone(shift) : null;
}

export function getOpenCashShift(employeeId, locationId = "") {
  const shift = readShifts().find((row) => row.NV_Ma === employeeId
    && row.TrangThai === "Đang mở"
    && (!locationId || row.DD_Ma === locationId));
  return shift ? clone(shift) : null;
}

export function getCashShiftForPayment(TTBH_Ma) {
  const shift = readShifts().find((row) => row.paymentIds.includes(TTBH_Ma));
  return shift ? clone(shift) : null;
}

export function openCashShift({ employeeId, locationId, openingCash, note = "" }, role) {
  if (!cashierRoles.has(role) || roleEmployees[role] !== employeeId) {
    throw new Error("Chỉ nhân viên bán hàng sở hữu vai trò hiện tại được mở ca.");
  }
  const employee = getState().NhanVien.find((row) => row.NV_Ma === employeeId && row.NV_TrangThai === "Đang làm");
  const location = getState().DiaDiem.find((row) => row.DD_Ma === locationId
    && row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động");
  if (!employee) throw new Error("Nhân viên bán hàng không hợp lệ hoặc đã ngừng làm.");
  if (!location) throw new Error("Địa điểm bán không hợp lệ.");
  const openingAmount = safeAmount(openingCash, "Tiền mặt đầu ca");
  const shifts = readShifts();
  if (shifts.some((shift) => shift.NV_Ma === employeeId && shift.TrangThai === "Đang mở")) {
    throw new Error("Nhân viên đã có ca đang mở. Hãy tiếp tục ca đó hoặc kết ca trước.");
  }
  const openedAt = stamp();
  const shift = {
    Ca_Ma: nextShiftId(shifts),
    NV_Ma: employeeId,
    DD_Ma: locationId,
    GioMo: openedAt,
    GioDong: null,
    TienMatDauCa: openingAmount,
    invoiceIds: [],
    paymentIds: [],
    TienMatThucDem: null,
    TienMatDuKien: null,
    ChenhLech: null,
    GiaiTrinh: "",
    GhiChu: String(note || "").trim(),
    TrangThai: "Đang mở",
    ThoiDiemGuiDoiSoat: null,
    NguoiYeuCauGiaiTrinh: "",
    ThoiDiemYeuCauGiaiTrinh: null,
    GhiChuKeToan: "",
    NguoiDoiSoat: "",
    ThoiDiemDoiSoat: null,
    TienMatBanGiao: null,
    NguoiNhanBanGiao: "",
    ThoiDiemXacNhanBanGiao: null,
    GhiChuBanGiao: ""
  };
  shifts.push(shift);
  writeShifts(shifts);
  return shift.Ca_Ma;
}

export function attachCashShiftSale(shiftId, invoiceId, paymentIds = []) {
  return updateShift(shiftId, (shift, shifts) => {
    if (shift.TrangThai !== "Đang mở") throw new Error("Ca đã đóng; không thể gắn giao dịch mới.");
    if (shifts.some((row) => row.Ca_Ma !== shiftId && row.invoiceIds.includes(invoiceId))) {
      throw new Error("Hóa đơn đã được gắn với một ca khác.");
    }
    if (shift.invoiceIds.includes(invoiceId)) throw new Error("Hóa đơn đã được gắn với ca này.");
    shift.invoiceIds.push(invoiceId);
    for (const paymentId of paymentIds) {
      if (shifts.some((row) => row.Ca_Ma !== shiftId && row.paymentIds.includes(paymentId))) {
        throw new Error("Thanh toán đã được gắn với một ca khác.");
      }
      if (shift.paymentIds.includes(paymentId)) throw new Error("Thanh toán đã được gắn với ca này.");
      shift.paymentIds.push(paymentId);
    }
    return shift.Ca_Ma;
  });
}

export function detachCashShiftSale(shiftId, invoiceId, paymentIds = []) {
  return updateShift(shiftId, (shift) => {
    shift.invoiceIds = shift.invoiceIds.filter((id) => id !== invoiceId);
    shift.paymentIds = shift.paymentIds.filter((id) => !paymentIds.includes(id));
    return shift.Ca_Ma;
  });
}

export function attachCashShiftPayment(shiftId, paymentId) {
  return updateShift(shiftId, (shift, shifts) => {
    if (shift.TrangThai !== "Đang mở") throw new Error("Ca đã đóng; không thể gắn thanh toán mới.");
    if (shifts.some((row) => row.Ca_Ma !== shiftId && row.paymentIds.includes(paymentId))) {
      throw new Error("Thanh toán đã được gắn với một ca khác.");
    }
    if (shift.paymentIds.includes(paymentId)) throw new Error("Thanh toán đã được gắn với ca này.");
    shift.paymentIds.push(paymentId);
    return shift.Ca_Ma;
  });
}

export function detachCashShiftPayment(shiftId, paymentId) {
  return updateShift(shiftId, (shift) => {
    shift.paymentIds = shift.paymentIds.filter((id) => id !== paymentId);
    return shift.Ca_Ma;
  });
}

export function calculateCashShift(shift, state = getState()) {
  const invoices = shift.invoiceIds.map((id) => state.HoaDonBanHang.find((row) => row.BH_Ma === id))
    .filter((row) => row && row.BH_TrangThai === "Đã xác nhận");
  const payments = shift.paymentIds.map((id) => state.ThanhToanBanHang.find((row) => row.TTBH_Ma === id))
    .filter(Boolean);
  const successfulPayments = payments.filter((row) => row.TTBH_TrangThai === "Thành công");
  const cash = successfulPayments.filter((row) => row.TTBH_PhuongThuc === "Tiền mặt")
    .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
  const transfer = successfulPayments.filter((row) => ["Chuyển khoản", "QR"].includes(row.TTBH_PhuongThuc))
    .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
  const pendingPayments = payments.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận");
  const revenue = invoices.reduce((sum, row) => sum + Number(row.BH_TongCong || 0), 0);
  const unpaidFromShiftInvoices = invoices.reduce((sum, invoice) => {
    const paid = state.ThanhToanBanHang.filter((row) => row.BH_Ma === invoice.BH_Ma && row.TTBH_TrangThai === "Thành công")
      .reduce((total, row) => total + Number(row.TTBH_SoTien || 0), 0);
    return sum + Math.max(0, invoice.BH_TongCong - paid);
  }, 0);
  const expectedCash = Number(shift.TienMatDauCa || 0) + cash;
  return {
    invoices, payments, successfulPayments, pendingPayments,
    invoiceCount: invoices.length,
    paymentCount: successfulPayments.length,
    revenue, cash, transfer,
    collected: cash + transfer,
    unpaidFromShiftInvoices,
    expectedCash,
    actualCash: shift.TienMatThucDem,
    variance: shift.ChenhLech
  };
}

export function submitCashShift(shiftId, { countedCash, explanation = "" }, role, employeeId, state = getState()) {
  return updateShift(shiftId, (shift) => {
    requireCashier(shift, role, employeeId);
    if (shift.TrangThai !== "Đang mở") throw new Error("Ca này đã kết thúc hoặc đã gửi đối soát.");
    const summary = calculateCashShift(shift, state);
    if (summary.pendingPayments.length) throw new Error("Ca còn thanh toán đang chờ xác nhận. Hãy xử lý các giao dịch trước khi kết ca.");
    const counted = safeAmount(countedCash, "Tiền mặt thực đếm");
    const variance = counted - summary.expectedCash;
    const reason = String(explanation || "").trim();
    if (variance !== 0 && !reason) throw new Error("Cần nhập giải trình khi tiền thực đếm không khớp tiền dự kiến.");
    shift.GioDong = stamp();
    shift.TienMatThucDem = counted;
    shift.TienMatDuKien = summary.expectedCash;
    shift.ChenhLech = variance;
    shift.GiaiTrinh = reason;
    shift.ThoiDiemGuiDoiSoat = stamp();
    shift.TrangThai = "Chờ đối soát";
    return shift.Ca_Ma;
  });
}

export function respondCashShiftExplanation(shiftId, explanation, role, employeeId) {
  return updateShift(shiftId, (shift) => {
    requireCashier(shift, role, employeeId);
    if (shift.TrangThai !== "Cần giải trình") throw new Error("Ca hiện không chờ giải trình.");
    const reason = String(explanation || "").trim();
    if (!reason) throw new Error("Vui lòng nhập nội dung giải trình.");
    shift.GiaiTrinh = [shift.GiaiTrinh, `Bổ sung: ${reason}`].filter(Boolean).join("\n");
    shift.TrangThai = "Chờ đối soát";
    shift.ThoiDiemGuiDoiSoat = stamp();
    return shift.Ca_Ma;
  });
}

export function requestCashShiftExplanation(shiftId, note, role, employeeId) {
  requireAccountant(role);
  const reason = String(note || "").trim();
  if (!reason) throw new Error("Cần ghi rõ nội dung yêu cầu giải trình.");
  return updateShift(shiftId, (shift) => {
    if (!["Chờ đối soát", "Cần giải trình"].includes(shift.TrangThai)) {
      throw new Error("Chỉ yêu cầu giải trình cho ca đang chờ đối soát.");
    }
    shift.TrangThai = "Cần giải trình";
    shift.NguoiYeuCauGiaiTrinh = employeeId;
    shift.ThoiDiemYeuCauGiaiTrinh = stamp();
    shift.GhiChuKeToan = reason;
    return shift.Ca_Ma;
  });
}

export function reconcileCashShift(shiftId, role, employeeId, note = "") {
  requireAccountant(role);
  return updateShift(shiftId, (shift) => {
    if (shift.TrangThai !== "Chờ đối soát") throw new Error("Ca chưa ở trạng thái chờ đối soát.");
    if (shift.ChenhLech !== 0 && !String(shift.GiaiTrinh || "").trim()) {
      throw new Error("Chưa có giải trình cho chênh lệch ca.");
    }
    const summary = calculateCashShift(shift);
    if (summary.pendingPayments.length) throw new Error("Ca có giao dịch thanh toán đang chờ.");
    shift.NguoiDoiSoat = employeeId;
    shift.ThoiDiemDoiSoat = stamp();
    shift.GhiChuKeToan = String(note || shift.GhiChuKeToan || "").trim();
    shift.TrangThai = "Đã đối soát";
    return shift.Ca_Ma;
  });
}

export function confirmCashHandover(shiftId, { amount, note = "" }, role, employeeId) {
  requireAccountant(role);
  return updateShift(shiftId, (shift) => {
    if (shift.TrangThai !== "Đã đối soát" || shift.ThoiDiemXacNhanBanGiao) {
      throw new Error("Chỉ xác nhận bàn giao một lần sau khi ca đã đối soát.");
    }
    const handedOver = safeAmount(amount, "Tiền mặt bàn giao");
    const handoverNote = String(note || "").trim();
    if (handedOver !== shift.TienMatThucDem && !handoverNote) {
      throw new Error("Cần ghi chú khi số tiền bàn giao khác số tiền thực đếm.");
    }
    shift.TienMatBanGiao = handedOver;
    shift.NguoiNhanBanGiao = employeeId;
    shift.ThoiDiemXacNhanBanGiao = stamp();
    shift.GhiChuBanGiao = handoverNote;
    shift.TrangThai = "Đã bàn giao";
    return shift.Ca_Ma;
  });
}
