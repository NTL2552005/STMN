import { getAccountingDashboard, getAccountingReports } from "../../services/accounting-service.js";
import { getState } from "../../services/kho-service.js";
import { validatePartnerData } from "../../services/customer-service.js";
import {
  approveManagerCount, endPrice, getManagerOverview, getManagerReports, getManagerTasks,
  getProductStockSummary, hasProductUnitHistory, saveAccount, saveCategory, saveEmployee, savePartner, savePrice, saveProduct
} from "../../services/manager-service.js";
import { getAvailableStock } from "../../services/inventory-service.js";
import { cancelPurchaseOrder, confirmPurchaseOrder, getPurchaseOrderSummary, savePurchaseOrder } from "../../services/purchase-order-service.js";
import { getPurchaseOrderReceiptSummary, PURCHASE_ORDER_STATUSES } from "../../services/purchase-order-utils.js";
import {
  approveSupplierReturn, getSupplierReturns, rejectSupplierReturn
} from "../../services/supplier-return-service.js";
import { calculateCashShift, getCashShift, getCashShifts } from "../../services/cash-register-service.js";
import { formatBaseQuantity, getUnitPackage, toBaseQuantity, toBaseUnitPrice } from "../../services/unit-service.js";
import { escapeHtml as esc, formatCurrency, formatDate, formatNumber } from "../../utils/formatters.js";

const page = document.body.dataset.page || "overview";
const ownerRole = "Chủ cửa hàng";
const role = localStorage.getItem("stmn-kho-demo-role") || ownerRole;
const pages = [
  { group: "TỔNG QUAN", items: [["overview", "Tổng quan điều hành", "/pages/chu-cua-hang/tong-quan.html", "▦"], ["tasks", "Công việc cần xử lý", "/pages/chu-cua-hang/cong-viec-can-xu-ly.html", "✓"]] },
  { group: "HỆ THỐNG & DANH MỤC", items: [["employees", "Nhân viên", "/pages/he-thong/nhan-vien.html", "♙"], ["accounts", "Tài khoản", "/pages/he-thong/tai-khoan.html", "▣"], ["roles", "Vai trò", "/pages/he-thong/vai-tro.html", "◇"], ["categories", "Danh mục", "/pages/hang-hoa/danh-muc.html", "▤"], ["products", "Hàng hóa", "/pages/hang-hoa/hang-hoa.html", "◫"], ["orders", "Đơn đặt hàng", "/pages/chu-cua-hang/don-dat-hang.html", "🛒"], ["prices", "Giá bán", "/pages/hang-hoa/gia-ban.html", "＄"], ["partners", "Đối tác kinh doanh", "/pages/hang-hoa/doi-tac.html", "♧"]] },
  { group: "GIÁM SÁT VẬN HÀNH", items: [["receipts", "Phiếu nhập kho", "/pages/kho/phieu-nhap.html", "⇩"], ["operations", "Tồn kho & chuyển hàng", "/pages/kho/ton-kho.html", "⇄"], ["supplier-returns", "Trả hàng NCC", "/pages/chu-cua-hang/tra-hang-ncc.html", "↩"], ["counts", "Duyệt kiểm kê", "/pages/kho/kiem-ke-kho.html", "✓"], ["sales", "Hóa đơn bán hàng", "/pages/ban-hang-ke-toan/hoa-don.html", "▧"]] },
  { group: "TÀI CHÍNH & BÁO CÁO", items: [["finance", "Công nợ & thu chi", "/pages/ban-hang-ke-toan/tong-quan-ke-toan.html", "＄"], ["reports", "Báo cáo tổng hợp", "/pages/chu-cua-hang/bao-cao-tong-hop.html", "▥"]] }
];
const title = pages.flatMap((group) => group.items).find(([key]) => key === page)?.[1] || "Quản lý cửa hàng";
let reportTab = "revenue";
let overviewFilters = {};
let reportFilters = {};
let orderFilters = { search: "", status: "", from: "", to: "" };
let orderPage = 1;
const orderPageSize = 15;

const locationName = (state, id) => state.DiaDiem.find((row) => row.DD_Ma === id)?.DD_Ten || id || "—";
const employeeName = (state, id) => state.NhanVien.find((row) => row.NV_Ma === id)?.NV_Ten || id || "—";
const productName = (state, id) => state.HangHoa.find((row) => row.HH_Ma === id)?.HH_Ten || id || "—";
const categoryName = (state, id) => state.DanhMuc.find((row) => row.DM_Ma === id)?.DM_Ten || id || "—";
const partnerName = (state, id) => state.DoiTacKinhDoanh.find((row) => row.DT_Ma === id)?.DT_Ten || id || "—";
const today = () => new Date().toISOString().slice(0, 10);

function shell() {
  const nav = pages.map(({ group, items }) => `<section class="manager-nav-group"><div class="nav-label">${group}</div>${items.map(([key, label, href, icon]) =>
    `<a class="nav-link ${key === page ? "active" : ""}" href="${href}"><span class="nav-icon">${icon}</span><span>${label}</span></a>`).join("")}</section>`).join("");
  document.querySelector("#app").innerHTML = `<div class="app-shell">
    <aside class="sidebar"><a class="brand" href="/pages/chu-cua-hang/tong-quan.html"><span class="brand-mark">S</span><div><strong>Siêu thị mini</strong><small>Điều hành cửa hàng</small></div></a>
      ${nav}<div class="sidebar-bottom">Dữ liệu dùng chung Kho · Bán hàng · Kế toán<br>Bản mô phỏng frontend · không có Backend</div></aside>
    <main class="main-area"><header class="topbar"><div><div class="topbar-title">${esc(title)}</div><div class="topbar-subtitle">Chủ cửa hàng · Quản lý và giám sát vận hành</div></div>
      <div class="topbar-actions"><span class="badge badge-blue">${esc(ownerRole)}</span><span class="user-role">${esc(employeeName(getState(), getState().NhanVien[0]?.NV_Ma))}</span></div></header>
      <section class="content" id="page-content"></section></main></div><div id="modal-host"></div><div id="toast-host" aria-live="polite"></div>`;
  if (role !== ownerRole) {
    document.querySelector("#page-content").innerHTML = `<div class="info-box info-warning"><strong>Không có quyền truy cập.</strong><br>Trang quản lý chỉ hiển thị cho vai trò Chủ cửa hàng trong mô phỏng giao diện. Vai trò lưu trong trình duyệt, không phải xác thực Backend.</div><a class="button" href="../kho/tong-quan-kho.html">Quay lại phân hệ Kho</a>`;
    return;
  }
  render();
  bindEvents();
}

function heading(titleText, description, actions = "") {
  return `<div class="page-heading"><div><h1>${esc(titleText)}</h1><p>${esc(description)}</p></div><div class="heading-actions">${actions}</div></div>`;
}

function metric(label, value, note = "") {
  return `<div class="metric-card"><div class="metric-title">${esc(label)}</div><div class="metric-value">${value}</div>${note ? `<div class="metric-caption">${esc(note)}</div>` : ""}</div>`;
}

function tableCard(titleText, subtitle, headers, rows, note = "") {
  return `<div class="table-card"><div class="table-toolbar"><strong>${esc(titleText)}</strong><span>${esc(subtitle)}</span></div><div class="table-wrap"><table><thead><tr>${headers.map((item) => `<th>${item}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state">Không có dữ liệu phù hợp.</td></tr>`}</tbody></table></div>${note ? `<div class="table-subnote">${note}</div>` : ""}</div>`;
}

function statusBadge(value) {
  const tone = ["Đang làm", "Hoạt động", "Đang kinh doanh", "Đã xác nhận", "Đã duyệt", "Đang áp dụng", "Đã đối soát", "Đã bàn giao"].includes(value) ? "green"
    : ["Chờ duyệt", "Trả hàng NCC chờ duyệt", "Chờ giao", "Đang giao", "Đang chuyển", "Chờ xuất", "Chờ kế toán xác nhận", "Đã nhận một phần", "Chờ đối soát"].includes(value) ? "amber"
      : ["Nháp", "Nghỉ việc", "Khóa", "Ngừng hoạt động", "Ngừng kinh doanh", "Đã hủy", "Ngừng áp dụng"].includes(value) ? "gray"
        : ["Chờ đối chiếu", "Cần đối chiếu", "Cần giải trình", "Từ chối"].includes(value) ? "red" : "blue";
  return `<span class="badge badge-${tone}">${esc(value || "—")}</span>`;
}

