import { getState, resetDemoData } from "../../services/kho-service.js";
import {
  confirmInboundWithPayable, confirmSupplierPayment, createSupplierDebtFromReceipt, createSupplierPaymentVoucher,
  getAccountingDashboard, getAccountingReports, getCustomerReceivables,
  getCashbook, getPaymentReconciliation, getPurchaseReconciliation, getSalesRevenueReconciliation, getSupplierDebtBalance,
  getSupplierDebtDetails, getSupplierPayables, recordSupplierPayment, saveExpenseVoucher,
  saveReceiptVoucher, setExpenseVoucherStatus, setReceiptVoucherStatus,
  setSupplierPaymentStatus
} from "../../services/accounting-service.js";
import { getReplenishmentItems } from "../../services/inventory-service.js";
import {
  calculateCashShift, confirmCashHandover, getCashShift, getCashShifts, getOpenCashShift,
  getCashShiftForPayment, reconcileCashShift, requestCashShiftExplanation
} from "../../services/cash-register-service.js";
import { syncMissingSuccessfulSalesReceipts, syncSuccessfulSalesReceipt } from "../../services/sales-service.js";
import { escapeHtml as esc, formatCurrency, formatDate, formatNumber } from "../../utils/formatters.js";

const page = document.body.dataset.page;
const roleOptions = ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán", "Nhân viên bán hàng"];
const roleEmployees = { "Chủ cửa hàng": "NV001", "Nhân viên kho": "NV002", "Nhân viên kế toán": "NV003", "Nhân viên bán hàng": "NV004" };
const roleNames = Object.fromEntries(Object.entries(roleEmployees).map(([name, id]) => [id, name]));
const links = [
  ["accounting-overview", "Tổng quan kế toán", "tong-quan-ke-toan.html", "▦"],
  ["purchase-reconciliation", "Đối chiếu nhập hàng", "doi-chieu-nhap-hang.html", "⇩"],
  ["stock-reconciliation", "Đối chiếu chứng từ kho", "doi-chieu-chung-tu-kho.html", "⇄"],
  ["supplier-debts", "Công nợ nhà cung cấp", "cong-no-ncc.html", "◷"],
  ["supplier-payments", "Thanh toán NCC", "thanh-toan-ncc.html", "＄"],
  ["receipts", "Phiếu thu", "phieu-thu.html", "＋"],
  ["expenses", "Phiếu chi", "phieu-chi.html", "－"],
  ["customer-debts", "Công nợ khách hàng", "cong-no-khach-hang.html", "♙"],
  ["revenue-reconciliation", "Đối soát doanh thu", "doi-soat-doanh-thu.html", "▤"],
  ["payment-reconciliation", "Đối soát thanh toán", "doi-soat-thanh-toan.html", "✓"],
  ["cash-shift-reconciliation", "Đối soát ca bán hàng", "doi-soat-ca-ban-hang.html", "◷"],
  ["reports", "Báo cáo kế toán", "bao-cao-ke-toan.html", "▥"]
];
const salesLinks = [
  ["Tổng quan bán hàng", "tong-quan-ban-hang.html", "▦"],
  ["Bán hàng tại quầy", "ban-hang.html", "▣"],
  ["Ca bán hàng", "ca-ban-hang.html", "◷"],
  ["Hóa đơn bán hàng", "hoa-don.html", "▤"],
  ["Thanh toán bán hàng", "thanh-toan.html", "＄"],
  ["Khách hàng", "khach-hang.html", "♙"]
];
const warehouseLinks = [
  ["Tổng quan kho", "tong-quan-kho.html", "▦"],
  ["Phiếu nhập kho", "phieu-nhap.html", "⇩"],
  ["Theo dõi tồn kho", "ton-kho.html", "▤"],
  ["Xuất chuyển nội bộ", "xuat-chuyen-noi-bo.html", "⇄"],
  ["Trả hàng NCC", "tra-hang-ncc.html?readonly=1", "↩"],
  ["Kiểm kê kho", "kiem-ke-kho.html", "✓"],
  ["Biến động kho", "bien-dong-kho.html", "↗"]
];
const pageTitle = links.find(([key]) => key === page)?.[1] || "Kế toán";
const today = () => new Date().toISOString().slice(0, 10);
const formatDateTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
};
const nameOf = (state, table, key, field, name) => state[table].find((row) => row[field] === key)?.[name] || "—";
const supplierName = (state, id) => nameOf(state, "DoiTacKinhDoanh", id, "DT_Ma", "DT_Ten");
const itemName = (state, id) => nameOf(state, "HangHoa", id, "HH_Ma", "HH_Ten");
const locationName = (state, id) => nameOf(state, "DiaDiem", id, "DD_Ma", "DD_Ten");
const employeeName = (state, id) => nameOf(state, "NhanVien", id, "NV_Ma", "NV_Ten");
const role = () => localStorage.getItem("stmn-kho-demo-role") || "Nhân viên kế toán";
let selectedSupplier = "";
let reconciliationTab = "transfers";
let reportTab = "revenue";
let dateFrom = "";
let dateTo = "";
let cashbookFilters = { from: "", to: "", method: "", type: "", partner: "", status: "" };
const tablePages = new Map();

function toast(message, error = false) {
  const host = document.querySelector("#toast-host");
  const node = document.createElement("div");
  node.className = `toast ${error ? "error" : ""}`;
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}

function badge(status) {
  const tone = ({
    "Đã xác nhận": "green", "Thành công": "green", "Đã thanh toán": "green", "Đã nhận đủ": "green", "Hoàn tất": "green",
    "Chờ xác nhận": "amber", "Chờ kế toán xác nhận": "amber", "Chờ đối soát": "amber", "Đang mở": "blue", "Đã đối soát": "green", "Đã bàn giao": "green", "Cần giải trình": "red", "Chờ giao": "blue", "Đang giao": "blue", "Đang chuyển": "blue", "Chờ xuất": "amber", "Chờ xử lý thanh toán": "amber",
    "Còn nợ": "red", "Bất thường cần kiểm tra": "red", "Thất bại": "red",
    "Chờ đối chiếu": "red", "Cần đối chiếu": "red",
    "Đã hủy": "gray", "Nháp": "gray",
    "Hết hàng tại cửa hàng, kho còn": "amber", "Hết hàng tại cửa hàng, nơi khác còn": "amber",
    "Sắp hết hàng tại cửa hàng": "amber", "Hết hàng toàn hệ thống": "red",
    "Có tồn nhưng không khả dụng": "red", "Ngừng kinh doanh": "gray", "Đủ hàng": "green"
  })[status] || "gray";
  return `<span class="badge badge-${tone}">${esc(status || "—")}</span>`;
}

function heading(title, description, action = "") {
  return `<div class="page-heading"><div><h1>${esc(title)}</h1><p>${description}</p></div><div class="heading-actions">${action}</div></div>`;
}

function tableCard(title, subtitle, headers, rows, note = "", key = "table") {
  const pageIndex = tablePages.get(key) || 0;
  const numericHeader = (value) => /tổng|tiền|giá|nợ|đã trả|đã thu|còn nợ|\bsl\b|số lượng|chênh lệch|lệch/i.test(value);
  return `<div class="table-card" data-table-card="${esc(key)}">
    <div class="table-toolbar"><strong>${title}</strong><span>${subtitle}</span></div>
    <div class="table-wrap"><table><thead><tr>${headers.map((item) => `<th class="${numericHeader(item) ? "money" : ""}">${item}</th>`).join("")}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state">Không có dữ liệu.</td></tr>`}</tbody></table></div>
    <div class="accounting-pagination" data-pagination="${esc(key)}" data-page="${pageIndex}"></div>
    ${note ? `<div class="table-subnote">${note}</div>` : ""}
  </div>`;
}

function listFilters(fields) {
  return `<div class="filters">${fields.join("")}<button class="button" data-action="clear-filters">Xóa lọc</button></div>`;
}

function searchFilter(label = "Tìm kiếm", key = "search") {
  return `<div class="field grow"><label>${label}</label><input class="list-filter" data-filter="${key}" placeholder="Nhập từ khóa…"></div>`;
}

function selectFilter(key, label, rows, first = "Tất cả") {
  return `<div class="field"><label>${label}</label><select class="list-filter" data-filter="${key}"><option value="">${first}</option>${rows.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join("")}</select></div>`;
}

function dateFilter(key, label) {
  return `<div class="field"><label>${label}</label><input type="date" class="list-filter" data-filter="${key}"></div>`;
}

function metric(title, value, caption = "") {
  return `<div class="metric-card"><div class="metric-title">${title}</div><div class="metric-value">${formatCurrency(value)}</div><div class="metric-caption">${caption}</div></div>`;
}

function modal(title, body, footer = "", wide = false) {
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="backdrop-close"><section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-header"><h2>${esc(title)}</h2><button class="button button-small" data-action="close-modal">Đóng</button></div>
    <div class="modal-body">${body}</div><div class="modal-footer">${footer}</div></section></div>`;
}

function closeModal() { document.querySelector("#modal-host").innerHTML = ""; }

function options(rows, valueKey, labelKey, selected = "", first = "") {
  return `${first ? `<option value="">${esc(first)}</option>` : ""}${rows.map((row) =>
    `<option value="${esc(row[valueKey])}" ${row[valueKey] === selected ? "selected" : ""}>${esc(row[labelKey])}</option>`).join("")}`;
}

function shell() {
  const state = getState();
  const locations = state.DiaDiem.filter((row) => row.DD_TrangThai === "Hoạt động");
  const currentRole = role();
  const activeAccountLinks = links.map(([key, label, file, icon]) =>
    `<a class="nav-link ${page === key ? "active" : ""}" href="${file}" title="${label}"><span class="nav-icon">${icon}</span><span>${label}</span></a>`).join("");
  const salesNav = salesLinks.map(([label, file, icon]) =>
    `<a class="nav-link" href="../ban-hang-ke-toan/${file}" title="${label}"><span class="nav-icon">${icon}</span><span>${label}</span></a>`).join("");
  const warehouseNav = warehouseLinks.map(([label, file, icon]) =>
    `<a class="nav-link" href="../kho/${file}" title="${label}"><span class="nav-icon">${icon}</span><span>${label}</span></a>`).join("");
  document.querySelector("#app").innerHTML = `<div class="app-shell"><aside class="sidebar">
    <a class="brand" href="tong-quan-ke-toan.html"><span class="brand-mark">S</span><div><strong>Siêu thị mini</strong><small>Hệ thống quản lý</small></div></a>
    <a class="nav-link" href="../chu-cua-hang/tong-quan.html"><span class="nav-icon">⌂</span><span>Chủ cửa hàng</span></a>
    <div class="nav-label">Phân hệ kế toán</div>${activeAccountLinks}
    <div class="module-label">Bán hàng</div>${salesNav}
    <div class="module-label">Quản lý kho</div>${warehouseNav}
    <div class="sidebar-bottom">Dữ liệu dùng chung Kho &amp; Bán hàng<br>Chế độ demo · localStorage<br>Không thay thế phân quyền Backend</div>
    </aside><main class="main-area"><header class="topbar">
      <div><div class="topbar-title">${esc(pageTitle)}</div><div class="topbar-subtitle">Kế toán nội bộ · Bản mô phỏng nghiệp vụ</div></div>
      <div class="topbar-actions"><select id="accounting-location" aria-label="Địa điểm hiển thị">
        <option value="">Tất cả địa điểm</option>${options(locations, "DD_Ma", "DD_Ten", "")}</select>
        <select id="accounting-role" aria-label="Vai trò demo">${roleOptions.map((item) => `<option ${item === currentRole ? "selected" : ""}>${item}</option>`).join("")}</select>
        <span class="user-role">${esc(employeeName(state, roleEmployees[currentRole]))}</span>
        <button class="button button-small" data-action="reset">Khôi phục demo</button></div></header>
      <section class="content" id="page-content"></section></main></div><div id="modal-host"></div>`;
  renderContent();
}

function rowsFor(state, table, keyField, labelField, type) {
  return state[table].filter((row) => !type || row.DT_Loai === type)
    .map((row) => [row[keyField], row[labelField]]);
}

