import { applyStockMovement, getState, runDemoTransaction, generateDemoId } from "./kho-service.js";
import { getUnitPackage, toBaseQuantity } from "./unit-service.js";

export const SUPPLIER_RETURN_STATUSES = {
  draft: "Nháp",
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  shipped: "Đã xuất trả",
  cancelled: "Đã hủy",
  rejected: "Từ chối"
};

const confirmedReceiptStatuses = new Set(["Đã xác nhận", "Hoàn tất", "Đã nhận"]);
const supplierTypes = new Set(["Nhà cung cấp"]);
const returnReasons = new Set([
  "Hàng hư hỏng",
  "Hàng lỗi chất lượng",
  "Hàng giao sai",
  "Hàng không đúng quy cách",
  "Hàng gần hết hạn",
  "Lý do khác"
]);
const warehouseRole = "Nhân viên kho";
const ownerRole = "Chủ cửa hàng";
const stamp = () => new Date().toISOString();
const returnsOf = (state) => Array.isArray(state.TraHangNCC) ? state.TraHangNCC : [];
const validDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export function getSupplierReturns(state = getState()) {
  return returnsOf(state);
}

function assertRole(role, allowed, message) {
  if (!allowed.includes(role)) throw new Error(message);
}

function requireReceiptLine(state, lineId, supplierId) {
  const line = state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === lineId);
  const receipt = line && state.PhieuNhap.find((row) => row.PN_Ma === line.PN_Ma);
  if (!line || !receipt || !confirmedReceiptStatuses.has(receipt.PN_TrangThai)) {
    throw new Error(`Dòng nhập ${lineId || ""} không thuộc phiếu nhập đã xác nhận.`);
  }
  if (receipt.DT_Ma !== supplierId) throw new Error("NCC của phiếu trả phải trùng NCC trên phiếu nhập gốc.");
  return { line, receipt };
}

function confirmedReturnedQuantity(state, lineId, exceptReturnId = "") {
  return returnsOf(state)
    .filter((doc) => doc.TRNCC_Ma !== exceptReturnId && doc.TRNCC_TrangThai === SUPPLIER_RETURN_STATUSES.shipped)
    .flatMap((doc) => doc.chiTiet || [])
    .filter((detail) => detail.PNCT_Ma === lineId)
    .reduce((sum, detail) => sum + Number(detail.TRNCC_SL || 0), 0);
}

function availableQuantity(state, lineId, locationId, exceptReturnId = "") {
  const sourceLine = state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === lineId);
  if (!sourceLine) return 0;
  const alreadyReturned = confirmedReturnedQuantity(state, lineId, exceptReturnId);
  const stock = state.TonKho.find((row) => row.DD_Ma === locationId && row.PNCT_Ma === lineId)?.TK_SL || 0;
  return Math.max(0, Math.min(sourceLine.PNCT_SL - alreadyReturned, stock));
}