function actionButton(action, label, id = "", variant = "") {
  return `<button class="button button-small ${variant}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
}

function renderOverview() {
  const state = getState();
  const overview = getManagerOverview(overviewFilters, state);
  const report = getAccountingReports(state);
  const trend = overview.revenueByDay.slice(-14);
  const max = Math.max(1, ...trend.map((row) => row.revenue));
  const chart = trend.length ? trend.map((row) => `<div class="chart-column" title="${esc(formatDate(row.date))}: ${esc(formatCurrency(row.revenue))}"><div class="chart-bar" style="height:${Math.max(5, Math.round(row.revenue / max * 100))}%"></div><small>${esc(row.date.slice(5))}</small></div>`).join("") : `<div class="empty-state">Chưa có hóa đơn đã xác nhận trong kỳ.</div>`;
  const sellerRows = overview.bestSellers.slice(0, 5).map((row) => `<tr><td>${esc(productName(state, row.HH_Ma))}</td><td>${formatNumber(row.quantity)}</td><td>${formatCurrency(row.revenue)}</td></tr>`).join("");
  const warehouse = state.DiaDiem.find((row) => row.DD_Loai === "Kho" && row.DD_TrangThai === "Hoạt động");
  const outRows = overview.outOfStock.slice(0, 6).map(({ item, store, status }) => {
    const warehouseQty = warehouse ? getAvailableStock(warehouse.DD_Ma, item.HH_Ma, state) : 0;
    const transferHref = warehouseQty > 0 ? `../kho/xuat-chuyen-noi-bo.html?create=1&source=${encodeURIComponent(warehouse.DD_Ma)}&destination=${encodeURIComponent(store.DD_Ma)}&product=${encodeURIComponent(item.HH_Ma)}` : "";
    return `<tr><td>${esc(item.HH_Ten)}</td><td>${esc(store.DD_Ten)}</td><td>${statusBadge(status)}</td><td><a class="text-link" href="/pages/kho/ton-kho.html">Xem tồn →</a>${transferHref ? ` <a class="button button-small" href="${transferHref}">Lập phiếu chuyển</a>` : ""}</td></tr>`;
  }).join("");
  const tasks = overview.tasks.slice(0, 6).map((task) => `<div class="task-item"><div><strong>${esc(task.label)}</strong><small>${esc(task.type)}${task.amount ? ` · ${formatCurrency(task.amount)}` : ""}</small></div><a class="text-link" href="${task.href}">Xem →</a></div>`).join("") || `<div class="empty-state">Không có công việc cần xử lý.</div>`;
  const debtSuppliers = report.debtDetails.slice(0, 5).map(({ debt, due }) => `<tr><td>${esc(partnerName(state, state.CongNoNCC.find((row) => row.CNNCC_Ma === debt.CNNCC_Ma)?.DT_Ma))}</td><td>${esc(debt.PN_Ma)}</td><td class="negative">${formatCurrency(due)}</td></tr>`).join("");
  const debtCustomers = report.customerDebts.slice(0, 5).map(({ invoice, due }) => `<tr><td>${esc(partnerName(state, invoice.DT_Ma))}</td><td>${esc(invoice.BH_Ma)}</td><td class="negative">${formatCurrency(due)}</td></tr>`).join("");
  return `${heading("Tổng quan điều hành", "Chỉ số tính từ dữ liệu nghiệp vụ dùng chung. Số dư công nợ và giá trị tồn là hiện tại; doanh thu và tiền thu theo kỳ đang chọn.", `<a class="button button-primary" href="/pages/chu-cua-hang/bao-cao-tong-hop.html">Mở báo cáo tổng hợp</a>`)}
    <div class="filters"><div class="field"><label>Từ ngày</label><input type="date" id="overview-from" value="${esc(overviewFilters.from || "")}"></div><div class="field"><label>Đến ngày</label><input type="date" id="overview-to" value="${esc(overviewFilters.to || "")}"></div><div class="field"><label>Địa điểm</label><select id="overview-location"><option value="">Toàn hệ thống</option>${state.DiaDiem.map((row) => `<option value="${esc(row.DD_Ma)}" ${overviewFilters.location === row.DD_Ma ? "selected" : ""}>${esc(row.DD_Ten)}</option>`).join("")}</select></div><button class="button button-primary" data-action="filter-overview">Áp dụng</button></div>
    <div class="metric-grid">${metric("Doanh thu hóa đơn xác nhận", formatCurrency(overview.revenue), "Không đồng nhất với tiền đã thu")}${metric("Tiền bán hàng đã thu hợp lệ", formatCurrency(overview.salesCollected))}${metric("Số hóa đơn", formatNumber(overview.invoiceCount))}${metric("Phải thu khách hàng", formatCurrency(overview.receivableBalance), "Số dư hiện tại")}${metric("Phải trả nhà cung cấp", formatCurrency(overview.payableBalance), "Số dư hiện tại")}${metric("Giá trị tồn theo giá nhập", formatCurrency(overview.inventoryValue), "Không phải giá vốn hàng bán")}${metric("Mặt hàng hết tại cửa hàng", formatNumber(overview.outOfStockCount), "Mỗi mặt hàng đếm một lần")}${metric("Dòng hàng sắp/đã hết hạn", formatNumber(overview.expiryCount))}${metric("Kiểm kê chờ duyệt", formatNumber(overview.pendingCounts))}${metric("Phiếu chuyển chưa hoàn tất", formatNumber(overview.activeTransfers))}</div>
    <div class="dashboard-grid"><div class="panel"><div class="panel-title">Doanh thu theo ngày <span class="muted">Hóa đơn đã xác nhận</span></div><div class="manager-chart">${chart}</div></div>${tableCard("Mặt hàng bán nhiều", "Theo số lượng từ hóa đơn hợp lệ", ["Mặt hàng", "Số lượng", "Doanh thu"], sellerRows)}</div>
    <div class="dashboard-grid">${tableCard("Hết hàng hoặc sắp hết tại cửa hàng", `${overview.outOfStockCount} dòng cần theo dõi`, ["Mặt hàng", "Địa điểm", "Trạng thái", "Điều hướng"], outRows, "Không tự động điều chuyển hoặc trừ tồn.")}<div class="panel"><div class="panel-title">Công việc đang chờ xử lý <a class="text-link" href="/pages/chu-cua-hang/cong-viec-can-xu-ly.html">Tất cả →</a></div><div class="task-list">${tasks}</div></div></div>
    <div class="dashboard-grid">${tableCard("Công nợ NCC còn lại", "Không hiển thị tuổi nợ/quá hạn", ["Nhà cung cấp", "Phiếu nhập", "Còn phải trả"], debtSuppliers)}${tableCard("Công nợ khách hàng", "Khoản phải thu theo hóa đơn", ["Khách hàng", "Hóa đơn", "Còn phải thu"], debtCustomers)}</div>
    ${overview.anomalies.length || overview.paymentAlerts.length ? `<div class="info-box info-warning">Có ${overview.anomalies.length} hóa đơn và ${overview.paymentAlerts.length} cảnh báo thanh toán cần kiểm tra. <a class="text-link" href="../ban-hang-ke-toan/doi-soat-doanh-thu.html">Đối soát doanh thu</a> · <a class="text-link" href="../ban-hang-ke-toan/doi-soat-thanh-toan.html">Đối soát thanh toán →</a></div>` : `<div class="info-box">Không phát hiện bất thường trong dữ liệu đối soát hóa đơn/thanh toán hiện có.</div>`}
    <div class="manager-footnote">Lợi nhuận gộp sơ bộ hiện tại: ${formatCurrency(report.grossProfit)} · Doanh thu trừ giá vốn; không phải lợi nhuận ròng.</div>`;
}

function renderTasks() {
  const state = getState();
  const tasks = getManagerTasks(state);
  const rows = tasks.map((task) => `<tr><td>${statusBadge(task.type)}</td><td class="cell-primary">${esc(task.label)}</td><td>${esc(task.id || "—")}</td><td>${task.amount ? formatCurrency(task.amount) : "—"}</td><td><a class="button button-small" href="${task.href}">Xem chi tiết</a>${task.type === "Kiểm kê chờ duyệt" ? ` ${actionButton("approve-count", "Duyệt", task.id)}` : ""}${task.type === "Trả hàng NCC chờ duyệt" ? ` ${actionButton("approve-supplier-return", "Duyệt", task.id, "button-primary")} ${actionButton("reject-supplier-return", "Từ chối", task.id, "button-danger")}` : ""}</td></tr>`).join("");
  return `${heading("Công việc cần xử lý", "Tổng hợp từ phiếu nghiệp vụ hiện có; không tạo bảng công việc và không suy luận nợ quá hạn.")}${tableCard("Danh sách cần quan tâm", `${tasks.length} mục`, ["Nhóm", "Nội dung", "Mã tham chiếu", "Số tiền", "Thao tác"], rows)}
    <div class="info-box">Duyệt trả NCC chỉ đổi trạng thái phiếu; tồn chỉ giảm khi nhân viên kho xác nhận xuất trả.</div>`;
}

function renderSupplierReturns() {
  const state = getState();
  const returns = getSupplierReturns(state).slice().sort((left, right) => String(right.TRNCC_Ngay).localeCompare(String(left.TRNCC_Ngay)));
  const pendingCount = returns.filter((doc) => doc.TRNCC_TrangThai === "Chờ duyệt").length;
  const rows = returns.map((doc) => {
    const supplier = partnerName(state, doc.DT_Ma);
    const actions = doc.TRNCC_TrangThai === "Chờ duyệt"
      ? `${actionButton("approve-supplier-return", "Duyệt", doc.TRNCC_Ma, "button-primary")} ${actionButton("reject-supplier-return", "Từ chối", doc.TRNCC_Ma, "button-danger")}`
      : "";
    return `<tr><td class="cell-primary">${esc(doc.TRNCC_Ma)}</td><td>${formatDate(doc.TRNCC_Ngay)}</td><td>${esc(supplier)}</td><td>${esc(doc.PN_Ma)}</td><td>${esc(locationName(state, doc.DD_Ma))}</td><td>${formatNumber(doc.TRNCC_TongSL)}</td><td>${formatCurrency(doc.TRNCC_TongTien)}</td><td>${statusBadge(doc.TRNCC_TrangThai)}</td><td>${actionButton("view-supplier-return", "Chi tiết", doc.TRNCC_Ma)} ${actions}</td></tr>`;
  }).join("");
  return `${heading("Trả hàng nhà cung cấp", "Duyệt hoặc từ chối yêu cầu trả. Duyệt không tự giảm tồn.", `<a class="button" href="/pages/kho/tra-hang-ncc.html">Mở phân hệ Kho</a>`)}
    <div class="metric-grid">${metric("Tổng phiếu trả", formatNumber(returns.length))}${metric("Chờ duyệt", formatNumber(pendingCount))}${metric("Đã xuất trả", formatNumber(returns.filter((doc) => doc.TRNCC_TrangThai === "Đã xuất trả").length))}${metric("Giá trị chờ duyệt", formatCurrency(returns.filter((doc) => doc.TRNCC_TrangThai === "Chờ duyệt").reduce((sum, doc) => sum + doc.TRNCC_TongTien, 0)))}</div>
    ${tableCard("Yêu cầu và lịch sử trả NCC", `${returns.length} phiếu`, ["Mã phiếu", "Ngày lập", "Nhà cung cấp", "Phiếu nhập", "Địa điểm", "Số lượng", "Giá trị theo dõi", "Trạng thái", "Thao tác"], rows)}
    <div class="info-box">Phiếu trả lưu trong collection demo/localStorage, không thuộc 27 bảng SQL. Đối chiếu công nợ NCC vẫn thực hiện thủ công; không tự ghi giảm công nợ.</div>`;
}

function viewSupplierReturn(returnId) {
  const state = getState();
  const doc = getSupplierReturns(state).find((row) => row.TRNCC_Ma === returnId);
  if (!doc) {
    toast("Không tìm thấy phiếu trả NCC.", true);
    return;
  }
  const supplier = partnerName(state, doc.DT_Ma);
  const lines = (doc.chiTiet || []).map((line) => {
    const item = state.HangHoa.find((row) => row.HH_Ma === line.HH_Ma);
    return `<tr><td>${esc(line.PNCT_Ma)}</td><td>${esc(item?.HH_Ma || line.HH_Ma)} · ${esc(item?.HH_Ten || "Không rõ mặt hàng")}</td><td>${formatNumber(line.TRNCC_SL)} ${esc(item?.HH_DVi || "")}</td><td>${esc(line.TRNCC_LyDoChiTiet || doc.TRNCC_LyDo)}</td><td>${formatCurrency(line.TRNCC_DonGia)}</td><td>${formatCurrency(line.TRNCC_TTien)}</td></tr>`;
  }).join("");
  const body = `<div class="form-grid two">
      <div><strong>Nhà cung cấp</strong><div>${esc(supplier)}</div></div>
      <div><strong>Phiếu nhập gốc</strong><div>${esc(doc.PN_Ma)}</div></div>
      <div><strong>Địa điểm xuất trả</strong><div>${esc(locationName(state, doc.DD_Ma))}</div></div>
      <div><strong>Ngày lập · trạng thái</strong><div>${formatDate(doc.TRNCC_Ngay)} · ${statusBadge(doc.TRNCC_TrangThai)}</div></div>
      <div><strong>Lý do trả</strong><div>${esc(doc.TRNCC_LyDo)}</div></div>
      <div><strong>Ghi chú</strong><div>${esc(doc.TRNCC_GhiChu || "—")}</div></div>
    </div>
    ${tableCard("Chi tiết mặt hàng", `${formatNumber(doc.TRNCC_TongSL)} đơn vị · ${formatCurrency(doc.TRNCC_TongTien)}`, ["Mã dòng nhập", "Sản phẩm", "Số lượng", "Lý do trả", "Đơn giá nhập", "Giá trị theo dõi"], lines || `<tr><td colspan="6">Phiếu chưa có dòng hàng.</td></tr>`)}
    <div class="info-box">Giá trị chỉ phục vụ theo dõi theo đơn giá nhập gốc; phiếu trả không tự động điều chỉnh công nợ NCC.</div>`;
  const actions = doc.TRNCC_TrangThai === "Chờ duyệt"
    ? `${actionButton("close-modal", "Đóng", "")} ${actionButton("reject-supplier-return", "Từ chối", returnId, "button-danger")} ${actionButton("approve-supplier-return", "Duyệt", returnId, "button-primary")}`
    : `<button class="button" data-action="close-modal">Đóng</button>`;
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal modal-wide manager-modal">
    <div class="modal-header"><h2>Chi tiết phiếu trả ${esc(returnId)}</h2><button type="button" class="button button-small" data-action="close-modal">Đóng</button></div>
    <div class="modal-body">${body}</div><div class="modal-footer">${actions}</div></section></div>`;
}

function renderEmployees() {
  const state = getState();
  const rows = state.NhanVien.map((row) => `<tr data-search-row><td>${esc(row.NV_Ma)}</td><td class="cell-primary">${esc(row.NV_Ten)}</td><td>${esc(row.NV_SDT || "—")}</td><td>${formatDate(row.NV_NgayVaoLam)}</td><td>${statusBadge(row.NV_TrangThai)}</td><td>${actionButton("edit-employee", "Xem / sửa", row.NV_Ma)}</td></tr>`).join("");
  return `${heading("Quản lý nhân viên", "Cập nhật hồ sơ và trạng thái; không xóa nhân viên đã liên quan chứng từ.", actionButton("new-employee", "＋ Thêm nhân viên"))}<div class="filters"><div class="field grow"><label>Tìm kiếm</label><input data-table-search placeholder="Tên, mã, số điện thoại"></div><div class="field"><label>Trạng thái</label><select data-table-filter><option value="">Tất cả</option><option>Đang làm</option><option>Nghỉ việc</option></select></div></div>${tableCard("Danh sách nhân viên", `${state.NhanVien.length} nhân viên`, ["Mã", "Họ tên", "Số điện thoại", "Ngày vào làm", "Trạng thái", "Thao tác"], rows)}`;
}

function renderAccounts() {
  const state = getState();
  const rows = state.TaiKhoan.map((account) => `<tr data-search-row><td>${esc(account.TK_TenDangNhap)}</td><td>${esc(employeeName(state, account.NV_Ma))}</td><td>${esc(state.VaiTro.find((row) => row.VT_Ma === account.VT_Ma)?.VT_Ten || "—")}</td><td>${statusBadge(account.TK_TrangThai)}</td><td>${actionButton("edit-account", "Sửa vai trò", account.TK_Ma)} ${actionButton("toggle-account", account.TK_TrangThai === "Khóa" ? "Mở khóa" : "Khóa", account.TK_Ma)}</td></tr>`).join("");
  return `${heading("Quản lý tài khoản", "Mô phỏng quản trị giao diện. Mật khẩu không lưu dạng rõ; không có Backend xác thực.", actionButton("new-account", "＋ Tạo tài khoản"))}<div class="filters"><div class="field grow"><label>Tìm kiếm</label><input data-table-search placeholder="Tên đăng nhập hoặc nhân viên"></div><div class="field"><label>Trạng thái</label><select data-table-filter><option value="">Tất cả</option><option>Hoạt động</option><option>Khóa</option></select></div></div>${tableCard("Tài khoản", `${state.TaiKhoan.length} tài khoản`, ["Tên đăng nhập", "Nhân viên", "Vai trò", "Trạng thái", "Thao tác"], rows)}<div class="info-box">Giá trị TK_MatKhau được lưu là chuỗi xác minh PBKDF2 có salt; đây không thay thế hệ thống xác thực Backend.</div>`;
}

function renderRoles() {
  const state = getState();
  const rows = state.VaiTro.map((row) => `<tr><td>${esc(row.VT_Ma)}</td><td class="cell-primary">${esc(row.VT_Ten)}</td><td>${esc(row.VT_MoTa || "")}</td><td>${formatNumber(state.TaiKhoan.filter((account) => account.VT_Ma === row.VT_Ma).length)}</td></tr>`).join("");
  return `${heading("Vai trò hệ thống", "Danh mục vai trò cố định theo dữ liệu hiện có; không tạo quyền chi tiết tùy biến.")}${tableCard("Các vai trò", `${state.VaiTro.length} vai trò`, ["Mã vai trò", "Tên vai trò", "Mô tả", "Tài khoản đang gán"], rows)}<div class="info-box">Đổi vai trò tài khoản chỉ chủ cửa hàng thao tác trong mô phỏng. Ẩn giao diện không phải cơ chế bảo mật Backend.</div>`;
}

function renderCategories() {
  const state = getState();
  const rows = state.DanhMuc.map((row) => `<tr data-search-row><td>${esc(row.DM_Ma)}</td><td class="cell-primary">${esc(row.DM_Ten)}</td><td>${esc(row.DM_MoTa || "—")}</td><td>${formatNumber(state.HangHoa.filter((item) => item.DM_Ma === row.DM_Ma).length)}</td><td>${actionButton("edit-category", "Sửa", row.DM_Ma)}</td></tr>`).join("");
  return `${heading("Danh mục hàng hóa", "Quản lý danh mục dùng chung; không xóa vật lý danh mục đã tham chiếu.", actionButton("new-category", "＋ Thêm danh mục"))}<div class="filters"><div class="field grow"><label>Tìm kiếm</label><input data-table-search placeholder="Tên danh mục"></div></div>${tableCard("Danh mục", `${state.DanhMuc.length} danh mục`, ["Mã", "Tên danh mục", "Mô tả", "Số mặt hàng", "Thao tác"], rows)}`;
}