function renderOverview(state) {
  const location = document.querySelector("#accounting-location")?.value || "";
  const summary = getAccountingDashboard({ from: dateFrom, to: dateTo, location }, state);
  const suppliers = summary.payables.filter((row) => row.due > 0).slice(0, 5).map(({ creditor, due, principal, paid }) =>
    `<tr data-accounting-row data-search="${esc(`${creditor.CNNCC_Ma} ${supplierName(state, creditor.DT_Ma)}`.toLocaleLowerCase("vi-VN"))}">
      <td>${esc(creditor.CNNCC_Ma)}</td><td>${esc(supplierName(state, creditor.DT_Ma))}</td><td class="money">${formatCurrency(principal)}</td>
      <td class="money">${formatCurrency(paid)}</td><td class="negative money">${formatCurrency(due)}</td></tr>`).join("");
  const customers = summary.receivables.slice(0, 5).map(({ debt, invoice, paid, due }) =>
    `<tr data-accounting-row data-search="${esc(`${invoice.BH_Ma} ${supplierName(state, invoice.DT_Ma)}`.toLocaleLowerCase("vi-VN"))}">
      <td>${esc(invoice.BH_Ma)}</td><td>${esc(supplierName(state, invoice.DT_Ma))}</td><td class="money">${formatCurrency(invoice.BH_TongCong)}</td>
      <td class="money">${formatCurrency(paid)}</td><td class="negative money">${formatCurrency(due)}</td></tr>`).join("");
  const discrepancies = summary.purchaseDiscrepancies.slice(0, 5).map(({ receipt, comparison }) => {
    const reasons = comparison.filter((row) => row.quantityDelta > 0 || (row.currentQty && Math.round(row.priceDelta) !== 0))
      .map((row) => `${itemName(state, row.HH_Ma)}: ${row.quantityDelta > 0 ? `vượt ${row.quantityDelta}` : `lệch đơn giá ${formatCurrency(row.priceDelta)}`}`).join("; ");
    return `<tr data-accounting-row data-search="${esc(`${receipt.PN_Ma} ${supplierName(state, receipt.DT_Ma)} ${reasons}`.toLocaleLowerCase("vi-VN"))}">
      <td>${esc(receipt.PN_Ma)}</td><td>${esc(supplierName(state, receipt.DT_Ma))}</td><td>${esc(reasons)}</td>
      <td><button class="button button-small" data-action="view-purchase" data-id="${esc(receipt.PN_Ma)}">Đối chiếu</button></td></tr>`;
  }).join("");
  const pending = [
    ...state.ThanhToanBanHang.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận")
      .map((row) => ({ id: row.TTBH_Ma, source: "Bán hàng", document: row.BH_Ma, method: row.TTBH_PhuongThuc, amount: row.TTBH_SoTien, status: row.TTBH_TrangThai })),
    ...state.ThanhToanNCC.filter((row) => row.TTNCC_TrangThai === "Chờ xác nhận")
      .map((row) => ({ id: row.TTNCC_Ma, source: "Nhà cung cấp", document: row.CTNNCC_Ma, method: row.TTNCC_PhuongThuc, amount: row.TTNCC_SoTien, status: row.TTNCC_TrangThai }))
  ].slice(0, 5).map((row) =>
    `<tr data-accounting-row data-search="${esc(`${row.id} ${row.document} ${row.method} ${row.source}`.toLocaleLowerCase("vi-VN"))}">
      <td>${esc(row.id)}</td><td>${esc(row.source)}</td><td>${esc(row.document)}</td><td>${esc(row.method)}</td>
      <td class="money">${formatCurrency(row.amount)}</td><td>${badge(row.status)}</td></tr>`).join("");
  const recent = [
    ...state.PhieuNhap.map((row) => ({ id: row.PN_Ma, date: row.PN_Ngay, type: "Phiếu nhập", amount: row.PN_TongTien, status: row.PN_TrangThai })),
    ...state.HoaDonBanHang.map((row) => ({ id: row.BH_Ma, date: row.BH_Ngay, type: "Hóa đơn bán", amount: row.BH_TongCong, status: row.BH_TrangThai })),
    ...state.ThanhToanNCC.map((row) => ({ id: row.TTNCC_Ma, date: row.TTNCC_Ngay, type: "Thanh toán NCC", amount: row.TTNCC_SoTien, status: row.TTNCC_TrangThai })),
    ...state.PhieuThu.map((row) => ({ id: row.PT_Ma, date: row.PT_Ngay, type: row.TTBH_Ma ? "Phiếu thu bán hàng" : "Phiếu thu khác", amount: row.PT_SoTien, status: row.PT_TrangThai })),
    ...state.PhieuChi.map((row) => ({ id: row.PC_Ma, date: row.PC_Ngay, type: "Phiếu chi", amount: row.PC_SoTien, status: row.PC_TrangThai }))
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8).map((row) =>
    `<tr data-accounting-row data-search="${esc(`${row.id} ${row.type}`.toLocaleLowerCase("vi-VN"))}"><td>${esc(row.id)}</td><td>${esc(row.type)}</td><td>${formatDate(row.date)}</td><td class="money">${formatCurrency(row.amount)}</td><td>${badge(row.status)}</td></tr>`).join("");
  const actions = `<a class="button button-primary" href="cong-no-ncc.html">Quản lý công nợ NCC</a>`;
  return `${heading("Tổng quan kế toán", "Theo dõi riêng doanh thu, dòng tiền, công nợ và chênh lệch chứng từ.", actions)}
    <div class="filters"><div class="field"><label>Từ ngày</label><input id="accounting-from" type="date" value="${esc(dateFrom)}"></div>
      <div class="field"><label>Đến ngày</label><input id="accounting-to" type="date" value="${esc(dateTo)}"></div>
      <button class="button" data-action="clear-dashboard-dates">Xóa ngày</button>
      <span class="role-note">Địa điểm áp dụng cho hóa đơn bán; công nợ là số dư hiện tại.</span></div>
    <div class="metric-grid accounting-metrics">
      ${metric("Doanh thu hóa đơn đã xác nhận", summary.revenue, "Theo thời gian và địa điểm chọn")}
      ${metric("Tiền đã thu từ bán hàng", summary.salesCollected, "Chỉ ThanhToanBanHang thành công")}
      ${metric("Thu khác", summary.otherIncome, "Phiếu thu đã xác nhận")}
      ${metric("Chi NCC", summary.supplierPaid, "ThanhToanNCC thành công; không cộng PhiếuChi liên kết lần hai")}
      ${metric("Chi khác", summary.otherExpense, "Phiếu chi độc lập đã xác nhận")}
      ${metric("Phải thu khách hàng", summary.receivableBalance, "Số dư hiện tại")}
      ${metric("Phải trả nhà cung cấp", summary.payableBalance, "Số dư hiện tại")}
      <div class="metric-card"><div class="metric-title">Việc cần kiểm tra</div><div class="metric-value">${summary.purchaseDiscrepancies.length + summary.pendingPayments}</div><div class="metric-caption">${summary.purchaseDiscrepancies.length} lệch nhập · ${summary.pendingPayments} thanh toán chờ</div></div>
    </div>
    <div class="info-box" style="margin-bottom:14px">${esc(summary.currentBalancesNote)}</div>
    <div class="dashboard-grid">
      ${tableCard("Công nợ NCC còn lại", "Số dư tính từ nợ gốc trừ thanh toán thành công", ["Mã công nợ", "Nhà cung cấp", "Nợ gốc", "Đã trả", "Còn nợ"], suppliers, "", "overview-suppliers")}
      ${tableCard("Hóa đơn khách hàng còn nợ", "Lịch sử và thanh toán xem tại phân hệ Bán hàng", ["Hóa đơn", "Khách hàng", "Tổng tiền", "Đã thu", "Còn nợ"], customers, "", "overview-customers")}
      ${tableCard("Phiếu nhập cần kiểm tra", "Chỉ nêu chênh lệch vượt số lượng/đơn giá; giao nhiều lần không bị coi là sai", ["Phiếu nhập", "NCC", "Nguyên nhân", "Thao tác"], discrepancies, "", "overview-discrepancies")}
      ${tableCard("Thanh toán đang chờ", "Giao dịch chờ không làm giảm/cộng dòng tiền", ["Mã thanh toán", "Nguồn", "Chứng từ", "Phương thức", "Số tiền", "Trạng thái"], pending, "", "overview-pending")}
    </div>
    ${tableCard("Chứng từ gần đây", "Phiếu nhập và hóa đơn bán không đồng nghĩa với tiền đã thu/chi", ["Mã", "Loại", "Ngày", "Giá trị", "Trạng thái"], recent, "", "overview-recent")}`;
}

function receiptDebtId(state, PN_Ma) {
  return state.ChiTietNoNCC.find((row) => row.PN_Ma === PN_Ma)?.CTNNCC_Ma || "";
}

