import { confirmInboundInState, generateDemoId, getState, runDemoTransaction } from "./kho-service.js";
import { getInvoiceOutstanding, getInvoicePaid } from "./sales-service.js";
import { formatCurrency } from "../utils/formatters.js";

const accountantRoles = new Set(["Chủ cửa hàng", "Nhân viên kế toán"]);
const successful = (row) => row.TTNCC_TrangThai === "Thành công";
const activeInvoice = (row) => row.BH_TrangThai === "Đã xác nhận";
const confirmedVoucher = (row) => row.PT_TrangThai === "Đã xác nhận";
const confirmedExpense = (row) => row.PC_TrangThai === "Đã xác nhận";
const amountValue = (value, label = "Số tiền") => {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`${label} phải là số nguyên VND lớn hơn 0.`);
  return amount;
};
const dateValue = (value, label = "Ngày") => {
  if (!value || Number.isNaN(Date.parse(`${value}T00:00:00`))) throw new Error(`${label} không hợp lệ.`);
  return value;
};
const paymentMethods = new Set(["Tiền mặt", "Chuyển khoản", "QR"]);
const paymentStatusFor = (method) => method === "Tiền mặt" ? "Thành công" : "Chờ xác nhận";

function assertAccountant(role) {
  if (!accountantRoles.has(role)) throw new Error("Chỉ kế toán hoặc chủ cửa hàng được thực hiện nghiệp vụ kế toán trong demo.");
}

function debtPaid(state, CTNNCC_Ma, includePending = false) {
  return state.ThanhToanNCC.filter((row) => row.CTNNCC_Ma === CTNNCC_Ma
    && (successful(row) || (includePending && row.TTNCC_TrangThai === "Chờ xác nhận")))
    .reduce((sum, row) => sum + Number(row.TTNCC_SoTien || 0), 0);
}

function debtBalance(state, debt) {
  return Math.max(0, Number(debt.CTNNCC_SoTienNo || 0) - debtPaid(state, debt.CTNNCC_Ma));
}

function setDebtStatus(state, debt) {
  debt.CTNNCC_TrangThai = debtBalance(state, debt) === 0 ? "Đã thanh toán" : "Còn nợ";
  const creditor = state.CongNoNCC.find((row) => row.CNNCC_Ma === debt.CNNCC_Ma);
  if (creditor) {
    const remaining = state.ChiTietNoNCC.filter((row) => row.CNNCC_Ma === creditor.CNNCC_Ma)
      .reduce((sum, row) => sum + debtBalance(state, row), 0);
    creditor.CNNCC_TrangThai = remaining ? "Còn nợ" : "Đã thanh toán";
  }
}

function nextId(prefix, rows, field) {
  return generateDemoId(prefix, rows, field);
}

export function getSupplierDebtBalance(CTNNCC_Ma, state = getState()) {
  const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === CTNNCC_Ma);
  if (!debt) throw new Error("Không tìm thấy khoản nợ nhà cung cấp.");
  return debtBalance(state, debt);
}

export function getSupplierDebtDetails(CNNCC_Ma, state = getState()) {
  return state.ChiTietNoNCC.filter((row) => row.CNNCC_Ma === CNNCC_Ma).map((debt) => {
    const receipt = state.PhieuNhap.find((row) => row.PN_Ma === debt.PN_Ma);
    const paid = debtPaid(state, debt.CTNNCC_Ma);
    return {
      debt, receipt, paid, due: debtBalance(state, debt),
      pending: state.ThanhToanNCC.filter((row) => row.CTNNCC_Ma === debt.CTNNCC_Ma && row.TTNCC_TrangThai === "Chờ xác nhận")
        .reduce((sum, row) => sum + row.TTNCC_SoTien, 0)
    };
  }).sort((a, b) => String(b.receipt?.PN_Ngay || "").localeCompare(String(a.receipt?.PN_Ngay || "")));
}

export function getSupplierPayables(DT_Ma = "", state = getState()) {
  return state.CongNoNCC.filter((row) => !DT_Ma || row.DT_Ma === DT_Ma).map((creditor) => {
    const details = getSupplierDebtDetails(creditor.CNNCC_Ma, state);
    const principal = details.reduce((sum, row) => sum + Number(row.debt.CTNNCC_SoTienNo || 0), 0);
    const paid = details.reduce((sum, row) => sum + row.paid, 0);
    const due = details.reduce((sum, row) => sum + row.due, 0);
    return { creditor, details, principal, paid, due, status: due ? "Còn nợ" : "Đã thanh toán" };
  });
}