function renderProducts() {
  const state = getState();
  const products = getProductStockSummary(state);
  const rows = products.map(({ item, totalStock, currentPrice, stockByLocation }) => {
    const pack = getUnitPackage(item);
    const conversion = pack ? `1 ${pack.name} = ${formatNumber(pack.ratio)} ${item.HH_DVi}` : "Không quy đổi";
    return `<tr data-search-row data-category="${esc(item.DM_Ma)}"><td>${esc(item.HH_Ma)}</td><td>${esc(item.HH_MaVach || "—")}</td><td class="cell-primary">${esc(item.HH_Ten)}</td><td>${esc(categoryName(state, item.DM_Ma))}</td><td>${esc(item.HH_DVi)}</td><td>${esc(conversion)}</td><td>${esc(formatBaseQuantity(totalStock, item))}</td><td>${esc(stockByLocation.map((entry) => `${entry.location.DD_Ten}: ${formatBaseQuantity(entry.physical, item)}`).join(" · ") || "Không có tồn")}</td><td>${currentPrice === null ? "Chưa có giá" : formatCurrency(currentPrice)}</td><td>${statusBadge(item.HH_TrangThai)}</td><td>${actionButton("edit-product", "Sửa", item.HH_Ma)}</td></tr>`;
  }).join("");
  return `${heading("Quản lý hàng hóa", "Thông tin hàng hóa và tồn lấy từ nguồn dùng chung; không chỉnh số lượng tồn tại đây.", actionButton("new-product", "＋ Thêm hàng hóa"))}<div class="filters"><div class="field grow"><label>Tìm theo mã hàng, tên hoặc mã vạch</label><input data-table-search placeholder="HH001, Coca-Cola, 012345…"></div><div class="field"><label>Danh mục</label><select data-table-filter><option value="">Tất cả danh mục</option>${state.DanhMuc.map((row) => `<option value="${esc(row.DM_Ma)}">${esc(row.DM_Ten)}</option>`).join("")}</select></div></div>${tableCard("Danh sách hàng hóa", `${products.length} mặt hàng`, ["Mã", "Mã vạch", "Hàng hóa", "Danh mục", "Đơn vị cơ bản", "Quy đổi đơn vị", "Tổng tồn", "Tồn theo địa điểm", "Giá hiện hành", "Trạng thái", "Thao tác"], rows)}`;
}

function renderPrices() {
  const state = getState();
  const rows = state.GiaBan.map((price) => `<tr data-search-row><td>${esc(price.GB_Ma)}</td><td>${esc(productName(state, price.HH_Ma))}</td><td class="money">${formatCurrency(price.GB_DonGia)}</td><td>${formatDate(price.GB_NgayBD)}</td><td>${price.GB_NgayKT ? formatDate(price.GB_NgayKT) : "Không giới hạn"}</td><td>${statusBadge(price.GB_TrangThai)}</td><td>${actionButton("edit-price", "Chỉnh sửa", price.GB_Ma)} ${actionButton("end-price", "Kết thúc", price.GB_Ma)}</td></tr>`).join("");
  return `${heading("Quản lý giá bán", "Lịch sử giá không sửa đơn giá của hóa đơn đã xác nhận. Khoảng giá hiệu lực cùng mặt hàng không được chồng lấn.", actionButton("new-price", "＋ Tạo mức giá"))}<div class="filters"><div class="field grow"><label>Tìm kiếm</label><input data-table-search placeholder="Mã hoặc tên hàng"></div></div>${tableCard("Bảng giá và lịch sử", `${state.GiaBan.length} mức giá`, ["Mã", "Mặt hàng", "Đơn giá", "Ngày bắt đầu", "Ngày kết thúc", "Trạng thái", "Thao tác"], rows)}<div class="info-box">POS chỉ lấy mức giá hiệu lực tại ngày bán và từ chối nếu không có đúng một mức giá hợp lệ.</div>`;
}

function partnerDebt(state, id) {
  const receivable = state.HoaDonBanHang.filter((row) => row.DT_Ma === id && row.BH_TrangThai === "Đã xác nhận")
    .reduce((sum, invoice) => sum + Math.max(0, invoice.BH_TongCong - state.ThanhToanBanHang.filter((payment) => payment.BH_Ma === invoice.BH_Ma && payment.TTBH_TrangThai === "Thành công").reduce((total, payment) => total + payment.TTBH_SoTien, 0)), 0);
  const credit = getAccountingDashboard({}, state).payables.find((row) => row.creditor.DT_Ma === id);
  return { receivable, payable: credit?.due || 0 };
}

function renderPartners() {
  const state = getState();
  const rows = state.DoiTacKinhDoanh.map((row) => {
    const debt = partnerDebt(state, row.DT_Ma);
    return `<tr data-search-row data-type="${esc(row.DT_Loai)}"><td>${esc(row.DT_Ma)}</td><td class="cell-primary">${esc(row.DT_Ten)}</td><td>${esc(row.DT_SDT || "—")}</td><td>${esc(row.DT_Loai)}</td><td>${statusBadge(row.DT_TrangThai)}</td><td>${debt.receivable ? formatCurrency(debt.receivable) : "—"}${debt.payable ? ` · Phải trả ${formatCurrency(debt.payable)}` : ""}</td><td>${actionButton("edit-partner", "Sửa", row.DT_Ma)} ${actionButton("view-partner", "Lịch sử", row.DT_Ma)}</td></tr>`;
  }).join("");
  return `${heading("Đối tác kinh doanh", "Một đối tác chỉ thuộc một loại: khách hàng hoặc nhà cung cấp.", actionButton("new-partner", "＋ Thêm đối tác"))}<div class="filters"><div class="field grow"><label>Tìm kiếm</label><input data-table-search placeholder="Tên, mã, điện thoại"></div><div class="field"><label>Loại đối tác</label><select data-table-filter><option value="">Tất cả</option><option>Khách hàng</option><option>Nhà cung cấp</option></select></div></div>${tableCard("Danh sách đối tác", `${state.DoiTacKinhDoanh.length} đối tác`, ["Mã", "Tên", "Điện thoại", "Loại", "Trạng thái", "Công nợ hiện tại", "Thao tác"], rows)}`;
}

function renderOrders() {
  const state = getState();
  const summaries = getPurchaseOrderSummary(state);
  const byStatus = (status) => summaries.filter((summary) => summary.status === status);
  const rows = summaries.filter(({ order, status }) => {
    const searchable = `${order.DH_Ma} ${partnerName(state, order.DT_Ma)} ${employeeName(state, order.NV_Ma)}`.toLocaleLowerCase("vi-VN");
    const date = String(order.DH_Ngay || "").slice(0, 10);
    return (!orderFilters.search || searchable.includes(orderFilters.search.toLocaleLowerCase("vi-VN")))
      && (!orderFilters.status || status === orderFilters.status)
      && (!orderFilters.from || date >= orderFilters.from)
      && (!orderFilters.to || date <= orderFilters.to);
  }).sort((left, right) => String(right.order.DH_Ngay).localeCompare(String(left.order.DH_Ngay)));
  const pageCount = Math.max(1, Math.ceil(rows.length / orderPageSize));
  orderPage = Math.min(orderPage, pageCount);
  const pageRows = rows.slice((orderPage - 1) * orderPageSize, orderPage * orderPageSize);
  const orderRows = pageRows.map(({ order, status, lines, totalReceived }) => {
    const canCancel = totalReceived === 0 && !state.PhieuNhap.some((receipt) => receipt.DH_Ma === order.DH_Ma && receipt.PN_TrangThai !== "Đã hủy");
    const actions = `<div class="inline-actions">
      ${actionButton("view-order", "Chi tiết", order.DH_Ma)}
      ${status === PURCHASE_ORDER_STATUSES.draft ? actionButton("edit-order", "Sửa", order.DH_Ma) : ""}
      ${status === PURCHASE_ORDER_STATUSES.draft ? actionButton("confirm-order", "Xác nhận", order.DH_Ma, "button-primary") : ""}
      ${canCancel && ![PURCHASE_ORDER_STATUSES.cancelled, PURCHASE_ORDER_STATUSES.complete].includes(status) ? actionButton("cancel-order", "Hủy", order.DH_Ma, "button-danger") : ""}
    </div>`;
    const receivedText = lines.map((line) => `${formatNumber(line.received)}/${formatNumber(line.ordered)} ${state.HangHoa.find((item) => item.HH_Ma === line.HH_Ma)?.HH_DVi || ""}`).join("<br>");
    return `<tr data-order-row><td class="cell-primary">${esc(order.DH_Ma)}</td><td>${formatDate(order.DH_Ngay)}</td><td>${esc(partnerName(state, order.DT_Ma))}</td><td>${esc(employeeName(state, order.NV_Ma))}</td><td class="money">${formatNumber(order.DH_TongSL)}</td><td class="money">${formatCurrency(order.DH_TongTien)}</td><td>${receivedText || "—"}</td><td>${statusBadge(status)}</td><td>${actions}</td></tr>`;
  }).join("");
  const pagination = `<div class="manager-order-pagination"><span>${formatNumber(rows.length)} đơn · Trang ${orderPage} / ${pageCount}</span><div class="inline-actions"><button class="button button-small" data-action="orders-page" data-page="${orderPage - 1}" ${orderPage <= 1 ? "disabled" : ""}>Trước</button><button class="button button-small" data-action="orders-page" data-page="${orderPage + 1}" ${orderPage >= pageCount ? "disabled" : ""}>Tiếp</button></div></div>`;
  const statusOptions = [...new Set(summaries.map((summary) => summary.status))].map((status) => `<option value="${esc(status)}" ${orderFilters.status === status ? "selected" : ""}>${esc(status)}</option>`).join("");
  const openValue = summaries.filter((summary) => [PURCHASE_ORDER_STATUSES.waiting, PURCHASE_ORDER_STATUSES.partial].includes(summary.status))
    .reduce((sum, summary) => sum + summary.totalOutstandingValue, 0);
  const waiting = byStatus(PURCHASE_ORDER_STATUSES.waiting).length;
  const partial = byStatus(PURCHASE_ORDER_STATUSES.partial).length;
  const complete = byStatus(PURCHASE_ORDER_STATUSES.complete).length;
  const incompleteLines = summaries.reduce((sum, summary) => sum + summary.lines.filter((line) => line.remaining > 0 && summary.status !== PURCHASE_ORDER_STATUSES.draft && summary.status !== PURCHASE_ORDER_STATUSES.cancelled).length, 0);
  return `${heading("QUẢN LÝ ĐƠN ĐẶT HÀNG", "Theo dõi các đơn hàng đặt mua từ nhà cung cấp.", `<button class="button button-primary" data-action="new-order">＋ Tạo đơn đặt hàng</button>`)}
    <div class="metric-grid manager-order-metrics">
      ${metric("Tổng số đơn đặt hàng", formatNumber(summaries.length))}
      ${metric("Đang chờ giao", formatNumber(waiting))}
      ${metric("Đã nhận một phần", formatNumber(partial))}
      ${metric("Đã nhận đủ", formatNumber(complete))}
      ${metric("Giá trị chưa nhận đủ", formatCurrency(openValue))}
    </div>
    <div class="info-box manager-order-note">Còn thiếu ${formatNumber(incompleteLines)} dòng hàng trên các đơn đã xác nhận. Đơn đặt hàng chỉ ghi DatHang/DatChiTiet; tồn kho và công nợ chỉ phát sinh khi kế toán xác nhận phiếu nhập.</div>
    <form class="filters manager-order-filters" id="purchase-order-filters">
      <div class="field grow"><label for="order-search">Mã đơn / nhà cung cấp</label><input id="order-search" name="search" value="${esc(orderFilters.search)}" placeholder="DH…, tên nhà cung cấp…"></div>
      <div class="field"><label for="order-date-from">Từ ngày</label><input id="order-date-from" name="from" type="date" value="${esc(orderFilters.from)}"></div>
      <div class="field"><label for="order-date-to">Đến ngày</label><input id="order-date-to" name="to" type="date" value="${esc(orderFilters.to)}"></div>
      <div class="field"><label for="order-status">Trạng thái</label><select id="order-status" name="status"><option value="">Tất cả</option>${statusOptions}</select></div>
      <button class="button button-primary" type="submit">Lọc đơn</button>
      <button class="button" type="button" data-action="clear-order-filters">Xóa lọc</button>
    </form>
    <div class="table-card manager-order-table"><div class="table-toolbar"><strong>Đơn đặt hàng nhà cung cấp</strong><span>${formatNumber(rows.length)} kết quả</span></div>
      <div class="table-wrap"><table><thead><tr><th>Mã đơn</th><th>Ngày đặt</th><th>Nhà cung cấp</th><th>Người lập</th><th>Tổng SL cơ bản</th><th>Tổng tiền</th><th>Đã nhận / Đã đặt</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>${orderRows || `<tr><td colspan="9" class="empty-state">Không có đơn đặt hàng phù hợp.</td></tr>`}</tbody></table></div>${pagination}
    </div>
    <div class="info-box">Đơn đã xác nhận được nhân viên kho nhận thành nhiều lần. Các phiếu Nháp/Chờ kế toán xác nhận giữ chỗ số lượng để tránh nhập vượt đơn; chỉ phiếu kế toán xác nhận mới được tính là đã nhận và ghi nhận tồn/công nợ.</div>`;
}

function purchaseOrderLineRow(state, line = {}) {
  const item = state.HangHoa.find((row) => row.HH_Ma === line.HH_Ma);
  const packageUnit = getUnitPackage(item);
  const unitFactor = packageUnit && Number(line.DN_DonVi) === packageUnit.ratio ? packageUnit.ratio : 1;
  const enteredQuantity = line.DN_SL === undefined ? 1 : Number(line.DN_SL) / unitFactor;
  const enteredPrice = line.DN_DonGia === undefined ? 0 : Number(line.DN_DonGia) * unitFactor;
  const searchOptions = state.HangHoa.filter((row) => row.HH_TrangThai === "Đang kinh doanh").map((row) => (
    `<option value="${esc(row.HH_Ma)}" ${row.HH_Ma === line.HH_Ma ? "selected" : ""}>${esc(row.HH_Ma)} · ${esc(row.HH_Ten)}${row.HH_MaVach ? ` · ${esc(row.HH_MaVach)}` : ""}</option>`
  )).join("");
  return `<tr class="purchase-order-line">
    <td class="order-line-number"></td>
    <td><select name="HH_Ma" required><option value="">Chọn mặt hàng</option>${searchOptions}</select><small class="field-hint order-stock"></small></td>
    <td><select name="DN_DonVi" aria-label="Đơn vị đặt"><option value="1" ${unitFactor === 1 ? "selected" : ""}>${esc(item?.HH_DVi || "ĐVT cơ bản")}</option>${packageUnit ? `<option value="${packageUnit.ratio}" ${unitFactor === packageUnit.ratio ? "selected" : ""}>${esc(packageUnit.name)}</option>` : ""}</select></td>
    <td><input name="DN_SL_Nhap" type="number" min="1" step="1" value="${esc(enteredQuantity)}" required></td>
    <td><input name="DN_DonGia_Nhap" type="number" min="0" step="1" value="${esc(enteredPrice)}" required></td>
    <td><div class="order-line-total">—</div><small class="field-hint order-line-conversion"></small></td>
    <td><button type="button" class="button button-small button-danger" data-action="remove-order-line">Xóa</button></td>
  </tr>`;
}