function viewPurchase(state, PN_Ma) {
  const result = getPurchaseReconciliation(PN_Ma, state);
  const { receipt, order, comparison } = result;
  const orderLabel = order ? `${esc(order.DH_Ma)} · ${badge(result.progress)}` : `<span class="badge badge-gray">Nhập không theo đơn đặt hàng</span>`;
  const detailRows = comparison.map((line) => `<tr data-accounting-row data-search="${esc(`${line.HH_Ma} ${itemName(state, line.HH_Ma)}`.toLocaleLowerCase("vi-VN"))}">
    <td>${esc(line.HH_Ma)}</td><td>${esc(itemName(state, line.HH_Ma))}</td><td class="money">${formatNumber(line.orderQty)}</td>
    <td class="money">${formatNumber(line.currentQty)}</td><td class="money">${formatNumber(line.deliveredQty)}</td><td>${line.quantityDelta > 0 ? badge(`Vượt ${line.quantityDelta}`) : line.deliveredQty === line.orderQty ? badge("Đã nhận đủ") : badge("Đang giao")}</td>
    <td class="money">${formatCurrency(line.orderUnitPrice)}</td><td class="money">${formatCurrency(line.currentUnitPrice)}</td>
    <td class="${line.priceDelta ? "negative" : ""} money">${formatCurrency(line.priceDelta)}</td><td class="money">${formatCurrency(line.amount)}</td></tr>`).join("");
  const detailHtml = `<div class="form-grid two">
    <div><span class="field-label">Phiếu nhập</span><div><strong>${esc(receipt.PN_Ma)}</strong></div></div>
    <div><span class="field-label">Đơn đặt hàng</span><div>${orderLabel}</div></div>
    <div><span class="field-label">Nhà cung cấp</span><div>${esc(supplierName(state, receipt.DT_Ma))}</div></div>
    <div><span class="field-label">Ngày nhập / kho</span><div>${formatDate(receipt.PN_Ngay)} · ${esc(locationName(state, receipt.DD_Ma))}</div></div>
    <div><span class="field-label">Nhân viên kho</span><div>${esc(employeeName(state, receipt.NV_Ma))}</div></div>
    <div><span class="field-label">Tổng tiền / trạng thái</span><div>${formatCurrency(receipt.PN_TongTien)} · ${badge(receipt.PN_TrangThai)}</div></div></div>
    ${order ? `<div class="info-box">Số lượng đã giao được cộng trên tất cả phiếu nhập đã xác nhận liên kết đơn ${esc(order.DH_Ma)}. Kế toán chỉ đối chiếu, không sửa dòng nhập đã xác nhận.</div>
      ${tableCard("So sánh theo mặt hàng", `${result.deliveries.length} phiếu giao đã xác nhận`, ["Mã hàng", "Tên hàng", "SL đặt", "SL phiếu này", "SL đã nhận lũy kế", "Tiến độ", "Giá đặt", "Giá nhập TB phiếu này", "Lệch đơn giá", "Thành tiền"], detailRows, "", "purchase-detail")}
      <p class="table-subnote">Chênh lệch SL hiển thị theo tổng giao lũy kế trừ số lượng đặt, nên các đợt giao một phần không bị xem là sai lệch.</p>` :
      `<div class="info-box">Phiếu nhập không liên kết đơn đặt hàng; không kết luận sai lệch theo đơn hàng.</div>`}`;
  const debtId = receiptDebtId(state, PN_Ma);
  const actions = `${receipt.PN_TrangThai === "Chờ kế toán xác nhận" && ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role())
    ? `<button class="button button-primary" data-action="confirm-inbound" data-id="${esc(PN_Ma)}">Xác nhận nhập & ghi nhận công nợ</button>` : ""}
    ${receipt.PN_TrangThai === "Đã xác nhận" && receipt.PN_TongTien > 0 && !debtId && ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role())
    ? `<button class="button button-primary" data-action="create-receipt-debt" data-id="${esc(PN_Ma)}">Ghi nhận công nợ NCC</button>` : ""}
    ${debtId ? `<a class="button" href="cong-no-ncc.html?debt=${encodeURIComponent(debtId)}">Xem công nợ ${esc(debtId)}</a>` : ""}`;
  modal(`Đối chiếu phiếu nhập ${PN_Ma}`, detailHtml, `${actions}<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function renderPurchaseReconciliation(state) {
  const rows = state.PhieuNhap.slice().sort((a, b) => String(b.PN_Ngay).localeCompare(String(a.PN_Ngay))).map((receipt) => {
    const result = getPurchaseReconciliation(receipt.PN_Ma, state);
    const differences = result.order ? result.comparison.filter((line) => line.quantityDelta > 0 || (line.currentQty && Math.round(line.priceDelta) !== 0)) : [];
    const indication = !result.order ? "Nhập không theo đơn đặt hàng"
      : differences.length ? differences.map((line) => line.quantityDelta > 0 ? `${line.HH_Ma}: vượt ${line.quantityDelta}` : `${line.HH_Ma}: lệch đơn giá`).join("; ")
        : result.progress;
    return `<tr data-accounting-row data-search="${esc(`${receipt.PN_Ma} ${receipt.DH_Ma || ""} ${supplierName(state, receipt.DT_Ma)} ${indication}`.toLocaleLowerCase("vi-VN"))}"
      data-supplier="${esc(receipt.DT_Ma)}" data-status="${esc(receipt.PN_TrangThai)}" data-date="${esc(String(receipt.PN_Ngay).slice(0, 10))}">
      <td class="cell-primary">${esc(receipt.PN_Ma)}</td><td>${esc(receipt.DH_Ma || "—")}</td><td>${esc(supplierName(state, receipt.DT_Ma))}</td>
      <td>${formatDate(receipt.PN_Ngay)}</td><td>${esc(locationName(state, receipt.DD_Ma))}</td><td>${esc(employeeName(state, receipt.NV_Ma))}</td>
      <td class="money">${formatCurrency(receipt.PN_TongTien)}</td><td>${badge(receipt.PN_TrangThai)}</td><td>${esc(indication)}</td>
      <td><button class="button button-small" data-action="view-purchase" data-id="${esc(receipt.PN_Ma)}">Chi tiết</button></td></tr>`;
  }).join("");
  return `${heading("Đối chiếu nhập hàng", "Đối chiếu dữ liệu phiếu nhập của Kho với đơn đặt hàng và công nợ NCC.", "")}
    ${listFilters([searchFilter("Mã phiếu / đơn đặt / NCC"), selectFilter("supplier", "Nhà cung cấp", rowsFor(state, "DoiTacKinhDoanh", "DT_Ma", "DT_Ten", "Nhà cung cấp")),
      dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày"), selectFilter("status", "Trạng thái", [...new Set(state.PhieuNhap.map((row) => row.PN_TrangThai))].map((status) => [status, status]))])}
    ${tableCard("Danh sách phiếu nhập", `${state.PhieuNhap.length} chứng từ`, ["Mã phiếu nhập", "Đơn đặt hàng", "Nhà cung cấp", "Ngày nhập", "Kho nhận", "Nhân viên kho", "Tổng tiền", "Trạng thái nhập", "Đối chiếu", "Thao tác"], rows,
      "Kế toán không sửa số lượng nhập đã xác nhận. Nhập không theo đơn đặt hàng là trường hợp hợp lệ, không tự kết luận chênh lệch.", "purchase-list")}`;
}

function renderStockReconciliation(state) {
  const current = reconciliationTab;
  const tabBar = `<div class="accounting-tabs">${[
    ["transfers", "Phiếu chuyển nội bộ"], ["replenishment", "Theo dõi bổ sung hàng"], ["counts", "Kiểm kê kho"], ["movements", "Lịch sử biến động"]
  ].map(([key, label]) => `<button class="button ${current === key ? "button-primary" : ""}" data-action="stock-tab" data-tab="${key}">${label}</button>`).join("")}</div>`;
  let title = "";
  let headers = [];
  let rows = "";
  let note = "Chỉ xem và đối chiếu; không tự tạo thu/chi hoặc sửa tồn kho từ chứng từ chuyển/kiểm kê.";
  if (current === "transfers") {
    title = "Phiếu chuyển nội bộ";
    headers = ["Mã phiếu", "Địa điểm xuất", "Địa điểm nhận", "SL xuất", "SL thực nhận", "Chênh lệch", "Trạng thái", "Mở Kho"];
    rows = state.PhieuXuatChuyenNoiBo.map((transfer) => {
      const lines = state.PhieuXuatChuyenNoiBoChiTiet.filter((row) => row.PXCN_Ma === transfer.PXCN_Ma);
      const sent = lines.reduce((sum, row) => sum + Number(row.PXCN_SL || 0), 0);
      const received = lines.reduce((sum, row) => sum + Number(row.PXCN_SLThucNhan || 0), 0);
      const known = lines.every((row) => row.PXCN_SLThucNhan !== null && row.PXCN_SLThucNhan !== undefined);
      return `<tr data-accounting-row data-search="${esc(`${transfer.PXCN_Ma} ${locationName(state, transfer.DD_Xuat)} ${locationName(state, transfer.DD_Nhan)}`.toLocaleLowerCase("vi-VN"))}"
        data-status="${esc(transfer.PXCN_TrangThai)}" data-date="${esc(String(transfer.PXCN_Ngay).slice(0, 10))}">
        <td>${esc(transfer.PXCN_Ma)}</td><td>${esc(locationName(state, transfer.DD_Xuat))}</td><td>${esc(locationName(state, transfer.DD_Nhan))}</td>
        <td class="money">${formatNumber(sent)}</td><td class="money">${known ? formatNumber(received) : "Chưa nhận đủ"}</td>
        <td>${known ? formatNumber(sent - received) : "—"}</td><td>${badge(transfer.PXCN_TrangThai)}</td>
        <td><a class="text-link" href="../kho/xuat-chuyen-noi-bo.html">Mở chứng từ Kho</a></td></tr>`;
    }).join("");
  } else if (current === "replenishment") {
    title = "Theo dõi bổ sung hàng nội bộ";
    headers = ["Mặt hàng", "Cửa hàng cần bổ sung", "Tồn khả dụng tại cửa hàng", "Tồn khả dụng tại kho trung tâm", "Trạng thái", "Phiếu chuyển đang xử lý", "Thao tác"];
    const store = state.DiaDiem.find((row) => row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động");
    const warehouse = state.DiaDiem.find((row) => row.DD_Loai === "Kho" && row.DD_TrangThai === "Hoạt động");
    rows = getReplenishmentItems(store?.DD_Ma || "", warehouse?.DD_Ma || "", state).map(({ item, store: storeStock, warehouse: warehouseStock, systemAvailable, status }) => {
      const activeTransfers = state.PhieuXuatChuyenNoiBo.filter((transfer) =>
        transfer.DD_Nhan === store?.DD_Ma && ["Chờ xuất", "Đang chuyển", "Chờ đối chiếu", "Cần đối chiếu"].includes(transfer.PXCN_TrangThai) &&
        state.PhieuXuatChuyenNoiBoChiTiet.some((line) => line.PXCN_Ma === transfer.PXCN_Ma &&
          state.PhieuNhapChiTiet.find((receiptLine) => receiptLine.PNCT_Ma === line.PNCT_Ma)?.HH_Ma === item.HH_Ma)
      );
      const query = new URLSearchParams({ create: "1", source: warehouse?.DD_Ma || "", destination: store?.DD_Ma || "", product: item.HH_Ma });
      const action = ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) &&
        warehouseStock.available > 0 && ["Hết hàng tại cửa hàng, kho còn", "Sắp hết hàng tại cửa hàng"].includes(status)
        ? `<a class="button button-small button-primary" href="../kho/xuat-chuyen-noi-bo.html?${query.toString()}">Tạo phiếu chuyển</a>`
        : role() === "Chủ cửa hàng" && systemAvailable === 0 && item.HH_TrangThai === "Đang kinh doanh"
          ? `<a class="button button-small button-primary" href="../chu-cua-hang/don-dat-hang.html">Quản lý đơn đặt hàng</a>`
          : role() === "Nhân viên kế toán" && systemAvailable === 0 && item.HH_TrangThai === "Đang kinh doanh"
            ? `<span class="field-hint">Chủ cửa hàng lập đơn đặt hàng</span>`
        : `<a class="text-link" href="../kho/ton-kho.html">Mở tồn kho</a>`;
      return `<tr data-accounting-row data-search="${esc(`${item.HH_Ma} ${item.HH_Ten} ${store?.DD_Ten || ""} ${status}`.toLocaleLowerCase("vi-VN"))}" data-status="${esc(status)}">
        <td>${esc(item.HH_Ma)} · ${esc(item.HH_Ten)}</td><td>${esc(store?.DD_Ten || "—")}</td>
        <td class="money">${formatNumber(storeStock.available)}</td><td class="money">${formatNumber(warehouseStock.available)}</td>
        <td>${badge(status)}</td><td>${activeTransfers.length ? activeTransfers.map((transfer) => `<a class="text-link" href="../kho/xuat-chuyen-noi-bo.html">${esc(transfer.PXCN_Ma)} · ${esc(transfer.PXCN_TrangThai)}</a>`).join("<br>") : "—"}</td><td>${action}</td></tr>`;
    }).join("");
  } else if (current === "counts") {
    title = "Phiếu kiểm kê kho";
    headers = ["Mã kiểm kê", "Địa điểm", "Ngày kiểm kê", "Chênh lệch tăng/giảm", "Người lập", "Người duyệt", "Trạng thái", "Mở Kho"];
    rows = state.PhieuKiemKeKho.map((count) => {
      const lines = state.PhieuKiemKeKhoChiTiet.filter((row) => row.PKK_Ma === count.PKK_Ma);
      const delta = lines.reduce((sum, row) => sum + Number(row.PKKCT_ChenhLech || 0), 0);
      return `<tr data-accounting-row data-search="${esc(`${count.PKK_Ma} ${locationName(state, count.DD_Ma)} ${employeeName(state, count.NV_Ma)}`.toLocaleLowerCase("vi-VN"))}"
        data-status="${esc(count.PKK_TrangThai)}" data-date="${esc(String(count.PKK_Ngay).slice(0, 10))}">
        <td>${esc(count.PKK_Ma)}</td><td>${esc(locationName(state, count.DD_Ma))}</td><td>${formatDate(count.PKK_Ngay)}</td>
        <td class="${delta ? "negative" : ""} money">${formatNumber(delta)}</td><td>${esc(employeeName(state, count.NV_Ma))}</td>
        <td>${esc(employeeName(state, count.NV_Duyet))}</td><td>${badge(count.PKK_TrangThai)}</td>
        <td><a class="text-link" href="../kho/kiem-ke-kho.html">Mở chứng từ Kho</a></td></tr>`;
    }).join("");
  } else {
    title = "Lịch sử biến động kho";
    headers = ["Mã biến động", "Loại", "Chứng từ nguồn", "Địa điểm", "Dòng nhập", "SL tăng/giảm", "Ngày phát sinh", "Mở Kho"];
    rows = state.BienDongKho.slice().sort((a, b) => String(b.BDK_Ngay).localeCompare(String(a.BDK_Ngay))).map((movement) =>
      `<tr data-accounting-row data-search="${esc(`${movement.BDK_Ma} ${movement.BDK_Loai} ${movement.BDK_MaChungTu} ${movement.PNCT_Ma}`.toLocaleLowerCase("vi-VN"))}"
        data-date="${esc(String(movement.BDK_Ngay).slice(0, 10))}">
        <td>${esc(movement.BDK_Ma)}</td><td>${esc(movement.BDK_Loai)}</td><td>${esc(`${movement.BDK_Nguon} · ${movement.BDK_MaChungTu}`)}</td>
        <td>${esc(locationName(state, movement.DD_Ma))}</td><td>${esc(movement.PNCT_Ma)}</td>
        <td class="${movement.BDK_SoLuong < 0 ? "negative" : "positive"} money">${formatNumber(movement.BDK_SoLuong)}</td><td>${formatDate(movement.BDK_Ngay)}</td>
        <td><a class="text-link" href="../kho/bien-dong-kho.html">Mở chứng từ Kho</a></td></tr>`).join("");
  }
  const filters = current === "replenishment"
    ? listFilters([searchFilter("Tìm mặt hàng"), selectFilter("status", "Trạng thái", [...new Set(getReplenishmentItems(
      state.DiaDiem.find((row) => row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động")?.DD_Ma || "",
      state.DiaDiem.find((row) => row.DD_Loai === "Kho" && row.DD_TrangThai === "Hoạt động")?.DD_Ma || "",
      state
    ).map((item) => item.status))].map((status) => [status, status]))])
    : listFilters([searchFilter("Tìm chứng từ"), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày")]);
  return `${heading("Đối chiếu chứng từ kho", "Tra cứu chuyển nội bộ, hàng cần bổ sung, kiểm kê và biến động từ state Kho dùng chung.", "")}
    ${tabBar}${filters}
    ${tableCard(title, `${rows ? rows.match(/data-accounting-row/g)?.length || 0 : 0} mục`, headers, rows, current === "replenishment" ? "Phiếu chuyển nội bộ chỉ thay đổi tồn giữa địa điểm; không ghi doanh thu, phiếu thu/chi hoặc công nợ nhà cung cấp." : note, `stock-${current}`)}
    <div class="table-subnote"><a class="text-link" href="../kho/xuat-chuyen-noi-bo.html">Mở phân hệ Kho để xem/xử lý chứng từ</a></div>`;
}

function openCreateDebt(state) {
  const eligible = state.PhieuNhap.filter((receipt) => receipt.PN_TrangThai === "Đã xác nhận"
    && receipt.PN_TongTien > 0 && !receiptDebtId(state, receipt.PN_Ma));
  const body = `<div class="info-box">Chỉ phiếu nhập đã xác nhận mới được ghi một khoản nợ. Ghi nợ không tự tạo thanh toán.</div>
    <form id="supplier-debt-form"><div class="field"><label>Phiếu nhập *</label><select name="PN_Ma" required>
      <option value="">Chọn phiếu nhập</option>${eligible.map((row) => `<option value="${esc(row.PN_Ma)}">${esc(row.PN_Ma)} · ${esc(supplierName(state, row.DT_Ma))} · ${formatCurrency(row.PN_TongTien)}</option>`).join("")}</select></div>
      <div id="supplier-debt-error" class="form-error"></div></form>`;
  modal("Ghi nhận công nợ NCC từ phiếu nhập", body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="supplier-debt-form" type="submit" ${eligible.length ? "" : "disabled"}>Ghi công nợ</button>`);
}

function renderSupplierDebts(state) {
  const payables = getSupplierPayables("", state);
  const rows = payables.map(({ creditor, principal, paid, due, status }) =>
    `<tr data-accounting-row data-search="${esc(`${creditor.CNNCC_Ma} ${creditor.DT_Ma} ${supplierName(state, creditor.DT_Ma)}`.toLocaleLowerCase("vi-VN"))}"
      data-supplier="${esc(creditor.DT_Ma)}" data-status="${esc(status)}">
      <td>${esc(creditor.CNNCC_Ma)}</td><td>${esc(creditor.DT_Ma)}</td><td>${esc(supplierName(state, creditor.DT_Ma))}</td>
      <td class="money">${formatCurrency(principal)}</td><td class="money">${formatCurrency(paid)}</td>
      <td class="${due ? "negative" : "positive"} money">${formatCurrency(due)}</td><td>${badge(status)}</td>
      <td><button class="button button-small" data-action="select-supplier" data-id="${esc(creditor.CNNCC_Ma)}">Xem chi tiết</button></td></tr>`).join("");
  const requested = new URLSearchParams(location.search).get("debt") || "";
  const selected = selectedSupplier || (requested ? state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === requested)?.CNNCC_Ma : "") || "";
  const selectedCreditor = state.CongNoNCC.find((row) => row.CNNCC_Ma === selected);
  const detailRows = selectedCreditor ? getSupplierDebtDetails(selected, state).map(({ debt, receipt, paid, due }) =>
    `<tr data-accounting-row data-search="${esc(`${debt.CTNNCC_Ma} ${debt.PN_Ma}`.toLocaleLowerCase("vi-VN"))}" data-status="${esc(debt.CTNNCC_TrangThai)}">
      <td>${esc(debt.CTNNCC_Ma)}</td><td>${esc(receipt?.PN_Ma || debt.PN_Ma)}</td><td>${formatDate(receipt?.PN_Ngay)}</td>
      <td class="money">${formatCurrency(debt.CTNNCC_SoTienNo)}</td><td class="money">${formatCurrency(paid)}</td>
      <td class="${due ? "negative" : "positive"} money">${formatCurrency(due)}</td><td>${badge(debt.CTNNCC_TrangThai)}</td>
      <td><div class="inline-actions">${receipt ? `<button class="button button-small" data-action="view-purchase" data-id="${esc(receipt.PN_Ma)}">Phiếu nhập</button>` : ""}
      <button class="button button-small" data-action="view-debt-payments" data-id="${esc(debt.CTNNCC_Ma)}">Thanh toán</button>
      ${due && ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) ? `<a class="button button-small" href="thanh-toan-ncc.html?debt=${encodeURIComponent(debt.CTNNCC_Ma)}">Trả nợ</a>` : ""}</div></td></tr>`).join("") : "";
  const supplierOptions = payables.map(({ creditor }) => `<option value="${esc(creditor.CNNCC_Ma)}" ${creditor.CNNCC_Ma === selected ? "selected" : ""}>${esc(supplierName(state, creditor.DT_Ma))}</option>`).join("");
  return `${heading("Công nợ nhà cung cấp", "Tổng hợp theo NCC; chi tiết tính từ nợ gốc trừ các giao dịch ThanhToanNCC thành công.",
      ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) ? `<button class="button button-primary" data-action="new-supplier-debt">＋ Ghi nợ từ phiếu nhập</button>` : "")}
    ${listFilters([searchFilter("Tìm công nợ / NCC"),
      selectFilter("supplier", "Nhà cung cấp", payables.map(({ creditor }) => [creditor.DT_Ma, supplierName(state, creditor.DT_Ma)])),
      selectFilter("status", "Trạng thái", [["Còn nợ", "Còn nợ"], ["Đã thanh toán", "Đã thanh toán"]])])}
    ${tableCard("Tổng hợp theo nhà cung cấp", `${payables.length} nhà cung cấp`, ["Mã công nợ", "Mã NCC", "Nhà cung cấp", "Tổng phải trả", "Đã thanh toán", "Còn nợ", "Trạng thái", "Thao tác"], rows,
      "Mỗi NCC có tối đa một CongNoNCC; mỗi phiếu nhập có tối đa một ChiTietNoNCC. Số dư không được lưu thành cột khác.", "supplier-summary")}
    <div class="panel" style="margin-top:14px"><div class="panel-title"><span>Chi tiết khoản nợ theo phiếu nhập</span>
      <select id="supplier-detail-select" aria-label="Chọn nhà cung cấp"><option value="">Chọn nhà cung cấp</option>${supplierOptions}</select></div>
      ${selectedCreditor ? tableCard(esc(supplierName(state, selectedCreditor.DT_Ma)), `${getSupplierDebtDetails(selected, state).length} khoản nợ`,
        ["CTNNCC_Ma", "PN_Ma", "Ngày nhập", "Nợ gốc", "Đã trả", "Còn nợ", "Trạng thái", "Thao tác"], detailRows,
        "Thanh toán chờ/thất bại không làm giảm số còn nợ.", "supplier-details") : `<div class="empty-state">Chọn NCC phía trên để xem từng khoản nợ.</div>`}</div>`;
}

function supplierPaymentHistory(state, CTNNCC_Ma) {
  const payments = state.ThanhToanNCC.filter((row) => row.CTNNCC_Ma === CTNNCC_Ma);
  const rows = payments.map((payment) => {
    const voucher = state.PhieuChi.find((row) => row.TTNCC_Ma === payment.TTNCC_Ma);
    return `<tr data-accounting-row data-search="${esc(`${payment.TTNCC_Ma} ${payment.TTNCC_PhuongThuc}`.toLocaleLowerCase("vi-VN"))}">
      <td>${esc(payment.TTNCC_Ma)}</td><td>${formatDate(payment.TTNCC_Ngay)}</td><td class="money">${formatCurrency(payment.TTNCC_SoTien)}</td>
      <td>${esc(payment.TTNCC_PhuongThuc)}</td><td>${badge(payment.TTNCC_TrangThai)}</td><td>${voucher ? esc(voucher.PC_Ma) : "—"}</td></tr>`;
  }).join("");
  modal(`Thanh toán khoản nợ ${CTNNCC_Ma}`, tableCard("Lịch sử thanh toán", `${payments.length} giao dịch`,
    ["Mã thanh toán", "Ngày", "Số tiền", "Phương thức", "Trạng thái", "Phiếu chi"], rows, "", "debt-payment-history"),
  `<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function paymentForm(state, initialDebt = "") {
  const suppliers = state.CongNoNCC;
  const chosenDebt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === initialDebt);
  const chosenSupplier = chosenDebt ? suppliers.find((row) => row.CNNCC_Ma === chosenDebt.CNNCC_Ma)?.DT_Ma || "" : "";
  const firstAvailableDebt = state.ChiTietNoNCC.find((row) => getSupplierDebtBalance(row.CTNNCC_Ma, state) > 0);
  const defaultDebt = chosenDebt || firstAvailableDebt;
  const firstDebtSupplier = defaultDebt ? suppliers.find((row) => row.CNNCC_Ma === defaultDebt.CNNCC_Ma)?.DT_Ma || "" : "";
  const supplierId = chosenSupplier || firstDebtSupplier;
  const detailOptions = (DT_Ma) => {
    const creditor = suppliers.find((row) => row.DT_Ma === DT_Ma);
    const available = state.ChiTietNoNCC.filter((row) => row.CNNCC_Ma === creditor?.CNNCC_Ma && getSupplierDebtBalance(row.CTNNCC_Ma, state) > 0);
    return available.map((row, index) => `<option value="${esc(row.CTNNCC_Ma)}" ${row.CTNNCC_Ma === (defaultDebt?.CTNNCC_Ma || initialDebt) || (!defaultDebt && index === 0) ? "selected" : ""}>${esc(row.PN_Ma)} · còn ${formatCurrency(getSupplierDebtBalance(row.CTNNCC_Ma, state))}</option>`).join("");
  };
  const selected = defaultDebt && defaultDebt.CNNCC_Ma === suppliers.find((row) => row.DT_Ma === supplierId)?.CNNCC_Ma ? defaultDebt : null;
  const balance = selected ? getSupplierDebtBalance(selected.CTNNCC_Ma, state) : 0;
  const paid = selected ? Number(selected.CTNNCC_SoTienNo) - balance : 0;
  const body = `<div id="supplier-payment-error" class="form-error"></div><form id="supplier-payment-form">
    <div class="form-grid two"><div class="field"><label>Nhà cung cấp *</label><select id="payment-supplier" name="DT_Ma" required>
      <option value="">Chọn nhà cung cấp</option>${suppliers.map((row) => `<option value="${esc(row.DT_Ma)}" ${row.DT_Ma === supplierId ? "selected" : ""}>${esc(supplierName(state, row.DT_Ma))}</option>`).join("")}</select></div>
      <div class="field"><label>Khoản nợ / phiếu nhập *</label><select id="payment-debt" name="CTNNCC_Ma" required>
      <option value="">Chọn khoản nợ</option>${detailOptions(supplierId)}</select></div>
      <div class="field"><label>Nợ gốc</label><input id="payment-principal" value="${formatCurrency(selected?.CTNNCC_SoTienNo || 0)}" readonly></div>
      <div class="field"><label>Đã thanh toán thành công</label><input id="payment-paid" value="${formatCurrency(paid)}" readonly></div>
      <div class="field"><label>Còn nợ theo thanh toán thành công</label><input id="payment-balance" value="${formatCurrency(balance)}" readonly></div>
      <div class="field"><label>Số tiền trả *</label><input name="amount" type="number" min="1" max="${balance}" step="1" required></div>
      <div class="field"><label>Phương thức *</label><select name="method" required><option>Tiền mặt</option><option>Chuyển khoản</option><option>QR</option></select></div>
      <div class="field"><label>Ngày thanh toán *</label><input name="date" type="date" value="${today()}" required></div>
      <div class="field grow"><label>Ghi chú</label><input name="note" maxlength="250"></div></div>
      <div class="info-box">Chuyển khoản/QR tạo trạng thái chờ; chỉ xác nhận sau khi đã kiểm tra thực tế. Giao dịch chờ được giữ chỗ để ngăn vượt nợ nhưng chưa làm giảm số dư.</div></form>`;
  modal("Ghi thanh toán nhà cung cấp", body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="supplier-payment-form" type="submit" ${balance ? "" : "disabled"}>Ghi nhận</button>`, true);
}

function renderSupplierPayments(state) {
  const payments = state.ThanhToanNCC.slice().sort((a, b) => String(b.TTNCC_Ngay).localeCompare(String(a.TTNCC_Ngay)));
  const rows = payments.map((payment) => {
    const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === payment.CTNNCC_Ma);
    const creditor = state.CongNoNCC.find((row) => row.CNNCC_Ma === debt?.CNNCC_Ma);
    const receipt = state.PhieuNhap.find((row) => row.PN_Ma === debt?.PN_Ma);
    const voucher = state.PhieuChi.find((row) => row.TTNCC_Ma === payment.TTNCC_Ma);
    return `<tr data-accounting-row data-search="${esc(`${payment.TTNCC_Ma} ${supplierName(state, creditor?.DT_Ma)} ${payment.CTNNCC_Ma} ${debt?.PN_Ma || ""}`.toLocaleLowerCase("vi-VN"))}"
      data-supplier="${esc(creditor?.DT_Ma || "")}" data-method="${esc(payment.TTNCC_PhuongThuc)}" data-status="${esc(payment.TTNCC_TrangThai)}" data-date="${esc(String(payment.TTNCC_Ngay).slice(0, 10))}">
      <td>${esc(payment.TTNCC_Ma)}</td><td>${esc(supplierName(state, creditor?.DT_Ma))}</td><td>${esc(payment.CTNNCC_Ma)}</td><td>${esc(receipt?.PN_Ma || "—")}</td>
      <td>${formatDate(payment.TTNCC_Ngay)}</td><td class="money">${formatCurrency(payment.TTNCC_SoTien)}</td><td>${esc(payment.TTNCC_PhuongThuc)}</td>
      <td>${badge(payment.TTNCC_TrangThai)}</td><td>${voucher ? esc(voucher.PC_Ma) : "—"}</td><td><div class="inline-actions">
      ${payment.TTNCC_TrangThai === "Chờ xác nhận" && ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) ?
        `<button class="button button-small button-primary" data-action="confirm-supplier-payment" data-id="${esc(payment.TTNCC_Ma)}">Xác nhận</button>
        <button class="button button-small button-danger" data-action="fail-supplier-payment" data-id="${esc(payment.TTNCC_Ma)}">Thất bại</button>` : ""}
      ${payment.TTNCC_TrangThai === "Thành công" && payment.TTNCC_PhuongThuc === "Tiền mặt" && !voucher && ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) ?
        `<button class="button button-small" data-action="create-expense-voucher" data-id="${esc(payment.TTNCC_Ma)}">Tạo phiếu chi</button>` : ""}
      ${voucher ? `<button class="button button-small" data-action="view-expense" data-id="${esc(voucher.PC_Ma)}">Xem phiếu chi</button>` : ""}</div></td></tr>`;
  }).join("");
  const requested = new URLSearchParams(location.search).get("debt") || "";
  return `${heading("Thanh toán nhà cung cấp", "ThanhToanNCC thành công mới giảm công nợ; PhiếuChi liên kết chỉ là chứng từ, không cộng trùng dòng tiền.",
      ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) ? `<button class="button button-primary" data-action="new-supplier-payment" data-id="${esc(requested)}">＋ Ghi thanh toán</button>` : "")}
    ${listFilters([searchFilter("Tìm mã thanh toán / NCC / phiếu nhập"), selectFilter("supplier", "Nhà cung cấp", rowsFor(state, "DoiTacKinhDoanh", "DT_Ma", "DT_Ten", "Nhà cung cấp")),
      dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày"), selectFilter("method", "Phương thức", [...new Set(payments.map((row) => row.TTNCC_PhuongThuc))].map((value) => [value, value])),
      selectFilter("status", "Trạng thái", [...new Set(payments.map((row) => row.TTNCC_TrangThai))].map((value) => [value, value]))])}
    ${tableCard("Lịch sử thanh toán NCC", `${payments.length} giao dịch`, ["Mã thanh toán", "Nhà cung cấp", "Khoản nợ", "Phiếu nhập", "Ngày", "Số tiền", "Phương thức", "Trạng thái", "Phiếu chi", "Thao tác"], rows,
      "Không xác nhận chuyển khoản/QR đã vào tài khoản ngân hàng nếu chưa có nguồn xác minh.", "supplier-payments")}`;
}

function voucherForm(state, type, existing = null) {
  const isReceipt = type === "receipt";
  const idField = isReceipt ? "PT_Ma" : "PC_Ma";
  const formId = isReceipt ? "receipt-form" : "expense-form";
  const prefix = isReceipt ? "PT" : "PC";
  const action = isReceipt ? "Phiếu thu" : "Phiếu chi khác";
  const receiptDate = existing?.PT_Ngay || today();
  const body = `<div id="${formId}-error" class="form-error"></div><form id="${formId}" data-id="${esc(existing?.[idField] || "")}">
    <div class="info-box">${isReceipt ? "Phiếu thu thủ công chỉ ghi nhận khoản thu khác, không liên kết TTBH. Thu bán hàng tự tạo chứng từ khi khoản thanh toán được xác nhận thành công." : "Phiếu chi khác có TTNCC_Ma = NULL. Không dùng màn hình này để ghi lại khoản thanh toán NCC."}</div>
    <div class="form-grid two"><div class="field"><label>Ngày ${isReceipt ? "thu" : "chi"} *</label><input name="${prefix}_Ngay" type="date" value="${esc(String(isReceipt ? receiptDate : existing?.[`${prefix}_Ngay`] || today()).slice(0, 10))}" required></div>
    <div class="field"><label>Số tiền *</label><input name="${prefix}_SoTien" type="number" min="1" step="1" value="${esc(existing?.[`${prefix}_SoTien`] ?? "")}" required></div>
    <div class="field"><label>Đối tác</label><select name="DT_Ma"><option value="">Không gắn đối tác</option>${options(state.DoiTacKinhDoanh, "DT_Ma", "DT_Ten", existing?.DT_Ma || "")}</select></div>
    <div class="field"><label>Phương thức *</label><select name="${prefix}_PhuongThuc" ${isReceipt ? "disabled" : ""}>${(isReceipt ? ["Tiền mặt"] : ["Tiền mặt"]).map((method) => `<option ${method === (existing?.[`${prefix}_PhuongThuc`] || "Tiền mặt") ? "selected" : ""}>${method}</option>`).join("")}</select>${isReceipt ? `<input type="hidden" name="PT_PhuongThuc" value="Tiền mặt">` : ""}</div>
    <div class="field grow"><label>Lý do *</label><input name="${prefix}_LyDo" maxlength="200" value="${esc(existing?.[`${prefix}_LyDo`] || "")}" required></div>
    <div class="field grow"><label>Ghi chú</label><input name="${prefix}_GhiChu" maxlength="250" value="${esc(existing?.[`${prefix}_GhiChu`] || "")}"></div></div>
    <div class="role-note">Mã phiếu và nhân viên lập được xác định tự động. Phiếu mới lưu ở trạng thái Nháp.${isReceipt ? " Phiếu thu khác dùng tiền mặt; QR/chuyển khoản bán hàng được tạo tự động sau xác nhận." : ""}</div></form>`;
  modal(existing ? `Sửa ${action} ${existing[idField]}` : `Tạo ${action}`, body,
    `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="${formId}" type="submit">Lưu nháp</button>`);
}

function renderReceiptVouchers(state) {
  const shifts = getCashShifts();
  const rowDetails = state.PhieuThu.map((voucher) => {
    const payment = voucher.TTBH_Ma && state.ThanhToanBanHang.find((row) => row.TTBH_Ma === voucher.TTBH_Ma);
    const invoice = payment && state.HoaDonBanHang.find((row) => row.BH_Ma === payment.BH_Ma);
    const shift = payment && shifts.find((row) => row.paymentIds.includes(payment.TTBH_Ma));
    const source = !payment ? "Thu khác"
      : voucher.PT_GhiChu?.includes("Nguồn: Thu nợ khách hàng") ? "Thu nợ khách hàng"
        : voucher.PT_GhiChu?.includes("Nguồn: Cần đối chiếu") ? "Cần đối chiếu"
          : shift ? shift.invoiceIds.includes(payment.BH_Ma) ? "Bán hàng POS" : "Thu nợ khách hàng" : "Cần đối chiếu";
    return { voucher, payment, invoice, shift, source };
  });
  const rows = rowDetails.sort((a, b) => String(b.voucher.PT_Ngay).localeCompare(String(a.voucher.PT_Ngay))).map(({ voucher, payment, invoice, shift, source }) =>
    `<tr data-accounting-row data-search="${esc(`${voucher.PT_Ma} ${invoice?.BH_Ma || ""} ${voucher.TTBH_Ma || ""} ${supplierName(state, voucher.DT_Ma)} ${voucher.PT_LyDo} ${shift?.Ca_Ma || ""}`.toLocaleLowerCase("vi-VN"))}"
      data-method="${esc(voucher.PT_PhuongThuc)}" data-status="${esc(voucher.PT_TrangThai)}" data-date="${esc(String(voucher.PT_Ngay).slice(0, 10))}"
      data-source="${esc(source)}" data-employee="${esc(voucher.NV_Ma || "")}" data-shift="${esc(shift?.Ca_Ma || "")}">
      <td><button class="text-link" data-action="view-receipt" data-id="${esc(voucher.PT_Ma)}">${esc(voucher.PT_Ma)}</button></td>
      <td>${formatDate(voucher.PT_Ngay)}</td><td>${esc(voucher.DT_Ma ? supplierName(state, voucher.DT_Ma) : "Khách lẻ")}</td>
      <td class="money">${formatCurrency(voucher.PT_SoTien)}</td><td>${esc(voucher.PT_PhuongThuc)}</td><td>${esc(source)}</td>
      <td>${invoice ? `<button class="text-link" data-action="view-receipt-invoice" data-id="${esc(invoice.BH_Ma)}">${esc(invoice.BH_Ma)}</button>` : "—"}</td>
      <td>${payment ? `<button class="text-link" data-action="view-invoice-payment" data-id="${esc(payment.TTBH_Ma)}">${esc(payment.TTBH_Ma)}</button>` : "—"}</td>
      <td>${esc(shift?.Ca_Ma || "—")}</td><td>${badge(voucher.PT_TrangThai)}</td>
      <td>${esc(employeeName(state, voucher.NV_Ma))}</td><td>${esc(voucher.PT_LyDo)}</td>
      <td><div class="inline-actions"><button class="button button-small" data-action="view-receipt" data-id="${esc(voucher.PT_Ma)}">Chi tiết</button>
        ${voucher.PT_TrangThai === "Nháp" && !voucher.TTBH_Ma && ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) ?
          `<button class="button button-small" data-action="edit-receipt" data-id="${esc(voucher.PT_Ma)}">Sửa</button>
          <button class="button button-small button-primary" data-action="confirm-receipt" data-id="${esc(voucher.PT_Ma)}">Xác nhận</button>
          <button class="button button-small button-danger" data-action="cancel-receipt" data-id="${esc(voucher.PT_Ma)}">Hủy</button>` : ""}</div></td></tr>`).join("");
  const successfulWithoutReceipt = state.ThanhToanBanHang.filter((payment) => payment.TTBH_TrangThai === "Thành công"
    && !state.PhieuThu.some((voucher) => voucher.TTBH_Ma === payment.TTBH_Ma)).length;
  const values = [...new Set(state.PhieuThu.map((row) => row.PT_PhuongThuc))].map((value) => [value, value]);
  const actions = ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role())
    ? `${successfulWithoutReceipt ? `<button class="button" data-action="sync-missing-sales-receipts">Đồng bộ ${successfulWithoutReceipt} phiếu thu thiếu</button>` : ""}
      <button class="button button-primary" data-action="new-receipt">＋ Tạo phiếu thu khác</button>` : "";
  const employeeOptions = state.NhanVien.map((employee) => [employee.NV_Ma, employee.NV_Ten]);
  const shiftOptions = shifts.map((shift) => [shift.Ca_Ma, shift.Ca_Ma]);
  return `${heading("Phiếu thu", "Phiếu thu bán hàng được tạo tự động khi TTBH thành công; phiếu liên kết chỉ là chứng từ, không cộng thu lần hai.", actions)}
    ${listFilters([searchFilter("Tìm mã phiếu / hóa đơn / thanh toán / ca"), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày"),
      selectFilter("method", "Phương thức", values), selectFilter("source", "Nguồn thu", [["Bán hàng POS", "Bán hàng POS"], ["Thu nợ khách hàng", "Thu nợ khách hàng"], ["Thu khác", "Thu khác"], ["Cần đối chiếu", "Cần đối chiếu"]]),
      selectFilter("employee", "Nhân viên lập", employeeOptions), selectFilter("shift", "Ca bán hàng", shiftOptions),
      selectFilter("status", "Trạng thái", [...new Set(state.PhieuThu.map((row) => row.PT_TrangThai))].map((value) => [value, value]))])}
    ${tableCard("Danh sách phiếu thu", `${state.PhieuThu.length} phiếu`, ["Mã phiếu", "Ngày chứng từ", "Người nộp", "Số tiền", "Hình thức thanh toán", "Nguồn thu", "Hóa đơn bán hàng", "Mã thanh toán", "Ca bán hàng", "Trạng thái", "Nhân viên lập", "Diễn giải", "Thao tác"], rows,
      "QR/chuyển khoản được phân loại thu qua ngân hàng, không phải tiền mặt. Thu bán hàng lấy giá trị từ TTBH; Phiếu thu liên kết chỉ dùng đối chiếu. Phiếu lịch sử thiếu liên kết chỉ được bổ sung khi người dùng chủ động đồng bộ.", "receipt-vouchers")}`;
}

