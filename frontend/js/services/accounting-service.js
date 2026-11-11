import { authenticatedApiRequest } from "./auth-service.js";
import {
  confirmCashHandover as handoverShift,
  confirmGoodsReceipt,
  createSupplierDebt,
  reconcileCashShift as reconcileShift,
  requestCashShiftExplanation as requestShiftExplanation
} from "./accounting-api-service.js";
import { formatCurrency } from "../utils/formatters.js";

const API = "/api/accounting/";
const ACCOUNTANT_ROLES = new Set(["Chủ cửa hàng", "Nhân viên kế toán"]);
const paymentMethods = new Set(["Tiền mặt", "Chuyển khoản", "QR"]);
const successful = (row) => row.TTNCC_TrangThai === "Thành công";
const activeInvoice = (row) => row.BH_TrangThai === "Đã xác nhận";
const confirmedVoucher = (row) => row.PT_TrangThai === "Đã xác nhận";
const confirmedExpense = (row) => row.PC_TrangThai === "Đã xác nhận";
const invoicePaid = (invoiceCode, state) => state.ThanhToanBanHang
  .filter((row) => row.BH_Ma === invoiceCode && row.TTBH_TrangThai === "Thành công")
  .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
const invoiceOutstanding = (invoice, state) => Math.max(0, invoice.BH_TongCong - invoicePaid(invoice.BH_Ma, state));

function assertAccountant(role) {
  if (!ACCOUNTANT_ROLES.has(role)) throw new Error("Chỉ kế toán hoặc chủ cửa hàng được thực hiện nghiệp vụ kế toán.");
}

function debtPaid(state, debtCode, includePending = false) {
  return state.ThanhToanNCC
    .filter((row) => row.CTNNCC_Ma === debtCode
      && (successful(row) || (includePending && row.TTNCC_TrangThai === "Chờ xác nhận")))
    .reduce((sum, row) => sum + Number(row.TTNCC_SoTien || 0), 0);
}

function debtBalance(state, debt) {
  return Math.max(0, Number(debt.CTNNCC_SoTienNo || 0) - debtPaid(state, debt.CTNNCC_Ma));
}

export function getSupplierDebtBalance(debtCode, state) {
  const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === debtCode);
  if (!debt) throw new Error("Không tìm thấy khoản nợ nhà cung cấp.");
  return debtBalance(state, debt);
}

export function getSupplierDebtDetails(supplierCode, state) {
  return state.ChiTietNoNCC.filter((row) => row.CNNCC_Ma === supplierCode).map((debt) => {
    const receipt = state.PhieuNhap.find((row) => row.PN_Ma === debt.PN_Ma);
    const paid = debtPaid(state, debt.CTNNCC_Ma);
    const pending = state.ThanhToanNCC
      .filter((row) => row.CTNNCC_Ma === debt.CTNNCC_Ma && row.TTNCC_TrangThai === "Chờ xác nhận")
      .reduce((sum, row) => sum + Number(row.TTNCC_SoTien || 0), 0);
    return { debt, receipt, paid, due: debtBalance(state, debt), pending };
  }).sort((a, b) => String(b.receipt?.PN_Ngay || "").localeCompare(String(a.receipt?.PN_Ngay || "")));
}

export function getSupplierPayables(supplierCode = "", state) {
  return state.CongNoNCC.filter((row) => !supplierCode || row.DT_Ma === supplierCode).map((creditor) => {
    const details = getSupplierDebtDetails(creditor.CNNCC_Ma, state);
    const principal = details.reduce((sum, row) => sum + Number(row.debt.CTNNCC_SoTienNo || 0), 0);
    const paid = details.reduce((sum, row) => sum + row.paid, 0);
    const due = details.reduce((sum, row) => sum + row.due, 0);
    return { creditor, details, principal, paid, due, status: due ? "Còn nợ" : "Đã thanh toán" };
  });
}

export async function createSupplierDebtFromReceipt(receiptCode, role) {
  assertAccountant(role);
  return createSupplierDebt(receiptCode);
}