function createSupplierDebtInState(state, PN_Ma) {
  const receipt = state.PhieuNhap.find((row) => row.PN_Ma === PN_Ma);
  if (!receipt || receipt.PN_TrangThai !== "Đã xác nhận") throw new Error("Chỉ ghi nhận công nợ từ phiếu nhập đã xác nhận.");
  if (!receipt.DT_Ma || !state.DoiTacKinhDoanh.some((row) => row.DT_Ma === receipt.DT_Ma && ["Nhà cung cấp", "Cả hai"].includes(row.DT_Loai))) {
    throw new Error("Phiếu nhập không có nhà cung cấp hợp lệ.");
  }
  if (!Number.isSafeInteger(receipt.PN_TongTien) || receipt.PN_TongTien < 0) throw new Error("Tổng tiền phiếu nhập không hợp lệ.");
  const lines = state.PhieuNhapChiTiet.filter((row) => row.PN_Ma === PN_Ma);
  if (lines.some((row) => !Number.isSafeInteger(row.PNCT_SL) || row.PNCT_SL <= 0
    || !Number.isSafeInteger(row.PNCT_DonGia) || row.PNCT_DonGia < 0
    || row.PNCT_TTien !== row.PNCT_SL * row.PNCT_DonGia)) {
    throw new Error("Có dòng nhập không hợp lệ; chưa thể ghi nhận công nợ.");
  }
  const actualQuantity = lines.reduce((sum, row) => sum + Number(row.PNCT_SL || 0), 0);
  const actualAmount = lines.reduce((sum, row) => sum + Number(row.PNCT_TTien ?? row.PNCT_SL * row.PNCT_DonGia), 0);
  if (!lines.length || actualQuantity !== receipt.PN_TongSL || actualAmount !== receipt.PN_TongTien) {
    throw new Error("Chi tiết phiếu nhập không khớp tổng số lượng/giá trị; chưa thể ghi nhận công nợ.");
  }
  if (state.ChiTietNoNCC.some((row) => row.PN_Ma === PN_Ma)) throw new Error("Phiếu nhập đã có khoản công nợ NCC.");
  if (actualAmount === 0) return null;
  const existingCreditors = state.CongNoNCC.filter((row) => row.DT_Ma === receipt.DT_Ma);
  if (existingCreditors.length > 1) throw new Error("Dữ liệu vi phạm ràng buộc một công nợ tổng hợp cho mỗi NCC.");
  let creditor = existingCreditors[0];
  if (!creditor) {
    creditor = {
      CNNCC_Ma: nextId("CNNCC", state.CongNoNCC, "CNNCC_Ma"),
      DT_Ma: receipt.DT_Ma,
      CNNCC_TrangThai: "Còn nợ"
    };
    state.CongNoNCC.push(creditor);
  }
  const debt = {
    CTNNCC_Ma: nextId("CTNNCC", state.ChiTietNoNCC, "CTNNCC_Ma"),
    CNNCC_Ma: creditor.CNNCC_Ma,
    PN_Ma,
    CTNNCC_SoTienNo: receipt.PN_TongTien,
    CTNNCC_TrangThai: "Còn nợ",
    CTNNCC_GhiChu: ""
  };
  state.ChiTietNoNCC.push(debt);
  setDebtStatus(state, debt);
  return debt.CTNNCC_Ma;
}

export function createSupplierDebtFromReceipt(PN_Ma, role) {
  assertAccountant(role);
  return runDemoTransaction((state) => createSupplierDebtInState(state, PN_Ma));
}

export function confirmInboundWithPayable(PN_Ma, role) {
  assertAccountant(role);
  return runDemoTransaction((state) => {
    confirmInboundInState(state, PN_Ma);
    const debtId = createSupplierDebtInState(state, PN_Ma);
    return { PN_Ma, debtId };
  });
}

export function recordSupplierPayment(CTNNCC_Ma, { amount, method, date, note = "" }, role) {
  assertAccountant(role);
  return runDemoTransaction((state) => {
    const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === CTNNCC_Ma);
    if (!debt) throw new Error("Không tìm thấy khoản nợ nhà cung cấp.");
    const value = amountValue(amount);
    const paymentMethod = String(method || "");
    if (!paymentMethods.has(paymentMethod)) throw new Error("Phương thức thanh toán không hợp lệ.");
    const paymentDate = dateValue(date, "Ngày thanh toán");
    const reserved = debtPaid(state, CTNNCC_Ma, true);
    const remaining = Number(debt.CTNNCC_SoTienNo) - reserved;
    if (value > remaining) throw new Error(`Số tiền vượt số dư có thể thanh toán (${formatCurrency(Math.max(0, remaining))}), đã tính cả giao dịch đang chờ.`);
    const payment = {
      TTNCC_Ma: nextId("TTNCC", state.ThanhToanNCC, "TTNCC_Ma"),
      CTNNCC_Ma,
      TTNCC_Ngay: `${paymentDate}T12:00:00`,
      TTNCC_SoTien: value,
      TTNCC_PhuongThuc: paymentMethod,
      TTNCC_TrangThai: paymentStatusFor(paymentMethod),
      TTNCC_GhiChu: String(note).trim()
    };
    state.ThanhToanNCC.push(payment);
    setDebtStatus(state, debt);
    return payment.TTNCC_Ma;
  });
}

export function confirmSupplierPayment(TTNCC_Ma, role) {
  assertAccountant(role);
  return runDemoTransaction((state) => {
    const payment = state.ThanhToanNCC.find((row) => row.TTNCC_Ma === TTNCC_Ma);
    if (!payment || payment.TTNCC_TrangThai !== "Chờ xác nhận") throw new Error("Giao dịch không còn chờ xác nhận.");
    const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === payment.CTNNCC_Ma);
    if (!debt || debtPaid(state, debt.CTNNCC_Ma, true) > debt.CTNNCC_SoTienNo) {
      throw new Error("Tổng tiền giao dịch chờ xác nhận và thành công vượt nợ gốc.");
    }
    payment.TTNCC_TrangThai = "Thành công";
    setDebtStatus(state, debt);
  });
}

export function setSupplierPaymentStatus(TTNCC_Ma, status, role) {
  assertAccountant(role);
  if (!["Thất bại", "Đã hủy"].includes(status)) throw new Error("Trạng thái giao dịch không được hỗ trợ.");
  return runDemoTransaction((state) => {
    const payment = state.ThanhToanNCC.find((row) => row.TTNCC_Ma === TTNCC_Ma);
    if (!payment || payment.TTNCC_TrangThai !== "Chờ xác nhận") throw new Error("Chỉ được cập nhật giao dịch đang chờ xác nhận.");
    payment.TTNCC_TrangThai = status;
    const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === payment.CTNNCC_Ma);
    if (debt) setDebtStatus(state, debt);
  });
}