function renderExpenseVouchers(state) {
  const rows = state.PhieuChi.slice().sort((a, b) => String(b.PC_Ngay).localeCompare(String(a.PC_Ngay))).map((voucher) => {
    const linked = Boolean(voucher.TTNCC_Ma);
    const payment = linked ? state.ThanhToanNCC.find((row) => row.TTNCC_Ma === voucher.TTNCC_Ma) : null;
    const expectedVoucherStatus = payment?.TTNCC_TrangThai === "Thành công" ? "Đã xác nhận" : payment?.TTNCC_TrangThai;
    const mismatch = payment && (payment.TTNCC_SoTien !== voucher.PC_SoTien || expectedVoucherStatus !== voucher.PC_TrangThai);
    return `<tr data-accounting-row data-search="${esc(`${voucher.PC_Ma} ${voucher.TTNCC_Ma || ""} ${supplierName(state, voucher.DT_Ma)} ${voucher.PC_LyDo}`.toLocaleLowerCase("vi-VN"))}"
      data-method="${esc(voucher.PC_PhuongThuc)}" data-status="${esc(voucher.PC_TrangThai)}" data-date="${esc(String(voucher.PC_Ngay).slice(0, 10))}">
      <td>${esc(voucher.PC_Ma)}</td><td>${formatDate(voucher.PC_Ngay)}</td><td>${esc(voucher.DT_Ma ? supplierName(state, voucher.DT_Ma) : "Không gắn đối tác")}</td>
      <td>${esc(voucher.PC_LyDo)}</td><td class="money">${formatCurrency(voucher.PC_SoTien)}</td><td>${esc(voucher.PC_PhuongThuc)}</td>
      <td>${linked ? badge("Liên kết NCC") : badge("Chi khác")}</td><td>${badge(voucher.PC_TrangThai)}${mismatch ? `<div class="negative">Cảnh báo: không khớp TTNCC</div>` : ""}</td>
      <td>${esc(employeeName(state, voucher.NV_Ma))}</td><td><div class="inline-actions">
      <button class="button button-small" data-action="view-expense" data-id="${esc(voucher.PC_Ma)}">Chi tiết</button>
      ${linked ? `<button class="button button-small" data-action="view-supplier-payment" data-id="${esc(voucher.TTNCC_Ma)}">Thanh toán NCC</button>` : ""}
      ${voucher.PC_TrangThai === "Nháp" && !linked && ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) ?
        `<button class="button button-small" data-action="edit-expense" data-id="${esc(voucher.PC_Ma)}">Sửa</button>
        <button class="button button-small button-primary" data-action="confirm-expense" data-id="${esc(voucher.PC_Ma)}">Xác nhận</button>
        <button class="button button-small button-danger" data-action="cancel-expense" data-id="${esc(voucher.PC_Ma)}">Hủy</button>` : ""}</div></td></tr>`;
  }).join("");
  return `${heading("Phiếu chi", "Quản lý chi khác và chứng từ chi liên kết thanh toán NCC, không ghi trùng hai lần.",
      ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role()) ? `<button class="button button-primary" data-action="new-expense">＋ Tạo phiếu chi khác</button>` : "")}
    ${listFilters([searchFilter("Tìm mã phiếu / NCC / lý do"), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày"),
      selectFilter("method", "Phương thức", [...new Set(state.PhieuChi.map((row) => row.PC_PhuongThuc))].map((value) => [value, value])),
      selectFilter("status", "Trạng thái", [...new Set(state.PhieuChi.map((row) => row.PC_TrangThai))].map((value) => [value, value]))])}
    ${tableCard("Danh sách phiếu chi", `${state.PhieuChi.length} phiếu`, ["Mã phiếu", "Ngày chi", "Người/đối tác nhận", "Lý do", "Số tiền", "Phương thức", "Loại", "Trạng thái", "Nhân viên lập", "Thao tác"], rows,
      "Phiếu chi có TTNCC_Ma là chứng từ cho ThanhToanNCC; khoản chi NCC chỉ tính một lần từ giao dịch TTNCC thành công.", "expense-vouchers")}`;
}