function normalizeLines(state, inputLines, supplierId, locationId, receiptId, exceptReturnId = "", defaultReason = "") {
  if (!Array.isArray(inputLines) || !inputLines.length) throw new Error("Phiếu trả cần ít nhất một dòng hàng.");
  const seen = new Set();
  return inputLines.map((input) => {
    const lineId = String(input.PNCT_Ma || "");
    if (!lineId || seen.has(lineId)) throw new Error("Không thể lặp lại cùng một dòng nhập trong phiếu trả.");
    seen.add(lineId);
    const { line, receipt } = requireReceiptLine(state, lineId, supplierId);
    if (receipt.PN_Ma !== receiptId) throw new Error("Sản phẩm không thuộc phiếu nhập gốc đã chọn.");
    const item = state.HangHoa.find((row) => row.HH_Ma === line.HH_Ma);
    const pack = getUnitPackage(item);
    const factor = Number(input.TRNCC_HeSo ?? input.factor ?? 1);
    const enteredQuantity = Number(input.TRNCC_SLNhap ?? input.enteredQuantity ?? input.TRNCC_SL ?? input.quantity);
    if (factor !== 1 && factor !== pack?.ratio) throw new Error(`Đơn vị quy đổi của ${lineId} không hợp lệ.`);
    const convertedQuantity = toBaseQuantity(enteredQuantity, factor);
    const quantity = Number(input.TRNCC_SL ?? input.quantity ?? convertedQuantity);
    if (quantity !== convertedQuantity) throw new Error(`Số lượng quy đổi của ${lineId} không khớp đơn vị cơ bản.`);
    const allowed = availableQuantity(state, lineId, locationId, exceptReturnId);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Số lượng trả phải là số nguyên dương theo đơn vị cơ bản.");
    if (quantity > line.PNCT_SL - confirmedReturnedQuantity(state, lineId, exceptReturnId)) {
      throw new Error(`Số lượng trả ${lineId} vượt số lượng nhập còn có thể trả.`);
    }
    if (quantity > allowed) throw new Error(`Tồn khả dụng của ${lineId} tại địa điểm đã chọn không đủ (còn ${allowed}).`);
    const reason = String(input.TRNCC_LyDoChiTiet || defaultReason).trim();
    if (!returnReasons.has(reason)) throw new Error(`Lý do trả của dòng ${lineId} không hợp lệ.`);
    const amount = quantity * Number(line.PNCT_DonGia);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Giá trị trả của ${lineId} vượt giới hạn số chính xác.`);
    return {
      PNCT_Ma: lineId,
      PN_Ma: receipt.PN_Ma,
      HH_Ma: line.HH_Ma,
      TRNCC_SL: quantity,
      TRNCC_DonGia: line.PNCT_DonGia,
      TRNCC_TTien: amount,
      TRNCC_SLNhap: enteredQuantity,
      TRNCC_HeSo: factor,
      TRNCC_LyDoChiTiet: reason
    };
  });
}

function validateHeader(state, input) {
  const supplierId = String(input.DT_Ma || "");
  const supplier = state.DoiTacKinhDoanh.find((row) => row.DT_Ma === supplierId && supplierTypes.has(row.DT_Loai));
  if (!supplier) throw new Error("Chỉ chọn đối tác có loại Nhà cung cấp.");
  const receipt = state.PhieuNhap.find((row) => row.PN_Ma === input.PN_Ma);
  if (!receipt || receipt.DT_Ma !== supplierId || !confirmedReceiptStatuses.has(receipt.PN_TrangThai)) {
    throw new Error("Chỉ chọn phiếu nhập đã xác nhận thuộc đúng nhà cung cấp.");
  }
  if (!state.DiaDiem.some((row) => row.DD_Ma === input.DD_Ma && row.DD_TrangThai === "Hoạt động")) {
    throw new Error("Địa điểm xuất trả không hợp lệ hoặc đã ngừng hoạt động.");
  }
  if (!state.NhanVien.some((row) => row.NV_Ma === input.NV_Ma)) throw new Error("Nhân viên lập phiếu không hợp lệ.");
  if (!validDate(input.TRNCC_Ngay)) throw new Error("Ngày lập phiếu không hợp lệ.");
  const reason = String(input.TRNCC_LyDo || "").trim();
  if (!returnReasons.has(reason)) throw new Error("Vui lòng chọn lý do trả hàng hợp lệ.");
  return { supplierId, receiptId: receipt.PN_Ma, locationId: String(input.DD_Ma), reason };
}

export function saveSupplierReturn(input, role) {
  assertRole(role, [warehouseRole, ownerRole], "Vai trò hiện tại không được lập phiếu trả NCC.");
  return runDemoTransaction((state) => {
    state.TraHangNCC = returnsOf(state);
    const existing = input.TRNCC_Ma ? state.TraHangNCC.find((row) => row.TRNCC_Ma === input.TRNCC_Ma) : null;
    if (input.TRNCC_Ma && !existing) throw new Error("Không tìm thấy phiếu trả cần chỉnh sửa.");
    if (existing && existing.TRNCC_TrangThai !== SUPPLIER_RETURN_STATUSES.draft) {
      throw new Error("Chỉ được chỉnh sửa phiếu trả ở trạng thái Nháp.");
    }
    const header = validateHeader(state, input);
    const lines = normalizeLines(state, input.lines, header.supplierId, header.locationId, header.receiptId, existing?.TRNCC_Ma || "", header.reason);
    const id = existing?.TRNCC_Ma || generateDemoId("TRNCC", state.TraHangNCC, "TRNCC_Ma");
    const totalQuantity = lines.reduce((sum, row) => sum + row.TRNCC_SL, 0);
    const totalAmount = lines.reduce((sum, row) => sum + row.TRNCC_TTien, 0);
    if (!Number.isSafeInteger(totalQuantity) || !Number.isSafeInteger(totalAmount)) {
      throw new Error("Tổng số lượng hoặc giá trị phiếu trả vượt giới hạn số chính xác.");
    }
    const record = {
      TRNCC_Ma: id,
      TRNCC_Ngay: String(input.TRNCC_Ngay),
      DT_Ma: header.supplierId,
      PN_Ma: header.receiptId,
      DD_Ma: header.locationId,
      NV_Ma: String(input.NV_Ma),
      TRNCC_LyDo: header.reason,
      TRNCC_GhiChu: String(input.TRNCC_GhiChu || "").trim(),
      TRNCC_TrangThai: SUPPLIER_RETURN_STATUSES.draft,
      TRNCC_TongSL: totalQuantity,
      TRNCC_TongTien: totalAmount,
      chiTiet: lines
    };
    if (existing) Object.assign(existing, record);
    else state.TraHangNCC.push(record);
    return id;
  });
}

export function submitSupplierReturn(returnId, role) {
  assertRole(role, [warehouseRole, ownerRole], "Vai trò hiện tại không được gửi phiếu trả.");
  return runDemoTransaction((state) => {
    const doc = returnsOf(state).find((row) => row.TRNCC_Ma === returnId);
    if (!doc || doc.TRNCC_TrangThai !== SUPPLIER_RETURN_STATUSES.draft) throw new Error("Chỉ gửi duyệt phiếu trả ở trạng thái Nháp.");
    doc.chiTiet = normalizeLines(state, doc.chiTiet, doc.DT_Ma, doc.DD_Ma, doc.PN_Ma, doc.TRNCC_Ma, doc.TRNCC_LyDo);
    doc.TRNCC_TongSL = doc.chiTiet.reduce((sum, row) => sum + row.TRNCC_SL, 0);
    doc.TRNCC_TongTien = doc.chiTiet.reduce((sum, row) => sum + row.TRNCC_TTien, 0);
    doc.TRNCC_TrangThai = SUPPLIER_RETURN_STATUSES.pending;
    doc.TRNCC_NgayGuiDuyet = stamp();
    return returnId;
  });
}

export function approveSupplierReturn(returnId, employeeId, role) {
  assertRole(role, [ownerRole], "Chỉ Chủ cửa hàng được duyệt phiếu trả NCC.");
  return runDemoTransaction((state) => {
    const doc = returnsOf(state).find((row) => row.TRNCC_Ma === returnId);
    if (!doc || doc.TRNCC_TrangThai !== SUPPLIER_RETURN_STATUSES.pending) throw new Error("Chỉ duyệt phiếu trả đang chờ duyệt.");
    if (!state.NhanVien.some((row) => row.NV_Ma === employeeId)) throw new Error("Nhân viên duyệt không hợp lệ.");
    doc.chiTiet = normalizeLines(state, doc.chiTiet, doc.DT_Ma, doc.DD_Ma, doc.PN_Ma, doc.TRNCC_Ma, doc.TRNCC_LyDo);
    doc.TRNCC_TrangThai = SUPPLIER_RETURN_STATUSES.approved;
    doc.TRNCC_NguoiDuyet = employeeId;
    doc.TRNCC_NgayDuyet = stamp();
    return returnId;
  });
}

export function rejectSupplierReturn(returnId, employeeId, role) {
  assertRole(role, [ownerRole], "Chỉ Chủ cửa hàng được từ chối yêu cầu trả NCC.");
  return runDemoTransaction((state) => {
    const doc = returnsOf(state).find((row) => row.TRNCC_Ma === returnId);
    if (!doc || doc.TRNCC_TrangThai !== SUPPLIER_RETURN_STATUSES.pending) throw new Error("Chỉ từ chối phiếu đang chờ duyệt.");
    if (!state.NhanVien.some((row) => row.NV_Ma === employeeId)) throw new Error("Nhân viên từ chối không hợp lệ.");
    doc.TRNCC_TrangThai = SUPPLIER_RETURN_STATUSES.rejected;
    doc.TRNCC_NguoiDuyet = employeeId;
    doc.TRNCC_NgayDuyet = stamp();
    doc.TRNCC_GhiChuDuyet = "Chủ cửa hàng từ chối yêu cầu.";
    return returnId;
  });
}

export function cancelSupplierReturn(returnId, role) {
  assertRole(role, [warehouseRole, ownerRole], "Vai trò hiện tại không được hủy phiếu trả.");
  return runDemoTransaction((state) => {
    const doc = returnsOf(state).find((row) => row.TRNCC_Ma === returnId);
    if (!doc || [
      SUPPLIER_RETURN_STATUSES.shipped,
      SUPPLIER_RETURN_STATUSES.cancelled,
      SUPPLIER_RETURN_STATUSES.rejected
    ].includes(doc.TRNCC_TrangThai)) {
      throw new Error("Không thể hủy phiếu đã xuất trả hoặc đã hủy.");
    }
    doc.TRNCC_TrangThai = SUPPLIER_RETURN_STATUSES.cancelled;
    doc.TRNCC_NgayHuy = stamp();
    return returnId;
  });
}

export function deleteDraftSupplierReturn(returnId, role) {
  assertRole(role, [warehouseRole, ownerRole], "Vai trò hiện tại không được xóa phiếu trả.");
  return runDemoTransaction((state) => {
    const doc = returnsOf(state).find((row) => row.TRNCC_Ma === returnId);
    if (!doc || doc.TRNCC_TrangThai !== SUPPLIER_RETURN_STATUSES.draft) throw new Error("Chỉ xóa được phiếu trả ở trạng thái Nháp.");
    state.TraHangNCC = state.TraHangNCC.filter((row) => row.TRNCC_Ma !== returnId);
    return returnId;
  });
}

export function confirmSupplierReturn(returnId, employeeId, role) {
  assertRole(role, [warehouseRole, ownerRole], "Vai trò hiện tại không được xác nhận xuất trả.");
  return runDemoTransaction((state) => {
    const doc = returnsOf(state).find((row) => row.TRNCC_Ma === returnId);
    if (!doc || doc.TRNCC_TrangThai !== SUPPLIER_RETURN_STATUSES.approved) {
      throw new Error("Phiếu trả chưa được duyệt hoặc đã được xuất trả.");
    }
    if (!state.NhanVien.some((row) => row.NV_Ma === employeeId)) throw new Error("Nhân viên xác nhận không hợp lệ.");
    if (state.BienDongKho.some((row) => row.BDK_Nguon === "TraHangNCC" && row.BDK_MaChungTu === returnId)) {
      throw new Error("Phiếu này đã có biến động xuất trả; không thể xác nhận lần nữa.");
    }
    doc.chiTiet = normalizeLines(state, doc.chiTiet, doc.DT_Ma, doc.DD_Ma, doc.PN_Ma, doc.TRNCC_Ma, doc.TRNCC_LyDo);
    for (const line of doc.chiTiet) {
      applyStockMovement(state, {
        DD_Ma: doc.DD_Ma,
        PNCT_Ma: line.PNCT_Ma,
        amount: -line.TRNCC_SL,
        BDK_Loai: "Trả NCC",
        BDK_Nguon: "TraHangNCC",
        BDK_MaChungTu: returnId,
        NV_Ma: employeeId,
        BDK_GhiChu: `${line.TRNCC_LyDoChiTiet || doc.TRNCC_LyDo} · ${state.DoiTacKinhDoanh.find((row) => row.DT_Ma === doc.DT_Ma)?.DT_Ten || doc.DT_Ma}`
      });
    }
    doc.TRNCC_TrangThai = SUPPLIER_RETURN_STATUSES.shipped;
    doc.TRNCC_NguoiXuat = employeeId;
    doc.TRNCC_NgayXuat = stamp();
    return returnId;
  });
}

export function getSupplierReturnLineAvailability(state, lineId, locationId, exceptReturnId = "") {
  const { line, receipt } = requireReceiptLine(
    state,
    lineId,
    state.PhieuNhap.find((row) => row.PN_Ma === state.PhieuNhapChiTiet.find((detail) => detail.PNCT_Ma === lineId)?.PN_Ma)?.DT_Ma
  );
  const item = state.HangHoa.find((row) => row.HH_Ma === line.HH_Ma);
  const returned = confirmedReturnedQuantity(state, lineId, exceptReturnId);
  return {
    line,
    receipt,
    item,
    returned,
    stock: state.TonKho.find((row) => row.DD_Ma === locationId && row.PNCT_Ma === lineId)?.TK_SL || 0,
    available: availableQuantity(state, lineId, locationId, exceptReturnId),
    package: getUnitPackage(item),
    totalValue: line.PNCT_SL * line.PNCT_DonGia
  };
}

export function convertSupplierReturnQuantity(quantity, factor) {
  return toBaseQuantity(quantity, factor);
}
