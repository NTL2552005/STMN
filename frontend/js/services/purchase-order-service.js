import { generateDemoId, getState, runDemoTransaction } from "./kho-service.js";
import {
  getPurchaseOrderReceiptSummary,
  PURCHASE_ORDER_STATUSES
} from "./purchase-order-utils.js";

const OWNER_ROLE = "Chủ cửa hàng";
const supplierTypes = new Set(["Nhà cung cấp"]);
const validDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

function assertOwner(role) {
  if (role !== OWNER_ROLE) throw new Error("Chỉ chủ cửa hàng được quản lý đơn đặt hàng.");
}

function normalizedLines(state, lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("Đơn đặt hàng cần ít nhất một sản phẩm.");
  const seen = new Set();
  return lines.map((line) => {
    const itemId = String(line.HH_Ma || "");
    const item = state.HangHoa.find((row) => row.HH_Ma === itemId && row.HH_TrangThai === "Đang kinh doanh");
    const quantity = Number(line.DN_SL);
    const unitPrice = Number(line.DN_DonGia);
    if (!item) throw new Error("Chỉ chọn hàng hóa đang kinh doanh.");
    if (seen.has(itemId)) throw new Error("Mỗi mặt hàng chỉ được có một dòng trong đơn đặt hàng.");
    seen.add(itemId);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error(`Số lượng đặt của ${item.HH_Ten} phải là số nguyên dương.`);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) throw new Error(`Đơn giá đặt của ${item.HH_Ten} phải là số nguyên VND không âm.`);
    const amount = quantity * unitPrice;
    if (!Number.isSafeInteger(amount)) throw new Error(`Thành tiền của ${item.HH_Ten} vượt giới hạn số chính xác.`);
    return { DH_Ma: "", HH_Ma: itemId, DN_DonGia: unitPrice, DN_SL: quantity, DN_TTien: amount };
  });
}

export function savePurchaseOrder(input, role) {
  assertOwner(role);
  return runDemoTransaction((state) => {
    const supplier = state.DoiTacKinhDoanh.find((row) => (
      row.DT_Ma === input.DT_Ma && supplierTypes.has(row.DT_Loai) && row.DT_TrangThai === "Hoạt động"
    ));
    if (!supplier) throw new Error("Chọn nhà cung cấp đang hoạt động.");
    if (!validDate(input.DH_Ngay)) throw new Error("Ngày đặt hàng không hợp lệ.");
    const lines = normalizedLines(state, input.lines);
    const totalQuantity = lines.reduce((sum, line) => sum + line.DN_SL, 0);
    const totalAmount = lines.reduce((sum, line) => sum + line.DN_TTien, 0);
    if (!Number.isSafeInteger(totalQuantity) || !Number.isSafeInteger(totalAmount)) {
      throw new Error("Tổng số lượng hoặc tổng tiền vượt giới hạn chính xác.");
    }

    const id = input.DH_Ma || generateDemoId("DH", state.DatHang, "DH_Ma");
    const existing = state.DatHang.find((row) => row.DH_Ma === id);
    if (input.DH_Ma && (!existing || existing.DH_TrangThai !== PURCHASE_ORDER_STATUSES.draft)) {
      throw new Error("Chỉ chỉnh sửa đơn đặt hàng ở trạng thái Nháp.");
    }
    if (existing && state.PhieuNhap.some((receipt) => receipt.DH_Ma === id && receipt.PN_TrangThai !== "Đã hủy")) {
      throw new Error("Không thể sửa đơn đã phát sinh phiếu nhập.");
    }
    const employeeId = String(input.NV_Ma || "");
    if (!state.NhanVien.some((row) => row.NV_Ma === employeeId && row.NV_TrangThai !== "Nghỉ việc")) {
      throw new Error("Nhân viên lập đơn không hợp lệ.");
    }
    const order = existing || { DH_Ma: id };
    Object.assign(order, {
      DT_Ma: supplier.DT_Ma,
      NV_Ma: employeeId,
      DH_Ngay: input.DH_Ngay,
      DH_TongSL: totalQuantity,
      DH_TongTien: totalAmount,
      DH_TrangThai: PURCHASE_ORDER_STATUSES.draft
    });
    if (!existing) state.DatHang.push(order);
    state.DatChiTiet = state.DatChiTiet.filter((line) => line.DH_Ma !== id);
    state.DatChiTiet.push(...lines.map((line) => ({ ...line, DH_Ma: id })));
    return id;
  });
}

export function confirmPurchaseOrder(DH_Ma, role) {
  assertOwner(role);
  return runDemoTransaction((state) => {
    const order = state.DatHang.find((row) => row.DH_Ma === DH_Ma);
    if (!order || order.DH_TrangThai !== PURCHASE_ORDER_STATUSES.draft) {
      throw new Error("Chỉ xác nhận đơn đặt hàng ở trạng thái Nháp.");
    }
    const lines = state.DatChiTiet.filter((row) => row.DH_Ma === DH_Ma);
    if (!lines.length) throw new Error("Đơn đặt hàng chưa có sản phẩm.");
    order.DH_TrangThai = PURCHASE_ORDER_STATUSES.waiting;
    return DH_Ma;
  });
}

export function cancelPurchaseOrder(DH_Ma, role) {
  assertOwner(role);
  return runDemoTransaction((state) => {
    const order = state.DatHang.find((row) => row.DH_Ma === DH_Ma);
    if (!order || [PURCHASE_ORDER_STATUSES.complete, PURCHASE_ORDER_STATUSES.cancelled].includes(order.DH_TrangThai)) {
      throw new Error("Đơn đặt hàng không ở trạng thái có thể hủy.");
    }
    const receipts = state.PhieuNhap.filter((row) => row.DH_Ma === DH_Ma && row.PN_TrangThai !== "Đã hủy");
    if (receipts.some((receipt) => receipt.PN_TrangThai === "Đã xác nhận")) {
      throw new Error("Không thể hủy đơn đã có phiếu nhập xác nhận.");
    }
    if (receipts.length) throw new Error("Hãy hủy hoặc xử lý các phiếu nhập đang chờ trước khi hủy đơn.");
    order.DH_TrangThai = PURCHASE_ORDER_STATUSES.cancelled;
    return DH_Ma;
  });
}

export function getPurchaseOrderSummary(state = getState()) {
  return state.DatHang.map((order) => getPurchaseOrderReceiptSummary(state, order));
}