export async function confirmInboundWithPayable(receiptCode, role) {
  assertAccountant(role);
  await confirmGoodsReceipt(receiptCode);
  const debt = await createSupplierDebt(receiptCode);
  return { PN_Ma: receiptCode, debtId: debt?.code || "" };
}

export async function recordSupplierPayment(debtCode, { amount, method, date, note = "" }, role) {
  assertAccountant(role);
  if (!Number.isSafeInteger(Number(amount)) || Number(amount) <= 0) {
    throw new Error("Số tiền phải là số nguyên VND lớn hơn 0.");
  }
  if (!paymentMethods.has(String(method || ""))) throw new Error("Phương thức thanh toán không hợp lệ.");
  const receiptCode = String(debtCode || "").trim();
  if (!receiptCode) throw new Error("Cần chọn khoản nợ nhà cung cấp.");
  return authenticatedApiRequest(`${API}supplier-debts/${encodeURIComponent(receiptCode)}/payments/`, {
    method: "POST",
    body: { amount: Number(amount), method, date, note: String(note || "").trim() }
  });
}

export async function confirmSupplierPayment(paymentCode, role) {
  assertAccountant(role);
  return authenticatedApiRequest(`${API}supplier-payments/${encodeURIComponent(paymentCode)}/confirm/`, {
    method: "POST",
    body: {}
  });
}

export async function setSupplierPaymentStatus(paymentCode, status, role) {
  assertAccountant(role);
  const action = status === "Thất bại" ? "fail" : status === "Đã hủy" ? "cancel" : "";
  if (!action) throw new Error("Trạng thái thanh toán không hợp lệ.");
  return authenticatedApiRequest(`${API}supplier-payments/${encodeURIComponent(paymentCode)}/${action}/`, {
    method: "POST",
    body: {}
  });
}

export async function createSupplierPaymentVoucher(paymentCode, role) {
  assertAccountant(role);
  return authenticatedApiRequest(`${API}supplier-payments/${encodeURIComponent(paymentCode)}/expense-voucher/`, {
    method: "POST",
    body: {}
  });
}

export async function saveReceiptVoucher(values, role) {
  assertAccountant(role);
  return authenticatedApiRequest(`${API}receipts/`, {
    method: "POST",
    body: {
      code: values.PT_Ma || "",
      customer: values.DT_Ma || null,
      date: values.PT_Ngay,
      amount: Number(values.PT_SoTien),
      reason: String(values.PT_LyDo || "").trim(),
      method: values.PT_PhuongThuc || "Tiền mặt",
      note: String(values.PT_GhiChu || "").trim()
    }
  });
}

export async function setReceiptVoucherStatus(voucherCode, status, role) {
  assertAccountant(role);
  return authenticatedApiRequest(`${API}receipts/${encodeURIComponent(voucherCode)}/status/`, {
    method: "POST",
    body: { status }
  });
}

export async function saveExpenseVoucher(values, role) {
  assertAccountant(role);
  return authenticatedApiRequest(`${API}expenses/`, {
    method: "POST",
    body: {
      code: values.PC_Ma || "",
      supplier: values.DT_Ma || null,
      date: values.PC_Ngay,
      amount: Number(values.PC_SoTien),
      reason: String(values.PC_LyDo || "").trim(),
      method: values.PC_PhuongThuc || "Tiền mặt",
      note: String(values.PC_GhiChu || "").trim()
    }
  });
}

export async function setExpenseVoucherStatus(voucherCode, status, role) {
  assertAccountant(role);
  return authenticatedApiRequest(`${API}expenses/${encodeURIComponent(voucherCode)}/status/`, {
    method: "POST",
    body: { status }
  });
}

export async function syncSalesReceipt(paymentCode, role) {
  assertAccountant(role);
  return authenticatedApiRequest(`${API}sales-payments/${encodeURIComponent(paymentCode)}/receipt/`, {
    method: "POST",
    body: {}
  });
}

export async function syncMissingSalesReceipts(state, role) {
  assertAccountant(role);
  const missing = state.ThanhToanBanHang.filter((payment) => payment.TTBH_TrangThai === "Thành công"
    && !state.PhieuThu.some((voucher) => voucher.TTBH_Ma === payment.TTBH_Ma));
  return Promise.all(missing.map((payment) => syncSalesReceipt(payment.TTBH_Ma, role)));
}