export function createSupplierPaymentVoucher(TTNCC_Ma, role) {
  assertAccountant(role);
  return runDemoTransaction((state) => {
    const payment = state.ThanhToanNCC.find((row) => row.TTNCC_Ma === TTNCC_Ma && successful(row));
    if (!payment) throw new Error("Chỉ tạo phiếu chi liên kết cho thanh toán NCC thành công.");
    if (payment.TTNCC_PhuongThuc !== "Tiền mặt") throw new Error("Không tạo phiếu chi tiền mặt cho thanh toán NCC qua ngân hàng/QR.");
    const existing = state.PhieuChi.filter((row) => row.TTNCC_Ma === TTNCC_Ma);
    if (existing.length > 1) throw new Error("Dữ liệu đã có nhiều phiếu chi liên kết cùng giao dịch NCC.");
    if (existing.length === 1) return existing[0].PC_Ma;
    const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === payment.CTNNCC_Ma);
    const creditor = state.CongNoNCC.find((row) => row.CNNCC_Ma === debt?.CNNCC_Ma);
    if (!debt || !creditor) throw new Error("Không tìm thấy công nợ NCC gắn với giao dịch.");
    const voucher = {
      PC_Ma: nextId("PC", state.PhieuChi, "PC_Ma"),
      DT_Ma: creditor.DT_Ma,
      NV_Ma: role === "Chủ cửa hàng" ? "NV001" : "NV003",
      TTNCC_Ma,
      PC_Ngay: payment.TTNCC_Ngay,
      PC_SoTien: payment.TTNCC_SoTien,
      PC_LyDo: `Thanh toán NCC ${debt.PN_Ma}`,
      PC_PhuongThuc: payment.TTNCC_PhuongThuc,
      PC_TrangThai: "Đã xác nhận",
      PC_GhiChu: payment.TTNCC_GhiChu || ""
    };
    state.PhieuChi.push(voucher);
    return voucher.PC_Ma;
  });
}

function validateVoucherMethod(method) {
  if (!paymentMethods.has(String(method || ""))) throw new Error("Phương thức thu/chi không hợp lệ.");
}

function validatePartner(state, DT_Ma) {
  if (DT_Ma && !state.DoiTacKinhDoanh.some((row) => row.DT_Ma === DT_Ma)) throw new Error("Đối tác không tồn tại.");
}

export function saveReceiptVoucher(values, role) {
  assertAccountant(role);
  return runDemoTransaction((state) => {
    const existing = values.PT_Ma ? state.PhieuThu.find((row) => row.PT_Ma === values.PT_Ma) : null;
    if (existing && (existing.PT_TrangThai !== "Nháp" || existing.TTBH_Ma)) {
      throw new Error("Phiếu thu tự động hoặc phiếu đã xác nhận không được sửa.");
    }
    const TTBH_Ma = String(values.TTBH_Ma || "").trim() || null;
    if (TTBH_Ma) throw new Error("Phiếu thu bán hàng được tạo tự động khi thanh toán thành công; phiếu thủ công chỉ dùng cho khoản thu khác.");
    const amount = amountValue(values.PT_SoTien);
    const method = String(values.PT_PhuongThuc || "");
    validateVoucherMethod(method);
    if (method !== "Tiền mặt") throw new Error("Phiếu thu chỉ dùng để ghi nhận tiền mặt; khoản thu qua ngân hàng theo dõi từ thanh toán bán hàng.");
    const date = dateValue(values.PT_Ngay, "Ngày thu");
    const DT_Ma = values.DT_Ma || "";
    validatePartner(state, DT_Ma);
    const reason = String(values.PT_LyDo || "").trim();
    if (!reason) throw new Error("Vui lòng nhập lý do thu.");
    const voucher = existing || {
      PT_Ma: nextId("PT", state.PhieuThu, "PT_Ma"),
      PT_TrangThai: "Nháp"
    };
    Object.assign(voucher, {
      DT_Ma: DT_Ma || null,
      TTBH_Ma: null,
      NV_Ma: role === "Chủ cửa hàng" ? "NV001" : "NV003",
      PT_Ngay: `${date}T12:00:00`,
      PT_SoTien: amount,
      PT_LyDo: reason,
      PT_PhuongThuc: method,
      PT_GhiChu: String(values.PT_GhiChu || "").trim()
    });
    if (!existing) state.PhieuThu.push(voucher);
    return voucher.PT_Ma;
  });
}

export function setReceiptVoucherStatus(PT_Ma, status, role) {
  assertAccountant(role);
  if (!["Đã xác nhận", "Đã hủy"].includes(status)) throw new Error("Trạng thái phiếu thu không hợp lệ.");
  return runDemoTransaction((state) => {
    const voucher = state.PhieuThu.find((row) => row.PT_Ma === PT_Ma);
    if (!voucher || voucher.PT_TrangThai !== "Nháp") throw new Error("Chỉ xác nhận hoặc hủy phiếu thu nháp.");
    if (voucher.TTBH_Ma) throw new Error("Phiếu thu tự động không được sửa trạng thái thủ công.");
    if (status === "Đã xác nhận" && voucher.PT_PhuongThuc !== "Tiền mặt") {
      throw new Error("Phiếu thu xác nhận chỉ được ghi nhận tiền mặt.");
    }
    voucher.PT_TrangThai = status;
  });
}