function currentStockForProduct(state, itemId) {
  const inboundLineIds = new Set(state.PhieuNhapChiTiet.filter((line) => line.HH_Ma === itemId).map((line) => line.PNCT_Ma));
  return state.TonKho.filter((stock) => inboundLineIds.has(stock.PNCT_Ma)).reduce((sum, stock) => sum + Number(stock.TK_SL || 0), 0);
}

function updateOrderLine(row, state = getState()) {
  const itemId = row.querySelector('[name="HH_Ma"]').value;
  const item = state.HangHoa.find((entry) => entry.HH_Ma === itemId);
  const packageUnit = getUnitPackage(item);
  const unitSelect = row.querySelector('[name="DN_DonVi"]');
  unitSelect.innerHTML = `<option value="1">${esc(item?.HH_DVi || "ĐVT cơ bản")}</option>${packageUnit ? `<option value="${packageUnit.ratio}">${esc(packageUnit.name)} (${packageUnit.ratio} ${esc(item.HH_DVi)})</option>` : ""}`;
  unitSelect.value = "1";
  row.querySelector(".order-stock").textContent = item ? `Tồn hiện có toàn hệ thống: ${formatBaseQuantity(currentStockForProduct(state, itemId), item)}` : "";
  updateOrderTotals();
}

function updateOrderTotals() {
  const form = document.querySelector("#purchase-order-form");
  if (!form) return;
  let totalQuantity = 0;
  let totalAmount = 0;
  let hasError = false;
  const rows = [...form.querySelectorAll(".purchase-order-line")];
  rows.forEach((row, index) => {
    row.querySelector(".order-line-number").textContent = String(index + 1);
    const item = getState().HangHoa.find((entry) => entry.HH_Ma === row.querySelector('[name="HH_Ma"]').value);
    const quantity = Number(row.querySelector('[name="DN_SL_Nhap"]').value || 0);
    const price = Number(row.querySelector('[name="DN_DonGia_Nhap"]').value || 0);
    const factor = Number(row.querySelector('[name="DN_DonVi"]').value || 1);
    const conversion = row.querySelector(".order-line-conversion");
    try {
      if (!item || quantity <= 0 || price < 0) throw new Error("Chọn hàng hóa và nhập số lượng/đơn giá hợp lệ.");
      const baseQuantity = toBaseQuantity(quantity, factor);
      const basePrice = toBaseUnitPrice(price, factor);
      const lineTotal = quantity * price;
      if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(baseQuantity * basePrice) || lineTotal !== baseQuantity * basePrice) {
        throw new Error("Giá trị không thể quy đổi chính xác.");
      }
      totalQuantity += baseQuantity;
      totalAmount += lineTotal;
      row.querySelector(".order-line-total").textContent = formatCurrency(lineTotal);
      conversion.textContent = factor === 1
        ? `${formatNumber(baseQuantity)} ${item.HH_DVi}`
        : `${formatNumber(quantity)} ${getUnitPackage(item).name} = ${formatNumber(baseQuantity)} ${item.HH_DVi} · ${formatCurrency(basePrice)}/${item.HH_DVi}`;
      conversion.classList.remove("conversion-error");
    } catch (error) {
      hasError = true;
      row.querySelector(".order-line-total").textContent = "—";
      conversion.textContent = error.message;
      conversion.classList.add("conversion-error");
    }
  });
  form.querySelector("#order-total-quantity").textContent = formatNumber(totalQuantity);
  form.querySelector("#order-total-amount").textContent = formatCurrency(totalAmount);
  form.querySelector("#order-total-amount").classList.toggle("conversion-error", hasError || !Number.isSafeInteger(totalAmount));
}

function openPurchaseOrderForm(state, orderId = "") {
  const order = state.DatHang.find((row) => row.DH_Ma === orderId);
  if (order && order.DH_TrangThai !== PURCHASE_ORDER_STATUSES.draft) {
    return toast("Chỉ chỉnh sửa đơn đặt hàng ở trạng thái Nháp.", true);
  }
  const suppliers = state.DoiTacKinhDoanh.filter((row) => (
    row.DT_Loai === "Nhà cung cấp" && row.DT_TrangThai === "Hoạt động"
  ));
  const activeEmployee = state.NhanVien.find((row) => row.NV_Ma === "NV001" && row.NV_TrangThai !== "Nghỉ việc")
    || state.NhanVien.find((row) => row.NV_TrangThai !== "Nghỉ việc");
  const lines = order ? state.DatChiTiet.filter((row) => row.DH_Ma === orderId) : [{}];
  const modal = document.querySelector("#modal-host");
  modal.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><form class="modal modal-wide manager-modal manager-order-modal" id="purchase-order-form" data-id="${esc(orderId)}">
    <div class="modal-header"><h2>${order ? `Chỉnh sửa đơn nháp ${esc(orderId)}` : "Tạo đơn đặt hàng"}</h2><button type="button" class="button button-small" data-action="close-modal">Đóng</button></div>
    <div class="modal-body">
      <div class="form-error" id="purchase-order-error"></div>
      <div class="form-grid two">
        <div class="field"><label>Mã đơn</label><input value="${esc(orderId || "Tự sinh khi lưu")}" disabled></div>
        <div class="field"><label>Ngày đặt *</label><input name="DH_Ngay" type="date" value="${esc(order?.DH_Ngay || today())}" required></div>
        <div class="field"><label>Nhà cung cấp *</label><select name="DT_Ma" required><option value="">Chọn nhà cung cấp</option>${suppliers.map((supplier) => `<option value="${esc(supplier.DT_Ma)}" ${supplier.DT_Ma === order?.DT_Ma ? "selected" : ""}>${esc(supplier.DT_Ten)} · ${esc(supplier.DT_Ma)}</option>`).join("")}</select></div>
        <div class="field"><label>Người lập</label><input value="${esc(activeEmployee?.NV_Ten || "—")}" disabled><input type="hidden" name="NV_Ma" value="${esc(activeEmployee?.NV_Ma || "")}"></div>
        <div class="field"><label>Trạng thái</label><input value="${esc(order?.DH_TrangThai || PURCHASE_ORDER_STATUSES.draft)}" disabled></div>
        <div class="field"><label>Tìm sản phẩm</label><input id="order-item-search" type="search" placeholder="Mã hàng, tên hoặc mã vạch"></div>
      </div>
      <div class="detail-heading"><span>Sản phẩm đặt mua</span><button class="button button-small" type="button" data-action="add-order-line">＋ Thêm sản phẩm</button></div>
      <div class="table-wrap manager-order-lines-wrap"><table class="detail-table"><thead><tr><th>STT</th><th>Mã hàng / tên hàng / tồn hiện tại</th><th>Đơn vị đặt</th><th>Số lượng</th><th>Đơn giá</th><th>Thành tiền / quy đổi</th><th></th></tr></thead><tbody id="order-lines">${lines.map((line) => purchaseOrderLineRow(state, line)).join("")}</tbody></table></div>
      <div class="totals-row"><span>Tổng số lượng (đơn vị cơ bản): <strong id="order-total-quantity">0</strong></span><span>Tổng tiền: <strong id="order-total-amount">0 ₫</strong></span></div>
      <div class="info-box">Đơn vị đóng gói được lưu về DatChiTiet theo đơn vị cơ bản và đơn giá tương ứng. CSDL hiện không lưu đơn vị đặt ban đầu. Đơn đặt hàng chưa làm thay đổi tồn kho hoặc công nợ.</div>
    </div>
    <div class="modal-footer"><button type="button" class="button" data-action="close-modal">Hủy</button><button type="submit" class="button" data-order-submit="draft">Lưu nháp</button><button type="button" class="button button-primary" data-action="save-confirm-order">Xác nhận đặt hàng</button></div>
  </form></div>`;
  for (const row of modal.querySelectorAll(".purchase-order-line")) {
    row.querySelector(".order-stock").textContent = row.querySelector('[name="HH_Ma"]').value
      ? `Tồn hiện có toàn hệ thống: ${formatBaseQuantity(currentStockForProduct(state, row.querySelector('[name="HH_Ma"]').value), state.HangHoa.find((item) => item.HH_Ma === row.querySelector('[name="HH_Ma"]').value))}`
      : "";
  }
  updateOrderTotals();
}

function openPurchaseOrderDetails(state, orderId) {
  const order = state.DatHang.find((row) => row.DH_Ma === orderId);
  if (!order) return toast("Không tìm thấy đơn đặt hàng.", true);
  const summary = getPurchaseOrderReceiptSummary(state, order);
  const lineRows = summary.lines.map((line) => {
    const item = state.HangHoa.find((row) => row.HH_Ma === line.HH_Ma);
    return `<tr><td>${esc(line.HH_Ma)}</td><td>${esc(item?.HH_Ten || "—")}</td><td>${esc(formatBaseQuantity(line.ordered, item))}</td><td>${formatCurrency(line.DN_DonGia)} / ${esc(item?.HH_DVi || "đơn vị cơ bản")}</td><td>${formatCurrency(line.DN_TTien)}</td><td>${esc(formatBaseQuantity(line.received, item))}</td><td>${esc(formatBaseQuantity(line.remaining, item))}</td></tr>`;
  }).join("");
  const receipts = summary.receipts.slice().sort((a, b) => String(b.PN_Ngay).localeCompare(String(a.PN_Ngay)));
  const receiptRows = receipts.map((receipt) => {
    const quantity = state.PhieuNhapChiTiet.filter((row) => row.PN_Ma === receipt.PN_Ma).reduce((sum, row) => sum + Number(row.PNCT_SL || 0), 0);
    return `<tr><td>${esc(receipt.PN_Ma)}</td><td>${formatDate(receipt.PN_Ngay)}</td><td>${esc(locationName(state, receipt.DD_Ma))}</td><td>${esc(employeeName(state, receipt.NV_Ma))}</td><td>${statusBadge(receipt.PN_TrangThai)}</td><td>${formatNumber(quantity)}</td><td>${formatCurrency(receipt.PN_TongTien)}</td><td><button class="button button-small" data-action="view-order-receipt" data-id="${esc(receipt.PN_Ma)}">Xem chi tiết</button></td></tr>`;
  }).join("");
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal modal-wide manager-modal">
    <div class="modal-header"><h2>Chi tiết đơn đặt hàng ${esc(order.DH_Ma)}</h2><button type="button" class="button button-small" data-action="close-modal">Đóng</button></div>
    <div class="modal-body">
      <div class="form-grid two manager-order-summary">
        <div><span class="field-label">Nhà cung cấp</span><div>${esc(partnerName(state, order.DT_Ma))}</div></div>
        <div><span class="field-label">Người lập</span><div>${esc(employeeName(state, order.NV_Ma))}</div></div>
        <div><span class="field-label">Ngày đặt</span><div>${formatDate(order.DH_Ngay)}</div></div>
        <div><span class="field-label">Trạng thái</span><div>${statusBadge(summary.status)}</div></div>
        <div><span class="field-label">Tổng tiền đặt</span><div>${formatCurrency(order.DH_TongTien)}</div></div>
        <div><span class="field-label">Tiến độ nhận</span><div>${formatNumber(summary.totalReceived)} / ${formatNumber(summary.totalOrdered)} đơn vị cơ bản</div></div>
      </div>
      ${tableCard("Chi tiết mặt hàng", "", ["Mã sản phẩm", "Tên sản phẩm", "Số lượng đặt", "Đơn giá đặt", "Thành tiền", "Đã nhận", "Còn thiếu"], lineRows)}
      ${tableCard("Phiếu nhập liên quan", `${receipts.length} phiếu`, ["Mã phiếu nhập", "Ngày nhập", "Kho nhận", "Nhân viên lập", "Trạng thái", "Số lượng", "Tổng tiền", "Thao tác"], receiptRows)}
    </div>
    <div class="modal-footer"><button class="button" data-action="close-modal">Đóng</button>${summary.status === PURCHASE_ORDER_STATUSES.draft ? `<button class="button button-primary" data-action="confirm-order" data-id="${esc(order.DH_Ma)}">Xác nhận đặt hàng</button>` : ""}</div>
  </section></div>`;
}