function renderRevenueReconciliation(state) {
  const location = document.querySelector("#accounting-location")?.value || "";
  const rowsData = getSalesRevenueReconciliation({ location }, state);
  const rows = rowsData.map(({ invoice, detailAmount, detailQuantity, paid, due, status, reasons, pending }) =>
    `<tr data-accounting-row data-search="${esc(`${invoice.BH_Ma} ${supplierName(state, invoice.DT_Ma)} ${status} ${reasons.join(" ")}`.toLocaleLowerCase("vi-VN"))}"
      data-staff="${esc(invoice.NV_Ma)}" data-location="${esc(invoice.DD_Ma)}" data-status="${esc(status)}" data-date="${esc(String(invoice.BH_Ngay).slice(0, 10))}">
      <td>${esc(invoice.BH_Ma)}</td><td>${formatDate(invoice.BH_Ngay)}</td><td>${esc(locationName(state, invoice.DD_Ma))}</td>
      <td>${esc(employeeName(state, invoice.NV_Ma))}</td><td>${esc(supplierName(state, invoice.DT_Ma))}</td>
      <td class="money">${formatCurrency(detailAmount)}</td><td class="money">${formatCurrency(invoice.BH_TongCong)}</td>
      <td class="money">${formatCurrency(paid)}${pending ? `<div class="cell-muted">Chờ: ${formatCurrency(pending)}</div>` : ""}</td>
      <td class="${due ? "negative" : ""} money">${formatCurrency(due)}</td><td>${badge(status)}${reasons.length ? `<div class="reconciliation-reasons">${reasons.map(esc).join("<br>")}</div>` : ""}</td>
      <td>${formatNumber(detailQuantity)} / ${formatNumber(invoice.BH_TongSL)}</td></tr>`).join("");
  const valid = rowsData.filter(({ invoice }) => invoice.BH_TrangThai === "Đã xác nhận");
  const revenue = valid.reduce((sum, row) => sum + row.invoice.BH_TongCong, 0);
  const collected = valid.reduce((sum, row) => sum + row.paid, 0);
  const due = valid.reduce((sum, row) => sum + row.due, 0);
  const anomalies = rowsData.filter((row) => row.reasons.length).length;
  return `${heading("Đối soát doanh thu", "Kiểm tra hóa đơn, chi tiết, thanh toán và biến động kho; còn phải thu hợp lệ không phải lỗi.", "")}
    ${listFilters([searchFilter("Tìm hóa đơn / khách / nguyên nhân"), selectFilter("staff", "Nhân viên bán", state.NhanVien.map((row) => [row.NV_Ma, row.NV_Ten])),
      dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày"),
      selectFilter("status", "Trạng thái đối chiếu", [...new Set(rowsData.map((row) => row.status))].map((value) => [value, value]))])}
    <div class="metric-grid">${metric("Doanh thu hóa đơn hợp lệ", revenue)}${metric("Đã thu thành công", collected)}${metric("Còn phải thu", due)}
      <div class="metric-card"><div class="metric-title">Hóa đơn bất thường</div><div class="metric-value">${anomalies}</div><div class="metric-caption">${rowsData.filter((row) => row.due > 0).length} hóa đơn còn công nợ</div></div></div>
    ${tableCard("Đối chiếu từng hóa đơn", `${rowsData.length} hóa đơn`, ["Mã hóa đơn", "Ngày bán", "Cửa hàng", "Nhân viên", "Khách hàng", "Tổng chi tiết", "Tổng hóa đơn", "Đã thu", "Còn phải thu", "Kết quả / nguyên nhân", "SL chi tiết / HĐ"], rows,
      "Doanh thu chỉ tính hóa đơn Đã xác nhận. Không cộng PhieuThu; các khoản chờ không tính là đã thu.", "revenue-reconciliation")}`;
}

function renderPaymentReconciliation(state) {
  const result = getPaymentReconciliation({ from: dateFrom, to: dateTo }, state);
  const tabs = [["sales", "Thanh toán bán hàng"], ["supplier", "Thanh toán NCC"], ["cashflow", "Tổng hợp thu chi"], ["review", "Cần kiểm tra"]];
  const tabBar = `<div class="accounting-tabs">${tabs.map(([key, label]) =>
    `<button class="button ${key === reconciliationTab ? "button-primary" : ""}" data-action="payment-tab" data-tab="${key}">${label}</button>`).join("")}</div>`;
  let content = "";
  if (reconciliationTab === "sales") {
    const invoiceIds = state.HoaDonBanHang
      .filter((invoice) => (!dateFrom || String(invoice.BH_Ngay).slice(0, 10) >= dateFrom)
        && (!dateTo || String(invoice.BH_Ngay).slice(0, 10) <= dateTo))
      .map((invoice) => invoice.BH_Ma);
    const rows = invoiceIds.map((invoiceId) => {
      const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === invoiceId);
      if (!invoice) return "";
      const payments = state.ThanhToanBanHang.filter((row) => row.BH_Ma === invoiceId);
      const successfulPayments = payments.filter((row) => row.TTBH_TrangThai === "Thành công");
      const cash = successfulPayments.filter((row) => row.TTBH_PhuongThuc === "Tiền mặt").reduce((sum, row) => sum + row.TTBH_SoTien, 0);
      const bank = successfulPayments.filter((row) => row.TTBH_PhuongThuc !== "Tiền mặt").reduce((sum, row) => sum + row.TTBH_SoTien, 0);
      const paid = cash + bank;
      const due = invoice.BH_TrangThai === "Đã xác nhận" ? Math.max(0, invoice.BH_TongCong - paid) : 0;
      const linkedReceipts = state.PhieuThu.filter((voucher) => successfulPayments.some((payment) => payment.TTBH_Ma === voucher.TTBH_Ma));
      const validReceipt = linkedReceipts.some((voucher) => voucher.PT_TrangThai === "Đã xác nhận"
        && successfulPayments.some((payment) => payment.TTBH_Ma === voucher.TTBH_Ma
        && payment.TTBH_PhuongThuc === voucher.PT_PhuongThuc && payment.TTBH_SoTien === voucher.PT_SoTien));
      const missingReceipt = successfulPayments.some((payment) =>
        !state.PhieuThu.some((voucher) => voucher.TTBH_Ma === payment.TTBH_Ma));
      const stateLabel = due > 0 ? "Còn phải thu"
        : validReceipt ? "Đã thu đủ — phiếu thu liên kết hợp lệ"
        : linkedReceipts.length ? "Đã thu đủ — phiếu thu chưa xác nhận"
        : missingReceipt ? "Đã thu đủ — thiếu chứng từ thu"
          : "Chưa có thanh toán thành công";
      const transactionIds = payments.map((payment) => `<button class="text-link" data-action="view-invoice-payment" data-id="${esc(payment.TTBH_Ma)}">${esc(payment.TTBH_Ma)}</button>`).join(", ");
      const createReceiptActions = successfulPayments.filter((payment) =>
        !state.PhieuThu.some((voucher) => voucher.TTBH_Ma === payment.TTBH_Ma))
        .map((payment) => ["Chủ cửa hàng", "Nhân viên kế toán"].includes(role())
          ? `<button class="button button-small" data-action="sync-sales-receipt" data-id="${esc(payment.TTBH_Ma)}">Đồng bộ ${esc(payment.TTBH_Ma)}</button>`
          : "").join(" ");
      const receiptLinks = linkedReceipts.map((voucher) => `<button class="text-link" data-action="view-receipt" data-id="${esc(voucher.PT_Ma)}">${esc(voucher.PT_Ma)}</button>`).join(", ") || "—";
      return `<tr data-accounting-row data-search="${esc(`${invoiceId} ${supplierName(state, invoice.DT_Ma)} ${stateLabel} ${payments.map((payment) => payment.TTBH_Ma).join(" ")}`.toLocaleLowerCase("vi-VN"))}"
        data-status="${esc(stateLabel)}" data-date="${esc(String(invoice.BH_Ngay).slice(0, 10))}">
        <td>${payments[0] ? `<button class="text-link" data-action="view-invoice-payment" data-id="${esc(payments[0].TTBH_Ma)}">${esc(invoiceId)}</button>` : esc(invoiceId)}</td>
        <td>${formatCurrency(invoice.BH_TongCong)}</td><td class="money">${formatCurrency(paid)}</td><td class="money">${formatCurrency(cash)}</td><td class="money">${formatCurrency(bank)}</td>
        <td class="${due ? "negative" : ""} money">${formatCurrency(due)}</td><td>${receiptLinks}</td><td>${transactionIds}${createReceiptActions ? `<div class="inline-actions">${createReceiptActions}</div>` : ""}</td><td>${badge(stateLabel)}</td></tr>`;
    }).join("");
    content = tableCard("Đối soát theo hóa đơn", `${invoiceIds.length} hóa đơn · ${result.sales.length} giao dịch`, ["Mã hóa đơn", "Tổng hóa đơn", "Đã thu thành công", "Tiền mặt", "Chuyển khoản/QR", "Công nợ còn lại", "Phiếu thu liên kết", "Giao dịch nguồn", "Trạng thái"], rows, "Phiếu thu liên kết không làm tăng tổng thu lần hai. Thanh toán QR/chuyển khoản chỉ được ghi nhận sau xác nhận nội bộ demo, không kết nối ngân hàng.", "reconcile-sales");
  } else if (reconciliationTab === "supplier") {
    const rows = result.supplier.map(({ payment, debt, linkedVoucher, alerts }) => {
      const creditor = state.CongNoNCC.find((row) => row.CNNCC_Ma === debt?.CNNCC_Ma);
      return `<tr data-accounting-row data-search="${esc(`${payment.TTNCC_Ma} ${supplierName(state, creditor?.DT_Ma)} ${payment.CTNNCC_Ma}`.toLocaleLowerCase("vi-VN"))}"
        data-status="${esc(payment.TTNCC_TrangThai)}" data-date="${esc(String(payment.TTNCC_Ngay).slice(0, 10))}">
        <td>${esc(payment.TTNCC_Ma)}</td><td>${esc(supplierName(state, creditor?.DT_Ma))}</td><td>${esc(payment.CTNNCC_Ma)}</td>
        <td class="money">${formatCurrency(payment.TTNCC_SoTien)}</td><td>${esc(payment.TTNCC_PhuongThuc)}</td><td>${badge(payment.TTNCC_TrangThai)}</td>
        <td>${linkedVoucher ? esc(linkedVoucher.PC_Ma) : "—"}</td><td>${alerts.length ? `<span class="negative">${alerts.map(esc).join("<br>")}</span>` : "Khớp nội bộ"}</td></tr>`;
    }).join("");
    content = tableCard("Thanh toán NCC", `${result.supplier.length} giao dịch`, ["Mã TTNCC", "Nhà cung cấp", "Khoản nợ", "Số tiền", "Phương thức", "Trạng thái", "Phiếu chi", "Cảnh báo"], rows, "Phiếu chi liên kết không được cộng lần hai vào chi NCC.", "reconcile-supplier");
  } else if (reconciliationTab === "cashflow") {
    content = `<div class="metric-grid">${metric("Thu bán hàng", result.recognizedSalesIncome)}${metric("Thu khác", result.recognizedOtherIncome)}
      ${metric("Chi NCC", result.recognizedSupplierExpense)}${metric("Chi khác", result.recognizedOtherExpense)}
      ${metric("Thu - chi ghi nhận", result.netCashMovement, "Tổng hợp dòng tiền nội bộ; không phải báo cáo lưu chuyển tiền tệ chuẩn")}</div>
      <div class="info-box">Chưa có dữ liệu sao kê/kiểm quỹ để xác nhận độc lập. Không có kết nối ngân hàng trong bản demo.</div>`;
  } else {
    const rows = result.alerts.map((alert, index) => `<tr data-accounting-row data-search="${esc(alert.toLocaleLowerCase("vi-VN"))}"><td>${index + 1}</td><td class="negative">${esc(alert)}</td></tr>`).join("");
    content = tableCard("Các trường hợp cần kiểm tra", `${result.alerts.length} cảnh báo`, ["#", "Nội dung"], rows, "Không tự xác nhận giao dịch với ngân hàng.", "reconcile-alerts");
  }
  return `${heading("Đối soát thanh toán", "Đối chiếu nội bộ giữa giao dịch, công nợ và chứng từ; không tuyên bố đã đối soát ngân hàng.", "")}
    <div class="filters"><div class="field"><label>Từ ngày</label><input id="reconcile-from" type="date" value="${esc(dateFrom)}"></div>
      <div class="field"><label>Đến ngày</label><input id="reconcile-to" type="date" value="${esc(dateTo)}"></div>
      <button class="button" data-action="clear-dashboard-dates">Xóa ngày</button></div>${tabBar}${content}`;
}