export function saveExpenseVoucher(values, role) {
  assertAccountant(role);
  return runDemoTransaction((state) => {
    const existing = values.PC_Ma ? state.PhieuChi.find((row) => row.PC_Ma === values.PC_Ma) : null;
    if (existing && (existing.PC_TrangThai !== "Nháp" || existing.TTNCC_Ma)) {
      throw new Error("Chỉ được sửa phiếu chi khác ở trạng thái nháp.");
    }
    const amount = amountValue(values.PC_SoTien);
    const method = String(values.PC_PhuongThuc || "");
    validateVoucherMethod(method);
    if (method !== "Tiền mặt") throw new Error("Phiếu chi chỉ dùng để ghi nhận tiền mặt; khoản chi qua ngân hàng theo dõi từ thanh toán NCC.");
    const date = dateValue(values.PC_Ngay, "Ngày chi");
    validatePartner(state, values.DT_Ma || "");
    const reason = String(values.PC_LyDo || "").trim();
    if (!reason) throw new Error("Vui lòng nhập lý do chi.");
    const voucher = existing || {
      PC_Ma: nextId("PC", state.PhieuChi, "PC_Ma"),
      TTNCC_Ma: null,
      PC_TrangThai: "Nháp"
    };
    Object.assign(voucher, {
      DT_Ma: values.DT_Ma || null,
      NV_Ma: role === "Chủ cửa hàng" ? "NV001" : "NV003",
      PC_Ngay: `${date}T12:00:00`,
      PC_SoTien: amount,
      PC_LyDo: reason,
      PC_PhuongThuc: method,
      PC_GhiChu: String(values.PC_GhiChu || "").trim()
    });
    if (!existing) state.PhieuChi.push(voucher);
    return voucher.PC_Ma;
  });
}

export function setExpenseVoucherStatus(PC_Ma, status, role) {
  assertAccountant(role);
  if (!["Đã xác nhận", "Đã hủy"].includes(status)) throw new Error("Trạng thái phiếu chi không hợp lệ.");
  return runDemoTransaction((state) => {
    const voucher = state.PhieuChi.find((row) => row.PC_Ma === PC_Ma);
    if (!voucher || voucher.PC_TrangThai !== "Nháp" || voucher.TTNCC_Ma) {
      throw new Error("Chỉ xác nhận hoặc hủy phiếu chi khác ở trạng thái nháp.");
    }
    if (status === "Đã xác nhận" && voucher.PC_PhuongThuc !== "Tiền mặt") {
      throw new Error("Phiếu chi xác nhận chỉ được ghi nhận tiền mặt.");
    }
    voucher.PC_TrangThai = status;
  });
}

function groupedPurchaseLines(state, PN_Ma) {
  const grouped = new Map();
  for (const line of state.PhieuNhapChiTiet.filter((row) => row.PN_Ma === PN_Ma)) {
    const entry = grouped.get(line.HH_Ma) || { HH_Ma: line.HH_Ma, quantity: 0, amount: 0 };
    entry.quantity += Number(line.PNCT_SL || 0);
    entry.amount += Number(line.PNCT_TTien ?? line.PNCT_SL * line.PNCT_DonGia);
    grouped.set(line.HH_Ma, entry);
  }
  return grouped;
}

export function getPurchaseReconciliation(PN_Ma, state = getState()) {
  const receipt = state.PhieuNhap.find((row) => row.PN_Ma === PN_Ma);
  if (!receipt) throw new Error("Không tìm thấy phiếu nhập.");
  const order = state.DatHang.find((row) => row.DH_Ma === receipt.DH_Ma);
  const lines = state.PhieuNhapChiTiet.filter((row) => row.PN_Ma === PN_Ma);
  if (!order) return { receipt, order: null, lines, comparison: [], deliveries: [], message: "Nhập không theo đơn đặt hàng" };
  const orderLines = state.DatChiTiet.filter((row) => row.DH_Ma === order.DH_Ma);
  const current = groupedPurchaseLines(state, PN_Ma);
  const deliveries = state.PhieuNhap.filter((row) => row.DH_Ma === order.DH_Ma && row.PN_TrangThai === "Đã xác nhận");
  const delivered = new Map();
  for (const delivery of deliveries) {
    for (const [HH_Ma, line] of groupedPurchaseLines(state, delivery.PN_Ma)) {
      const aggregate = delivered.get(HH_Ma) || { quantity: 0, amount: 0 };
      aggregate.quantity += line.quantity;
      aggregate.amount += line.amount;
      delivered.set(HH_Ma, aggregate);
    }
  }
  const itemIds = new Set([...orderLines.map((row) => row.HH_Ma), ...current.keys()]);
  const comparison = [...itemIds].map((HH_Ma) => {
    const ordered = orderLines.filter((row) => row.HH_Ma === HH_Ma);
    const orderQty = ordered.reduce((sum, row) => sum + Number(row.DN_SL || 0), 0);
    const orderAmount = ordered.reduce((sum, row) => sum + Number(row.DN_TTien ?? row.DN_SL * row.DN_DonGia), 0);
    const orderUnitPrice = orderQty ? orderAmount / orderQty : 0;
    const currentRow = current.get(HH_Ma) || { quantity: 0, amount: 0 };
    const deliveryRow = delivered.get(HH_Ma) || { quantity: 0, amount: 0 };
    const currentUnitPrice = currentRow.quantity ? currentRow.amount / currentRow.quantity : 0;
    return {
      HH_Ma, orderQty, currentQty: currentRow.quantity, deliveredQty: deliveryRow.quantity,
      quantityDelta: deliveryRow.quantity - orderQty,
      orderUnitPrice, currentUnitPrice, priceDelta: currentRow.quantity ? currentUnitPrice - orderUnitPrice : 0,
      amount: currentRow.amount
    };
  });
  const progress = comparison.some((row) => row.quantityDelta > 0) ? "Vượt số lượng đặt"
    : comparison.every((row) => row.deliveredQty === row.orderQty) ? "Đã nhận đủ"
      : "Đang giao";
  return { receipt, order, lines, comparison, deliveries, progress, message: "" };
}