function openPurchaseReceiptDetails(state, receiptId) {
  const receipt = state.PhieuNhap.find((row) => row.PN_Ma === receiptId);
  if (!receipt) return toast("Không tìm thấy phiếu nhập liên quan.", true);
  const lines = state.PhieuNhapChiTiet.filter((row) => row.PN_Ma === receiptId).map((line) => {
    const item = state.HangHoa.find((row) => row.HH_Ma === line.HH_Ma);
    return `<tr><td>${esc(line.HH_Ma)}</td><td>${esc(item?.HH_Ten || "—")}</td><td>${esc(formatBaseQuantity(line.PNCT_SL, item))}</td><td>${formatCurrency(line.PNCT_DonGia)}</td><td>${formatCurrency(line.PNCT_TTien)}</td></tr>`;
  }).join("");
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal modal-wide manager-modal">
    <div class="modal-header"><h2>Chi tiết phiếu nhập ${esc(receiptId)}</h2><button class="button button-small" data-action="close-modal">Đóng</button></div>
    <div class="modal-body"><div class="form-grid two">
      <div><span class="field-label">Nhà cung cấp</span><div>${esc(partnerName(state, receipt.DT_Ma))}</div></div>
      <div><span class="field-label">Đơn đặt hàng</span><div>${esc(receipt.DH_Ma || "Không liên kết")}</div></div>
      <div><span class="field-label">Ngày / kho nhận</span><div>${formatDate(receipt.PN_Ngay)} · ${esc(locationName(state, receipt.DD_Ma))}</div></div>
      <div><span class="field-label">Trạng thái</span><div>${statusBadge(receipt.PN_TrangThai)}</div></div>
    </div>${tableCard("Dòng hàng nhận", "", ["Mã hàng", "Tên hàng", "Số lượng", "Đơn giá", "Thành tiền"], lines)}</div>
    <div class="modal-footer"><button class="button" data-action="close-modal">Đóng</button></div>
  </section></div>`;
}

function savePurchaseOrderForm(confirmAfterSave = false) {
  const form = document.querySelector("#purchase-order-form");
  if (!form || !form.reportValidity()) return;
  const lines = [];
  try {
    for (const row of form.querySelectorAll(".purchase-order-line")) {
      const itemId = row.querySelector('[name="HH_Ma"]').value;
      const quantity = Number(row.querySelector('[name="DN_SL_Nhap"]').value);
      const price = Number(row.querySelector('[name="DN_DonGia_Nhap"]').value);
      const factor = Number(row.querySelector('[name="DN_DonVi"]').value);
      lines.push({ HH_Ma: itemId, DN_SL: toBaseQuantity(quantity, factor), DN_DonGia: toBaseUnitPrice(price, factor) });
    }
    const orderId = savePurchaseOrder({
      DH_Ma: form.dataset.id,
      DT_Ma: form.querySelector('[name="DT_Ma"]').value,
      NV_Ma: form.querySelector('[name="NV_Ma"]').value,
      DH_Ngay: form.querySelector('[name="DH_Ngay"]').value,
      lines
    }, role);
    if (confirmAfterSave) confirmPurchaseOrder(orderId, role);
    closeModal();
    render();
    toast(confirmAfterSave ? `Đã xác nhận đơn ${orderId}.` : `Đã lưu nháp đơn ${orderId}.`);
  } catch (error) {
    const errorBox = form.querySelector("#purchase-order-error");
    errorBox.textContent = error.message || "Không thể lưu đơn đặt hàng.";
    errorBox.classList.add("visible");
  }
}

function renderOperations() {
  const state = getState();
  const transferRows = state.PhieuXuatChuyenNoiBo.map((row) => `<tr><td>${esc(row.PXCN_Ma)}</td><td>${esc(locationName(state, row.DD_Xuat))} → ${esc(locationName(state, row.DD_Nhan))}</td><td>${formatDate(row.PXCN_Ngay)}</td><td>${formatNumber(row.PXCN_TongSL)}</td><td>${statusBadge(row.PXCN_TrangThai)}</td><td><a class="text-link" href="../kho/xuat-chuyen-noi-bo.html">Mở phiếu →</a></td></tr>`).join("");
  return `${heading("Giám sát tồn kho & chuyển hàng", "Không sửa tồn trực tiếp. Mọi thay đổi tồn phải đi qua phiếu nhập, chuyển, bán hoặc kiểm kê.", `<a class="button button-primary" href="../kho/ton-kho.html">Mở theo dõi tồn</a>`)}
    <div class="heading-actions manager-shortcuts"><a class="button" href="../kho/han-su-dung.html">Hạn sử dụng</a><a class="button" href="../kho/bien-dong-kho.html">Biến động kho</a><a class="button" href="../kho/xuat-chuyen-noi-bo.html">Phiếu chuyển</a><a class="button" href="../kho/kiem-ke-kho.html">Kiểm kê</a></div>
    ${tableCard("Phiếu chuyển nội bộ", `${state.PhieuXuatChuyenNoiBo.length} phiếu`, ["Mã phiếu", "Luân chuyển", "Ngày", "Tổng SL", "Trạng thái", "Thao tác"], transferRows)}
    <div class="info-box">Tồn theo địa điểm và theo lô được xem tại trang Kho. Hàng cửa hàng hết nhưng điểm khác còn sẽ được gắn cảnh báo; việc chuyển cần được lập/xác nhận riêng.</div>`;
}

function renderCounts() {
  const state = getState();
  const rows = state.PhieuKiemKeKho.map((count) => {
    const lines = state.PhieuKiemKeKhoChiTiet.filter((row) => row.PKK_Ma === count.PKK_Ma);
    const deltaCount = lines.filter((row) => row.PKKCT_ChenhLech !== 0).length;
    return `<tr><td>${esc(count.PKK_Ma)}</td><td>${esc(locationName(state, count.DD_Ma))}</td><td>${formatDate(count.PKK_Ngay)}</td><td>${esc(employeeName(state, count.NV_Ma))}</td><td>${statusBadge(count.PKK_TrangThai)}</td><td>${formatNumber(deltaCount)}</td><td>${esc(employeeName(state, count.NV_Duyet))}</td><td>${formatDate(count.PKK_NgayDuyet)}</td><td><a class="button button-small" href="../kho/kiem-ke-kho.html?count=${encodeURIComponent(count.PKK_Ma)}">Xem phiếu</a>${count.PKK_TrangThai === "Chờ duyệt" ? ` ${actionButton("approve-count", "Duyệt", count.PKK_Ma)}` : ""}</td></tr>`;
  }).join("");
  return `${heading("Duyệt phiếu kiểm kê", "Khi duyệt, service xác minh tồn chưa thay đổi kể từ lúc kiểm kê; không duyệt lặp.", `<a class="button" href="../kho/kiem-ke-kho.html">Mở màn hình kiểm kê kho</a>`)}${tableCard("Phiếu kiểm kê", `${state.PhieuKiemKeKho.length} phiếu`, ["Mã phiếu", "Địa điểm", "Ngày kiểm kê", "Nhân viên lập", "Trạng thái", "Dòng lệch", "Người duyệt", "Ngày duyệt", "Thao tác"], rows)}`;
}

function renderSales() {
  const state = getState();
  const rows = state.HoaDonBanHang.slice().sort((a, b) => b.BH_Ngay.localeCompare(a.BH_Ngay)).map((invoice) => `<tr><td>${esc(invoice.BH_Ma)}</td><td>${formatDate(invoice.BH_Ngay)}</td><td>${esc(locationName(state, invoice.DD_Ma))}</td><td>${esc(employeeName(state, invoice.NV_Ma))}</td><td>${formatNumber(invoice.BH_TongSL)}</td><td>${formatCurrency(invoice.BH_TongCong)}</td><td>${statusBadge(invoice.BH_TrangThai)}</td><td><a class="text-link" href="../ban-hang-ke-toan/hoa-don.html">Xem hóa đơn →</a></td></tr>`).join("");
  const overview = getManagerOverview({}, state);
  return `${heading("Giám sát bán hàng", "Xem hóa đơn và đối soát dùng chung. Không tạo POS riêng, không sửa/xóa hóa đơn xác nhận.", `<a class="button button-primary" href="../ban-hang-ke-toan/hoa-don.html">Mở hóa đơn bán hàng</a>`)}
    <div class="metric-grid">${metric("Hóa đơn xác nhận", formatNumber(state.HoaDonBanHang.filter((row) => row.BH_TrangThai === "Đã xác nhận").length))}${metric("Hóa đơn nháp", formatNumber(state.HoaDonBanHang.filter((row) => row.BH_TrangThai === "Nháp").length))}${metric("Hóa đơn cần đối soát", formatNumber(overview.anomalies.length))}${metric("Cảnh báo thanh toán", formatNumber(overview.paymentAlerts.length))}</div>
    ${tableCard("Hóa đơn gần đây", `${state.HoaDonBanHang.length} hóa đơn`, ["Mã hóa đơn", "Ngày", "Địa điểm", "Nhân viên", "SL", "Tổng tiền", "Trạng thái", "Điều hướng"], rows)}
    <div class="info-box ${overview.anomalies.length || overview.paymentAlerts.length ? "info-warning" : ""}">${overview.anomalies.length} hóa đơn và ${overview.paymentAlerts.length} cảnh báo thanh toán. <a class="text-link" href="../ban-hang-ke-toan/doi-soat-doanh-thu.html">Đối soát doanh thu</a> · <a class="text-link" href="../ban-hang-ke-toan/doi-soat-thanh-toan.html">Đối soát thanh toán →</a></div>`;
}

function renderFinance() {
  const state = getState();
  const dashboard = getAccountingDashboard({}, state);
  const reports = getAccountingReports(state);
  const links = [
    ["Công nợ NCC", "../ban-hang-ke-toan/cong-no-ncc.html"],
    ["Công nợ khách hàng", "../ban-hang-ke-toan/cong-no-khach-hang.html"],
    ["Thanh toán NCC", "../ban-hang-ke-toan/thanh-toan-ncc.html"],
    ["Phiếu thu", "../ban-hang-ke-toan/phieu-thu.html"],
    ["Phiếu chi", "../ban-hang-ke-toan/phieu-chi.html"],
    ["Đối soát thanh toán", "../ban-hang-ke-toan/doi-soat-thanh-toan.html"]
  ];
  const payables = dashboard.payables.filter((row) => row.due > 0).map((row) => `<tr><td>${esc(partnerName(state, row.creditor.DT_Ma))}</td><td>${formatCurrency(row.principal)}</td><td>${formatCurrency(row.paid)}</td><td class="negative">${formatCurrency(row.due)}</td></tr>`).join("");
  return `${heading("Công nợ & thu chi", "Sử dụng số liệu và nghiệp vụ Kế toán. Không cộng trùng thanh toán NCC với phiếu chi liên kết.", `<a class="button button-primary" href="../ban-hang-ke-toan/tong-quan-ke-toan.html">Mở phân hệ Kế toán</a>`)}
    <div class="metric-grid">${metric("Phải thu hiện tại", formatCurrency(reports.receivableBalance))}${metric("Phải trả hiện tại", formatCurrency(reports.payableBalance))}${metric("Tiền bán hàng đã thu", formatCurrency(reports.receivedSales))}${metric("Thu khác", formatCurrency(reports.receivedOther))}${metric("Trả nhà cung cấp", formatCurrency(reports.paidSuppliers))}${metric("Chi khác", formatCurrency(reports.paidOther))}</div>
    ${tableCard("Công nợ nhà cung cấp", `${dashboard.payables.filter((row) => row.due > 0).length} nhà cung cấp còn dư`, ["Nhà cung cấp", "Nợ gốc", "Đã trả", "Còn phải trả"], payables)}
    <div class="manager-shortcuts">${links.map(([label, href]) => `<a class="button" href="${href}">${label} →</a>`).join("")}</div>
    <div class="info-box">Thu − chi theo giao dịch hệ thống; chưa phải báo cáo lưu chuyển tiền tệ chuẩn. Không có dữ liệu sao kê ngân hàng/kiểm quỹ. Không hiển thị tuổi nợ.</div>`;
}

function renderReports() {
  const state = getState();
  const report = getManagerReports(state, reportFilters);
  const tabs = [["revenue", "Doanh thu"], ["sales", "Bán hàng"], ["inventory", "Tồn kho"], ["cash", "Thu chi"], ["shifts", "Ca bán hàng"], ["debts", "Công nợ"], ["profit", "Giá vốn & lợi nhuận gộp"]];
  const tabBar = `<div class="accounting-tabs">${tabs.map(([key, label]) => `<button class="button ${reportTab === key ? "button-primary" : ""}" data-action="report-tab" data-tab="${key}">${label}</button>`).join("")}</div>`;
  let content = "";
  if (reportTab === "revenue") {
    const rows = report.revenueByMonth.map((row) => `<tr><td>${esc(row.month)}</td><td>${formatCurrency(row.revenue)}</td></tr>`).join("");
    const employees = report.revenueByEmployee.map((row) => `<tr><td>${esc(employeeName(state, row.id))}</td><td>${formatCurrency(row.revenue)}</td></tr>`).join("");
    const locations = report.revenueByLocation.map((row) => `<tr><td>${esc(locationName(state, row.id))}</td><td>${formatCurrency(row.revenue)}</td></tr>`).join("");
    content = `<div class="metric-grid">${metric("Doanh thu hóa đơn xác nhận", formatCurrency(report.periodRevenue))}${metric("Số hóa đơn", formatNumber(report.periodInvoiceCount))}${metric("Số lượng hàng bán", formatNumber(report.periodSoldQuantity))}</div><div class="dashboard-grid">${tableCard("Doanh thu theo tháng", "Theo ngày hóa đơn", ["Tháng", "Doanh thu"], rows)}${tableCard("Doanh thu theo nhân viên", "Hóa đơn đã xác nhận", ["Nhân viên", "Doanh thu"], employees)}${tableCard("Doanh thu theo địa điểm", "Hóa đơn đã xác nhận", ["Địa điểm", "Doanh thu"], locations)}</div>`;
  } else if (reportTab === "sales") {
    const products = report.products.map((row) => `<tr><td>${esc(productName(state, row.HH_Ma))}</td><td>${formatNumber(row.quantity)}</td><td>${formatCurrency(row.revenue)}</td><td>${row.quantity ? formatCurrency(row.revenue / row.quantity) : "—"}</td></tr>`).join("");
    const categories = report.revenueByCategory.map((row) => `<tr><td>${esc(categoryName(state, row.id))}</td><td>${formatCurrency(row.revenue)}</td></tr>`).join("");
    content = `<div class="dashboard-grid">${tableCard("Mặt hàng bán nhiều", "Số lượng và doanh thu", ["Mặt hàng", "Số lượng", "Doanh thu", "Giá bán TB thực tế"], products)}${tableCard("Doanh thu theo danh mục", "Phân loại theo mặt hàng bán", ["Danh mục", "Doanh thu"], categories)}</div>`;
  } else if (reportTab === "inventory") {
    const locations = report.inventoryByLocation.map((row) => `<tr><td>${esc(locationName(state, row.id))}</td><td>${formatNumber(row.quantity)}</td><td>${formatCurrency(row.value)}</td></tr>`).join("");
    const movements = report.movementTypes.map((row) => `<tr><td>${esc(row.type)}</td><td>${formatNumber(row.quantity)}</td></tr>`).join("");
    content = `<div class="metric-grid">${metric("Tổng số lượng tồn", formatNumber(state.TonKho.reduce((sum, row) => sum + row.TK_SL, 0)))}${metric("Giá trị tồn theo giá nhập", formatCurrency(report.inventoryValue))}${metric("Hàng sắp/đã hết hạn", formatNumber(getManagerOverview({}, state).expiryCount))}</div><div class="dashboard-grid">${tableCard("Tồn theo địa điểm", "Số dư hiện tại", ["Địa điểm", "Số lượng", "Giá trị theo giá nhập"], locations)}${tableCard("Biến động kho theo loại", "Tổng lượng +/- trong dữ liệu hiện có", ["Loại biến động", "Số lượng ròng"], movements)}</div>`;
  } else if (reportTab === "cash") {
    content = `<div class="metric-grid">${metric("Tiền bán hàng đã thu", formatCurrency(report.receivedSales))}${metric("Thu khác", formatCurrency(report.receivedOther))}${metric("Tiền trả NCC", formatCurrency(report.paidSuppliers))}${metric("Chi khác", formatCurrency(report.paidOther))}${metric("Thu − chi ghi nhận", formatCurrency(report.cashDifference))}</div><div class="info-box info-warning">Tổng hợp dòng tiền theo giao dịch hệ thống, chưa phải báo cáo lưu chuyển tiền tệ chuẩn. Phiếu chi liên kết nhà cung cấp không bị cộng lặp.</div>`;
  } else if (reportTab === "shifts") {
    const shifts = getCashShifts().filter((shift) => {
      const day = String(shift.GioMo || "").slice(0, 10);
      return (!reportFilters.from || day >= reportFilters.from)
        && (!reportFilters.to || day <= reportFilters.to)
        && (!reportFilters.location || shift.DD_Ma === reportFilters.location);
    }).sort((a, b) => String(b.GioMo).localeCompare(String(a.GioMo)));
    const summaries = shifts.map((shift) => ({ shift, summary: calculateCashShift(shift, state) }));
    const total = (key) => summaries.reduce((sum, row) => sum + Number(row.summary[key] || 0), 0);
    const varianceCount = shifts.filter((shift) => Number(shift.ChenhLech || 0) !== 0).length;
    const rows = summaries.map(({ shift, summary }) => `<tr>
      <td class="cell-primary">${esc(shift.Ca_Ma)}</td><td>${esc(employeeName(state, shift.NV_Ma))}</td><td>${esc(locationName(state, shift.DD_Ma))}</td>
      <td>${formatDate(shift.GioMo)}</td><td>${shift.GioDong ? formatDate(shift.GioDong) : "—"}</td>
      <td>${formatNumber(summary.invoiceCount)}</td><td>${formatCurrency(summary.revenue)}</td><td>${formatCurrency(summary.cash)}</td>
      <td>${formatCurrency(summary.transfer)}</td><td>${formatCurrency(summary.qr)}</td>
      <td>${formatCurrency(shift.TienMatDuKien ?? summary.expectedCash)}</td>
      <td>${shift.TienMatThucDem === null ? "—" : formatCurrency(shift.TienMatThucDem)}</td>
      <td>${shift.ChenhLech === null ? "—" : formatCurrency(shift.ChenhLech)}</td><td>${summary.pendingPayments.length}</td><td>${statusBadge(shift.TrangThai)}</td>
      <td>${actionButton("view-cash-shift", "Chi tiết / in", shift.Ca_Ma)}</td></tr>`).join("");
    content = `<div class="metric-grid">${metric("Số ca", formatNumber(shifts.length))}${metric("Doanh thu hóa đơn", formatCurrency(total("revenue")))}
      ${metric("Tiền mặt", formatCurrency(total("cash")))}${metric("Chuyển khoản", formatCurrency(total("transfer")))}
      ${metric("QR", formatCurrency(total("qr")))}${metric("Ca có chênh lệch", formatNumber(varianceCount))}</div>
      ${tableCard("Báo cáo theo ca", `${shifts.length} ca trong kỳ`, ["Mã ca", "Thu ngân", "Cửa hàng", "Mở ca", "Kết ca", "Hóa đơn", "Doanh thu", "Tiền mặt", "Chuyển khoản", "QR", "Tiền dự kiến", "Thực đếm", "Chênh lệch", "Thanh toán chờ", "Trạng thái", "Báo cáo"], rows,
        "Báo cáo dựa trên ca demo trong localStorage. Doanh thu hóa đơn, tiền thu và tiền mặt kiểm đếm là các số liệu riêng biệt.")}`;
  } else if (reportTab === "debts") {
    const suppliers = report.debtDetails.map(({ debt, paid, due }) => `<tr><td>${esc(partnerName(state, state.CongNoNCC.find((row) => row.CNNCC_Ma === debt.CNNCC_Ma)?.DT_Ma))}</td><td>${esc(debt.PN_Ma)}</td><td>${formatCurrency(debt.CTNNCC_SoTienNo)}</td><td>${formatCurrency(paid)}</td><td>${formatCurrency(due)}</td></tr>`).join("");
    const customers = report.customerDebts.map(({ invoice, paid, due }) => `<tr><td>${esc(partnerName(state, invoice.DT_Ma))}</td><td>${esc(invoice.BH_Ma)}</td><td>${formatCurrency(invoice.BH_TongCong)}</td><td>${formatCurrency(paid)}</td><td>${formatCurrency(due)}</td></tr>`).join("");
    content = `<div class="metric-grid">${metric("Phải thu hiện tại", formatCurrency(report.receivableBalance))}${metric("Phải trả hiện tại", formatCurrency(report.payableBalance))}</div><div class="dashboard-grid">${tableCard("Phải trả NCC", "Số dư hiện tại", ["Nhà cung cấp", "Phiếu nhập", "Nợ gốc", "Đã trả", "Còn nợ"], suppliers)}${tableCard("Phải thu khách hàng", "Hóa đơn còn số dư", ["Khách hàng", "Hóa đơn", "Tổng tiền", "Đã thu", "Còn nợ"], customers)}</div><div class="table-subnote">Không báo cáo tuổi nợ hoặc quá hạn vì dữ liệu không lưu ngày đến hạn.</div>`;
  } else {
    content = `<div class="metric-grid">${metric("Doanh thu trong kỳ", formatCurrency(report.periodRevenue))}${metric("Giá vốn trong kỳ", formatCurrency(report.periodCost))}${metric("Lợi nhuận gộp sơ bộ trong kỳ", formatCurrency(report.periodGrossProfit))}${metric("Giá trị tồn hiện tại", formatCurrency(report.inventoryValue))}</div><div class="info-box">Giá vốn tính từ BH_SL × PNCT_DonGia của hóa đơn hợp lệ; lợi nhuận gộp sơ bộ = doanh thu − giá vốn. Giá trị tồn là số dư hiện tại theo giá nhập, không phải giá trị tồn lịch sử theo kỳ. Không phải lợi nhuận ròng/sau thuế.</div>`;
  }
  const reportAction = reportTab === "shifts" ? `<button class="button" data-action="print-cash-shift-report">In báo cáo ca</button>` : "";
  return `${heading("Báo cáo tổng hợp", "Báo cáo tính trực tiếp từ các bảng nghiệp vụ dùng chung. Số dư tồn kho/công nợ là tại thời điểm hiện tại.", `${reportAction}<a class="button" href="../ban-hang-ke-toan/bao-cao-ke-toan.html">Báo cáo kế toán hiện có</a>`)}
    <div class="filters"><div class="field"><label>Từ ngày</label><input type="date" id="report-from" value="${esc(reportFilters.from || "")}"></div><div class="field"><label>Đến ngày</label><input type="date" id="report-to" value="${esc(reportFilters.to || "")}"></div><div class="field"><label>Địa điểm</label><select id="report-location"><option value="">Tất cả địa điểm</option>${state.DiaDiem.map((row) => `<option value="${esc(row.DD_Ma)}" ${reportFilters.location === row.DD_Ma ? "selected" : ""}>${esc(row.DD_Ten)}</option>`).join("")}</select></div><button class="button button-primary" data-action="filter-report">Áp dụng</button></div>${tabBar}${content}`;
}

function ownerCashShiftPrintMarkup(state, shifts) {
  const details = shifts.map((shift) => ({ shift, summary: calculateCashShift(shift, state) }));
  const rows = details.map(({ shift, summary }) => `<tr><td>${esc(shift.Ca_Ma)}</td><td>${esc(employeeName(state, shift.NV_Ma))}</td>
    <td>${esc(locationName(state, shift.DD_Ma))}</td><td>${formatDate(shift.GioMo)}</td><td>${formatNumber(summary.invoiceCount)}</td>
    <td>${formatCurrency(summary.revenue)}</td><td>${formatCurrency(summary.cash)}</td><td>${formatCurrency(summary.transfer)}</td>
    <td>${formatCurrency(summary.qr)}</td><td>${formatCurrency(shift.TienMatDuKien ?? summary.expectedCash)}</td>
    <td>${shift.TienMatThucDem === null ? "—" : formatCurrency(shift.TienMatThucDem)}</td>
    <td>${shift.ChenhLech === null ? "—" : formatCurrency(shift.ChenhLech)}</td><td>${summary.pendingPayments.length}</td><td>${esc(shift.TrangThai)}</td></tr>`).join("");
  return `<div class="shift-print"><h2>BÁO CÁO CA BÁN HÀNG</h2>
    <p>Kỳ báo cáo: ${esc(reportFilters.from || "Tất cả")} – ${esc(reportFilters.to || "Tất cả")}
      · Cửa hàng: ${esc(reportFilters.location ? locationName(state, reportFilters.location) : "Tất cả")}</p>
    ${tableCard("Chi tiết ca", `${shifts.length} ca`, ["Mã ca", "Thu ngân", "Cửa hàng", "Ngày mở", "Hóa đơn", "Doanh thu", "Tiền mặt", "Chuyển khoản", "QR", "Tiền dự kiến", "Thực đếm", "Chênh lệch", "Thanh toán chờ", "Trạng thái"], rows)}
    <p class="cell-muted">Bản in demo, không phải chứng từ kế toán hoặc sao kê ngân hàng.</p></div>`;
}

function openOwnerCashShiftDetail(shiftId) {
  const state = getState();
  const shift = getCashShift(shiftId);
  if (!shift) return toast("Không tìm thấy ca bán hàng.", true);
  const summary = calculateCashShift(shift, state);
  const invoices = summary.invoices.map((invoice) => `<tr><td>${esc(invoice.BH_Ma)}</td><td>${formatDate(invoice.BH_Ngay)}</td><td>${formatCurrency(invoice.BH_TongCong)}</td></tr>`).join("");
  const payments = summary.payments.map((payment) => `<tr><td>${esc(payment.BH_Ma)}</td><td>${esc(payment.TTBH_Ma)}</td><td>${formatDate(payment.TTBH_Ngay)}</td>
    <td>${formatCurrency(payment.TTBH_SoTien)}</td><td>${esc(payment.TTBH_PhuongThuc)}</td><td>${esc(payment.TTBH_TrangThai)}</td></tr>`).join("");
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal modal-wide">
    <div class="modal-header"><h2>Chi tiết ca ${esc(shift.Ca_Ma)}</h2><button class="button button-small" data-action="close-modal">Đóng</button></div>
    <div class="modal-body"><div class="shift-print"><h2>BÁO CÁO CA BÁN HÀNG · ${esc(shift.Ca_Ma)}</h2>
      <p>Thu ngân: ${esc(employeeName(state, shift.NV_Ma))} · Cửa hàng: ${esc(locationName(state, shift.DD_Ma))} · ${esc(shift.TrangThai)}</p>
      <p>Mở: ${formatDate(shift.GioMo)} · Kết: ${shift.GioDong ? formatDate(shift.GioDong) : "Chưa kết ca"}</p>
      <div class="metric-grid">${metric("Doanh thu hóa đơn", formatCurrency(summary.revenue))}${metric("Tiền mặt", formatCurrency(summary.cash))}
        ${metric("Chuyển khoản", formatCurrency(summary.transfer))}${metric("QR", formatCurrency(summary.qr))}
        ${metric("Tiền đầu ca", formatCurrency(shift.TienMatDauCa))}${metric("Tiền dự kiến", formatCurrency(shift.TienMatDuKien ?? summary.expectedCash))}
        ${metric("Thực đếm", shift.TienMatThucDem === null ? "Chưa kết ca" : formatCurrency(shift.TienMatThucDem))}
        ${metric("Chênh lệch", shift.ChenhLech === null ? "—" : formatCurrency(shift.ChenhLech))}</div>
      <p>Giải trình: ${esc(shift.GiaiTrinh || "—")} · Ghi chú kế toán: ${esc(shift.GhiChuKeToan || "—")}</p>
      <p>Bàn giao: ${shift.TienMatBanGiao === null ? "Chưa xác nhận" : formatCurrency(shift.TienMatBanGiao)}
        ${shift.ThoiDiemXacNhanBanGiao ? ` · Người nhận ${esc(employeeName(state, shift.NguoiNhanBanGiao))}` : ""}</p>
      ${tableCard("Hóa đơn trong ca", `${summary.invoiceCount} hóa đơn`, ["Mã hóa đơn", "Ngày", "Tổng tiền"], invoices)}
      ${tableCard("Thanh toán gắn với ca", `${summary.payments.length} thanh toán`, ["Hóa đơn", "Mã thanh toán", "Ngày", "Số tiền", "Phương thức", "Trạng thái"], payments)}
      <p class="cell-muted">Bản in demo, không phải chứng từ kế toán hoặc chữ ký điện tử.</p></div></div>
    <div class="modal-footer"><button class="button" data-action="close-modal">Đóng</button><button class="button button-primary" data-action="print-shift-report-now">In báo cáo</button></div></section></div>`;
}