function groupedPurchaseLines(state, receiptCode) {
  const grouped = new Map();
  for (const line of state.PhieuNhapChiTiet.filter((row) => row.PN_Ma === receiptCode)) {
    const entry = grouped.get(line.HH_Ma) || { HH_Ma: line.HH_Ma, quantity: 0, amount: 0 };
    entry.quantity += Number(line.PNCT_SL || 0);
    entry.amount += Number(line.PNCT_TTien ?? line.PNCT_SL * line.PNCT_DonGia);
    grouped.set(line.HH_Ma, entry);
  }
  return grouped;
}

export function getPurchaseReconciliation(receiptCode, state) {
  const receipt = state.PhieuNhap.find((row) => row.PN_Ma === receiptCode);
  if (!receipt) throw new Error("Không tìm thấy phiếu nhập.");
  const serverResult = state.PurchaseReconciliation.get(receiptCode);
  if (!receipt.DH_Ma) {
    return { receipt, order: null, lines: receipt.lines, comparison: [], deliveries: [], message: "Nhập không theo đơn đặt hàng" };
  }
  if (serverResult) {
    const order = { DH_Ma: serverResult.DH_Ma };
    const deliveries = state.PhieuNhap.filter((row) => row.DH_Ma === receipt.DH_Ma && row.PN_TrangThai === "Đã xác nhận");
    return {
      receipt,
      order,
      lines: receipt.lines,
      comparison: serverResult.comparison,
      deliveries,
      progress: serverResult.progress,
      message: ""
    };
  }
  const deliveries = state.PhieuNhap.filter((row) => row.DH_Ma === receipt.DH_Ma && row.PN_TrangThai === "Đã xác nhận");
  return {
    receipt,
    order: { DH_Ma: receipt.DH_Ma },
    lines: receipt.lines,
    comparison: [],
    deliveries,
    progress: "Đang giao",
    message: ""
  };
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

export function getSalesRevenueReconciliation(filters = {}, state) {
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
    const paid = payments.filter((row) => row.TTBH_TrangThai === "Thành công")
      .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
    const pending = payments.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận")
      .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
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

export function getPaymentReconciliation(filters = {}, state) {
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
    return { payment, debt, linkedVoucher, alerts };
  });
  const recognizedSalesIncome = sales.filter((row) => row.TTBH_TrangThai === "Thành công")
    .reduce((sum, row) => sum + row.TTBH_SoTien, 0);
  const recognizedSupplierExpense = supplier.filter(successful)
    .reduce((sum, row) => sum + row.TTNCC_SoTien, 0);
  const recognizedOtherIncome = receipts.filter((row) => confirmedVoucher(row) && !row.TTBH_Ma && row.PT_PhuongThuc === "Tiền mặt")
    .reduce((sum, row) => sum + row.PT_SoTien, 0);
  const recognizedOtherExpense = expenses.filter((row) => confirmedExpense(row) && !row.TTNCC_Ma && row.PC_PhuongThuc === "Tiền mặt")
    .reduce((sum, row) => sum + row.PC_SoTien, 0);
  const alerts = [
    ...sales.filter((row) => row.TTBH_TrangThai !== "Thành công" && row.TTBH_TrangThai !== "Đã hủy")
      .map((row) => `${row.TTBH_Ma}: ${row.TTBH_TrangThai}`),
    ...sales.filter((row) => row.TTBH_TrangThai === "Thành công"
      && !state.PhieuThu.some((voucher) => voucher.TTBH_Ma === row.TTBH_Ma))
      .map((row) => `${row.TTBH_Ma}: thiếu phiếu thu liên kết`),
    ...supplierRows.flatMap(({ payment, alerts: issues }) => issues.map((issue) => `${payment.TTNCC_Ma}: ${issue}`))
  ];
  return {
    sales,
    supplier: supplierRows,
    alerts: [...new Set(alerts)],
    recognizedSalesIncome,
    recognizedSupplierExpense,
    recognizedOtherIncome,
    recognizedOtherExpense,
    netCashMovement: recognizedSalesIncome + recognizedOtherIncome - recognizedSupplierExpense - recognizedOtherExpense
  };
}