function saleMovementMismatch(state, invoice) {
  const expected = new Map();
  for (const line of state.HoaDonBanHangChiTiet.filter((row) => row.BH_Ma === invoice.BH_Ma)) {
    expected.set(line.PNCT_Ma, (expected.get(line.PNCT_Ma) || 0) - Number(line.BH_SL || 0));
  }
  const actual = new Map();
  for (const movement of state.BienDongKho.filter((row) => row.BDK_Nguon === "HoaDonBanHang" && row.BDK_MaChungTu === invoice.BH_Ma)) {
    actual.set(movement.PNCT_Ma, (actual.get(movement.PNCT_Ma) || 0) + Number(movement.BDK_SoLuong || 0));
  }
  const ids = new Set([...expected.keys(), ...actual.keys()]);
  return [...ids].some((id) => (expected.get(id) || 0) !== (actual.get(id) || 0));
}

export function getSalesRevenueReconciliation(filters = {}, state = getState()) {
  return state.HoaDonBanHang.filter((invoice) =>
    (!filters.location || invoice.DD_Ma === filters.location)
    && (!filters.staff || invoice.NV_Ma === filters.staff)
    && (!filters.from || invoice.BH_Ngay.slice(0, 10) >= filters.from)
    && (!filters.to || invoice.BH_Ngay.slice(0, 10) <= filters.to)
    && (!filters.status || invoice.BH_TrangThai === filters.status)
  ).map((invoice) => {
    const lines = state.HoaDonBanHangChiTiet.filter((row) => row.BH_Ma === invoice.BH_Ma);
    const detailAmount = lines.reduce((sum, row) => sum + Number(row.BH_TTien || 0), 0);
    const detailQuantity = lines.reduce((sum, row) => sum + Number(row.BH_SL || 0), 0);
    const payments = state.ThanhToanBanHang.filter((row) => row.BH_Ma === invoice.BH_Ma);
    const paid = payments.filter((row) => row.TTBH_TrangThai === "Thành công").reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
    const pending = payments.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận").reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
    const due = activeInvoice(invoice) ? Math.max(0, invoice.BH_TongCong - paid) : 0;
    const reasons = [];
    if (activeInvoice(invoice) && detailAmount !== invoice.BH_TongCong) reasons.push(`Tổng hóa đơn lệch tổng chi tiết ${formatCurrency(invoice.BH_TongCong - detailAmount)}`);
    if (activeInvoice(invoice) && detailQuantity !== invoice.BH_TongSL) reasons.push(`Tổng số lượng lệch chi tiết ${invoice.BH_TongSL - detailQuantity}`);
    if (paid > invoice.BH_TongCong) reasons.push("Thanh toán thành công vượt tổng hóa đơn");
    if (invoice.BH_TrangThai === "Đã hủy" && paid > 0) reasons.push("Hóa đơn đã hủy nhưng còn thanh toán thành công");
    if (saleMovementMismatch(state, invoice)) reasons.push("Biến động kho không khớp số lượng chi tiết hóa đơn");
    if (activeInvoice(invoice) && !invoice.DT_Ma && due > 0) reasons.push("Hóa đơn khách lẻ còn khoản phải thu không định danh");
    const status = reasons.length ? "Bất thường cần kiểm tra"
      : invoice.BH_TrangThai === "Đã hủy" ? "Đã hủy (không tính doanh thu)"
        : pending > 0 ? "Chờ xử lý thanh toán"
        : due > 0 ? "Khớp dữ liệu, còn phải thu hợp lệ"
          : "Khớp dữ liệu, đã thu đủ";
    return { invoice, detailAmount, detailQuantity, paid, pending, due, reasons, status };
  });
}