function render() {
  const state = getState();
  let content;
  switch (page) {
    case "tasks": content = renderTasks(); break;
    case "employees": content = renderEmployees(); break;
    case "accounts": content = renderAccounts(); break;
    case "roles": content = renderRoles(); break;
    case "categories": content = renderCategories(); break;
    case "products": content = renderProducts(); break;
    case "prices": content = renderPrices(); break;
    case "partners": content = renderPartners(); break;
    case "orders": content = renderOrders(); break;
    case "supplier-returns": content = renderSupplierReturns(); break;
    case "operations": content = renderOperations(); break;
    case "counts": content = renderCounts(); break;
    case "sales": content = renderSales(); break;
    case "finance": content = renderFinance(); break;
    case "reports": content = renderReports(); break;
    default: content = renderOverview();
  }
  document.querySelector("#page-content").innerHTML = content;
}

function field(label, name, value = "", type = "text", required = false, validation = false, nativeRequired = required) {
  return `<div class="field"><label>${esc(label)}${required ? " *" : ""}</label><input name="${esc(name)}" type="${type}" value="${esc(value ?? "")}" ${nativeRequired ? "required" : ""}>${validation ? `<small class="field-validation-error" data-field-error="${esc(name)}" aria-live="polite"></small>` : ""}</div>`;
}