export function getCashbook(filters = {}, state) {
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
      status: voucher.PT_TrangThai, recognized: confirmedVoucher(voucher) && voucher.PT_PhuongThuc === "Tiền mặt"
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
  const total = (list, field) => list.reduce((sum, row) => sum + Number(row[field] || 0), 0);
  const cashIncome = total(recognized.filter((row) => row.incoming && row.method === "Tiền mặt"), "incoming");
  const bankIncome = total(recognized.filter((row) => row.incoming && row.method !== "Tiền mặt"), "incoming");
  const cashExpense = total(recognized.filter((row) => row.outgoing && row.method === "Tiền mặt"), "outgoing");
  const bankExpense = total(recognized.filter((row) => row.outgoing && row.method !== "Tiền mặt"), "outgoing");
  return { rows, cashIncome, bankIncome, cashExpense, bankExpense, net: cashIncome + bankIncome - cashExpense - bankExpense };
}

export function getAccountingDashboard(filters = {}, state) {
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
    && dateMatch(row.PN_Ngay) && (!filters.location || row.DD_Ma === filters.location))
    .map((row) => getPurchaseReconciliation(row.PN_Ma, state))
    .filter(({ order, comparison }) => order && comparison.some((line) => line.quantityDelta > 0 || (line.currentQty && Math.round(line.priceDelta) !== 0)));
  const pendingSales = state.ThanhToanBanHang.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận"
    && dateMatch(row.TTBH_Ngay)
    && (!filters.location || state.HoaDonBanHang.find((invoice) => invoice.BH_Ma === row.BH_Ma)?.DD_Ma === filters.location));
  const pendingSupplier = state.ThanhToanNCC.filter((row) => row.TTNCC_TrangThai === "Chờ xác nhận" && dateMatch(row.TTNCC_Ngay));
  const customerDebts = getCustomerReceivables("", state);
  return {
    revenue: validRevenue.reduce((sum, row) => sum + row.invoice.BH_TongCong, 0),
    salesCollected: salesPayments.reduce((sum, row) => sum + row.TTBH_SoTien, 0),
    otherIncome: receipts.reduce((sum, row) => sum + row.PT_SoTien, 0),
    supplierPaid: supplierPayments.reduce((sum, row) => sum + row.TTNCC_SoTien, 0),
    otherExpense: otherExpenses.reduce((sum, row) => sum + row.PC_SoTien, 0),
    receivableBalance: customerDebts
      .filter(({ invoice }) => !filters.location || invoice.DD_Ma === filters.location)
      .reduce((sum, row) => sum + row.due, 0),
    payableBalance: payables.reduce((sum, row) => sum + row.due, 0),
    purchaseDiscrepancies: discrepancies,
    pendingPayments: pendingSales.length + pendingSupplier.length,
    payables,
    receivables: customerDebts,
    pendingSales,
    currentBalancesNote: "Công nợ phải thu/phải trả là số dư hiện tại; bộ lọc ngày không áp dụng cho số dư này."
  };
}

export function getCustomerReceivables(customerCode = "", state) {
  return state.CongNoKhachHang.map((debt) => {
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === debt.BH_Ma);
    const paid = invoice ? invoicePaid(invoice.BH_Ma, state) : 0;
    const due = invoice ? invoiceOutstanding(invoice, state) : 0;
    return { debt, invoice, paid, due };
  }).filter(({ invoice, due }) => invoice && (!customerCode || invoice.DT_Ma === customerCode) && due > 0);
}

export function getAccountingReports(state) {
  const report = state.AccountingReports;
  const debtDetails = state.ChiTietNoNCC.map((debt) => {
    const receipt = state.PhieuNhap.find((row) => row.PN_Ma === debt.PN_Ma);
    const paid = debtPaid(state, debt.CTNNCC_Ma);
    return { debt, receipt, paid, due: debtBalance(state, debt) };
  }).filter((row) => row.due > 0);
  const customerDebts = getCustomerReceivables("", state);
  return {
    ...report,
    debtDetails,
    customerDebts
  };
}