export function getPaymentReconciliation(filters = {}, state = getState()) {
  const inRange = (date) => (!filters.from || String(date).slice(0, 10) >= filters.from)
    && (!filters.to || String(date).slice(0, 10) <= filters.to);
  const sales = state.ThanhToanBanHang.filter((row) => inRange(row.TTBH_Ngay));
  const supplier = state.ThanhToanNCC.filter((row) => inRange(row.TTNCC_Ngay));
  const receipts = state.PhieuThu.filter((row) => inRange(row.PT_Ngay));
  const expenses = state.PhieuChi.filter((row) => inRange(row.PC_Ngay));
  const supplierRows = supplier.map((payment) => {
    const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === payment.CTNNCC_Ma);
    const linkedVoucher = state.PhieuChi.find((row) => row.TTNCC_Ma === payment.TTNCC_Ma);
    const alerts = [];
    if (!debt) alerts.push("Không tìm thấy khoản nợ liên kết");
    if (debt && debtPaid(state, debt.CTNNCC_Ma) > debt.CTNNCC_SoTienNo) alerts.push("Tổng thanh toán thành công vượt nợ gốc");
    if (linkedVoucher && linkedVoucher.PC_SoTien !== payment.TTNCC_SoTien) alerts.push("Số tiền phiếu chi không khớp thanh toán NCC");
    const expectedVoucherStatus = payment.TTNCC_TrangThai === "Thành công" ? "Đã xác nhận" : payment.TTNCC_TrangThai;
    if (linkedVoucher && linkedVoucher.PC_TrangThai !== expectedVoucherStatus) alerts.push("Trạng thái phiếu chi và thanh toán NCC không khớp");
    if (state.PhieuChi.filter((row) => row.TTNCC_Ma === payment.TTNCC_Ma).length > 1) alerts.push("Có nhiều phiếu chi liên kết cùng giao dịch NCC");
    return { payment, debt, linkedVoucher, alerts };
  });
  const independentExpenses = expenses.filter((row) => !row.TTNCC_Ma && confirmedExpense(row)
    && row.PC_PhuongThuc === "Tiền mặt");
  const recognizedSupplierExpense = supplier.filter(successful).reduce((sum, row) => sum + row.TTNCC_SoTien, 0);
  const recognizedSalesIncome = sales.filter((row) => row.TTBH_TrangThai === "Thành công").reduce((sum, row) => sum + row.TTBH_SoTien, 0);
  const recognizedOtherIncome = receipts.filter((row) => confirmedVoucher(row) && !row.TTBH_Ma
    && row.PT_PhuongThuc === "Tiền mặt").reduce((sum, row) => sum + row.PT_SoTien, 0);
  const recognizedOtherExpense = independentExpenses.reduce((sum, row) => sum + row.PC_SoTien, 0);
  const receiptRows = state.PhieuThu.filter((row) => row.TTBH_Ma);
  const receiptAlerts = receiptRows.flatMap((voucher) => {
    const linkedPayment = state.ThanhToanBanHang.find((row) => row.TTBH_Ma === voucher.TTBH_Ma);
    const alerts = [];
    if (!linkedPayment) alerts.push("Phiếu thu liên kết không có thanh toán bán hàng");
    else if (linkedPayment.TTBH_TrangThai !== "Thành công" || linkedPayment.TTBH_SoTien !== voucher.PT_SoTien
      || linkedPayment.TTBH_PhuongThuc !== voucher.PT_PhuongThuc || voucher.PT_TrangThai !== "Đã xác nhận") {
      alerts.push("Phiếu thu không khớp giao dịch thanh toán thành công");
    }
    if (receiptRows.filter((row) => row.TTBH_Ma === voucher.TTBH_Ma).length > 1) alerts.push("Có nhiều phiếu thu liên kết cùng giao dịch bán hàng");
    return alerts.map((message) => `${voucher.PT_Ma}: ${message}`);
  });
  const missingSalesReceipts = sales.filter((row) => row.TTBH_TrangThai === "Thành công"
    && !state.PhieuThu.some((voucher) => voucher.TTBH_Ma === row.TTBH_Ma));
  return {
    sales,
    supplier: supplierRows,
    receipts,
    expenses,
    independentExpenses,
    recognizedSalesIncome,
    recognizedOtherIncome,
    recognizedSupplierExpense,
    recognizedOtherExpense,
    netCashMovement: recognizedSalesIncome + recognizedOtherIncome - recognizedSupplierExpense - recognizedOtherExpense,
    alerts: [
      ...sales.filter((row) => ["Chờ xác nhận", "Thất bại"].includes(row.TTBH_TrangThai)).map((row) => `${row.TTBH_Ma}: ${row.TTBH_TrangThai}`),
      ...state.HoaDonBanHang.filter((invoice) => getInvoicePaid(invoice.BH_Ma, state) > invoice.BH_TongCong)
        .map((invoice) => `${invoice.BH_Ma}: thanh toán thành công vượt tổng hóa đơn`),
      ...supplierRows.filter(({ payment }) => ["Chờ xác nhận", "Thất bại"].includes(payment.TTNCC_TrangThai)).map(({ payment }) => `${payment.TTNCC_Ma}: ${payment.TTNCC_TrangThai}`),
      ...supplierRows.flatMap(({ payment, alerts }) => alerts.map((text) => `${payment.TTNCC_Ma}: ${text}`)),
      ...receiptAlerts,
      ...missingSalesReceipts.map((payment) => `${payment.TTBH_Ma}: thiếu phiếu thu liên kết`),
      ...state.PhieuChi.filter((row) => row.TTNCC_Ma && !state.ThanhToanNCC.some((payment) => payment.TTNCC_Ma === row.TTNCC_Ma))
        .map((row) => `${row.PC_Ma}: phiếu chi liên kết không có thanh toán NCC`)
    ]
  };
}