function selectField(label, name, rows, valueField, labelField, selected = "", required = true, validation = false) {
  return `<div class="field"><label>${esc(label)}</label><select name="${esc(name)}" ${required ? "required" : ""}>${rows.map((row) => `<option value="${esc(row[valueField])}" ${row[valueField] === selected ? "selected" : ""}>${esc(row[labelField])}</option>`).join("")}</select>${validation ? `<small class="field-validation-error" data-field-error="${esc(name)}" aria-live="polite"></small>` : ""}</div>`;
}

function setPartnerFieldErrors(form, errors = {}, generalMessage = "") {
  const fieldNames = new Set();
  form.querySelectorAll("[data-field-error]").forEach((node) => {
    const name = node.dataset.fieldError;
    fieldNames.add(name);
    const message = errors[name] || "";
    node.textContent = message;
    node.classList.toggle("visible", Boolean(message));
    const field = node.closest(".field");
    field?.classList.toggle("has-error", Boolean(message));
    const input = field?.querySelector("input, select");
    if (input) input.setAttribute("aria-invalid", String(Boolean(message)));
  });
  const unbound = Object.entries(errors).filter(([name]) => !fieldNames.has(name)).map(([, message]) => message);
  const errorNode = form.querySelector("#partner-form-error");
  if (errorNode) {
    const message = [generalMessage, ...unbound].filter(Boolean).join(" ");
    errorNode.textContent = message;
    errorNode.classList.toggle("visible", Boolean(message));
  }
}

function openForm(titleText, fields, value, submitLabel, callback, options = {}) {
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><form class="modal manager-modal" id="manager-form"><div class="modal-header"><h2>${esc(titleText)}</h2><button type="button" class="button button-small" data-action="close-modal">Đóng</button></div><div class="modal-body">${options.validate ? `<div class="form-error" id="partner-form-error" aria-live="polite"></div>` : ""}${fields(value)}</div><div class="modal-footer"><button type="button" class="button" data-action="close-modal">Hủy</button><button class="button button-primary" type="submit">${esc(submitLabel)}</button></div></form></div>`;
  const form = document.querySelector("#manager-form");
  let validationAttempted = false;
  let serverFieldErrors = {};
  let serverGeneralError = "";
  const refreshErrors = (changedField = "") => {
    if (changedField) delete serverFieldErrors[changedField];
    serverGeneralError = "";
    const data = Object.fromEntries(new FormData(form).entries());
    setPartnerFieldErrors(form, { ...serverFieldErrors, ...(options.validate(data) || {}) }, serverGeneralError);
  };
  if (options.validate) {
    form.addEventListener("input", (event) => { if (validationAttempted) refreshErrors(event.target.name); });
    form.addEventListener("change", (event) => { if (validationAttempted) refreshErrors(event.target.name); });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (options.validate) {
      validationAttempted = true;
      serverFieldErrors = {};
      serverGeneralError = "";
      const fieldErrors = options.validate(data) || {};
      setPartnerFieldErrors(form, fieldErrors);
      if (Object.keys(fieldErrors).length) return;
    }
    try {
      await callback(data);
      closeModal();
      render();
      toast("Đã lưu thay đổi.");
    } catch (error) {
      if (options.validate) {
        serverFieldErrors = error.fieldErrors || {};
        serverGeneralError = Object.keys(serverFieldErrors).length ? "" : error.message || "Không thể lưu thay đổi.";
        setPartnerFieldErrors(form, serverFieldErrors, serverGeneralError);
      } else {
        toast(error.message || "Không thể lưu thay đổi.", true);
      }
    }
  });
  if (document.querySelector("#product-has-package")) updateProductPackagingControls(form);
}

function updateProductPackagingControls(form) {
  const enabled = form.querySelector("#product-has-package").checked;
  const fields = form.querySelector(".unit-conversion-fields");
  const name = form.querySelector("[name='HH_DViDongGoi']");
  const ratio = form.querySelector("[name='HH_TyLeQuyDoi']");
  fields.hidden = !enabled;
  name.disabled = !enabled;
  ratio.disabled = !enabled;
  name.required = enabled;
  ratio.required = enabled;
  const preview = form.querySelector("#product-unit-preview");
  const baseUnit = form.querySelector("[name='HH_DVi']").value.trim() || "đơn vị cơ bản";
  const packageName = name.value.trim() || "đơn vị đóng gói";
  const conversion = Number(ratio.value);
  preview.textContent = enabled && Number.isSafeInteger(conversion) && conversion > 0
    ? `1 ${packageName} = ${formatNumber(conversion)} ${baseUnit}`
    : enabled ? "Nhập đơn vị đóng gói và tỷ lệ là số nguyên dương." : "Sản phẩm chỉ sử dụng đơn vị cơ bản.";
}

function openPartnerDetails(state, id) {
  const partner = state.DoiTacKinhDoanh.find((row) => row.DT_Ma === id);
  if (!partner) return toast("Không tìm thấy đối tác.", true);
  const invoices = state.HoaDonBanHang.filter((row) => row.DT_Ma === id);
  const receipts = state.PhieuNhap.filter((row) => row.DT_Ma === id);
  const invoiceRows = invoices.map((invoice) => {
    const paid = state.ThanhToanBanHang.filter((row) => row.BH_Ma === invoice.BH_Ma && row.TTBH_TrangThai === "Thành công").reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0);
    return `<tr><td>${esc(invoice.BH_Ma)}</td><td>${formatDate(invoice.BH_Ngay)}</td><td>${statusBadge(invoice.BH_TrangThai)}</td><td>${formatCurrency(invoice.BH_TongCong)}</td><td>${formatCurrency(paid)}</td><td>${formatCurrency(Math.max(0, invoice.BH_TongCong - paid))}</td></tr>`;
  }).join("");
  const receiptRows = receipts.map((receipt) => {
    const debt = state.ChiTietNoNCC.find((row) => row.PN_Ma === receipt.PN_Ma);
    const payments = debt ? state.ThanhToanNCC.filter((row) => row.CTNNCC_Ma === debt.CTNNCC_Ma && row.TTNCC_TrangThai === "Thành công").reduce((sum, row) => sum + Number(row.TTNCC_SoTien || 0), 0) : 0;
    return `<tr><td>${esc(receipt.PN_Ma)}</td><td>${formatDate(receipt.PN_Ngay)}</td><td>${statusBadge(receipt.PN_TrangThai)}</td><td>${formatCurrency(receipt.PN_TongTien)}</td><td>${formatCurrency(debt?.CTNNCC_SoTienNo || 0)}</td><td>${formatCurrency(payments)}</td></tr>`;
  }).join("");
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal modal-wide"><div class="modal-header"><h2>Lịch sử đối tác · ${esc(partner.DT_Ten)}</h2><button type="button" class="button button-small" data-action="close-modal">Đóng</button></div><div class="modal-body">
    <div class="info-box">${esc(partner.DT_Ma)} · ${esc(partner.DT_Loai)} · ${statusBadge(partner.DT_TrangThai)}<br>Công nợ hiện tại: phải thu ${formatCurrency(partnerDebt(state, id).receivable)} · phải trả ${formatCurrency(partnerDebt(state, id).payable)}.</div>
    <div class="table-card"><div class="table-toolbar"><strong>Hóa đơn bán hàng</strong><span>${invoices.length} hóa đơn</span></div><div class="table-wrap"><table><thead><tr><th>Mã hóa đơn</th><th>Ngày</th><th>Trạng thái</th><th>Tổng tiền</th><th>Đã thu</th><th>Còn phải thu</th></tr></thead><tbody>${invoiceRows || `<tr><td colspan="6" class="empty-state">Chưa có hóa đơn.</td></tr>`}</tbody></table></div></div>
    <div class="table-card"><div class="table-toolbar"><strong>Phiếu nhập và thanh toán NCC</strong><span>${receipts.length} phiếu nhập</span></div><div class="table-wrap"><table><thead><tr><th>Phiếu nhập</th><th>Ngày</th><th>Trạng thái</th><th>Tổng tiền</th><th>Nợ ghi nhận</th><th>Đã thanh toán</th></tr></thead><tbody>${receiptRows || `<tr><td colspan="6" class="empty-state">Chưa có phiếu nhập.</td></tr>`}</tbody></table></div></div>
    </div><div class="modal-footer"><button class="button" data-action="close-modal">Đóng</button></div></section></div>`;
}

function closeModal() {
  document.querySelector("#modal-host").innerHTML = "";
}