export function getAccountingReplenishmentItems(storeCode, warehouseCode, state) {
  const activeLocations = state.DiaDiem.filter((row) => row.DD_TrangThai === "Hoạt động");
  const stockFor = (locationCode, productCode) => {
    let physical = 0;
    let available = 0;
    for (const stock of state.TonKho) {
      if (stock.DD_Ma !== locationCode || stock.TK_SL <= 0) continue;
      const line = state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === stock.PNCT_Ma);
      if (!line || line.HH_Ma !== productCode) continue;
      physical += stock.TK_SL;
      const receipt = state.PhieuNhap.find((row) => row.PN_Ma === line.PN_Ma);
      if (receipt?.PN_TrangThai === "Đã xác nhận"
        && (!line.PNCT_HSD || String(line.PNCT_HSD).slice(0, 10) >= new Date().toISOString().slice(0, 10))) {
        available += stock.TK_SL;
      }
    }
    return { physical, available, unavailable: Math.max(0, physical - available) };
  };
  return state.HangHoa.map((item) => {
    const store = stockFor(storeCode, item.HH_Ma);
    const warehouse = stockFor(warehouseCode, item.HH_Ma);
    const systemPhysical = activeLocations.reduce((sum, location) =>
      sum + stockFor(location.DD_Ma, item.HH_Ma).physical, 0);
    const systemAvailable = activeLocations.reduce((sum, location) =>
      sum + stockFor(location.DD_Ma, item.HH_Ma).available, 0);
    let status = "Đủ hàng";
    if (item.HH_TrangThai !== "Đang kinh doanh") status = "Ngừng kinh doanh";
    else if (store.available === 0 && warehouse.available > 0) status = "Hết hàng tại cửa hàng, kho còn";
    else if (store.available === 0 && systemAvailable > 0) status = "Hết hàng tại cửa hàng, nơi khác còn";
    else if (store.available === 0 && systemAvailable === 0 && systemPhysical > 0) status = "Có tồn nhưng không khả dụng";
    else if (store.available === 0) status = "Hết hàng toàn hệ thống";
    else if (store.available <= 10) status = "Sắp hết hàng tại cửa hàng";
    return { item, store, warehouse, systemPhysical, systemAvailable, status };
  });
}

export function calculateCashShift(shift, state) {
  const invoices = shift.invoiceIds.map((id) => state.HoaDonBanHang.find((row) => row.BH_Ma === id))
    .filter((row) => row && activeInvoice(row));
  const payments = shift.paymentIds.map((id) => state.ThanhToanBanHang.find((row) => row.TTBH_Ma === id))
    .filter(Boolean);
  const successfulPayments = payments.filter((row) => row.TTBH_TrangThai === "Thành công");
  const cash = successfulPayments.filter((row) => row.TTBH_PhuongThuc === "Tiền mặt")
    .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
  const transfer = successfulPayments.filter((row) => row.TTBH_PhuongThuc !== "Tiền mặt")
    .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
  const pendingPayments = payments.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận");
  const revenue = invoices.reduce((sum, row) => sum + Number(row.BH_TongCong || 0), 0);
  const unpaidFromShiftInvoices = invoices.reduce((sum, invoice) => {
    const paid = invoicePaid(invoice.BH_Ma, state);
    return sum + Math.max(0, Number(invoice.BH_TongCong || 0) - paid);
  }, 0);
  return {
    invoices,
    payments,
    pendingPayments,
    cash,
    transfer,
    revenue,
    expectedCash: shift.TienMatDuKien == null
      ? Number(shift.TienMatDauCa || 0) + cash
      : Number(shift.TienMatDuKien),
    invoiceCount: invoices.length,
    unpaidFromShiftInvoices
  };
}

export const requestCashShiftExplanation = requestShiftExplanation;
export const reconcileCashShift = reconcileShift;
export const confirmCashHandover = handoverShift;