export function getCashbook(filters = {}, state = getState()) {
  const rows = [];
  const inRange = (date) => (!filters.from || String(date).slice(0, 10) >= filters.from)
    && (!filters.to || String(date).slice(0, 10) <= filters.to);
  const matches = (row) => inRange(row.date)
    && (!filters.method || row.method === filters.method)
    && (!filters.type || row.type === filters.type)
    && (!filters.partner || row.partnerId === filters.partner)
    && (!filters.status || row.status === filters.status);
  for (const payment of state.ThanhToanBanHang) {
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === payment.BH_Ma);
    if (!invoice) continue;
    const linkedReceipt = state.PhieuThu.find((row) => row.TTBH_Ma === payment.TTBH_Ma);
    const row = {
      date: payment.TTBH_Ngay, voucherId: payment.TTBH_Ma, sourceId: payment.BH_Ma,
      linkedVoucherId: linkedReceipt?.PT_Ma || "", type: "Thu bán hàng",
      content: `Thanh toán hóa đơn ${payment.BH_Ma}`, partnerId: invoice.DT_Ma || "",
      method: payment.TTBH_PhuongThuc, incoming: payment.TTBH_SoTien, outgoing: 0,
      status: payment.TTBH_TrangThai, recognized: payment.TTBH_TrangThai === "Thành công"
    };
    if (matches(row)) rows.push(row);
  }
  for (const voucher of state.PhieuThu.filter((row) => !row.TTBH_Ma)) {
    const row = {
      date: voucher.PT_Ngay, voucherId: voucher.PT_Ma, sourceId: "", linkedVoucherId: "",
      type: "Thu khác", content: voucher.PT_LyDo, partnerId: voucher.DT_Ma || "",
      method: voucher.PT_PhuongThuc, incoming: voucher.PT_SoTien, outgoing: 0,
      status: voucher.PT_TrangThai,
      recognized: confirmedVoucher(voucher) && voucher.PT_PhuongThuc === "Tiền mặt"
    };
    if (matches(row)) rows.push(row);
  }
  for (const payment of state.ThanhToanNCC) {
    const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === payment.CTNNCC_Ma);
    const creditor = state.CongNoNCC.find((row) => row.CNNCC_Ma === debt?.CNNCC_Ma);
    const linkedVoucher = state.PhieuChi.find((row) => row.TTNCC_Ma === payment.TTNCC_Ma);
    const row = {
      date: payment.TTNCC_Ngay, voucherId: payment.TTNCC_Ma, sourceId: payment.CTNNCC_Ma,
      linkedVoucherId: linkedVoucher?.PC_Ma || "", type: "Chi NCC",
      content: `Thanh toán công nợ ${payment.CTNNCC_Ma}`, partnerId: creditor?.DT_Ma || "",
      method: payment.TTNCC_PhuongThuc, incoming: 0, outgoing: payment.TTNCC_SoTien,
      status: payment.TTNCC_TrangThai, recognized: successful(payment)
    };
    if (matches(row)) rows.push(row);
  }
  for (const voucher of state.PhieuChi.filter((row) => !row.TTNCC_Ma)) {
    const row = {
      date: voucher.PC_Ngay, voucherId: voucher.PC_Ma, sourceId: "", linkedVoucherId: "",
      type: "Chi khác", content: voucher.PC_LyDo, partnerId: voucher.DT_Ma || "",
      method: voucher.PC_PhuongThuc, incoming: 0, outgoing: voucher.PC_SoTien,
      status: voucher.PC_TrangThai, recognized: confirmedExpense(voucher) && voucher.PC_PhuongThuc === "Tiền mặt"
    };
    if (matches(row)) rows.push(row);
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.voucherId.localeCompare(a.voucherId));
  const recognized = rows.filter((row) => row.recognized);
  const isCash = (row) => row.method === "Tiền mặt";
  const total = (list, field) => list.reduce((sum, row) => sum + Number(row[field] || 0), 0);
  const cashIncome = total(recognized.filter((row) => row.incoming && isCash(row)), "incoming");
  const bankIncome = total(recognized.filter((row) => row.incoming && !isCash(row)), "incoming");
  const cashExpense = total(recognized.filter((row) => row.outgoing && isCash(row)), "outgoing");
  const bankExpense = total(recognized.filter((row) => row.outgoing && !isCash(row)), "outgoing");
  return {
    rows,
    cashIncome,
    bankIncome,
    cashExpense,
    bankExpense,
    net: cashIncome + bankIncome - cashExpense - bankExpense
  };
}

export function getAccountingDashboard(filters = {}, state = getState()) {
  const revenueRows = getSalesRevenueReconciliation(filters, state);
  const validRevenue = revenueRows.filter(({ invoice }) => activeInvoice(invoice));
  const dateMatch = (date) => (!filters.from || String(date).slice(0, 10) >= filters.from)
    && (!filters.to || String(date).slice(0, 10) <= filters.to);
  const salesPayments = state.ThanhToanBanHang.filter((row) => dateMatch(row.TTBH_Ngay)
    && row.TTBH_TrangThai === "Thành công"
    && (!filters.location || state.HoaDonBanHang.find((invoice) => invoice.BH_Ma === row.BH_Ma)?.DD_Ma === filters.location));
  const payables = getSupplierPayables("", state);
  const receipts = state.PhieuThu.filter((row) => confirmedVoucher(row) && !row.TTBH_Ma
    && row.PT_PhuongThuc === "Tiền mặt" && dateMatch(row.PT_Ngay));
  const supplierPayments = state.ThanhToanNCC.filter((row) => successful(row) && dateMatch(row.TTNCC_Ngay));
  const otherExpenses = state.PhieuChi.filter((row) => !row.TTNCC_Ma && confirmedExpense(row)
    && row.PC_PhuongThuc === "Tiền mặt" && dateMatch(row.PC_Ngay));
  const discrepancies = state.PhieuNhap.filter((row) => row.PN_TrangThai === "Đã xác nhận"
    && dateMatch(row.PN_Ngay) && (!filters.location || row.DD_Ma === filters.location)).map((row) => getPurchaseReconciliation(row.PN_Ma, state))
    .filter(({ order, comparison }) => order && comparison.some((line) => line.quantityDelta > 0 || (line.currentQty && Math.round(line.priceDelta) !== 0)));
  const pendingSales = state.ThanhToanBanHang.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận"
    && dateMatch(row.TTBH_Ngay)
    && (!filters.location || state.HoaDonBanHang.find((invoice) => invoice.BH_Ma === row.BH_Ma)?.DD_Ma === filters.location));
  const pendingSupplier = state.ThanhToanNCC.filter((row) => row.TTNCC_TrangThai === "Chờ xác nhận" && dateMatch(row.TTNCC_Ngay));
  return {
    revenue: validRevenue.reduce((sum, row) => sum + row.invoice.BH_TongCong, 0),
    salesCollected: salesPayments.reduce((sum, row) => sum + row.TTBH_SoTien, 0),
    otherIncome: receipts.reduce((sum, row) => sum + row.PT_SoTien, 0),
    supplierPaid: supplierPayments.reduce((sum, row) => sum + row.TTNCC_SoTien, 0),
    otherExpense: otherExpenses.reduce((sum, row) => sum + row.PC_SoTien, 0),
    receivableBalance: state.HoaDonBanHang.filter(activeInvoice).filter((row) => !filters.location || row.DD_Ma === filters.location)
      .reduce((sum, row) => sum + getInvoiceOutstanding(row.BH_Ma, state), 0),
    payableBalance: payables.reduce((sum, row) => sum + row.due, 0),
    purchaseDiscrepancies: discrepancies,
    pendingPayments: pendingSales.length + pendingSupplier.length,
    payables,
    receivables: getCustomerReceivables("", state),
    pendingSales,
    currentBalancesNote: "Công nợ phải thu/phải trả là số dư hiện tại; bộ lọc ngày không áp dụng cho số dư này."
  };
}