function formActions(action, id) {
  const state = getState();
  if (action === "new-order") {
    openPurchaseOrderForm(state);
  } else if (action === "edit-order") {
    openPurchaseOrderForm(state, id);
  } else if (action === "view-order") {
    openPurchaseOrderDetails(state, id);
  } else if (action === "view-order-receipt") {
    openPurchaseReceiptDetails(state, id);
  } else if (action === "confirm-order") {
    if (!confirm(`Xác nhận đặt hàng ${id}? Hành động này không cập nhật tồn kho hoặc công nợ.`)) return;
    try {
      confirmPurchaseOrder(id, role);
      closeModal();
      render();
      toast(`Đơn ${id} đã chuyển sang trạng thái Chờ giao.`);
    } catch (error) { toast(error.message || "Không thể xác nhận đơn đặt hàng.", true); }
  } else if (action === "cancel-order") {
    if (!confirm(`Hủy đơn đặt hàng ${id}?`)) return;
    try {
      cancelPurchaseOrder(id, role);
      render();
      toast(`Đã hủy đơn ${id}. Tồn kho và công nợ không thay đổi.`);
    } catch (error) { toast(error.message || "Không thể hủy đơn đặt hàng.", true); }
  } else if (action === "new-employee" || action === "edit-employee") {
    const row = state.NhanVien.find((item) => item.NV_Ma === id) || {};
    openForm(row.NV_Ma ? "Cập nhật nhân viên" : "Thêm nhân viên", (data) => `${data.NV_Ma ? `<div class="field"><label>Mã nhân viên</label><input value="${esc(data.NV_Ma)}" disabled></div><input type="hidden" name="NV_Ma" value="${esc(data.NV_Ma)}">` : ""}${field("Họ tên", "NV_Ten", data.NV_Ten, "text", true)}${field("Số điện thoại", "NV_SDT", data.NV_SDT)}${field("Địa chỉ", "NV_DChi", data.NV_DChi)}${field("Ngày sinh", "NV_NgaySinh", data.NV_NgaySinh, "date")}${selectField("Giới tính", "NV_GioiTinh", [{ v: "", n: "Chưa cập nhật" }, { v: "Nam", n: "Nam" }, { v: "Nữ", n: "Nữ" }, { v: "Khác", n: "Khác" }], "v", "n", data.NV_GioiTinh || "", false)}${field("Ngày vào làm", "NV_NgayVaoLam", data.NV_NgayVaoLam || today(), "date")}${selectField("Trạng thái", "NV_TrangThai", [{ v: "Đang làm", n: "Đang làm" }, { v: "Nghỉ việc", n: "Nghỉ việc" }], "v", "n", data.NV_TrangThai || "Đang làm")}`, row, "Lưu nhân viên", (data) => saveEmployee(data, role));
  } else if (action === "new-account" || action === "edit-account") {
    const account = state.TaiKhoan.find((item) => item.TK_Ma === id) || {};
    const employees = state.NhanVien.filter((employee) => employee.NV_Ma === account.NV_Ma || (!state.TaiKhoan.some((row) => row.NV_Ma === employee.NV_Ma) && employee.NV_TrangThai !== "Nghỉ việc"));
    openForm(account.TK_Ma ? "Cập nhật tài khoản" : "Tạo tài khoản", (data) => `${selectField("Nhân viên", "NV_Ma", employees.map((row) => ({ ...row, optionName: `${row.NV_Ma} · ${row.NV_Ten}` })), "NV_Ma", "optionName", data.NV_Ma || employees[0]?.NV_Ma)}${field("Tên đăng nhập", "TK_TenDangNhap", data.TK_TenDangNhap, "text", true)}${field(account.TK_Ma ? "Mật khẩu mới (không bắt buộc)" : "Mật khẩu khởi tạo", "password", "", "password", !account.TK_Ma)}${selectField("Vai trò", "VT_Ma", state.VaiTro, "VT_Ma", "VT_Ten", data.VT_Ma || state.VaiTro[0]?.VT_Ma)}${account.TK_Ma ? selectField("Trạng thái", "TK_TrangThai", [{ v: "Hoạt động", n: "Hoạt động" }, { v: "Khóa", n: "Khóa" }], "v", "n", data.TK_TrangThai || "Hoạt động") : ""}`, account, "Lưu tài khoản", (data) => saveAccount({ ...account, ...data }, role));
  } else if (action === "new-category" || action === "edit-category") {
    const row = state.DanhMuc.find((item) => item.DM_Ma === id) || {};
    openForm(row.DM_Ma ? "Sửa danh mục" : "Thêm danh mục", (data) => `${field("Tên danh mục", "DM_Ten", data.DM_Ten, "text", true)}<div class="field"><label>Mô tả</label><textarea name="DM_MoTa">${esc(data.DM_MoTa || "")}</textarea></div>`, row, "Lưu danh mục", (data) => saveCategory({ ...row, ...data }, role));
  } else if (action === "new-product" || action === "edit-product") {
    const row = state.HangHoa.find((item) => item.HH_Ma === id) || {};
    const existingPackage = getUnitPackage(row);
    openForm(row.HH_Ma ? "Sửa hàng hóa" : "Thêm hàng hóa", (data) => `${selectField("Danh mục", "DM_Ma", state.DanhMuc, "DM_Ma", "DM_Ten", data.DM_Ma || state.DanhMuc[0]?.DM_Ma)}${field("Tên hàng hóa", "HH_Ten", data.HH_Ten, "text", true)}<div class="field"><label>Mã vạch sản phẩm</label><input name="HH_MaVach" type="text" inputmode="numeric" maxlength="32" autocomplete="off" value="${esc(data.HH_MaVach || "")}" placeholder="Để trống nếu chưa có mã"></div>
      <section class="unit-conversion-card"><div><strong>Quy đổi đơn vị tính</strong><p>Đơn vị cơ bản là đơn vị dùng để lưu nhập, tồn kho và hóa đơn.</p></div>
        <div class="field"><label>Đơn vị cơ bản *</label><input name="HH_DVi" value="${esc(data.HH_DVi || "")}" required maxlength="50" placeholder="Ví dụ: Chai"></div>
        <label class="unit-conversion-toggle"><input type="checkbox" name="HH_HasPackage" id="product-has-package" ${existingPackage ? "checked" : ""}><span>Có đơn vị đóng gói</span></label>
        <div class="unit-conversion-fields" ${existingPackage ? "" : "hidden"}>
          <div class="field"><label for="product-package-unit">Tên đơn vị đóng gói</label><input id="product-package-unit" name="HH_DViDongGoi" value="${esc(existingPackage?.name || "")}" maxlength="50" placeholder="Gói, lốc, thùng..."></div>
          <div class="field"><label for="product-package-ratio">Tỷ lệ quy đổi</label><input id="product-package-ratio" name="HH_TyLeQuyDoi" type="number" min="1" step="1" value="${existingPackage?.ratio ?? ""}" placeholder="Số đơn vị cơ bản"></div>
        </div>
        <div id="product-unit-preview" class="unit-conversion-preview" aria-live="polite"></div>
      </section>
      ${field("Đường dẫn hình ảnh", "HH_Hinh", data.HH_Hinh)}${selectField("Trạng thái", "HH_TrangThai", [{ v: "Đang kinh doanh", n: "Đang kinh doanh" }, { v: "Ngừng kinh doanh", n: "Ngừng kinh doanh" }], "v", "n", data.HH_TrangThai || "Đang kinh doanh")}`, row, "Lưu hàng hóa", (data) => {
      const current = getState().HangHoa.find((item) => item.HH_Ma === row.HH_Ma);
      const nextPackageName = data.HH_HasPackage === "on" ? String(data.HH_DViDongGoi || "").trim() : "";
      const nextRatio = data.HH_HasPackage === "on" ? Number(data.HH_TyLeQuyDoi) : null;
      const changed = current && (
        String(current.HH_DVi || "").trim() !== String(data.HH_DVi || "").trim()
        || String(current.HH_DViDongGoi || "").trim() !== nextPackageName
        || (current.HH_TyLeQuyDoi === null || current.HH_TyLeQuyDoi === undefined ? null : Number(current.HH_TyLeQuyDoi)) !== nextRatio
      );
      if (changed && hasProductUnitHistory(getState(), row.HH_Ma)) {
        if (!confirm("Hàng hóa đã phát sinh nhập kho, bán hàng hoặc hóa đơn nháp. Thay đổi quy cách có thể ảnh hưởng cách diễn giải chứng từ cũ. Bạn có chắc muốn tiếp tục?")) {
          throw new Error("Đã hủy thay đổi quy cách đơn vị.");
        }
        data.HH_ConfirmUnitChange = "true";
      }
      data.HH_DViDongGoi = nextPackageName;
      data.HH_TyLeQuyDoi = nextRatio;
      return saveProduct({ ...row, ...data }, role);
    });
  } else if (action === "new-price" || action === "edit-price") {
    const row = state.GiaBan.find((item) => item.GB_Ma === id) || {};
    openForm(row.GB_Ma ? "Chỉnh sửa mức giá" : "Tạo mức giá", (data) => `${selectField("Mặt hàng", "HH_Ma", state.HangHoa, "HH_Ma", "HH_Ten", data.HH_Ma || state.HangHoa[0]?.HH_Ma)}${field("Đơn giá (VND)", "GB_DonGia", data.GB_DonGia, "number", true)}${field("Ngày bắt đầu", "GB_NgayBD", data.GB_NgayBD || today(), "date", true)}${field("Ngày kết thúc", "GB_NgayKT", data.GB_NgayKT, "date")}${selectField("Trạng thái", "GB_TrangThai", [{ v: "Đang áp dụng", n: "Đang áp dụng" }, { v: "Ngừng áp dụng", n: "Ngừng áp dụng" }], "v", "n", data.GB_TrangThai || "Đang áp dụng")}`, row, "Lưu mức giá", (data) => savePrice({ ...row, ...data }, role));
  } else if (action === "new-partner" || action === "edit-partner") {
    const row = state.DoiTacKinhDoanh.find((item) => item.DT_Ma === id) || {};
    openForm(row.DT_Ma ? "Cập nhật đối tác" : "Thêm đối tác", (data) => `${field("Tên đối tác", "DT_Ten", data.DT_Ten, "text", true, true, false)}${field("Số điện thoại", "DT_SDT", data.DT_SDT, "text", false, true)}${field("Địa chỉ", "DT_DChi", data.DT_DChi, "text", false, true)}${selectField("Loại", "DT_Loai", [{ v: "Khách hàng", n: "Khách hàng" }, { v: "Nhà cung cấp", n: "Nhà cung cấp" }], "v", "n", data.DT_Loai || "Khách hàng", true, true)}${field("Số tài khoản", "DT_STK", data.DT_STK, "text", false, true)}${selectField("Trạng thái", "DT_TrangThai", [{ v: "Hoạt động", n: "Hoạt động" }, { v: "Ngừng hoạt động", n: "Ngừng hoạt động" }], "v", "n", data.DT_TrangThai || "Hoạt động", true, true)}`, row, "Lưu đối tác", (data) => savePartner({ ...row, ...data }, role), {
      validate: (data) => validatePartnerData({ ...row, ...data }, getState().DoiTacKinhDoanh)
    });
  } else if (action === "end-price") {
    const date = prompt("Ngày kết thúc mức giá (YYYY-MM-DD):", today());
    if (date && confirm(`Kết thúc mức giá ${id} vào ${date}?`)) {
      try { endPrice(id, date, role); render(); toast("Đã kết thúc mức giá."); }
      catch (error) { toast(error.message, true); }
    }
  } else if (action === "toggle-account") {
    const account = state.TaiKhoan.find((row) => row.TK_Ma === id);
    if (!account) return;
    const updated = { ...account, TK_TrangThai: account.TK_TrangThai === "Khóa" ? "Hoạt động" : "Khóa" };
    if (confirm(`${updated.TK_TrangThai === "Khóa" ? "Khóa" : "Mở khóa"} tài khoản ${account.TK_TenDangNhap}?`)) {
      saveAccount(updated, role).then(() => { render(); toast("Đã cập nhật trạng thái tài khoản."); }).catch((error) => toast(error.message, true));
    }
  } else if (action === "view-supplier-return") {
    viewSupplierReturn(id);
  } else if (action === "view-partner") {
    openPartnerDetails(state, id);
  }
}

function toast(message, error = false) {
  const host = document.querySelector("#toast-host");
  if (!host) return;
  host.innerHTML = `<div class="manager-toast ${error ? "error" : ""}">${esc(message)}</div>`;
  setTimeout(() => { if (host) host.innerHTML = ""; }, 3500);
}

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "report-tab") {
      reportTab = button.dataset.tab;
      render();
      return;
    }
    if (action === "close-modal") {
      if (button.classList.contains("modal-backdrop") && event.target !== button) return;
      closeModal();
      return;
    }
    if (action === "view-cash-shift") return openOwnerCashShiftDetail(button.dataset.id);
    if (action === "print-cash-shift-report") {
      const state = getState();
      const shifts = getCashShifts().filter((shift) => {
        const day = String(shift.GioMo || "").slice(0, 10);
        return (!reportFilters.from || day >= reportFilters.from) && (!reportFilters.to || day <= reportFilters.to)
          && (!reportFilters.location || shift.DD_Ma === reportFilters.location);
      }).sort((a, b) => String(b.GioMo).localeCompare(String(a.GioMo)));
      document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal modal-wide">
        <div class="modal-header"><h2>Báo cáo ca bán hàng</h2><button class="button button-small" data-action="close-modal">Đóng</button></div>
        <div class="modal-body">${ownerCashShiftPrintMarkup(state, shifts)}</div>
        <div class="modal-footer"><button class="button" data-action="close-modal">Đóng</button><button class="button button-primary" data-action="print-shift-report-now">In báo cáo</button></div></section></div>`;
      return;
    }
    if (action === "print-shift-report-now") {
      window.print();
      return;
    }
    if (action === "orders-page") {
      orderPage = Math.max(1, Number(button.dataset.page) || 1);
      render();
    } else if (action === "clear-order-filters") {
      orderFilters = { search: "", status: "", from: "", to: "" };
      orderPage = 1;
      render();
    } else if (action === "add-order-line") {
      const state = getState();
      document.querySelector("#order-lines").insertAdjacentHTML("beforeend", purchaseOrderLineRow(state));
      updateOrderTotals();
    } else if (action === "remove-order-line") {
      button.closest("tr").remove();
      updateOrderTotals();
    } else if (action === "save-confirm-order") {
      savePurchaseOrderForm(true);
    } else if (action === "filter-overview") {
      const query = new URLSearchParams();
      ["from", "to", "location"].forEach((key) => {
        const value = document.querySelector(`#overview-${key}`)?.value;
        if (value) query.set(key, value);
      });
      overviewFilters = Object.fromEntries(query.entries());
      render();
    } else if (action === "filter-report") {
      reportFilters = {
        from: document.querySelector("#report-from")?.value || "",
        to: document.querySelector("#report-to")?.value || "",
        location: document.querySelector("#report-location")?.value || ""
      };
      render();
    } else if (action === "approve-count") {
      if (!confirm(`Duyệt phiếu ${button.dataset.id} và áp dụng điều chỉnh tồn?`)) return;
      try {
        approveManagerCount(button.dataset.id, role, getState().NhanVien[0]?.NV_Ma);
        render();
        toast("Đã duyệt kiểm kê; tồn và biến động kho đã cập nhật.");
      } catch (error) {
        toast(error.message || "Không thể duyệt phiếu.", true);
      }
    } else if (action === "approve-supplier-return") {
      if (!confirm(`Duyệt yêu cầu trả ${button.dataset.id}? Tồn chỉ giảm khi Kho xác nhận xuất.`)) return;
      try {
        approveSupplierReturn(button.dataset.id, getState().NhanVien[0]?.NV_Ma, role);
        render();
        toast(`Đã duyệt ${button.dataset.id}; tồn kho chưa thay đổi.`);
      } catch (error) {
        toast(error.message || "Không thể duyệt phiếu trả.", true);
      }
    } else if (action === "reject-supplier-return") {
      if (!confirm(`Từ chối yêu cầu trả ${button.dataset.id}?`)) return;
      try {
        rejectSupplierReturn(button.dataset.id, getState().NhanVien[0]?.NV_Ma, role);
        render();
        toast(`Đã từ chối yêu cầu ${button.dataset.id}.`);
      } catch (error) {
        toast(error.message || "Không thể từ chối phiếu trả.", true);
      }
    } else {
      formActions(action, button.dataset.id);
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.closest("#manager-form") && event.target.matches("[name='HH_DVi'], [name='HH_DViDongGoi'], [name='HH_TyLeQuyDoi']")) {
      updateProductPackagingControls(event.target.form);
    }
    if (event.target.matches("#order-item-search")) {
      const query = event.target.value.trim().toLocaleLowerCase("vi-VN");
      document.querySelectorAll("#order-lines select[name='HH_Ma'] option").forEach((option) => {
        option.hidden = Boolean(query) && option.value && !option.textContent.toLocaleLowerCase("vi-VN").includes(query);
      });
    }
    if (event.target.closest("#purchase-order-form") && event.target.matches("[name='DN_SL_Nhap'], [name='DN_DonGia_Nhap']")) {
      updateOrderTotals();
    }
    if (!event.target.matches("[data-table-search]")) return;
    applyTableFilters();
  });
  document.addEventListener("change", (event) => {
    if (event.target.matches("#order-lines [name='HH_Ma']")) {
      const selectedId = event.target.value;
      const duplicate = [...document.querySelectorAll("#order-lines [name='HH_Ma']")].some((select) => select !== event.target && select.value === selectedId);
      if (selectedId && duplicate) {
        event.target.value = "";
        toast("Mặt hàng đã có trong đơn; hãy tăng số lượng ở dòng hiện có.", true);
      }
      updateOrderLine(event.target.closest(".purchase-order-line"));
      return;
    }
    if (event.target.matches("#order-lines [name='DN_DonVi']")) {
      updateOrderTotals();
      return;
    }
    if (event.target.id === "product-has-package") {
      updateProductPackagingControls(event.target.form);
      return;
    }
    if (!event.target.matches("[data-table-filter]")) return;
    applyTableFilters();
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id === "purchase-order-filters") {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.target).entries());
      orderFilters = {
        search: String(values.search || "").trim(),
        status: String(values.status || ""),
        from: String(values.from || ""),
        to: String(values.to || "")
      };
      orderPage = 1;
      render();
    } else if (event.target.id === "purchase-order-form") {
      event.preventDefault();
      savePurchaseOrderForm(false);
    }
  });
}

function applyTableFilters() {
  const query = document.querySelector("[data-table-search]")?.value.trim().toLocaleLowerCase("vi-VN") || "";
  const value = document.querySelector("[data-table-filter]")?.value || "";
  document.querySelectorAll("[data-search-row]").forEach((row) => {
    const matchesSearch = row.textContent.toLocaleLowerCase("vi-VN").includes(query);
    const matchesFilter = !value || row.dataset.type === value || row.dataset.category === value || row.textContent.includes(value);
    row.hidden = !matchesSearch || !matchesFilter;
  });
}

document.addEventListener("DOMContentLoaded", shell);