function renderCashbook(state) {
  const result = getCashbook(cashbookFilters, state);
  const records = result.rows.filter((row) => !cashbookFilters.status || row.status === cashbookFilters.status);
  const partnerOptions = [...new Set(state.DoiTacKinhDoanh.map((row) => row.DT_Ma))]
    .map((id) => [id, supplierName(state, id)]);
  const methodOptions = ["Tiền mặt", "Chuyển khoản", "QR"].map((value) => [value, value]);
  const typeOptions = ["Thu bán hàng", "Thu khác", "Chi NCC", "Chi khác"].map((value) => [value, value]);
  const statuses = [...new Set(result.rows.map((row) => row.status))].map((value) => [value, value]);
  const cashbookSelect = (key, label, options) => `<div class="field"><label>${label}</label><select data-cashbook-filter="${key}"><option value="">Tất cả</option>${options.map(([value, text]) => `<option value="${esc(value)}" ${cashbookFilters[key] === value ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></div>`;
  const rows = records.map((row) => {
    const sourceAction = row.type === "Thu bán hàng" ? `data-action="view-invoice-payment" data-id="${esc(row.voucherId)}"`
      : row.type === "Chi NCC" ? `data-action="view-supplier-payment" data-id="${esc(row.voucherId)}"`
        : row.type === "Thu khác" ? `data-action="view-receipt" data-id="${esc(row.voucherId)}"`
          : `data-action="view-expense" data-id="${esc(row.voucherId)}"`;
    return `<tr><td>${formatDateTime(row.date)}</td><td><button class="text-link" ${sourceAction}>${esc(row.voucherId)}</button></td>
      <td>${row.sourceId ? esc(row.sourceId) : "—"}${row.linkedVoucherId ? ` · Chứng từ <button class="text-link" data-action="${row.type === "Thu bán hàng" ? "view-receipt" : "view-expense"}" data-id="${esc(row.linkedVoucherId)}">${esc(row.linkedVoucherId)}</button>` : ""}</td>
      <td>${esc(row.type)}</td><td>${esc(row.content)}</td><td>${esc(row.partnerId ? supplierName(state, row.partnerId) : "—")}</td>
      <td>${esc(row.method)}</td><td class="money">${row.incoming ? formatCurrency(row.incoming) : "—"}</td>
      <td class="money">${row.outgoing ? formatCurrency(row.outgoing) : "—"}</td><td>${badge(row.status)}${row.recognized ? "" : `<div class="cell-muted">Chưa ghi nhận dòng tiền</div>`}</td></tr>`;
  }).join("");
  return `<div class="filters"><div class="field"><label>Từ ngày</label><input data-cashbook-filter="from" type="date" value="${esc(cashbookFilters.from)}"></div>
      <div class="field"><label>Đến ngày</label><input data-cashbook-filter="to" type="date" value="${esc(cashbookFilters.to)}"></div>
      ${cashbookSelect("method", "Phương thức", methodOptions)}
      ${cashbookSelect("type", "Loại giao dịch", typeOptions)}
      ${cashbookSelect("partner", "Đối tác", partnerOptions)}
      ${cashbookSelect("status", "Trạng thái", statuses)}
      <button class="button" data-action="clear-cashbook-filters">Xóa lọc</button></div>
    <div class="metric-grid">${metric("Tổng thu tiền mặt", result.cashIncome)}${metric("Tổng thu ngân hàng/QR", result.bankIncome)}
      ${metric("Tổng chi tiền mặt", result.cashExpense)}${metric("Tổng chi ngân hàng", result.bankExpense)}
      ${metric("Thuần tiền vào/ra", result.net, "Chỉ giao dịch thành công/phiếu đã xác nhận; chứng từ liên kết không tính lần hai")}</div>
    ${tableCard("Chi tiết sổ thu – chi", `${records.length} dòng`, ["Ngày giờ", "Mã chứng từ", "Chứng từ nguồn", "Loại thu/chi", "Nội dung", "Đối tác", "Phương thức", "Tiền vào", "Tiền ra", "Trạng thái"], rows, "Các giao dịch chờ/thất bại vẫn hiển thị để đối chiếu nhưng không cộng vào chỉ số. QR/chuyển khoản chỉ được ghi nhận sau xác nhận nội bộ demo.", "cashbook")}`;
}

function renderCashShiftReconciliation(state) {
  if (role() !== "Nhân viên kế toán") {
    return `${heading("Đối soát ca bán hàng", "Kế toán kiểm tra số liệu kết ca và xác nhận tiền mặt bàn giao.", "")}
      <div class="info-box info-warning">Chức năng xác nhận chỉ dành cho vai trò Nhân viên kế toán. Dữ liệu ca có thể xem tại báo cáo Chủ cửa hàng.</div>`;
  }
  const shifts = getCashShifts().sort((a, b) => String(b.GioMo).localeCompare(String(a.GioMo)));
  const rows = shifts.map((shift) => {
    const summary = calculateCashShift(shift, state);
    const actions = [
      `<button class="button button-small" data-action="view-cash-shift" data-id="${esc(shift.Ca_Ma)}">Chi tiết</button>`,
      summary.pendingPayments.length ? `<a class="button button-small" href="doi-soat-thanh-toan.html">Đối soát thanh toán</a>` : "",
      shift.TrangThai === "Chờ đối soát" ? `<button class="button button-small" data-action="request-cash-shift-explanation" data-id="${esc(shift.Ca_Ma)}">Yêu cầu giải trình</button>
        <button class="button button-small button-primary" data-action="reconcile-cash-shift" data-id="${esc(shift.Ca_Ma)}">Đối soát</button>` : "",
      shift.TrangThai === "Đã đối soát" && !shift.ThoiDiemXacNhanBanGiao
        ? `<button class="button button-small button-primary" data-action="confirm-cash-handover" data-id="${esc(shift.Ca_Ma)}">Xác nhận bàn giao</button>` : ""
    ].filter(Boolean).join("");
    return `<tr data-accounting-row data-search="${esc(`${shift.Ca_Ma} ${employeeName(state, shift.NV_Ma)} ${locationName(state, shift.DD_Ma)}`.toLocaleLowerCase("vi-VN"))}"
      data-date="${esc(String(shift.GioMo || "").slice(0, 10))}" data-location="${esc(shift.DD_Ma)}" data-staff="${esc(shift.NV_Ma)}" data-status="${esc(shift.TrangThai)}">
      <td class="cell-primary">${esc(shift.Ca_Ma)}</td><td>${esc(employeeName(state, shift.NV_Ma))}</td><td>${esc(locationName(state, shift.DD_Ma))}</td>
      <td>${formatDateTime(shift.GioMo)}</td><td>${shift.GioDong ? formatDateTime(shift.GioDong) : "—"}</td>
      <td class="money">${formatCurrency(summary.expectedCash)}</td><td class="money">${shift.TienMatThucDem === null ? "—" : formatCurrency(shift.TienMatThucDem)}</td>
      <td class="money">${shift.ChenhLech === null ? "—" : formatCurrency(shift.ChenhLech)}</td>
      <td>${summary.pendingPayments.length ? `<span class="badge badge-amber">${summary.pendingPayments.length} chờ xác nhận</span>` : "—"}</td>
      <td>${badge(shift.TrangThai)}</td><td><div class="inline-actions">${actions}</div></td></tr>`;
  }).join("");
  const shiftsNeedingReconcile = shifts.filter((shift) => shift.TrangThai === "Chờ đối soát").length;
  const shiftsNeedHandover = shifts.filter((shift) => shift.TrangThai === "Đã đối soát" && !shift.ThoiDiemXacNhanBanGiao).length;
  const varianceCount = shifts.filter((shift) => Number(shift.ChenhLech || 0) !== 0).length;
  const activeCount = shifts.filter((shift) => shift.TrangThai === "Đang mở").length;
  const countMetric = (title, value) => `<div class="metric-card"><div class="metric-title">${title}</div><div class="metric-value">${formatNumber(value)}</div></div>`;
  return `${heading("Đối soát ca bán hàng", "Kiểm tra thanh toán theo ca, yêu cầu giải trình, đối soát và xác nhận bàn giao tiền mặt.", `<a class="button" href="doi-soat-thanh-toan.html">Mở đối soát thanh toán</a>`)}
    <div class="metric-grid">${countMetric("Ca đang mở", activeCount)}${countMetric("Chờ đối soát", shiftsNeedingReconcile)}${countMetric("Chờ xác nhận bàn giao", shiftsNeedHandover)}${countMetric("Ca có chênh lệch", varianceCount)}</div>
    ${listFilters([searchFilter("Tìm mã ca / nhân viên / cửa hàng"), selectFilter("status", "Trạng thái", [
      ["Đang mở", "Đang mở"], ["Chờ đối soát", "Chờ đối soát"], ["Cần giải trình", "Cần giải trình"],
      ["Đã đối soát", "Đã đối soát"], ["Đã bàn giao", "Đã bàn giao"]
    ]), selectFilter("location", "Cửa hàng", state.DiaDiem.filter((row) => row.DD_Loai === "Cửa hàng").map((row) => [row.DD_Ma, row.DD_Ten])),
    selectFilter("staff", "Nhân viên", state.NhanVien.map((row) => [row.NV_Ma, row.NV_Ten])),
    dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày")])}
    ${tableCard("Danh sách ca bán hàng", `${shifts.length} ca`, ["Mã ca", "Thu ngân", "Cửa hàng", "Giờ mở", "Giờ kết", "Tiền dự kiến", "Thực đếm", "Chênh lệch", "Thanh toán chờ", "Trạng thái", "Thao tác"], rows, "Tiền dự kiến gồm tiền đầu ca và thanh toán tiền mặt thành công gắn với ca. Doanh thu hóa đơn và thu tiền là các chỉ số khác nhau.", "cash-shift-reconciliation")}`;
}

function cashShiftDetailMarkup(state, shift) {
  const summary = calculateCashShift(shift, state);
  const invoiceRows = summary.invoices.map((invoice) => `<tr><td>${esc(invoice.BH_Ma)}</td><td>${formatDateTime(invoice.BH_Ngay)}</td><td>${formatCurrency(invoice.BH_TongCong)}</td></tr>`).join("");
  const paymentRows = summary.payments.map((payment) => {
    const receipt = state.PhieuThu.find((row) => row.TTBH_Ma === payment.TTBH_Ma);
    return `<tr><td>${esc(payment.BH_Ma)}</td><td>${esc(payment.TTBH_Ma)}</td><td>${formatDateTime(payment.TTBH_Ngay)}</td>
      <td>${receipt ? `<button class="text-link" data-action="view-receipt" data-id="${esc(receipt.PT_Ma)}">${esc(receipt.PT_Ma)}</button>`
        : payment.TTBH_TrangThai === "Thành công" ? `<span class="negative">Thiếu chứng từ thu</span>` : "Chưa phát sinh"}</td>
      <td>${formatCurrency(payment.TTBH_SoTien)}</td><td>${esc(payment.TTBH_PhuongThuc)}</td><td>${badge(payment.TTBH_TrangThai)}</td></tr>`;
  }).join("");
  return `<div class="shift-print"><h2>BÁO CÁO CA BÁN HÀNG · ${esc(shift.Ca_Ma)}</h2>
    <p>Thu ngân: ${esc(employeeName(state, shift.NV_Ma))} · Cửa hàng: ${esc(locationName(state, shift.DD_Ma))}</p>
    <p>Mở: ${formatDateTime(shift.GioMo)} · Kết: ${shift.GioDong ? formatDateTime(shift.GioDong) : "Chưa kết ca"} · Trạng thái: ${esc(shift.TrangThai)}</p>
    <div class="metric-grid">${metric("Doanh thu hóa đơn", summary.revenue)}${metric("Tiền mặt", summary.cash)}${metric("Chuyển khoản", summary.transfer)}
      ${metric("QR", summary.qr)}${metric("Tiền mặt đầu ca", shift.TienMatDauCa)}
      ${metric("Tiền dự kiến", shift.TienMatDuKien ?? summary.expectedCash)}
      ${metric("Tiền thực đếm", shift.TienMatThucDem ?? 0)}
      ${metric("Chênh lệch", shift.ChenhLech ?? 0)}</div>
    <p>Giải trình thu ngân: ${esc(shift.GiaiTrinh || "—")}</p><p>Ghi chú kế toán: ${esc(shift.GhiChuKeToan || "—")}</p>
    <p>Tiền mặt bàn giao: ${shift.TienMatBanGiao === null ? "Chưa xác nhận" : formatCurrency(shift.TienMatBanGiao)}
      ${shift.ThoiDiemXacNhanBanGiao ? ` · Người nhận: ${esc(employeeName(state, shift.NguoiNhanBanGiao))} · ${formatDateTime(shift.ThoiDiemXacNhanBanGiao)}` : ""}</p>
    ${tableCard("Hóa đơn trong ca", `${summary.invoiceCount} hóa đơn`, ["Mã hóa đơn", "Thời điểm", "Tổng hóa đơn"], invoiceRows)}
    ${tableCard("Thanh toán gắn với ca", `${summary.payments.length} thanh toán`, ["Hóa đơn", "Mã thanh toán", "Thời điểm", "Phiếu thu liên kết", "Số tiền", "Phương thức", "Trạng thái"], paymentRows)}
    <p class="cell-muted">Bản in demo, không thay thế chứng từ kế toán hoặc sao kê ngân hàng.</p></div>`;
}

function openCashShiftDetail(state, shiftId) {
  const shift = getCashShift(shiftId);
  if (!shift) return toast("Không tìm thấy ca bán hàng.", true);
  modal(`Chi tiết ca ${shift.Ca_Ma}`, cashShiftDetailMarkup(state, shift),
    `<button class="button" data-action="close-modal">Đóng</button><button class="button button-primary" data-action="print-cash-shift">In báo cáo / biên bản</button>`, true);
}

function openCashShiftActionForm(action, shiftId) {
  const shift = getCashShift(shiftId);
  if (!shift) return toast("Không tìm thấy ca bán hàng.", true);
  const definitions = {
    "request-cash-shift-explanation": {
      title: `Yêu cầu giải trình · ${shiftId}`, formId: "cash-shift-request-form", submit: "Gửi yêu cầu",
      fields: `<div class="field"><label>Nội dung cần làm rõ *</label><textarea name="note" rows="4" required maxlength="500"></textarea></div>`
    },
    "reconcile-cash-shift": {
      title: `Đối soát ca · ${shiftId}`, formId: "cash-shift-reconcile-form", submit: "Xác nhận đối soát",
      fields: `<div class="info-box">Tiền dự kiến: ${formatCurrency(shift.TienMatDuKien)} · Thực đếm: ${formatCurrency(shift.TienMatThucDem)} · Chênh lệch: ${formatCurrency(shift.ChenhLech)}</div>
        <div class="field"><label>Ghi chú kế toán</label><textarea name="note" rows="3" maxlength="500">${esc(shift.GhiChuKeToan || "")}</textarea></div>`
    },
    "confirm-cash-handover": {
      title: `Xác nhận bàn giao · ${shiftId}`, formId: "cash-shift-handover-form", submit: "Xác nhận bàn giao",
      fields: `<div class="info-box">Tiền mặt thực đếm: ${formatCurrency(shift.TienMatThucDem)}. Hãy nhập số tiền thực nhận.</div>
        <div class="field"><label>Tiền mặt thực nhận (VND) *</label><input name="amount" type="number" min="0" step="1" value="${shift.TienMatThucDem ?? 0}" required></div>
        <div class="field"><label>Ghi chú / giải thích nếu lệch số tiền thực đếm</label><textarea name="note" rows="3" maxlength="500"></textarea></div>`
    }
  };
  const definition = definitions[action];
  if (!definition) return;
  modal(definition.title, `<div class="form-error" id="cash-shift-action-error"></div><form id="${definition.formId}" data-id="${esc(shiftId)}">${definition.fields}</form>`,
    `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="${definition.formId}" type="submit">${definition.submit}</button>`);
}

function renderReports(state) {
  const report = getAccountingReports(state);
  const tabs = [["revenue", "Doanh thu"], ["cashflow", "Thu chi"], ["cashbook", "Sổ thu – chi"], ["debts", "Công nợ"], ["inventory", "Tồn kho & giá vốn"]];
  const tabBar = `<div class="accounting-tabs">${tabs.map(([key, label]) =>
    `<button class="button ${key === reportTab ? "button-primary" : ""}" data-action="report-tab" data-tab="${key}">${label}</button>`).join("")}</div>`;
  let content = "";
  if (reportTab === "revenue") {
    const dayRows = report.revenueByDay.map((row) => `<tr data-accounting-row data-search="${esc(row.date)}" data-date="${esc(row.date)}">
      <td>${formatDate(row.date)}</td><td class="money">${formatNumber(row.invoices)}</td><td class="money">${formatNumber(row.quantity)}</td><td class="money">${formatCurrency(row.revenue)}</td></tr>`).join("");
    const locationRows = report.revenueByLocation.map((row) => `<tr data-accounting-row data-search="${esc(locationName(state, row.id))}">
      <td>${esc(locationName(state, row.id))}</td><td class="money">${formatNumber(row.invoices)}</td><td class="money">${formatNumber(row.quantity)}</td><td class="money">${formatCurrency(row.revenue)}</td></tr>`).join("");
    content = `<div class="metric-grid">${metric("Doanh thu hóa đơn xác nhận", report.revenue)}<div class="metric-card"><div class="metric-title">Số hóa đơn</div><div class="metric-value">${formatNumber(report.invoiceCount)}</div></div><div class="metric-card"><div class="metric-title">Số lượng bán</div><div class="metric-value">${formatNumber(report.soldQuantity)}</div></div></div>
      <div class="dashboard-grid">${tableCard("Doanh thu theo ngày", "Chỉ hóa đơn đã xác nhận", ["Ngày", "Số hóa đơn", "Số lượng", "Doanh thu"], dayRows, "", "report-revenue-day")}
      ${tableCard("Doanh thu theo địa điểm", "Không tính phiếu thu khác", ["Cửa hàng", "Số hóa đơn", "Số lượng", "Doanh thu"], locationRows, "", "report-revenue-location")}</div>`;
  } else if (reportTab === "cashbook") {
    content = renderCashbook(state);
  } else if (reportTab === "cashflow") {
    content = `<div class="metric-grid">${metric("Tiền thu bán hàng", report.receivedSales)}${metric("Thu khác", report.receivedOther)}${metric("Tiền trả NCC", report.paidSuppliers)}${metric("Chi khác", report.paidOther)}${metric("Thu - chi", report.cashDifference)}</div>
      <div class="info-box">Đây là tổng hợp dòng tiền theo dữ liệu hệ thống, không phải báo cáo lưu chuyển tiền tệ chuẩn kế toán. Phiếu chi liên kết NCC không cộng lặp với ThanhToanNCC.</div>`;
  } else if (reportTab === "debts") {
    const supplierRows = report.debtDetails.map(({ debt, receipt, paid, due }) => `<tr data-accounting-row data-search="${esc(`${debt.CTNNCC_Ma} ${debt.PN_Ma} ${supplierName(state, state.CongNoNCC.find((row) => row.CNNCC_Ma === debt.CNNCC_Ma)?.DT_Ma)}`.toLocaleLowerCase("vi-VN"))}">
      <td>${esc(supplierName(state, state.CongNoNCC.find((row) => row.CNNCC_Ma === debt.CNNCC_Ma)?.DT_Ma))}</td><td>${esc(receipt?.PN_Ma || debt.PN_Ma)}</td>
      <td class="money">${formatCurrency(debt.CTNNCC_SoTienNo)}</td><td class="money">${formatCurrency(paid)}</td><td class="negative money">${formatCurrency(due)}</td></tr>`).join("");
    const customerRows = report.customerDebts.map(({ invoice, paid, due }) => `<tr data-accounting-row data-search="${esc(`${invoice.BH_Ma} ${supplierName(state, invoice.DT_Ma)}`.toLocaleLowerCase("vi-VN"))}">
      <td>${esc(supplierName(state, invoice.DT_Ma))}</td><td>${esc(invoice.BH_Ma)}</td><td class="money">${formatCurrency(invoice.BH_TongCong)}</td><td class="money">${formatCurrency(paid)}</td><td class="negative money">${formatCurrency(due)}</td></tr>`).join("");
    content = `<div class="metric-grid">${metric("Phải thu khách hàng", report.receivableBalance)}${metric("Phải trả NCC", report.payableBalance)}</div>
      <div class="dashboard-grid">${tableCard("Khoản phải trả NCC", `${report.debtDetails.length} khoản còn dư`, ["NCC", "Phiếu nhập", "Nợ gốc", "Đã trả", "Còn nợ"], supplierRows, "", "report-supplier-debt")}
      ${tableCard("Khoản phải thu khách hàng", `${report.customerDebts.length} hóa đơn còn dư`, ["Khách hàng", "Hóa đơn", "Tổng tiền", "Đã thu", "Còn nợ"], customerRows, "", "report-customer-debt")}</div>
      <div class="table-subnote">Không báo cáo tuổi nợ/quá hạn vì CSDL không có ngày đến hạn.</div>`;
  } else {
    content = `<div class="metric-grid">${metric("Giá trị tồn theo giá nhập", report.inventoryValue)}${metric("Giá vốn đã bán", report.cost)}${metric("Lợi nhuận gộp sơ bộ", report.grossProfit, "Doanh thu − giá vốn; không phải lợi nhuận ròng")}</div>
      <div class="info-box">Giá trị tồn = SUM(TK_SL × PNCT_DonGia). Giá vốn = SUM(BH_SL × PNCT_DonGia) của hóa đơn đã xác nhận. Không suy luận thuế, chi phí phân bổ hoặc lợi nhuận sau thuế.</div>`;
  }
  const reportTitle = reportTab === "cashbook" ? "Sổ thu – chi" : "Báo cáo kế toán";
  return `${heading(reportTitle, "Báo cáo được tính trực tiếp từ state Kho/Bán hàng; không tạo bảng hoặc dữ liệu ngoài lược đồ.", "")}${tabBar}${content}`;
}

function renderContent() {
  try {
    const state = getState();
    const renderers = {
      "accounting-overview": renderOverview,
      "purchase-reconciliation": renderPurchaseReconciliation,
      "stock-reconciliation": renderStockReconciliation,
      "supplier-debts": renderSupplierDebts,
      "supplier-payments": renderSupplierPayments,
      receipts: renderReceiptVouchers,
      expenses: renderExpenseVouchers,
      "revenue-reconciliation": renderRevenueReconciliation,
      "payment-reconciliation": renderPaymentReconciliation,
      "cash-shift-reconciliation": renderCashShiftReconciliation,
      reports: renderReports
    };
    document.querySelector("#page-content").innerHTML = page === "customer-debts"
      ? `${heading("Công nợ khách hàng", "Màn hình dùng chung với Bán hàng; trả nợ ghi ThanhToanBanHang, không tạo PhieuThu và không giảm tồn lần nữa.",
        `<a class="button button-primary" href="../ban-hang-ke-toan/cong-no-khach-hang.html">Mở danh sách công nợ khách hàng</a>`)}
        <div class="info-box">Dữ liệu công nợ và lịch sử trả nợ được dùng trực tiếp từ phân hệ Bán hàng để tránh tạo một bản sao kế toán riêng.</div>
        ${tableCard("Công nợ khách hàng hiện tại", `${getCustomerReceivables("", state).length} hóa đơn còn nợ`,
          ["Mã hóa đơn", "Khách hàng", "Tổng hóa đơn", "Đã thanh toán", "Còn phải thu", "Lịch sử"], getCustomerReceivables("", state).map(({ invoice, paid, due }) =>
          `<tr data-accounting-row data-search="${esc(`${invoice.BH_Ma} ${supplierName(state, invoice.DT_Ma)}`.toLocaleLowerCase("vi-VN"))}">
            <td>${esc(invoice.BH_Ma)}</td><td>${esc(supplierName(state, invoice.DT_Ma))}</td><td class="money">${formatCurrency(invoice.BH_TongCong)}</td>
            <td class="money">${formatCurrency(paid)}</td><td class="negative money">${formatCurrency(due)}</td>
            <td><a class="button button-small" href="../ban-hang-ke-toan/cong-no-khach-hang.html?customer=${encodeURIComponent(invoice.DT_Ma)}">Xem / ghi trả nợ</a></td></tr>`).join(""), "", "accounting-customer-debts")}`
      : (renderers[page] || renderOverview)(state);
    applyFilters();
  } catch (error) {
    document.querySelector("#page-content").innerHTML = `<div class="warning-box">Không thể tải dữ liệu kế toán: ${esc(error.message || "Lỗi không xác định.")}</div>`;
  }
}

function applyFilters() {
  const content = document.querySelector("#page-content");
  const controls = [...content.querySelectorAll(".list-filter")];
  for (const card of content.querySelectorAll("[data-table-card]")) {
    const tbody = card.querySelector("tbody");
    const rows = [...tbody.querySelectorAll("tr[data-accounting-row]")];
    let visible = 0;
    for (const row of rows) {
      const match = controls.every((control) => {
        const value = control.value.trim().toLocaleLowerCase("vi-VN");
        if (!value) return true;
        const key = control.dataset.filter;
        if (key === "search") return row.dataset.search.includes(value);
        if (key === "from") return (row.dataset.date || "") >= value;
        if (key === "to") return (row.dataset.date || "") <= value;
        return (row.dataset[key] || "").toLocaleLowerCase("vi-VN") === value;
      });
      row.dataset.filterMatch = String(match);
    }
    const matching = rows.filter((row) => row.dataset.filterMatch === "true");
    const pageSize = 20;
    const pages = Math.max(1, Math.ceil(matching.length / pageSize));
    let currentPage = Math.min(tablePages.get(card.dataset.tableCard) || 0, pages - 1);
    tablePages.set(card.dataset.tableCard, currentPage);
    matching.forEach((row, index) => { row.hidden = Math.floor(index / pageSize) !== currentPage; });
    rows.filter((row) => row.dataset.filterMatch !== "true").forEach((row) => { row.hidden = true; });
    visible = matching.length;
    let empty = tbody.querySelector("[data-filter-empty]");
    if (rows.length && !visible) {
      if (!empty) {
        const count = card.querySelectorAll("thead th").length;
        tbody.insertAdjacentHTML("beforeend", `<tr data-filter-empty><td colspan="${count}" class="empty-state">Không có dữ liệu phù hợp.</td></tr>`);
      }
    } else if (empty) empty.remove();
    const pagination = card.querySelector("[data-pagination]");
    pagination.innerHTML = visible > pageSize ? `<span>${currentPage * pageSize + 1}–${Math.min((currentPage + 1) * pageSize, visible)} / ${visible}</span>
      <div class="inline-actions"><button class="button button-small" data-action="page" data-table="${esc(card.dataset.tableCard)}" data-step="-1" ${currentPage === 0 ? "disabled" : ""}>Trước</button>
      <button class="button button-small" data-action="page" data-table="${esc(card.dataset.tableCard)}" data-step="1" ${currentPage >= pages - 1 ? "disabled" : ""}>Tiếp</button></div>` : "";
  }
}

function showFormError(selector, message) {
  const node = document.querySelector(selector);
  if (node) {
    node.textContent = message;
    node.classList.add("visible");
  } else toast(message, true);
}

function updateSupplierDebtForm(state, DT_Ma) {
  const debtSelect = document.querySelector("#payment-debt");
  if (!debtSelect) return;
  const creditor = state.CongNoNCC.find((row) => row.DT_Ma === DT_Ma);
  const available = state.ChiTietNoNCC.filter((row) => row.CNNCC_Ma === creditor?.CNNCC_Ma && getSupplierDebtBalance(row.CTNNCC_Ma, state) > 0);
  const optionsHtml = available.map((row, index) =>
    `<option value="${esc(row.CTNNCC_Ma)}" ${index === 0 ? "selected" : ""}>${esc(row.PN_Ma)} · còn ${formatCurrency(getSupplierDebtBalance(row.CTNNCC_Ma, state))}</option>`).join("");
  debtSelect.innerHTML = `<option value="">Chọn khoản nợ</option>${optionsHtml}`;
  debtSelect.dispatchEvent(new Event("change", { bubbles: true }));
}

function updateSelectedDebtDetails(state, CTNNCC_Ma) {
  const debt = state.ChiTietNoNCC.find((row) => row.CTNNCC_Ma === CTNNCC_Ma);
  const balance = debt ? getSupplierDebtBalance(CTNNCC_Ma, state) : 0;
  const paid = debt ? debt.CTNNCC_SoTienNo - balance : 0;
  const setValue = (selector, value) => { const node = document.querySelector(selector); if (node) node.value = value; };
  setValue("#payment-principal", formatCurrency(debt?.CTNNCC_SoTienNo || 0));
  setValue("#payment-paid", formatCurrency(paid));
  setValue("#payment-balance", formatCurrency(balance));
  const amount = document.querySelector("#supplier-payment-form [name='amount']");
  if (amount) amount.max = String(balance);
  const submit = document.querySelector('[form="supplier-payment-form"][type="submit"]');
  if (submit) submit.disabled = !balance;
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id || "";
  const state = getState();
  if (action === "close-modal" || (action === "backdrop-close" && event.target === button)) return closeModal();
  if (action === "view-cash-shift") return openCashShiftDetail(state, id);
  if (["request-cash-shift-explanation", "reconcile-cash-shift", "confirm-cash-handover"].includes(action)) {
    return openCashShiftActionForm(action, id);
  }
  if (action === "print-cash-shift") return window.print();
  if (action === "print-receipt") return window.print();
  if (action === "sync-sales-receipt") {
    try {
      const result = syncSuccessfulSalesReceipt(id, role());
      renderContent();
      toast(result.created ? `Đã đồng bộ phiếu thu ${result.PT_Ma}.` : `Giao dịch đã có phiếu thu ${result.PT_Ma}.`);
    } catch (error) { toast(error.message, true); }
    return;
  }
  if (action === "sync-missing-sales-receipts") {
    const state = getState();
    const missing = state.ThanhToanBanHang.filter((payment) => payment.TTBH_TrangThai === "Thành công"
      && !state.PhieuThu.some((voucher) => voucher.TTBH_Ma === payment.TTBH_Ma));
    if (!missing.length) return toast("Không có phiếu thu bán hàng nào đang thiếu.");
    if (!confirm(`Đồng bộ ${missing.length} giao dịch thanh toán thành công đang thiếu phiếu thu? Dữ liệu cũ không được tự thay đổi khi chưa xác nhận.`)) return;
    try {
      const results = syncMissingSuccessfulSalesReceipts(role());
      renderContent();
      toast(`Đã đồng bộ ${results.length} phiếu thu.`);
    } catch (error) { toast(error.message, true); }
    return;
  }
  if (action === "reset") {
    if (!confirm("Khôi phục dữ liệu demo dùng chung cho Kho, Bán hàng và Kế toán? Các thay đổi trên trình duyệt sẽ bị xóa.")) return;
    resetDemoData();
    closeModal();
    renderContent();
    toast("Đã khôi phục dữ liệu demo dùng chung.");
  } else if (action === "clear-filters") {
    document.querySelectorAll(".list-filter").forEach((control) => { control.value = ""; });
    tablePages.clear();
    applyFilters();
  } else if (action === "clear-dashboard-dates") {
    dateFrom = "";
    dateTo = "";
    renderContent();
  } else if (action === "clear-cashbook-filters") {
    cashbookFilters = { from: "", to: "", method: "", type: "", partner: "", status: "" };
    renderContent();
  } else if (action === "page") {
    const key = button.dataset.table;
    tablePages.set(key, Math.max(0, (tablePages.get(key) || 0) + Number(button.dataset.step)));
    applyFilters();
  } else if (action === "stock-tab") {
    reconciliationTab = button.dataset.tab;
    renderContent();
  } else if (action === "payment-tab") {
    reconciliationTab = button.dataset.tab;
    renderContent();
  } else if (action === "report-tab") {
    reportTab = button.dataset.tab;
    renderContent();
  } else if (action === "view-purchase") viewPurchase(state, id);
  else if (action === "confirm-inbound") {
    if (!confirm(`Xác nhận phiếu nhập ${id}? Hệ thống sẽ cập nhật TonKho, BienDongKho và tự ghi nhận công nợ NCC nếu phiếu có giá trị phải trả.`)) return;
    try {
      const result = confirmInboundWithPayable(id, role());
      closeModal();
      renderContent();
      toast(result.debtId
        ? `Đã xác nhận nhập ${id}; tồn kho, biến động và công nợ ${result.debtId} đã được ghi nhận.`
        : `Đã xác nhận nhập ${id}; tồn kho và biến động đã được ghi nhận, phiếu không phát sinh công nợ.`);
    } catch (error) { toast(error.message, true); }
  }
  else if (action === "new-supplier-debt") openCreateDebt(state);
  else if (action === "create-receipt-debt") {
    if (!confirm(`Ghi nhận một khoản nợ bằng tổng phiếu nhập ${id}? Không tạo thanh toán NCC.`)) return;
    try {
      const debtId = createSupplierDebtFromReceipt(id, role());
      selectedSupplier = state.CongNoNCC.find((row) => row.DT_Ma === state.PhieuNhap.find((receipt) => receipt.PN_Ma === id)?.DT_Ma)?.CNNCC_Ma || "";
      closeModal();
      renderContent();
      toast(`Đã ghi nhận khoản nợ ${debtId}.`);
    } catch (error) { toast(error.message, true); }
  } else if (action === "select-supplier") {
    selectedSupplier = id;
    renderContent();
  } else if (action === "view-debt-payments") supplierPaymentHistory(state, id);
  else if (action === "new-supplier-payment") paymentForm(state, id);
  else if (action === "confirm-supplier-payment") {
    if (!confirm(`Chỉ xác nhận ${id} sau khi đã kiểm tra thanh toán thực tế?`)) return;
    try { confirmSupplierPayment(id, role()); renderContent(); toast(`Đã xác nhận ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "fail-supplier-payment") {
    if (!confirm(`Đánh dấu giao dịch ${id} thất bại? Công nợ sẽ không giảm.`)) return;
    try { setSupplierPaymentStatus(id, "Thất bại", role()); renderContent(); toast(`Đã cập nhật ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "create-expense-voucher") {
    if (!confirm(`Tạo phiếu chi liên kết với ${id}? Khoản chi sẽ chỉ được tính một lần từ ThanhToanNCC.`)) return;
    try { const voucherId = createSupplierPaymentVoucher(id, role()); renderContent(); toast(`Đã tạo phiếu chi ${voucherId}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "view-receipt") {
    const voucher = state.PhieuThu.find((row) => row.PT_Ma === id);
    if (!voucher) return toast("Không tìm thấy phiếu thu.", true);
    const sourcePayment = voucher.TTBH_Ma && state.ThanhToanBanHang.find((row) => row.TTBH_Ma === voucher.TTBH_Ma);
    const invoice = sourcePayment && state.HoaDonBanHang.find((row) => row.BH_Ma === sourcePayment.BH_Ma);
    const shift = sourcePayment && getCashShiftForPayment(sourcePayment.TTBH_Ma);
    const invoicePaid = invoice ? state.ThanhToanBanHang
      .filter((row) => row.BH_Ma === invoice.BH_Ma && row.TTBH_TrangThai === "Thành công")
      .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0) : 0;
    const source = !sourcePayment ? "Thu khác"
      : voucher.PT_GhiChu?.includes("Nguồn: Thu nợ khách hàng") ? "Thu nợ khách hàng"
        : voucher.PT_GhiChu?.includes("Nguồn: Cần đối chiếu") ? "Cần đối chiếu"
          : shift ? shift.invoiceIds.includes(sourcePayment.BH_Ma) ? "Bán hàng POS" : "Thu nợ khách hàng" : "Cần đối chiếu";
    const isCash = voucher.PT_PhuongThuc === "Tiền mặt";
    modal(`Phiếu thu ${id}`, `<div class="invoice-print"><h2>${isCash ? "PHIẾU THU TIỀN MẶT" : "CHỨNG TỪ THU QUA NGÂN HÀNG"}</h2>
      <p>Siêu thị mini · ${source}</p><p>Mã phiếu: <strong>${esc(voucher.PT_Ma)}</strong> · Ngày lập: ${formatDateTime(voucher.PT_Ngay)}</p>
      <p>Người nộp: ${esc(voucher.DT_Ma ? supplierName(state, voucher.DT_Ma) : "Khách lẻ")} · Số tiền: <strong>${formatCurrency(voucher.PT_SoTien)}</strong></p>
      <p>Phương thức: ${esc(voucher.PT_PhuongThuc)} · Trạng thái: ${esc(voucher.PT_TrangThai)}</p>
      <p>Diễn giải: ${esc(voucher.PT_LyDo)} · Nhân viên lập: ${esc(employeeName(state, voucher.NV_Ma))}</p>
      ${voucher.PT_GhiChu ? `<p>Ghi chú: ${esc(voucher.PT_GhiChu)}</p>` : ""}
      ${sourcePayment ? `<hr><h3>Giao dịch thanh toán</h3><p>${esc(sourcePayment.TTBH_Ma)} · ${formatDateTime(sourcePayment.TTBH_Ngay)} · ${formatCurrency(sourcePayment.TTBH_SoTien)} · ${esc(sourcePayment.TTBH_PhuongThuc)} · ${esc(sourcePayment.TTBH_TrangThai)}</p>` : ""}
      ${invoice ? `<h3>Hóa đơn bán hàng</h3><p>${esc(invoice.BH_Ma)} · ${formatDateTime(invoice.BH_Ngay)} · Khách hàng: ${esc(invoice.DT_Ma ? supplierName(state, invoice.DT_Ma) : "Khách lẻ")}</p>
        <p>Tổng hóa đơn: ${formatCurrency(invoice.BH_TongCong)} · Đã thanh toán: ${formatCurrency(invoicePaid)} · Còn phải thu: ${formatCurrency(Math.max(0, invoice.BH_TongCong - invoicePaid))}</p>
        <p>Nhân viên bán: ${esc(employeeName(state, invoice.NV_Ma))} · Địa điểm: ${esc(locationName(state, invoice.DD_Ma))}</p>` : ""}
      ${shift ? `<h3>Ca bán hàng</h3><p>${esc(shift.Ca_Ma)} · ${esc(employeeName(state, shift.NV_Ma))} · ${formatDateTime(shift.GioMo)} – ${shift.GioDong ? formatDateTime(shift.GioDong) : "Đang mở"}</p>` : ""}</div>`,
    `${invoice ? `<button class="button" data-action="view-receipt-invoice" data-id="${esc(invoice.BH_Ma)}">Xem hóa đơn gốc</button>` : ""}
      ${sourcePayment ? `<button class="button" data-action="view-invoice-payment" data-id="${esc(sourcePayment.TTBH_Ma)}">Xem giao dịch</button>` : ""}
      <button class="button" data-action="close-modal">Đóng</button><button class="button button-primary" data-action="print-receipt">In chứng từ</button>`, true);
  } else if (action === "view-receipt-invoice") {
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === id);
    if (!invoice) return toast("Không tìm thấy hóa đơn bán hàng.", true);
    const paid = state.ThanhToanBanHang.filter((row) => row.BH_Ma === id && row.TTBH_TrangThai === "Thành công")
      .reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
    modal(`Hóa đơn ${id}`, `<div class="form-grid two">
      <div><span class="field-label">Mã hóa đơn / ngày bán</span><div>${esc(invoice.BH_Ma)} · ${formatDateTime(invoice.BH_Ngay)}</div></div>
      <div><span class="field-label">Khách hàng</span><div>${esc(invoice.DT_Ma ? supplierName(state, invoice.DT_Ma) : "Khách lẻ")}</div></div>
      <div><span class="field-label">Tổng hóa đơn</span><div>${formatCurrency(invoice.BH_TongCong)}</div></div>
      <div><span class="field-label">Đã thanh toán / còn phải thu</span><div>${formatCurrency(paid)} / ${formatCurrency(Math.max(0, invoice.BH_TongCong - paid))}</div></div>
      <div><span class="field-label">Nhân viên bán</span><div>${esc(employeeName(state, invoice.NV_Ma))}</div></div>
      <div><span class="field-label">Địa điểm bán</span><div>${esc(locationName(state, invoice.DD_Ma))}</div></div>
      <div><span class="field-label">Trạng thái</span><div>${badge(invoice.BH_TrangThai)}</div></div></div>`,
    `<button class="button" data-action="close-modal">Đóng</button>`);
  } else if (action === "view-invoice-payment") {
    const payment = state.ThanhToanBanHang.find((row) => row.TTBH_Ma === id);
    if (!payment) return toast("Không tìm thấy thanh toán bán hàng.", true);
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === payment.BH_Ma);
    const voucher = state.PhieuThu.find((row) => row.TTBH_Ma === id);
    modal(`Thanh toán ${id}`, `<div class="form-grid two">
      <div><span class="field-label">Hóa đơn</span><div>${esc(payment.BH_Ma)}</div></div>
      <div><span class="field-label">Khách hàng</span><div>${esc(supplierName(state, invoice?.DT_Ma))}</div></div>
      <div><span class="field-label">Ngày thanh toán</span><div>${formatDate(payment.TTBH_Ngay)}</div></div>
      <div><span class="field-label">Số tiền</span><div>${formatCurrency(payment.TTBH_SoTien)}</div></div>
      <div><span class="field-label">Phương thức / trạng thái</span><div>${esc(payment.TTBH_PhuongThuc)} · ${badge(payment.TTBH_TrangThai)}</div></div>
      <div><span class="field-label">Phiếu thu liên kết</span><div>${voucher ? `<button class="text-link" data-action="view-receipt" data-id="${esc(voucher.PT_Ma)}">${esc(voucher.PT_Ma)}</button>` : payment.TTBH_TrangThai === "Thành công" ? "Thiếu chứng từ thu" : "Chưa tạo khi giao dịch còn chờ"}</div></div>
      <div class="info-box">Giao dịch chuyển khoản/QR trong demo chưa được xác minh bởi ngân hàng thật.</div></div>`,
    `<button class="button" data-action="close-modal">Đóng</button>`);
  } else if (action === "view-expense") {
    const voucher = state.PhieuChi.find((row) => row.PC_Ma === id);
    if (!voucher) return toast("Không tìm thấy phiếu chi.", true);
    modal(`Phiếu chi ${id}`, `<div class="form-grid two"><div><span class="field-label">Loại</span><div>${voucher.TTNCC_Ma ? "Liên kết thanh toán NCC" : "Chi khác"}</div></div>
      <div><span class="field-label">Đối tác</span><div>${esc(supplierName(state, voucher.DT_Ma))}</div></div>
      <div><span class="field-label">Số tiền</span><div>${formatCurrency(voucher.PC_SoTien)}</div></div><div><span class="field-label">Trạng thái</span><div>${badge(voucher.PC_TrangThai)}</div></div>
      <div><span class="field-label">Lý do</span><div>${esc(voucher.PC_LyDo)}</div></div><div><span class="field-label">Phương thức</span><div>${esc(voucher.PC_PhuongThuc)}</div></div></div>`,
    `<button class="button" data-action="close-modal">Đóng</button>`);
  } else if (action === "view-supplier-payment") {
    const payment = state.ThanhToanNCC.find((row) => row.TTNCC_Ma === id);
    if (!payment) return toast("Không tìm thấy thanh toán NCC.", true);
    supplierPaymentHistory(state, payment.CTNNCC_Ma);
  } else if (action === "new-receipt") voucherForm(state, "receipt");
  else if (action === "edit-receipt") {
    const voucher = state.PhieuThu.find((row) => row.PT_Ma === id);
    if (voucher) voucherForm(state, "receipt", voucher);
  } else if (action === "confirm-receipt" || action === "cancel-receipt") {
    const next = action === "confirm-receipt" ? "Đã xác nhận" : "Đã hủy";
    if (!confirm(`${next} phiếu thu ${id}?`)) return;
    try { setReceiptVoucherStatus(id, next, role()); renderContent(); toast(`Đã cập nhật phiếu thu ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "new-expense") voucherForm(state, "expense");
  else if (action === "edit-expense") {
    const voucher = state.PhieuChi.find((row) => row.PC_Ma === id);
    if (voucher) voucherForm(state, "expense", voucher);
  } else if (action === "confirm-expense" || action === "cancel-expense") {
    const next = action === "confirm-expense" ? "Đã xác nhận" : "Đã hủy";
    if (!confirm(`${next} phiếu chi ${id}?`)) return;
    try { setExpenseVoucherStatus(id, next, role()); renderContent(); toast(`Đã cập nhật phiếu chi ${id}.`); }
    catch (error) { toast(error.message, true); }
  }
}

function handleSubmit(event) {
  const form = event.target;
  const shiftFormIds = ["cash-shift-request-form", "cash-shift-reconcile-form", "cash-shift-handover-form"];
  if (!["supplier-debt-form", "supplier-payment-form", "receipt-form", "expense-form", ...shiftFormIds].includes(form.id)) return;
  event.preventDefault();
  const submit = form.querySelector('[type="submit"]');
  if (submit?.disabled) return;
  if (submit) submit.disabled = true;
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.id === "cash-shift-request-form") {
      requestCashShiftExplanation(form.dataset.id, values.note, role(), roleEmployees[role()]);
      closeModal();
      renderContent();
      toast(`Đã gửi yêu cầu giải trình ca ${form.dataset.id}.`);
    } else if (form.id === "cash-shift-reconcile-form") {
      reconcileCashShift(form.dataset.id, role(), roleEmployees[role()], values.note);
      closeModal();
      renderContent();
      toast(`Đã đối soát ca ${form.dataset.id}.`);
    } else if (form.id === "cash-shift-handover-form") {
      confirmCashHandover(form.dataset.id, values, role(), roleEmployees[role()]);
      closeModal();
      renderContent();
      toast(`Đã xác nhận bàn giao ca ${form.dataset.id}.`);
    } else if (form.id === "supplier-debt-form") {
      const debtId = createSupplierDebtFromReceipt(values.PN_Ma, role());
      closeModal();
      renderContent();
      toast(`Đã ghi nhận khoản nợ ${debtId}.`);
    } else if (form.id === "supplier-payment-form") {
      const paymentId = recordSupplierPayment(values.CTNNCC_Ma, values, role());
      closeModal();
      renderContent();
      toast(`Đã ghi giao dịch ${paymentId} · ${values.method === "Tiền mặt" ? "Thành công" : "Chờ xác nhận"}.`);
    } else if (form.id === "receipt-form") {
      const voucherId = saveReceiptVoucher({ ...values, PT_Ma: form.dataset.id }, role());
      closeModal();
      renderContent();
      toast(`Đã lưu phiếu thu nháp ${voucherId}.`);
    } else {
      const voucherId = saveExpenseVoucher({ ...values, PC_Ma: form.dataset.id }, role());
      closeModal();
      renderContent();
      toast(`Đã lưu phiếu chi nháp ${voucherId}.`);
    }
  } catch (error) {
    if (submit) submit.disabled = false;
    const selector = {
      "cash-shift-request-form": "#cash-shift-action-error",
      "cash-shift-reconcile-form": "#cash-shift-action-error",
      "cash-shift-handover-form": "#cash-shift-action-error",
      "supplier-debt-form": "#supplier-debt-error",
      "supplier-payment-form": "#supplier-payment-error",
      "receipt-form": "#receipt-form-error",
      "expense-form": "#expense-form-error"
    }[form.id];
    showFormError(selector, error.message || "Không thể lưu dữ liệu.");
  }
}

function handleInput(event) {
  if (event.target.matches(".list-filter")) {
    tablePages.clear();
    applyFilters();
  }
}

function handleChange(event) {
  const target = event.target;
  if (target.matches("[data-cashbook-filter]")) {
    cashbookFilters[target.dataset.cashbookFilter] = target.value;
    renderContent();
  } else if (target.id === "accounting-role") {
    const currentRole = role();
    const activeShift = getOpenCashShift(roleEmployees[currentRole]);
    if (activeShift && roleEmployees[target.value] !== roleEmployees[currentRole]
      && !confirm(`Ca ${activeShift.Ca_Ma} vẫn đang mở. Ca sẽ được giữ nguyên và bạn cần quay lại đúng nhân viên để kết ca. Tiếp tục đổi vai trò?`)) {
      target.value = currentRole;
      return;
    }
    localStorage.setItem("stmn-kho-demo-role", target.value);
    document.querySelector(".user-role").textContent = employeeName(getState(), roleEmployees[target.value]);
    renderContent();
  } else if (target.id === "accounting-location") {
    localStorage.setItem("stmn-kho-demo-location", target.value);
    if (page === "accounting-overview" || page === "revenue-reconciliation") renderContent();
  } else if (target.id === "supplier-detail-select") {
    selectedSupplier = target.value;
    renderContent();
  } else if (target.id === "payment-supplier") updateSupplierDebtForm(getState(), target.value);
  else if (target.id === "payment-debt") updateSelectedDebtDetails(getState(), target.value);
  else if (target.id === "accounting-from") {
    dateFrom = target.value;
    renderContent();
  } else if (target.id === "accounting-to") {
    dateTo = target.value;
    renderContent();
  } else if (target.id === "reconcile-from") {
    dateFrom = target.value;
    renderContent();
  } else if (target.id === "reconcile-to") {
    dateTo = target.value;
    renderContent();
  } else if (target.matches(".list-filter")) {
    tablePages.clear();
    applyFilters();
  }
}

document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleChange);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

try { shell(); }
catch (error) {
  document.querySelector("#app").innerHTML = `<main class="content"><div class="warning-box">Không thể tải phân hệ kế toán: ${esc(error.message || "Lỗi không xác định.")}</div></main>`;
}