export function getCustomerReceivables(DT_Ma = "", state = getState()) {
  return state.CongNoKhachHang.map((debt) => {
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === debt.BH_Ma);
    return { debt, invoice, paid: invoice ? getInvoicePaid(invoice.BH_Ma, state) : 0, due: invoice ? getInvoiceOutstanding(invoice.BH_Ma, state) : 0 };
  }).filter(({ invoice, due }) => invoice && (!DT_Ma || invoice.DT_Ma === DT_Ma) && due > 0);
}

export function getAccountingReports(state = getState()) {
  const sales = state.HoaDonBanHang.filter(activeInvoice);
  const salesDetails = state.HoaDonBanHangChiTiet.filter((line) => sales.some((invoice) => invoice.BH_Ma === line.BH_Ma));
  const salesPayments = state.ThanhToanBanHang.filter((row) => row.TTBH_TrangThai === "Thành công");
  const supplierPayments = state.ThanhToanNCC.filter(successful);
  const receipts = state.PhieuThu.filter((row) => confirmedVoucher(row) && !row.TTBH_Ma
    && row.PT_PhuongThuc === "Tiền mặt");
  const otherExpenses = state.PhieuChi.filter((row) => !row.TTNCC_Ma && confirmedExpense(row) && row.PC_PhuongThuc === "Tiền mặt");
  const costByLine = new Map(state.PhieuNhapChiTiet.map((row) => [row.PNCT_Ma, row.PNCT_DonGia]));
  const revenue = sales.reduce((sum, row) => sum + row.BH_TongCong, 0);
  const cost = salesDetails.reduce((sum, row) => sum + Number(row.BH_SL || 0) * Number(costByLine.get(row.PNCT_Ma) || 0), 0);
  const inventoryValue = state.TonKho.reduce((sum, row) => sum + Number(row.TK_SL || 0) * Number(costByLine.get(row.PNCT_Ma) || 0), 0);
  const receivedSales = salesPayments.reduce((sum, row) => sum + row.TTBH_SoTien, 0);
  const receivedOther = receipts.reduce((sum, row) => sum + row.PT_SoTien, 0);
  const paidSuppliers = supplierPayments.reduce((sum, row) => sum + row.TTNCC_SoTien, 0);
  const paidOther = otherExpenses.reduce((sum, row) => sum + row.PC_SoTien, 0);
  const days = new Map();
  for (const invoice of sales) {
    const key = invoice.BH_Ngay.slice(0, 10);
    const summary = days.get(key) || { date: key, revenue: 0, invoices: 0, quantity: 0 };
    summary.revenue += invoice.BH_TongCong;
    summary.invoices++;
    summary.quantity += invoice.BH_TongSL;
    days.set(key, summary);
  }
  const locations = new Map();
  for (const invoice of sales) {
    const summary = locations.get(invoice.DD_Ma) || { id: invoice.DD_Ma, revenue: 0, invoices: 0, quantity: 0 };
    summary.revenue += invoice.BH_TongCong;
    summary.invoices++;
    summary.quantity += invoice.BH_TongSL;
    locations.set(invoice.DD_Ma, summary);
  }
  return {
    revenue, invoiceCount: sales.length, soldQuantity: sales.reduce((sum, row) => sum + row.BH_TongSL, 0),
    revenueByDay: [...days.values()].sort((a, b) => b.date.localeCompare(a.date)),
    revenueByLocation: [...locations.values()],
    receivedSales, receivedOther, paidSuppliers, paidOther,
    cashDifference: receivedSales + receivedOther - paidSuppliers - paidOther,
    receivableBalance: state.HoaDonBanHang.filter(activeInvoice).reduce((sum, row) => sum + getInvoiceOutstanding(row.BH_Ma, state), 0),
    payableBalance: getSupplierPayables("", state).reduce((sum, row) => sum + row.due, 0),
    inventoryValue, cost, grossProfit: revenue - cost,
    debtDetails: getSupplierPayables("", state).flatMap((row) => row.details.filter((debt) => debt.due > 0)),
    customerDebts: getCustomerReceivables("", state),
  };
}
