import { getState, resetDemoData, saveInbound, submitInboundForReview, cancelInbound, createTransfer, dispatchTransfer, receiveTransfer, createCount, submitCount, approveCount } from "../../services/kho-service.js";
import { DEMO_THRESHOLD_DAYS } from "../../data/kho-mock-data.js";
import { getReplenishmentItems, getValidSaleLots, LOW_STOCK_THRESHOLD } from "../../services/inventory-service.js";
import { buildStockLedgerReport } from "../../services/stock-ledger-service.js";
import { getPurchaseOrderSummary } from "../../services/purchase-order-service.js";
import { getPurchaseOrderAvailableQuantities, PURCHASE_ORDER_STATUSES } from "../../services/purchase-order-utils.js";
import {
  approveSupplierReturn, cancelSupplierReturn, confirmSupplierReturn, deleteDraftSupplierReturn,
  getSupplierReturnLineAvailability, getSupplierReturns, rejectSupplierReturn, saveSupplierReturn,
  submitSupplierReturn, SUPPLIER_RETURN_STATUSES
} from "../../services/supplier-return-service.js";
import { formatBaseQuantity, getUnitPackage, toBaseQuantity, toBaseUnitPrice } from "../../services/unit-service.js";
import { escapeHtml as esc, formatCurrency, formatDate, formatNumber } from "../../utils/formatters.js";

const page = document.body.dataset.page;
const pages = [
  ["overview", "Tổng quan kho", "tong-quan-kho.html", "▦"],
  ["receipts", "Phiếu nhập kho", "phieu-nhap.html", "⇩"],
  ["transfers", "Xuất chuyển nội bộ", "xuat-chuyen-noi-bo.html", "⇄"],
  ["returns", "Trả hàng nhà cung cấp", "tra-hang-ncc.html", "↩"],
  ["stock", "Theo dõi tồn kho", "ton-kho.html", "▤"],
  ["ledger", "Thẻ kho", "the-kho.html", "▥"],
  ["counts", "Kiểm kê kho", "kiem-ke-kho.html", "✓"],
  ["movements", "Biến động kho", "bien-dong-kho.html", "↗"],
  ["expiry", "Hạn sử dụng", "han-su-dung.html", "◷"]
];
const pageTitle = pages.find(([key]) => key === page)?.[1] || "Quản lý kho";
const roleOptions = ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán", "Nhân viên bán hàng"];
const roleEmployees = { "Chủ cửa hàng": "NV001", "Nhân viên kho": "NV002", "Nhân viên kế toán": "NV003", "Nhân viên bán hàng": "NV004" };
const supplierReturnReasons = ["Hàng hư hỏng", "Hàng lỗi chất lượng", "Hàng giao sai", "Hàng không đúng quy cách", "Hàng gần hết hạn", "Lý do khác"];
let role = localStorage.getItem("stmn-kho-demo-role") || "Nhân viên kho";
let stockMode = "summary";
let transferTab = "";
const today = () => new Date().toISOString().slice(0, 10);
let stockLedgerFilters = {
  locationId: "",
  itemId: "",
  lineId: "",
  from: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`,
  to: today(),
  movementType: "all"
};
let stockLedgerPage = 1;
const stockLedgerPageSize = 20;
let returnFilters = { search: "", status: "", from: "", to: "" };
let returnPage = 1;
const returnPageSize = 10;

const nameOf = (state, table, key, idField, nameField) => state[table].find((row) => row[idField] === key)?.[nameField] || "—";
const product = (state, id) => state.HangHoa.find((row) => row.HH_Ma === id);
const detail = (state, id) => state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === id);
const locationName = (state, id) => nameOf(state, "DiaDiem", id, "DD_Ma", "DD_Ten");
const employeeName = (state, id) => nameOf(state, "NhanVien", id, "NV_Ma", "NV_Ten");
const supplierName = (state, id) => nameOf(state, "DoiTacKinhDoanh", id, "DT_Ma", "DT_Ten");
const productName = (state, id) => product(state, id)?.HH_Ten || id || "—";
const stockQty = (state, locationId, lineId) => state.TonKho.find((row) => row.DD_Ma === locationId && row.PNCT_Ma === lineId)?.TK_SL || 0;
const isOwner = () => role === "Chủ cửa hàng";
const canManageReceipts = () => role === "Nhân viên kho" || isOwner();
const canCreateTransfer = () => role === "Nhân viên kế toán" || isOwner();
const canDispatch = () => role === "Nhân viên kho" || isOwner();
const canReceive = () => role === "Nhân viên bán hàng" || isOwner();
const canCount = () => role === "Nhân viên kho" || isOwner();
const canManageReturns = () => role === "Nhân viên kho" || isOwner();
const returnsReadOnly = () => new URLSearchParams(location.search).get("readonly") === "1"
  || !canManageReturns();

function badge(status) {
  const tone = ({
    "Đã xác nhận": "green", "Đã duyệt": "green", "Đã xuất trả": "green", "Hoàn tất": "green",
    "Đang chuyển": "blue", "Chờ giao": "blue", "Chờ kế toán xác nhận": "amber", "Chờ xuất": "amber", "Chờ duyệt": "amber",
    "Cần đối chiếu": "red", "Chờ đối chiếu": "red", "Đã hủy": "gray", "Nháp": "gray",
    "Còn hạn": "green", "Sắp hết hạn": "amber", "Đã hết hạn": "red", "Không áp dụng HSD": "gray",
    "Hết hàng tại cửa hàng, kho còn": "amber", "Hết hàng tại cửa hàng, nơi khác còn": "amber",
    "Sắp hết hàng tại cửa hàng": "amber", "Hết hàng toàn hệ thống": "red",
    "Có tồn nhưng không khả dụng": "red", "Ngừng kinh doanh": "gray", "Đủ hàng": "green"
  })[status] || "gray";
  return `<span class="badge badge-${tone}">${esc(status || "—")}</span>`;
}

function emptyRow(columns, text = "Không có dữ liệu phù hợp.") {
  return `<tr><td colspan="${columns}" class="empty-state">${esc(text)}</td></tr>`;
}

function optionList(rows, valueField, labelField, selected = "", first = "") {
  return `${first ? `<option value="">${esc(first)}</option>` : ""}${rows.map((row) => `<option value="${esc(row[valueField])}" ${row[valueField] === selected ? "selected" : ""}>${esc(row[labelField])}</option>`).join("")}`;
}

function shell() {
  const state = getState();
  const selectedLocation = localStorage.getItem("stmn-kho-demo-location") || "";
  const activeLink = pages.map(([key, label, file, icon]) => `
    <a class="nav-link ${page === key ? "active" : ""}" href="${file}" title="${label}">
      <span class="nav-icon">${icon}</span><span class="nav-text">${label}</span>
    </a>`).join("");
  const salesLinks = [
    ["Tổng quan bán hàng", "tong-quan-ban-hang.html", "▦"],
    ["Bán hàng tại quầy", "ban-hang.html", "▣"],
    ["Hóa đơn bán hàng", "hoa-don.html", "▤"],
    ["Thanh toán", "thanh-toan.html", "＄"],
    ["Khách hàng", "khach-hang.html", "♙"],
    ["Công nợ khách hàng", "cong-no-khach-hang.html", "◷"]
  ].map(([label, file, icon]) => `<a class="nav-link" href="../ban-hang-ke-toan/${file}" title="${label}"><span class="nav-icon">${icon}</span><span class="nav-text">${label}</span></a>`).join("");
  const accountingLinks = [
    ["Tổng quan kế toán", "tong-quan-ke-toan.html", "▦"],
    ["Đối chiếu nhập hàng", "doi-chieu-nhap-hang.html", "⇩"],
    ["Đối chiếu chứng từ kho", "doi-chieu-chung-tu-kho.html", "⇄"],
    ["Công nợ nhà cung cấp", "cong-no-ncc.html", "◷"],
    ["Thanh toán NCC", "thanh-toan-ncc.html", "＄"],
    ["Phiếu thu", "phieu-thu.html", "＋"],
    ["Phiếu chi", "phieu-chi.html", "－"],
    ["Đối soát doanh thu", "doi-soat-doanh-thu.html", "▤"],
    ["Đối soát thanh toán", "doi-soat-thanh-toan.html", "✓"],
    ["Báo cáo kế toán", "bao-cao-ke-toan.html", "▥"]
  ].map(([label, file, icon]) => `<a class="nav-link" href="../ban-hang-ke-toan/${file}" title="${label}"><span class="nav-icon">${icon}</span><span class="nav-text">${label}</span></a>`).join("");
  document.querySelector("#app").innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="tong-quan-kho.html"><span class="brand-mark">S</span><div><strong>Siêu thị mini</strong><small>Hệ thống quản lý</small></div></a>
        <a class="nav-link" href="../chu-cua-hang/tong-quan.html"><span class="nav-icon">⌂</span><span class="nav-text">Chủ cửa hàng</span></a>
        <div class="nav-label">Phân hệ kho</div>${activeLink}
        <div class="module-label">Bán hàng</div>${salesLinks}
        <div class="module-label">Kế toán</div>${accountingLinks}
        <div class="sidebar-bottom">Bản demo giao diện kho<br>Mock data · lưu trên trình duyệt</div>
      </aside>
      <main class="main-area">
        <header class="topbar">
          <div><div class="topbar-title">${pageTitle}</div><div class="topbar-subtitle">Quản lý kho hàng · Bản mô phỏng nghiệp vụ</div></div>
          <div class="topbar-actions">
            <select id="global-location" aria-label="Địa điểm hiển thị">
              <option value="" ${selectedLocation === "" ? "selected" : ""}>Tất cả địa điểm</option>
              ${optionList(state.DiaDiem, "DD_Ma", "DD_Ten", selectedLocation)}
            </select>
            <select id="global-role" aria-label="Vai trò demo">${roleOptions.map((name) => `<option ${role === name ? "selected" : ""}>${name}</option>`).join("")}</select>
            <span class="user-role">${employeeName(state, roleEmployees[role])}</span>
            <button class="button button-small" data-action="reset">Khôi phục demo</button>
          </div>
        </header>
        <section class="content" id="page-content"></section>
      </main>
    </div>
    <div id="modal-host"></div>`;
  renderContent();
    const transferQuery = new URLSearchParams(location.search);
    if (page === "transfers" && transferQuery.get("create") === "1") {
      openTransferForm(getState(), {
        DD_Xuat: transferQuery.get("source") || "",
        DD_Nhan: transferQuery.get("destination") || "",
        HH_Ma: transferQuery.get("product") || ""
      });
    }
}

function heading(title, description, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${action}</div></div>`;
}

function tableCard(title, subtitle, headers, rows, note = "") {
  return `<div class="table-card">
    <div class="table-toolbar"><strong>${title}</strong><span>${subtitle}</span></div>
    <div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows || emptyRow(headers.length)}</tbody></table></div>
    ${note ? `<div class="table-subnote">${note}</div>` : ""}
  </div>`;
}

function currentLocationFilter() {
  return localStorage.getItem("stmn-kho-demo-location") || "";
}

function filteredStock(state) {
  const place = currentLocationFilter();
  return state.TonKho.filter((row) => row.TK_SL > 0 && (!place || row.DD_Ma === place));
}

function expiryRows(state) {
  const now = new Date(`${today()}T00:00:00`);
  return filteredStock(state).map((stock) => {
    const line = detail(state, stock.PNCT_Ma);
    if (!line) return null;
    const days = line.PNCT_HSD ? Math.ceil((new Date(`${line.PNCT_HSD}T00:00:00`) - now) / 86400000) : null;
    const threshold = line.PNCT_HSDToiThieu ?? DEMO_THRESHOLD_DAYS;
    const status = days === null ? "Không áp dụng HSD" : days < 0 ? "Đã hết hạn" : days <= threshold ? "Sắp hết hạn" : "Còn hạn";
    return { stock, line, item: product(state, line.HH_Ma), days, threshold, status };
  }).filter(Boolean);
}

function renderOverview(state) {
  const stockRows = filteredStock(state);
  const products = new Set(stockRows.map((row) => detail(state, row.PNCT_Ma)?.HH_Ma).filter(Boolean));
  const qty = stockRows.reduce((sum, row) => sum + row.TK_SL, 0);
  const pendingReceipts = state.PhieuNhap.filter((row) => row.PN_TrangThai === "Nháp").length;
  const activeTransfers = state.PhieuXuatChuyenNoiBo.filter((row) => ["Chờ xuất", "Đang chuyển", "Chờ đối chiếu", "Cần đối chiếu"].includes(row.PXCN_TrangThai)).length;
  const pendingCounts = state.PhieuKiemKeKho.filter((row) => row.PKK_TrangThai === "Chờ duyệt").length;
  const expiring = expiryRows(state).filter((row) => row.days !== null && row.days >= 0 && row.days <= row.threshold);
  const tasks = [
    ...state.PhieuNhap.filter((row) => row.PN_TrangThai === "Nháp").map((row) => ({ label: `Xác nhận phiếu nhập ${row.PN_Ma}`, meta: `${supplierName(state, row.DT_Ma)} · ${formatDate(row.PN_Ngay)}`, url: "phieu-nhap.html", tag: "Chờ xử lý" })),
    ...state.PhieuXuatChuyenNoiBo.filter((row) => ["Chờ xuất", "Đang chuyển", "Chờ đối chiếu", "Cần đối chiếu"].includes(row.PXCN_TrangThai)).map((row) => ({ label: `${row.PXCN_Ma} · ${row.PXCN_TrangThai}`, meta: `${locationName(state, row.DD_Xuat)} → ${locationName(state, row.DD_Nhan)}`, url: "xuat-chuyen-noi-bo.html", tag: row.PXCN_TrangThai })),
    ...state.PhieuKiemKeKho.filter((row) => row.PKK_TrangThai === "Chờ duyệt").map((row) => ({ label: `Duyệt phiếu kiểm kê ${row.PKK_Ma}`, meta: `${locationName(state, row.DD_Ma)} · ${employeeName(state, row.NV_Ma)}`, url: "kiem-ke-kho.html", tag: "Chờ duyệt" }))
  ];
  const taskRows = tasks.length ? tasks.slice(0, 6).map((task) => `<div class="task-item"><div><strong>${esc(task.label)}</strong><small>${esc(task.meta)}</small></div><a class="text-link" href="${task.url}">${esc(task.tag)} →</a></div>`).join("") : `<div class="empty-state">Không có công việc cần xử lý.</div>`;
  const expRows = expiring.slice(0, 5).map(({ stock, line, item, days }) => `<tr><td class="cell-primary">${esc(item?.HH_Ten)}</td><td>${esc(line.PNCT_Ma)}</td><td>${esc(locationName(state, stock.DD_Ma))}</td><td>${formatDate(line.PNCT_HSD)}</td><td class="${days <= 7 ? "negative" : ""}">${days} ngày</td><td>${formatNumber(stock.TK_SL)}</td></tr>`).join("");
  const movements = [...state.BienDongKho].sort((a, b) => b.BDK_Ngay.localeCompare(a.BDK_Ngay)).slice(0, 6).map((row) => `<tr><td>${formatDate(row.BDK_Ngay)}<div class="cell-muted">${esc(row.BDK_Ma)}</div></td><td>${esc(productName(state, detail(state, row.PNCT_Ma)?.HH_Ma))}</td><td>${esc(locationName(state, row.DD_Ma))}</td><td>${esc(row.BDK_Loai)}</td><td class="${row.BDK_SoLuong > 0 ? "positive" : "negative"}">${row.BDK_SoLuong > 0 ? "+" : "−"}${formatNumber(Math.abs(row.BDK_SoLuong))}</td></tr>`).join("");
  const placeText = currentLocationFilter() ? locationName(state, currentLocationFilter()) : "Toàn hệ thống";
  return `${heading("Tổng quan kho", `Chỉ số tổng hợp theo dữ liệu nghiệp vụ · ${esc(placeText)}`, `<a class="button button-primary" href="phieu-nhap.html">＋ Tạo phiếu nhập</a>`)}
    <div class="metric-grid">
      <div class="metric-card"><div class="metric-title">Mặt hàng đang có tồn</div><div class="metric-value">${formatNumber(products.size)}</div><div class="metric-caption">Tại địa điểm đang chọn</div></div>
      <div class="metric-card"><div class="metric-title">Tổng số lượng tồn</div><div class="metric-value">${formatNumber(qty)}</div><div class="metric-caption">Tổng các dòng nhập còn hàng</div></div>
      <div class="metric-card"><div class="metric-title">Phiếu nhập chờ xử lý</div><div class="metric-value">${formatNumber(pendingReceipts)}</div><div class="metric-caption">Chưa ghi nhận tăng tồn</div></div>
      <div class="metric-card"><div class="metric-title">Phiếu chuyển đang thực hiện</div><div class="metric-value">${formatNumber(activeTransfers)}</div><div class="metric-caption">Chờ xuất, đang chuyển hoặc đối chiếu</div></div>
      <div class="metric-card"><div class="metric-title">Kiểm kê chờ duyệt</div><div class="metric-value">${formatNumber(pendingCounts)}</div><div class="metric-caption">Chưa điều chỉnh tồn</div></div>
      <div class="metric-card"><div class="metric-title">Dòng hàng sắp hết hạn</div><div class="metric-value">${formatNumber(expiring.length)}</div><div class="metric-caption">Theo ngưỡng trên dòng nhập / demo ${DEMO_THRESHOLD_DAYS} ngày</div></div>
    </div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-title">Công việc cần xử lý <span class="badge badge-amber">${tasks.length}</span></div><div class="task-list">${taskRows}</div></section>
      ${tableCard("Hàng sắp hết hạn", "Theo tồn hiện tại", ["Mặt hàng", "Mã dòng nhập", "Địa điểm", "Hạn sử dụng", "Còn lại", "Tồn"], expRows)}
    </div>
    ${tableCard("Biến động kho gần đây", "Dữ liệu từ BienDongKho", ["Thời gian", "Mặt hàng", "Địa điểm", "Loại", "Thay đổi"], movements)}`;
}

function filtersMarkup(items) {
  return `<div class="filters">${items.join("")}<button class="button" type="button" data-action="clear-filters">Xóa lọc</button></div>`;
}
function searchField(label = "Tìm kiếm", placeholder = "Nhập từ khóa…") {
  return `<div class="field grow"><label>${label}</label><input class="filter-control" data-filter="search" placeholder="${placeholder}"></div>`;
}
function selectFilter(field, label, options, first = "Tất cả") {
  return `<div class="field"><label>${label}</label><select class="filter-control" data-filter="${field}"><option value="">${first}</option>${options.map(([value, text]) => `<option value="${esc(value)}">${esc(text)}</option>`).join("")}</select></div>`;
}
function dateFilter(field, label) {
  return `<div class="field"><label>${label}</label><input class="filter-control" type="date" data-filter="${field}"></div>`;
}

function searchableRow(search, attrs, cells) {
  const attrText = Object.entries(attrs).map(([key, value]) => `data-${key}="${esc(value ?? "")}"`).join(" ");
  return `<tr data-search="${esc(search).toLocaleLowerCase("vi-VN")}" ${attrText}>${cells}</tr>`;
}

function renderReceipts(state) {
  const statusOptions = [...new Set(state.PhieuNhap.map((row) => row.PN_TrangThai))].map((status) => [status, status]);
  const rowHtml = state.PhieuNhap.slice().sort((a, b) => b.PN_Ngay.localeCompare(a.PN_Ngay)).map((row) => {
    const order = row.DH_Ma || "—";
    const actions = `<div class="inline-actions"><button class="button button-small" data-action="view-receipt" data-id="${row.PN_Ma}">Chi tiết</button>
      ${row.PN_TrangThai === "Nháp" && canManageReceipts() ? `<button class="button button-small" data-action="edit-receipt" data-id="${row.PN_Ma}">Sửa</button><button class="button button-small button-primary" data-action="submit-receipt-review" data-id="${row.PN_Ma}">Gửi kế toán</button><button class="button button-small button-danger" data-action="cancel-receipt" data-id="${row.PN_Ma}">Hủy</button>` : ""}</div>`;
    return searchableRow(`${row.PN_Ma} ${supplierName(state, row.DT_Ma)} ${order} ${locationName(state, row.DD_Ma)} ${row.PN_TrangThai}`, {
        status: row.PN_TrangThai, location: row.DD_Ma, supplier: row.DT_Ma, from: row.PN_Ngay, to: row.PN_Ngay
    }, `<td class="cell-primary">${esc(row.PN_Ma)}</td><td>${esc(supplierName(state, row.DT_Ma))}</td><td>${esc(order)}</td><td>${esc(locationName(state, row.DD_Ma))}</td><td>${formatDate(row.PN_Ngay)}</td><td>${formatNumber(row.PN_TongSL)}</td><td>${formatCurrency(row.PN_TongTien)}</td><td>${badge(row.PN_TrangThai)}</td><td>${actions}</td>`);
  }).join("");
  const filters = filtersMarkup([
    searchField("Tìm mã phiếu / đối tác", "Mã phiếu, nhà cung cấp…"),
    selectFilter("supplier", "Nhà cung cấp", state.DoiTacKinhDoanh.map((row) => [row.DT_Ma, row.DT_Ten])),
    selectFilter("location", "Địa điểm", state.DiaDiem.map((row) => [row.DD_Ma, row.DD_Ten])),
    dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày"),
    selectFilter("status", "Trạng thái", statusOptions)
  ]);
  return `${heading("Quản lý phiếu nhập", "Theo dõi chứng từ nhập và đối chiếu với đơn đặt hàng.", canManageReceipts() ? `<button class="button" data-action="new-receipt-from-order">Tạo từ đơn đặt hàng</button><button class="button button-primary" data-action="new-receipt">＋ Tạo phiếu nhập</button>` : "")}
    ${filters}${tableCard("Danh sách phiếu nhập", `${state.PhieuNhap.length} phiếu`, ["Mã phiếu", "Nhà cung cấp", "Đơn đặt hàng", "Địa điểm nhập", "Ngày nhập", "Tổng SL", "Tổng tiền", "Trạng thái", "Thao tác"], rowHtml, "Phiếu nháp chưa tác động tồn. Xác nhận nhập ghi nhận tồn và biến động kho; nghiệp vụ công nợ/thanh toán không thuộc màn hình này.")}`;
}

function stockSummaryRows(state) {
  const grouped = new Map();
  for (const stock of filteredStock(state)) {
    const line = detail(state, stock.PNCT_Ma);
    if (!line) continue;
    const item = product(state, line.HH_Ma);
    const key = `${line.HH_Ma}|${stock.DD_Ma}`;
    const current = grouped.get(key) || { item, DD_Ma: stock.DD_Ma, quantity: 0 };
    current.quantity += stock.TK_SL;
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => a.item.HH_Ma.localeCompare(b.item.HH_Ma)).map(({ item, DD_Ma, quantity }) => searchableRow(`${item.HH_Ma} ${item.HH_MaVach || ""} ${item.HH_Ten} ${nameOf(state, "DanhMuc", item.DM_Ma, "DM_Ma", "DM_Ten")} ${locationName(state, DD_Ma)}`, {
    location: DD_Ma, category: item.DM_Ma
  }, `<td>${esc(item.HH_Ma)}</td><td>${esc(item.HH_MaVach || "—")}</td><td class="cell-primary">${esc(item.HH_Ten)}</td><td>${esc(nameOf(state, "DanhMuc", item.DM_Ma, "DM_Ma", "DM_Ten"))}</td><td>${esc(item.HH_DVi)}</td><td>${esc(locationName(state, DD_Ma))}</td><td>${esc(formatBaseQuantity(quantity, item))}</td><td>${quantity <= 10 ? '<span class="badge badge-amber">Sắp hết</span>' : '<span class="badge badge-green">Đang có tồn</span>'}</td>`)).join("");
}

function stockDetailRows(state) {
  return filteredStock(state).map((stock) => {
    const line = detail(state, stock.PNCT_Ma);
    if (!line) return "";
    const item = product(state, line.HH_Ma);
    return searchableRow(`${line.PNCT_Ma} ${line.HH_Ma} ${item?.HH_MaVach || ""} ${productName(state, line.HH_Ma)} ${locationName(state, stock.DD_Ma)}`, {
      location: stock.DD_Ma, category: product(state, line.HH_Ma)?.DM_Ma, date: line.PNCT_NSX
    }, `<td class="cell-primary">${esc(line.PNCT_Ma)}</td><td>${esc(line.HH_Ma)} · ${esc(productName(state, line.HH_Ma))}<small class="field-hint">Mã vạch: ${esc(item?.HH_MaVach || "—")}</small></td><td>${formatDate(state.PhieuNhap.find((row) => row.PN_Ma === line.PN_Ma)?.PN_Ngay)}</td><td>${formatDate(line.PNCT_NSX)}</td><td>${formatDate(line.PNCT_HSD)}</td><td>${esc(locationName(state, stock.DD_Ma))}</td><td>${esc(formatBaseQuantity(stock.TK_SL, item))}</td><td><a class="text-link" href="bien-dong-kho.html?line=${encodeURIComponent(line.PNCT_Ma)}">Lịch sử</a></td>`);
  }).join("");
}

function restockRows(state, store, warehouse) {
  return getReplenishmentItems(store?.DD_Ma || "", warehouse?.DD_Ma || "", state).map(({ item, store: storeStock, warehouse: warehouseStock, status }) => {
    const query = new URLSearchParams({
      create: "1", source: warehouse?.DD_Ma || "", destination: store?.DD_Ma || "", product: item.HH_Ma
    });
    let action = "—";
    if (canCreateTransfer() && warehouseStock.available > 0 && ["Hết hàng tại cửa hàng, kho còn", "Sắp hết hàng tại cửa hàng"].includes(status)) {
      action = `<a class="button button-small button-primary" href="xuat-chuyen-noi-bo.html?${query.toString()}">Tạo phiếu chuyển</a>`;
    } else if (isOwner() && ["Hết hàng toàn hệ thống", "Có tồn nhưng không khả dụng"].includes(status)) {
      action = `<a class="button button-small" href="../chu-cua-hang/don-dat-hang.html">Chuyển chủ cửa hàng lập đơn</a>`;
    }
    return searchableRow(`${item.HH_Ma} ${item.HH_MaVach || ""} ${item.HH_Ten} ${store?.DD_Ten || ""} ${status}`, {
      location: store?.DD_Ma || "", category: item.DM_Ma, status
    }, `<td>${esc(item.HH_Ma)}</td><td>${esc(item.HH_MaVach || "—")}</td><td class="cell-primary">${esc(item.HH_Ten)}</td><td>${esc(item.HH_DVi)}</td>
      <td>${esc(store?.DD_Ten || "Chưa cấu hình cửa hàng")}</td>      <td>${esc(formatBaseQuantity(storeStock.available, item))}</td>
      <td>${esc(formatBaseQuantity(warehouseStock.available, item))}${warehouseStock.unavailable ? `<small class="field-hint"> · ${formatNumber(warehouseStock.unavailable)} không khả dụng</small>` : ""}</td>
      <td>${badge(status)}${storeStock.unavailable ? `<small class="field-hint"> · ${formatNumber(storeStock.unavailable)} tồn vật lý không khả dụng</small>` : ""}</td><td>${action}</td>`);
  }).join("");
}

function renderStock(state) {
  const categories = state.DanhMuc.map((row) => [row.DM_Ma, row.DM_Ten]);
  const summary = stockMode === "summary";
  const store = state.DiaDiem.find((row) => row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động");
  const warehouse = state.DiaDiem.find((row) => row.DD_Loai === "Kho" && row.DD_TrangThai === "Hoạt động");
  const headers = summary ? ["Mã hàng", "Mã vạch", "Tên mặt hàng", "Danh mục", "Đơn vị cơ bản", "Địa điểm", "Tổng tồn / quy đổi", "Tình trạng"] : ["Mã dòng nhập", "Mặt hàng / mã vạch", "Ngày nhập", "NSX", "HSD", "Địa điểm", "Tồn hiện tại / quy đổi", "Lịch sử"];
  const rows = summary ? stockSummaryRows(state) : stockDetailRows(state);
  return `${heading("Theo dõi tồn kho", "Tra cứu tồn theo mặt hàng hoặc theo từng dòng nhập PNCT_Ma.", "")}
    <div class="heading-actions" style="margin-bottom:12px">
      <button class="button ${summary ? "button-primary" : ""}" data-action="stock-mode" data-mode="summary">Tổng hợp theo hàng hóa</button>
      <button class="button ${!summary ? "button-primary" : ""}" data-action="stock-mode" data-mode="detail">Chi tiết theo dòng nhập</button>
    </div>
    ${filtersMarkup([searchField("Mã hàng / tên / mã vạch", "Tìm mặt hàng, mã vạch hoặc mã dòng nhập…"), selectFilter("category", "Danh mục", categories), selectFilter("location", "Địa điểm", state.DiaDiem.map((row) => [row.DD_Ma, row.DD_Ten])), selectFilter("status", "Trạng thái bổ sung", [...new Set(getReplenishmentItems(store?.DD_Ma || "", warehouse?.DD_Ma || "", state).map((row) => row.status))].map((status) => [status, status]))])}
    ${tableCard("Hàng cần bổ sung cho cửa hàng", `${store?.DD_Ten || "Chưa cấu hình"} · ngưỡng sắp hết ${LOW_STOCK_THRESHOLD} đơn vị (cấu hình FE)`, ["Mã hàng", "Mã vạch", "Tên hàng", "Đơn vị tính", "Cửa hàng", "Tồn khả dụng tại cửa hàng", "Tồn khả dụng tại kho trung tâm", "Trạng thái", "Thao tác"], restockRows(state, store, warehouse), "Tồn khả dụng chỉ tính dòng nhập đã xác nhận, còn hạn và hàng đang kinh doanh. Hàng hết hạn vẫn được giữ ở tồn vật lý; chỉ hiển thị riêng, không đề xuất chuyển để bán.") }
    ${tableCard(summary ? "Tồn kho theo mặt hàng và địa điểm" : "Tồn kho theo dòng nhập", `${filteredStock(state).length} dòng tồn`, headers, rows, "Tồn kho được tính từ TonKho; không hỗ trợ chỉnh sửa trực tiếp số lượng tồn.")}`;
}

function transferLinesFor(state, id) {
  return state.PhieuXuatChuyenNoiBoChiTiet.filter((row) => row.PXCN_Ma === id);
}

function renderTransfers(state) {
  const rows = state.PhieuXuatChuyenNoiBo.slice().sort((a, b) => b.PXCN_Ngay.localeCompare(a.PXCN_Ngay)).map((row) => {
    const actions = `<div class="inline-actions"><button class="button button-small" data-action="view-transfer" data-id="${row.PXCN_Ma}">Chi tiết</button>
      ${row.PXCN_TrangThai === "Chờ xuất" && canDispatch() ? `<button class="button button-small button-primary" data-action="dispatch-transfer" data-id="${row.PXCN_Ma}">Xác nhận xuất</button>` : ""}
      ${row.PXCN_TrangThai === "Đang chuyển" && canReceive() ? `<button class="button button-small button-primary" data-action="receive-transfer" data-id="${row.PXCN_Ma}">Xác nhận nhận</button>` : ""}</div>`;
    return searchableRow(`${row.PXCN_Ma} ${locationName(state, row.DD_Xuat)} ${locationName(state, row.DD_Nhan)} ${row.PXCN_TrangThai}`, {
      status: row.PXCN_TrangThai, location: row.DD_Xuat, date: row.PXCN_Ngay
    }, `<td class="cell-primary">${esc(row.PXCN_Ma)}</td><td>${esc(locationName(state, row.DD_Xuat))}</td><td>${esc(locationName(state, row.DD_Nhan))}</td><td>${formatDate(row.PXCN_Ngay)}</td><td>${formatNumber(row.PXCN_TongSL)}</td><td>${badge(row.PXCN_TrangThai)}</td><td>${esc(row.PXCN_NguoiNhan || "—")}</td><td>${actions}</td>`);
  }).join("");
  const transferTabs = [
    ["", "Tất cả"],
    ["Chờ xuất", "Cần kho xuất"],
    ["Đang chuyển", "Đang chuyển"],
    ["Chờ nhận", "Chờ nhận"],
    ["Chờ đối chiếu", "Chờ đối chiếu"],
    ["Hoàn tất", "Đã hoàn tất"]
  ].map(([status, label]) => `<button class="button button-small ${transferTab === status ? "button-primary" : ""}" data-action="transfer-tab" data-status="${status}">${label}</button>`).join("");
  return `${heading("Xuất chuyển nội bộ", "Theo dõi lệnh chuyển, xác nhận xuất và số lượng cửa hàng thực nhận.", canCreateTransfer() ? `<button class="button button-primary" data-action="new-transfer">＋ Lập phiếu chuyển</button>` : "")}
    <div class="heading-actions" style="margin-bottom:12px">${transferTabs}</div>
    ${filtersMarkup([searchField("Tìm mã phiếu / địa điểm"), selectFilter("status", "Trạng thái", [...new Set(state.PhieuXuatChuyenNoiBo.map((row) => row.PXCN_TrangThai))].map((x) => [x, x])), selectFilter("location", "Địa điểm xuất", state.DiaDiem.map((row) => [row.DD_Ma, row.DD_Ten])), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày")])}
    <div class="info-box" style="margin-bottom:12px">Luồng vai trò demo: kế toán lập phiếu → kho xác nhận xuất → nhân viên cửa hàng xác nhận thực nhận. Chênh lệch được giữ ở trạng thái cần đối chiếu, không tự bù tồn.</div>
    ${tableCard("Danh sách phiếu chuyển", `${state.PhieuXuatChuyenNoiBo.length} phiếu`, ["Mã phiếu", "Địa điểm xuất", "Địa điểm nhận", "Ngày chuyển", "Tổng SL", "Trạng thái", "Người nhận", "Thao tác"], rows)}`;
}

function returnReceiptsFor(state, supplierId) {
  return state.PhieuNhap
    .filter((row) => row.DT_Ma === supplierId && ["Đã xác nhận", "Hoàn tất", "Đã nhận"].includes(row.PN_TrangThai))
    .sort((left, right) => String(right.PN_Ngay).localeCompare(String(left.PN_Ngay)));
}

function supplierReturnLineRow(state, sourceLine, locationId, savedLine = null, returnId = "", defaultReason = "Hàng hư hỏng") {
  const availability = getSupplierReturnLineAvailability(state, sourceLine.PNCT_Ma, locationId, returnId);
  const item = availability.item;
  const pack = availability.package;
  const factor = Number(savedLine?.TRNCC_HeSo || 1);
  const allowedFactor = factor === 1 || factor === pack?.ratio ? factor : 1;
  const savedBaseQuantity = Number(savedLine?.TRNCC_SL || 0);
  const enteredQuantity = savedLine
    ? Number(savedLine.TRNCC_SLNhap || savedBaseQuantity / allowedFactor)
    : 0;
  const maxInputQuantity = Math.floor(availability.available / allowedFactor);
  const returnReason = savedLine?.TRNCC_LyDoChiTiet || defaultReason;
  return `<tr class="supplier-return-line" data-line="${esc(sourceLine.PNCT_Ma)}" data-available="${availability.available}" data-price="${sourceLine.PNCT_DonGia}">
    <td>${esc(sourceLine.PNCT_Ma)}<div class="cell-muted">${esc(sourceLine.PN_Ma)}</div></td>
    <td><span class="cell-primary">${esc(item?.HH_Ma)} · ${esc(item?.HH_Ten)}</span><div class="cell-muted">${esc(item?.HH_DVi || "")}</div></td>
    <td>${formatDate(sourceLine.PNCT_NSX)}</td><td>${formatDate(sourceLine.PNCT_HSD)}</td>
    <td>${formatNumber(sourceLine.PNCT_SL)} ${esc(item?.HH_DVi || "")}</td>
    <td>${formatNumber(availability.stock)} ${esc(item?.HH_DVi || "")}<div class="cell-muted">Đã trả ${formatNumber(availability.returned)}</div></td>
    <td class="return-available">${formatNumber(availability.available)} ${esc(item?.HH_DVi || "")}</td>
    <td class="money">${formatCurrency(sourceLine.PNCT_DonGia)} / ${esc(item?.HH_DVi || "")}</td>
    <td><select name="TRNCC_LyDoChiTiet" aria-label="Lý do trả ${esc(item?.HH_Ten)}">${supplierReturnReasons.map((reason) => `<option ${reason === returnReason ? "selected" : ""}>${reason}</option>`).join("")}</select></td>
    <td><div class="return-quantity-input"><input name="TRNCC_SLNhap" type="number" min="0" max="${maxInputQuantity}" step="1" value="${enteredQuantity}" data-factor="${allowedFactor}" aria-label="Số lượng trả ${esc(item?.HH_Ten)}"><select name="TRNCC_HeSo" aria-label="Đơn vị trả">${`<option value="1" ${allowedFactor === 1 ? "selected" : ""}>${esc(item?.HH_DVi || "ĐVT cơ bản")}</option>`}${pack ? `<option value="${pack.ratio}" ${allowedFactor === pack.ratio ? "selected" : ""}>${esc(pack.name)} (${pack.ratio})</option>` : ""}</select></div>
    <div class="field-hint return-conversion">${enteredQuantity > 0 ? `${formatNumber(enteredQuantity)} × ${allowedFactor} = ${formatNumber(enteredQuantity * allowedFactor)} ${esc(item?.HH_DVi || "")}` : `Tối đa ${formatNumber(maxInputQuantity)} đơn vị đã chọn`}</div></td>
    <td class="money return-line-total">${formatCurrency(savedBaseQuantity * sourceLine.PNCT_DonGia)}</td>
  </tr>`;
}

function renderSupplierReturns(state) {
  const returns = getSupplierReturns(state);
  const canEditReturns = canManageReturns() && !returnsReadOnly();
  const filtered = returns.filter((doc) => {
    const supplier = supplierName(state, doc.DT_Ma);
    const searchable = `${doc.TRNCC_Ma} ${supplier}`.toLocaleLowerCase("vi-VN");
    const date = String(doc.TRNCC_Ngay || "").slice(0, 10);
    return (!returnFilters.search || searchable.includes(returnFilters.search.toLocaleLowerCase("vi-VN")))
      && (!returnFilters.status || doc.TRNCC_TrangThai === returnFilters.status)
      && (!returnFilters.from || date >= returnFilters.from)
      && (!returnFilters.to || date <= returnFilters.to);
  }).sort((left, right) => String(right.TRNCC_Ngay).localeCompare(String(left.TRNCC_Ngay)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / returnPageSize));
  returnPage = Math.min(returnPage, pageCount);
  const pageRows = filtered.slice((returnPage - 1) * returnPageSize, returnPage * returnPageSize);
  const rows = pageRows.map((doc) => {
    const actions = [
      `<button class="button button-small" data-action="view-supplier-return" data-id="${esc(doc.TRNCC_Ma)}">Chi tiết</button>`,
      doc.TRNCC_TrangThai === SUPPLIER_RETURN_STATUSES.draft && canEditReturns
        ? `<button class="button button-small" data-action="edit-supplier-return" data-id="${esc(doc.TRNCC_Ma)}">Sửa</button>
          <button class="button button-small button-primary" data-action="submit-supplier-return" data-id="${esc(doc.TRNCC_Ma)}">Gửi duyệt</button>
          <button class="button button-small button-danger" data-action="delete-supplier-return" data-id="${esc(doc.TRNCC_Ma)}">Xóa</button>` : "",
      doc.TRNCC_TrangThai === SUPPLIER_RETURN_STATUSES.pending && isOwner() && !returnsReadOnly()
        ? `<button class="button button-small button-primary" data-action="approve-supplier-return" data-id="${esc(doc.TRNCC_Ma)}">Duyệt</button>
          <button class="button button-small button-danger" data-action="reject-supplier-return" data-id="${esc(doc.TRNCC_Ma)}">Từ chối</button>` : "",
      [SUPPLIER_RETURN_STATUSES.draft, SUPPLIER_RETURN_STATUSES.pending, SUPPLIER_RETURN_STATUSES.approved].includes(doc.TRNCC_TrangThai) && canEditReturns
        ? `<button class="button button-small button-danger" data-action="cancel-supplier-return" data-id="${esc(doc.TRNCC_Ma)}">Hủy</button>` : "",
      doc.TRNCC_TrangThai === SUPPLIER_RETURN_STATUSES.approved && canEditReturns
        ? `<button class="button button-small button-primary" data-action="confirm-supplier-return" data-id="${esc(doc.TRNCC_Ma)}">Xác nhận xuất</button>` : ""
    ].filter(Boolean).join("");
    const sourceReceipt = state.PhieuNhap.find((receipt) => receipt.PN_Ma === doc.PN_Ma);
    return `<tr data-search="${esc(`${doc.TRNCC_Ma} ${supplierName(state, doc.DT_Ma)}`.toLocaleLowerCase("vi-VN"))}" data-status="${esc(doc.TRNCC_TrangThai)}" data-date="${esc(String(doc.TRNCC_Ngay || "").slice(0, 10))}">
      <td class="cell-primary">${esc(doc.TRNCC_Ma)}</td><td>${formatDate(doc.TRNCC_Ngay)}</td><td>${esc(supplierName(state, doc.DT_Ma))}<div class="cell-muted">${esc(sourceReceipt?.PN_Ma || doc.PN_Ma || "—")}</div></td>
      <td>${esc(locationName(state, doc.DD_Ma))}</td><td class="money">${formatNumber(doc.TRNCC_TongSL)}</td><td class="money">${formatCurrency(doc.TRNCC_TongTien)}</td>
      <td>${esc(doc.TRNCC_LyDo)}</td><td>${badge(doc.TRNCC_TrangThai)}</td><td><div class="inline-actions">${actions || "—"}</div></td></tr>`;
  }).join("");
  const totals = [
    [returns.length, "Tổng phiếu trả"],
    [returns.filter((doc) => doc.TRNCC_TrangThai === SUPPLIER_RETURN_STATUSES.draft).length, "Phiếu nháp"],
    [returns.filter((doc) => doc.TRNCC_TrangThai === SUPPLIER_RETURN_STATUSES.pending).length, "Phiếu chờ duyệt"],
    [returns.filter((doc) => doc.TRNCC_TrangThai === SUPPLIER_RETURN_STATUSES.shipped).length, "Phiếu đã xuất trả"]
  ].map(([value, label]) => `<div class="metric-card"><div class="metric-title">${label}</div><div class="metric-value">${formatNumber(value)}</div></div>`).join("");
  const pagination = `<div class="ledger-pagination"><span>${formatNumber(filtered.length)} phiếu · Trang ${returnPage} / ${pageCount}</span><div class="inline-actions">
    <button class="button button-small" data-action="supplier-returns-page" data-page="${returnPage - 1}" ${returnPage <= 1 ? "disabled" : ""}>Trước</button>
    <button class="button button-small" data-action="supplier-returns-page" data-page="${returnPage + 1}" ${returnPage >= pageCount ? "disabled" : ""}>Tiếp</button></div></div>`;
  const createAction = canManageReturns() && !returnsReadOnly()
    ? `<button class="button button-primary" data-action="new-supplier-return">＋ Lập phiếu trả hàng</button>` : "";
  const readonlyNotice = returnsReadOnly()
    ? `<div class="info-box" style="margin-bottom:14px">Chế độ xem lịch sử chỉ đọc. Phiếu trả lưu ở collection demo/localStorage; chưa có bảng chứng từ trả NCC trong CSDL SQL.</div>` : "";
  return `${heading("QUẢN LÝ TRẢ HÀNG NHÀ CUNG CẤP", "Quản lý phiếu trả theo phiếu nhập gốc và tồn thực tế tại địa điểm xuất.", createAction)}
    <div class="metric-grid supplier-return-metrics">${totals}</div>
    ${readonlyNotice}
    <form class="filters supplier-return-filters" id="supplier-return-filters">
      <div class="field grow"><label for="return-search">Mã phiếu / nhà cung cấp</label><input id="return-search" name="search" value="${esc(returnFilters.search)}" placeholder="TRNCC, tên nhà cung cấp"></div>
      <div class="field"><label for="return-status">Trạng thái</label><select id="return-status" name="status"><option value="">Tất cả</option>${Object.values(SUPPLIER_RETURN_STATUSES).map((status) => `<option value="${esc(status)}" ${returnFilters.status === status ? "selected" : ""}>${esc(status)}</option>`).join("")}</select></div>
      <div class="field"><label for="return-from">Từ ngày</label><input id="return-from" name="from" type="date" value="${esc(returnFilters.from)}"></div>
      <div class="field"><label for="return-to">Đến ngày</label><input id="return-to" name="to" type="date" value="${esc(returnFilters.to)}"></div>
      <button class="button button-primary" type="submit">Lọc</button>
      <button class="button" type="button" data-action="clear-supplier-return-filters">Xóa lọc</button>
    </form>
    ${tableCard("Danh sách phiếu trả hàng NCC", `${formatNumber(filtered.length)} phiếu`, ["Mã phiếu trả", "Ngày lập", "Nhà cung cấp / phiếu nhập", "Kho xuất trả", "Số lượng trả", "Giá trị dự kiến", "Lý do", "Trạng thái", "Thao tác"], rows || emptyRow(9))}
    ${pagination}
    <div class="info-box supplier-return-footnote">Giá trị chỉ phục vụ theo dõi theo đơn giá nhập gốc. Chưa tự động điều chỉnh công nợ NCC. Collection phiếu trả chỉ tồn tại trong dữ liệu mock/localStorage, không phải bảng SQL thứ 28; thao tác nhiều máy không được bảo đảm transaction như Backend.</div>`;
}

function openSupplierReturnForm(state, returnId = "") {
  if (!canManageReturns() || returnsReadOnly()) return toast("Vai trò hiện tại chỉ được xem lịch sử phiếu trả NCC.", true);
  const doc = getSupplierReturns(state).find((row) => row.TRNCC_Ma === returnId);
  if (returnId && (!doc || doc.TRNCC_TrangThai !== SUPPLIER_RETURN_STATUSES.draft)) {
    return toast("Chỉ chỉnh sửa được phiếu trả ở trạng thái Nháp.", true);
  }
  const suppliers = state.DoiTacKinhDoanh.filter((row) => row.DT_Loai === "Nhà cung cấp");
  const activeLocations = state.DiaDiem.filter((row) => row.DD_TrangThai === "Hoạt động");
  const preferredLocation = localStorage.getItem("stmn-kho-demo-location");
  const defaultLocation = doc?.DD_Ma || (activeLocations.some((row) => row.DD_Ma === preferredLocation) ? preferredLocation : activeLocations[0]?.DD_Ma || "");
  const body = `<div class="form-error" id="form-error"></div><form id="supplier-return-form" data-edit-id="${esc(returnId)}">
    <div class="form-grid supplier-return-form-grid">
      <div class="field"><label>Mã phiếu trả</label><input value="${esc(doc?.TRNCC_Ma || "Tự sinh khi lưu")}" disabled></div>
      <div class="field"><label>Ngày lập *</label><input name="TRNCC_Ngay" type="date" value="${esc(doc?.TRNCC_Ngay || today())}" required></div>
      <div class="field"><label>Nhân viên lập</label><input value="${esc(employeeName(state, roleEmployees[role]))}" disabled></div>
      <div class="field"><label>Nhà cung cấp *</label><select name="DT_Ma" required><option value="">Chọn NCC</option>${suppliers.map((row) => `<option value="${esc(row.DT_Ma)}" ${row.DT_Ma === doc?.DT_Ma ? "selected" : ""}>${esc(row.DT_Ten)}</option>`).join("")}</select></div>
      <div class="field"><label>Phiếu nhập gốc *</label><select name="PN_Ma" required><option value="">Chọn NCC trước</option>${returnReceiptsFor(state, doc?.DT_Ma || "").map((row) => `<option value="${esc(row.PN_Ma)}" ${row.PN_Ma === doc?.PN_Ma ? "selected" : ""}>${esc(row.PN_Ma)} · ${formatDate(row.PN_Ngay)}</option>`).join("")}</select></div>
      <div class="field"><label>Địa điểm xuất trả *</label><select name="DD_Ma" required>${optionList(activeLocations, "DD_Ma", "DD_Ten", defaultLocation, "Chọn địa điểm")}</select></div>
      <div class="field"><label>Lý do chung *</label><select name="TRNCC_LyDo" required>${supplierReturnReasons.map((reason) => `<option ${reason === (doc?.TRNCC_LyDo || "Hàng hư hỏng") ? "selected" : ""}>${reason}</option>`).join("")}</select></div>
      <div class="field supplier-return-note"><label>Ghi chú</label><textarea name="TRNCC_GhiChu" placeholder="Thông tin bổ sung">${esc(doc?.TRNCC_GhiChu || "")}</textarea></div>
    </div>
    <div class="detail-heading"><span>Hàng thuộc phiếu nhập đã chọn</span><span class="cell-muted">Số lượng lưu theo đơn vị cơ bản</span></div>
    <div class="table-wrap supplier-return-lines-wrap"><table class="detail-table supplier-return-lines"><thead><tr><th>PNCT_Ma</th><th>Sản phẩm</th><th>NSX</th><th>HSD</th><th>Nhập ban đầu</th><th>Tồn / đã trả</th><th>Có thể trả</th><th>Đơn giá nhập</th><th>Lý do trả dòng hàng</th><th>Số lượng trả</th><th>Thành tiền</th></tr></thead><tbody id="supplier-return-lines"></tbody></table></div>
    <div class="totals-row"><span>Tổng trả theo ĐVT cơ bản: <strong id="supplier-return-total-quantity">0</strong></span><span>Giá trị dự kiến: <strong id="supplier-return-total-amount">0 ₫</strong></span></div>
    <div class="info-box" style="margin-top:12px">Giá trị hàng trả chỉ phục vụ theo dõi. Chưa tự động điều chỉnh công nợ nhà cung cấp.</div>
  </form>`;
  openModal(doc ? `Chỉnh sửa phiếu ${returnId}` : "Lập phiếu trả hàng NCC", body,
    `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="supplier-return-form" type="submit">Lưu nháp</button>`, true);
  if (doc) {
    const form = document.querySelector("#supplier-return-form");
    renderSupplierReturnLines(getState(), form, doc);
  }
  updateSupplierReturnTotals();
}

function renderSupplierReturnLines(state, form, doc = null) {
  const receiptId = form.querySelector('[name="PN_Ma"]').value;
  const locationId = form.querySelector('[name="DD_Ma"]').value;
  const lines = state.PhieuNhapChiTiet.filter((line) => line.PN_Ma === receiptId);
  const liveLines = [...form.querySelectorAll(".supplier-return-line")].map((row) => {
    const quantity = Number(row.querySelector('[name="TRNCC_SLNhap"]').value || 0);
    const factor = Number(row.querySelector('[name="TRNCC_HeSo"]').value || 1);
    return {
      PNCT_Ma: row.dataset.line,
      TRNCC_SL: quantity * factor,
      TRNCC_SLNhap: quantity,
      TRNCC_HeSo: factor,
      TRNCC_LyDoChiTiet: row.querySelector('[name="TRNCC_LyDoChiTiet"]').value
    };
  });
  const savedLines = new Map((liveLines.length ? liveLines : doc?.chiTiet || []).map((line) => [line.PNCT_Ma, line]));
  form.querySelector("#supplier-return-lines").innerHTML = lines.map((line) => supplierReturnLineRow(
    state, line, locationId, savedLines.get(line.PNCT_Ma), doc?.TRNCC_Ma || "", form.querySelector('[name="TRNCC_LyDo"]').value
  )).join("") || emptyRow(11, "Phiếu nhập này không có dòng hàng.");
  updateSupplierReturnTotals();
}

function updateSupplierReturnTotals() {
  const form = document.querySelector("#supplier-return-form");
  if (!form) return;
  let quantityTotal = 0;
  let amountTotal = 0;
  form.querySelectorAll(".supplier-return-line").forEach((row) => {
    const input = row.querySelector('[name="TRNCC_SLNhap"]');
    const factor = Number(row.querySelector('[name="TRNCC_HeSo"]').value || 1);
    const quantity = Number(input.value || 0);
    const baseQuantity = quantity * factor;
    const amount = baseQuantity * Number(row.dataset.price);
    if (!Number.isSafeInteger(baseQuantity) || !Number.isSafeInteger(amount)) return;
    quantityTotal += baseQuantity;
    amountTotal += amount;
    row.querySelector(".return-conversion").textContent = quantity
      ? `${formatNumber(quantity)} × ${formatNumber(factor)} = ${formatNumber(baseQuantity)} ${product(getState(), detail(getState(), row.dataset.line)?.HH_Ma)?.HH_DVi || ""}`
      : `Tối đa ${formatNumber(input.max || 0)} đơn vị đã chọn`;
    row.querySelector(".return-line-total").textContent = formatCurrency(amount);
  });
  form.querySelector("#supplier-return-total-quantity").textContent = formatNumber(quantityTotal);
  form.querySelector("#supplier-return-total-amount").textContent = formatCurrency(amountTotal);
}

function viewSupplierReturn(state, returnId) {
  const doc = getSupplierReturns(state).find((row) => row.TRNCC_Ma === returnId);
  if (!doc) return toast("Không tìm thấy phiếu trả NCC.", true);
  const rows = (doc.chiTiet || []).map((line) => {
    const detailLine = detail(state, line.PNCT_Ma);
    const item = product(state, line.HH_Ma);
    return `<tr><td>${esc(line.PNCT_Ma)}</td><td>${esc(item?.HH_Ma)} · ${esc(item?.HH_Ten)}</td><td>${formatNumber(line.TRNCC_SL)} ${esc(item?.HH_DVi || "")}</td><td>${esc(line.TRNCC_LyDoChiTiet || doc.TRNCC_LyDo)}</td><td>${formatCurrency(line.TRNCC_DonGia)}</td><td class="money">${formatCurrency(line.TRNCC_TTien)}</td><td>${formatDate(detailLine?.PNCT_HSD)}</td></tr>`;
  }).join("");
  const body = `<div class="form-grid"><div><strong>Mã phiếu:</strong> ${esc(doc.TRNCC_Ma)}</div><div><strong>Trạng thái:</strong> ${badge(doc.TRNCC_TrangThai)}</div><div><strong>Ngày lập:</strong> ${formatDate(doc.TRNCC_Ngay)}</div>
    <div><strong>Nhà cung cấp:</strong> ${esc(supplierName(state, doc.DT_Ma))}</div><div><strong>Phiếu nhập gốc:</strong> ${esc(doc.PN_Ma)}</div><div><strong>Địa điểm:</strong> ${esc(locationName(state, doc.DD_Ma))}</div>
    <div><strong>Nhân viên lập:</strong> ${esc(employeeName(state, doc.NV_Ma))}</div><div><strong>Lý do:</strong> ${esc(doc.TRNCC_LyDo)}</div><div><strong>Tổng giá trị:</strong> ${formatCurrency(doc.TRNCC_TongTien)}</div></div>
    ${tableCard("Chi tiết hàng trả", `${formatNumber(doc.chiTiet?.length || 0)} dòng`, ["PNCT_Ma", "Hàng hóa", "Số lượng", "Lý do trả", "Đơn giá nhập", "Thành tiền", "HSD"], rows)}
    <div class="info-box" style="margin-top:12px">Giá trị chỉ phục vụ theo dõi. Không tự động điều chỉnh công nợ NCC. ${doc.TRNCC_GhiChu ? `Ghi chú: ${esc(doc.TRNCC_GhiChu)}` : ""}</div>`;
  openModal(`Chi tiết ${returnId}`, body, `<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function renderCounts(state) {
  const rows = state.PhieuKiemKeKho.slice().sort((a, b) => b.PKK_Ngay.localeCompare(a.PKK_Ngay)).map((row) => {
    const lines = state.PhieuKiemKeKhoChiTiet.filter((line) => line.PKK_Ma === row.PKK_Ma);
    const varianceCount = lines.filter((line) => Number(line.PKKCT_ChenhLech) !== 0).length;
    const actions = `<div class="inline-actions"><button class="button button-small" data-action="view-count" data-id="${row.PKK_Ma}">Chi tiết</button>
      ${row.PKK_TrangThai === "Nháp" && canCount() ? `<button class="button button-small button-primary" data-action="submit-count" data-id="${row.PKK_Ma}">Gửi duyệt</button>` : ""}
      ${row.PKK_TrangThai === "Chờ duyệt" && isOwner() ? `<button class="button button-small button-primary" data-action="approve-count" data-id="${row.PKK_Ma}">Duyệt</button>` : ""}</div>`;
    return searchableRow(`${row.PKK_Ma} ${locationName(state, row.DD_Ma)} ${row.PKK_TrangThai}`, { status: row.PKK_TrangThai, location: row.DD_Ma, date: row.PKK_Ngay },
      `<td class="cell-primary">${esc(row.PKK_Ma)}</td><td>${esc(locationName(state, row.DD_Ma))}</td><td>${formatDate(row.PKK_Ngay)}</td><td>${esc(employeeName(state, row.NV_Ma))}</td><td>${formatNumber(varianceCount)}</td><td>${esc(employeeName(state, row.NV_Duyet))}</td><td>${formatDate(row.PKK_NgayDuyet)}</td><td>${badge(row.PKK_TrangThai)}</td><td>${actions}</td>`);
  }).join("");
  return `${heading("Kiểm kê kho", "Chốt tồn sổ sách, nhập thực tế và duyệt điều chỉnh theo quy trình.", canCount() ? `<button class="button button-primary" data-action="new-count">＋ Tạo phiếu kiểm kê</button>` : "")}
    ${filtersMarkup([searchField("Tìm mã phiếu"), selectFilter("location", "Địa điểm", state.DiaDiem.map((row) => [row.DD_Ma, row.DD_Ten])), selectFilter("status", "Trạng thái", [...new Set(state.PhieuKiemKeKho.map((row) => row.PKK_TrangThai))].map((x) => [x, x])), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày")])}
    <div class="info-box" style="margin-bottom:12px">Chỉ Chủ cửa hàng được duyệt trong demo. Khi duyệt, hệ thống đối chiếu tồn hiện tại với số sổ sách đã chốt; nếu tồn thay đổi, phiếu bị từ chối để tránh điều chỉnh sai.</div>
    ${tableCard("Danh sách phiếu kiểm kê", `${state.PhieuKiemKeKho.length} phiếu`, ["Mã phiếu", "Địa điểm", "Ngày kiểm kê", "Nhân viên lập", "Dòng chênh lệch", "Người duyệt", "Ngày duyệt", "Trạng thái", "Thao tác"], rows)}`;
}

function renderMovements(state) {
  const selectedLine = new URLSearchParams(location.search).get("line") || "";
  const rows = state.BienDongKho.slice().sort((a, b) => b.BDK_Ngay.localeCompare(a.BDK_Ngay)).map((row) => {
    const item = product(state, detail(state, row.PNCT_Ma)?.HH_Ma);
    const line = detail(state, row.PNCT_Ma);
    const sourceType = row.BDK_Nguon;
    return searchableRow(`${row.BDK_Ma} ${productName(state, line?.HH_Ma)} ${row.PNCT_Ma} ${row.BDK_Loai} ${row.BDK_MaChungTu}`, {
      location: row.DD_Ma, kind: row.BDK_Loai, item: line?.HH_Ma, date: row.BDK_Ngay.slice(0, 10), line: row.PNCT_Ma
    }, `<td class="cell-primary">${esc(row.BDK_Ma)}</td><td>${formatDate(row.BDK_Ngay)}<div class="cell-muted">${esc(row.BDK_Ngay.slice(11, 16))}</div></td><td>${esc(locationName(state, row.DD_Ma))}</td><td>${esc(item?.HH_Ten || "—")}</td><td>${esc(row.PNCT_Ma)}</td><td>${esc(row.BDK_Loai)}</td><td class="${row.BDK_SoLuong > 0 ? "positive" : "negative"}">${row.BDK_SoLuong > 0 ? "+" : "−"}${formatNumber(Math.abs(row.BDK_SoLuong))}</td><td>${esc(sourceType)} · <a class="text-link" href="#" data-action="source" data-source="${esc(sourceType)}" data-id="${esc(row.BDK_MaChungTu)}">${esc(row.BDK_MaChungTu)}</a></td><td>${esc(employeeName(state, row.NV_Ma))}</td>`);
  }).join("");
  return `${heading("Lịch sử biến động kho", "Tra cứu các biến động phát sinh từ chứng từ nghiệp vụ; không tạo/sửa/xóa thủ công.", "")}
    ${filtersMarkup([searchField("Mã biến động / hàng hóa / chứng từ"), selectFilter("location", "Địa điểm", state.DiaDiem.map((row) => [row.DD_Ma, row.DD_Ten])), selectFilter("item", "Hàng hóa", state.HangHoa.map((row) => [row.HH_Ma, row.HH_Ten])), selectFilter("kind", "Loại biến động", [...new Set(["Trả NCC", ...state.BienDongKho.map((row) => row.BDK_Loai)])].map((x) => [x, x])), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày")])}
    ${tableCard("Biến động phát sinh", `${state.BienDongKho.length} dòng`, ["Mã biến động", "Thời gian", "Địa điểm", "Mặt hàng", "Mã dòng nhập", "Loại biến động", "Thay đổi", "Chứng từ nguồn", "Nhân viên"], rows, "BDK_Nguon và BDK_MaChungTu được hiển thị như cặp tham chiếu chứng từ, không giả định là khóa ngoại tới một bảng duy nhất.")}`;
}

function renderStockLedger(state) {
  const locations = state.DiaDiem.filter((row) => row.DD_TrangThai !== "Ngừng hoạt động");
  if (!locations.some((row) => row.DD_Ma === stockLedgerFilters.locationId)) {
    const savedLocation = localStorage.getItem("stmn-kho-demo-location");
    const store = locations.find((row) => row.DD_Ma === savedLocation)
      || locations.find((row) => row.DD_Loai === "Cửa hàng")
      || locations[0];
    stockLedgerFilters.locationId = store?.DD_Ma || "";
  }
  const item = product(state, stockLedgerFilters.itemId);
  const report = item ? buildStockLedgerReport(state, stockLedgerFilters) : null;
  const productOptions = state.HangHoa.map((row) => `<option value="${esc(row.HH_Ma)}" data-ledger-search="${esc(`${row.HH_Ma} ${row.HH_Ten} ${row.HH_MaVach || ""}`.toLocaleLowerCase("vi-VN"))}" ${row.HH_Ma === stockLedgerFilters.itemId ? "selected" : ""}>${esc(`${row.HH_Ma} · ${row.HH_Ten}${row.HH_MaVach ? ` · ${row.HH_MaVach}` : ""}`)}</option>`).join("");
  const productLines = state.PhieuNhapChiTiet.filter((row) => row.HH_Ma === stockLedgerFilters.itemId);
  const lineOptions = `<option value="">Tất cả dòng nhập của sản phẩm</option>${productLines.map((row) => `<option value="${esc(row.PNCT_Ma)}" ${row.PNCT_Ma === stockLedgerFilters.lineId ? "selected" : ""}>${esc(row.PNCT_Ma)} · ${esc(row.PN_Ma)} · HSD ${esc(formatDate(row.PNCT_HSD))}</option>`).join("")}`;
  const visibleRows = report?.rows || [];
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / stockLedgerPageSize));
  stockLedgerPage = Math.min(stockLedgerPage, pageCount);
  const pageRows = visibleRows.slice((stockLedgerPage - 1) * stockLedgerPageSize, stockLedgerPage * stockLedgerPageSize);
  const movementRows = pageRows.map((row) => {
    const line = detail(state, row.PNCT_Ma);
    const rowItem = product(state, line?.HH_Ma);
    const signedQuantity = Number(row.BDK_SoLuong);
    const voucher = row.BDK_MaChungTu
      ? `<button class="text-link ledger-document-link" data-action="ledger-source" data-id="${esc(row.BDK_Ma)}">${esc(row.BDK_MaChungTu)}</button>`
      : "—";
    return `<tr>
      <td class="cell-primary">${esc(row.BDK_Ma)}</td>
      <td>${esc(formatDate(row.BDK_Ngay))}<div class="cell-muted">${esc(String(row.BDK_Ngay).slice(11, 16) || "—")}</div></td>
      <td>${esc(row.BDK_Loai || "—")}</td>
      <td>${voucher}<div class="cell-muted">${esc(row.BDK_Nguon || "Không rõ nguồn")}</div></td>
      <td>${esc(line?.PNCT_Ma || row.PNCT_Ma || "—")}</td>
      <td><span class="cell-primary">${esc(rowItem?.HH_Ten || item?.HH_Ten || "—")}</span><div class="cell-muted">${esc(rowItem?.HH_Ma || item?.HH_Ma || "")} · ${esc(rowItem?.HH_DVi || item?.HH_DVi || "")}</div></td>
      <td class="ledger-quantity ${signedQuantity >= 0 ? "positive" : "negative"}">${signedQuantity > 0 ? "+" : signedQuantity < 0 ? "−" : ""}${esc(formatBaseQuantity(Math.abs(signedQuantity), rowItem || item))}</td>
      <td>${row.BDK_SoDuSau === null ? "—" : esc(formatBaseQuantity(row.BDK_SoDuSau, rowItem || item))}</td>
      <td>${esc(employeeName(state, row.NV_Ma))}</td>
      <td class="ledger-note">${esc(row.BDK_GhiChu || "—")}</td>
    </tr>`;
  }).join("");
  const metrics = report?.complete ? `
    <div class="metric-card"><div class="metric-title">Tồn đầu kỳ</div><div class="metric-value">${esc(formatBaseQuantity(report.opening, item))}</div><div class="metric-caption">Trước ${esc(formatDate(report.from))}</div></div>
    <div class="metric-card"><div class="metric-title">Nhập trong kỳ</div><div class="metric-value positive">${esc(formatBaseQuantity(report.inbound, item))}</div><div class="metric-caption">Theo các biến động đã ghi</div></div>
    <div class="metric-card"><div class="metric-title">Xuất trong kỳ</div><div class="metric-value negative">${esc(formatBaseQuantity(report.outbound, item))}</div><div class="metric-caption">Theo các biến động đã ghi</div></div>
    <div class="metric-card"><div class="metric-title">Tồn cuối kỳ</div><div class="metric-value">${esc(formatBaseQuantity(report.closing, item))}</div><div class="metric-caption">Tồn hiện tại: ${esc(formatBaseQuantity(report.current, item))}</div></div>` : `
    ${["Tồn đầu kỳ", "Nhập trong kỳ", "Xuất trong kỳ", "Tồn cuối kỳ"].map((label) => `<div class="metric-card"><div class="metric-title">${label}</div><div class="metric-value">—</div><div class="metric-caption">Chưa thể xác minh</div></div>`).join("")}`;
  const integrityNotice = report?.error
    ? `<div class="warning-box ledger-warning">${esc(report.error)} ${report.itemId ? "Hãy kiểm tra lịch sử biến động và tồn hiện tại; số dư không được suy đoán." : ""}</div>`
    : item && report?.complete
      ? `<div class="info-box ledger-info">Lịch sử đã đối chiếu với TonKho tại ${esc(locationName(state, report.locationId))} · ${formatNumber(report.lineCount)} dòng nhập được tính.</div>`
      : `<div class="info-box ledger-info">Chọn sản phẩm để xem các phát sinh và số dư theo thời gian. Việc tra cứu không thay đổi tồn kho.</div>`;
  const rangeLabel = stockLedgerFilters.from && stockLedgerFilters.to
    ? `${formatDate(stockLedgerFilters.from)} – ${formatDate(stockLedgerFilters.to)}`
    : "Chưa chọn kỳ";
  const pagination = visibleRows.length ? `<div class="ledger-pagination"><span>${formatNumber(visibleRows.length)} phát sinh · Trang ${stockLedgerPage} / ${pageCount}</span><div class="inline-actions">
      <button class="button button-small" data-action="ledger-page" data-page="${stockLedgerPage - 1}" ${stockLedgerPage <= 1 ? "disabled" : ""}>Trước</button>
      <button class="button button-small" data-action="ledger-page" data-page="${stockLedgerPage + 1}" ${stockLedgerPage >= pageCount ? "disabled" : ""}>Tiếp</button>
    </div></div>` : "";
  return `${heading("Thẻ kho", "Theo dõi nhập, xuất và số dư theo sản phẩm, địa điểm, khoảng thời gian và dòng nhập PNCT_Ma.", `<button class="button" data-action="ledger-export" ${visibleRows.length ? "" : "disabled"}>Xuất CSV</button><button class="button" data-action="ledger-refresh">Làm mới</button>`)}
    <form class="filters ledger-filters" id="stock-ledger-filters">
      <div class="field ledger-search-field"><label for="ledger-item-search">Tìm sản phẩm</label><input id="ledger-item-search" type="search" placeholder="Tên, mã hàng hoặc mã vạch"></div>
      <div class="field grow"><label for="ledger-item">Sản phẩm</label><select id="ledger-item" name="itemId" required><option value="">Chọn sản phẩm</option>${productOptions}</select></div>
      <div class="field"><label for="ledger-location">Địa điểm</label><select id="ledger-location" name="locationId" required>${optionList(locations, "DD_Ma", "DD_Ten", stockLedgerFilters.locationId)}</select></div>
      <div class="field"><label for="ledger-line">Dòng nhập</label><select id="ledger-line" name="lineId">${lineOptions}</select></div>
      <div class="field"><label for="ledger-from">Từ ngày</label><input id="ledger-from" name="from" type="date" value="${esc(stockLedgerFilters.from)}" required></div>
      <div class="field"><label for="ledger-to">Đến ngày</label><input id="ledger-to" name="to" type="date" value="${esc(stockLedgerFilters.to)}" required></div>
      <div class="field"><label for="ledger-kind">Loại phát sinh</label><select id="ledger-kind" name="movementType">
        <option value="all" ${stockLedgerFilters.movementType === "all" ? "selected" : ""}>Tất cả</option>
        <option value="inbound" ${stockLedgerFilters.movementType === "inbound" ? "selected" : ""}>Nhập kho</option>
        <option value="outbound" ${stockLedgerFilters.movementType === "outbound" ? "selected" : ""}>Xuất khác</option>
        <option value="sale" ${stockLedgerFilters.movementType === "sale" ? "selected" : ""}>Bán hàng</option>
        <option value="transfer" ${stockLedgerFilters.movementType === "transfer" ? "selected" : ""}>Chuyển nội bộ</option>
        <option value="supplier-return" ${stockLedgerFilters.movementType === "supplier-return" ? "selected" : ""}>Trả NCC</option>
        <option value="count" ${stockLedgerFilters.movementType === "count" ? "selected" : ""}>Kiểm kê</option>
        <option value="other" ${stockLedgerFilters.movementType === "other" ? "selected" : ""}>Khác</option>
      </select></div>
      <button class="button button-primary" type="submit">Xem thẻ kho</button>
    </form>
    ${integrityNotice}
    <div class="metric-grid ledger-metrics">${metrics}</div>
    <div class="table-card ledger-table-card">
      <div class="table-toolbar"><div><strong>Chi tiết thẻ kho</strong><div class="cell-muted">${item ? `${esc(item.HH_Ma)} · ${esc(item.HH_Ten)} · ${esc(locationName(state, stockLedgerFilters.locationId))}` : "Chưa chọn sản phẩm"}</div></div><span>${esc(rangeLabel)}${stockLedgerFilters.lineId ? ` · ${esc(stockLedgerFilters.lineId)}` : ""}</span></div>
      <div class="table-wrap ledger-table-wrap"><table><thead><tr><th>Mã biến động</th><th>Ngày / giờ</th><th>Loại</th><th>Chứng từ nguồn</th><th>Mã dòng nhập</th><th>Sản phẩm / đơn vị</th><th>Thay đổi</th><th>Số dư sau</th><th>Nhân viên</th><th>Ghi chú</th></tr></thead><tbody>${movementRows || emptyRow(10, item ? "Không có biến động trong khoảng thời gian đã chọn." : "Chọn sản phẩm và nhấn Xem thẻ kho.")}</tbody></table></div>
      ${pagination}
    </div>`;
}

function renderExpiry(state) {
  const rows = expiryRows(state).map(({ stock, line, item, days, threshold, status }) => searchableRow(`${item?.HH_Ma} ${item?.HH_Ten} ${line.PNCT_Ma} ${locationName(state, stock.DD_Ma)}`, {
    location: stock.DD_Ma, item: item?.HH_Ma, expiry: status
  }, `<td>${esc(item?.HH_Ma)}</td><td class="cell-primary">${esc(item?.HH_Ten)}</td><td>${esc(line.PNCT_Ma)}</td><td>${formatDate(line.PNCT_NSX)}</td><td>${formatDate(line.PNCT_HSD)}</td><td>${days === null ? "—" : days < 0 ? `Quá ${formatNumber(Math.abs(days))} ngày` : `${formatNumber(days)} ngày`}</td><td>${esc(locationName(state, stock.DD_Ma))}</td><td>${formatNumber(stock.TK_SL)}</td><td>${badge(status)}</td>`)).join("");
  return `${heading("Theo dõi hạn sử dụng", "Cảnh báo theo từng dòng nhập còn tồn. Hàng hết hạn không được bán trong mô phỏng.", "")}
    ${filtersMarkup([searchField("Tìm mã hàng / tên hàng / dòng nhập"), selectFilter("expiry", "Tình trạng", [["Sắp hết hạn", "Sắp hết hạn"], ["Đã hết hạn", "Đã hết hạn"], ["Còn hạn", "Còn hạn"], ["Không áp dụng HSD", "Không áp dụng HSD"]]), selectFilter("location", "Địa điểm", state.DiaDiem.map((row) => [row.DD_Ma, row.DD_Ten]))])}
    <div class="warning-box" style="margin-bottom:12px">Ngưỡng ưu tiên lấy từ PNCT_HSDToiThieu. Khi không có giá trị, dùng ngưỡng demo ${DEMO_THRESHOLD_DAYS} ngày; đây là cấu hình giao diện, không phải thuộc tính CSDL. Màn hình không hỗ trợ xuất hủy hoặc trả hàng NCC.</div>
    ${tableCard("Hàng hóa theo hạn sử dụng", "Chỉ các dòng nhập còn tồn", ["Mã hàng", "Tên mặt hàng", "Mã dòng nhập", "Ngày sản xuất", "Hạn sử dụng", "Còn lại", "Địa điểm", "Tồn", "Tình trạng"], rows)}`;
}

function renderContent() {
  let state;
  try {
    state = getState();
  } catch (error) {
    document.querySelector("#page-content").innerHTML = `<div class="warning-box">Không thể đọc dữ liệu demo: ${esc(error.message)} <button class="button button-small" data-action="reset">Khôi phục dữ liệu demo</button></div>`;
    return;
  }
  const content = document.querySelector("#page-content");
  const renderers = { overview: renderOverview, receipts: renderReceipts, stock: renderStock, ledger: renderStockLedger, transfers: renderTransfers, returns: renderSupplierReturns, counts: renderCounts, movements: renderMovements, expiry: renderExpiry };
  content.innerHTML = (renderers[page] || renderOverview)(state);
  applyFilters();
}

function applyFilters() {
  const content = document.querySelector("#page-content");
  const filters = [...content.querySelectorAll(".filter-control")];
  const selectedLine = page === "movements" ? new URLSearchParams(location.search).get("line") : "";
  for (const tbody of content.querySelectorAll("tbody")) {
    const rows = [...tbody.querySelectorAll("tr[data-search]")];
    let visibleCount = 0;
    for (const row of rows) {
      let visible = true;
      for (const filter of filters) {
        const value = filter.value.trim().toLocaleLowerCase("vi-VN");
        if (!value) continue;
        const key = filter.dataset.filter;
        if (key === "search") visible = visible && row.dataset.search.includes(value);
        else if (key === "from") visible = visible && (row.dataset.date || row.dataset.from || "") >= value;
        else if (key === "to") visible = visible && (row.dataset.date || row.dataset.to || "") <= value;
        else visible = visible && (row.dataset[key] || "").toLocaleLowerCase("vi-VN") === value;
      }
      if (selectedLine) visible = visible && row.dataset.line === selectedLine;
      if (page === "transfers" && transferTab) {
        visible = visible && (transferTab === "Chờ nhận"
          ? row.dataset.status === "Đang chuyển"
          : transferTab === "Chờ đối chiếu"
            ? ["Chờ đối chiếu", "Cần đối chiếu"].includes(row.dataset.status)
            : row.dataset.status === transferTab);
      }
      row.hidden = !visible;
      if (visible) visibleCount++;
    }
    let empty = tbody.querySelector("[data-filter-empty]");
    if (rows.length && visibleCount === 0) {
      if (!empty) {
        const columns = tbody.closest("table").querySelectorAll("thead th").length;
        tbody.insertAdjacentHTML("beforeend", `<tr data-filter-empty><td colspan="${columns}" class="empty-state">Không có dữ liệu phù hợp với bộ lọc.</td></tr>`);
        empty = tbody.querySelector("[data-filter-empty]");
      }
      empty.hidden = false;
    } else if (empty) empty.remove();
  }
}

function lineOptions(state, locationId, selected = "", HH_Ma = "") {
  const eligibleLineIds = new Set(state.PhieuNhapChiTiet
    .filter((line) => !HH_Ma || line.HH_Ma === HH_Ma)
    .flatMap((line) => getValidSaleLots(locationId, line.HH_Ma, today(), state)
      .filter((lot) => lot.line.PNCT_Ma === line.PNCT_Ma)
      .map((lot) => lot.line.PNCT_Ma)));
  return state.PhieuNhapChiTiet.filter((line) => eligibleLineIds.has(line.PNCT_Ma) || line.PNCT_Ma === selected).map((line) => {
    const available = stockQty(state, locationId, line.PNCT_Ma);
    return `<option value="${esc(line.PNCT_Ma)}" data-stock="${available}" ${line.PNCT_Ma === selected ? "selected" : ""}>${esc(line.PNCT_Ma)} · ${esc(productName(state, line.HH_Ma))} · còn ${available}</option>`;
  }).join("");
}

function receiptLineRow(state, line = {}) {
  const item = state.HangHoa.find((row) => row.HH_Ma === line.HH_Ma);
  const unitPackage = getUnitPackage(item);
  const baseUnit = item?.HH_DVi || "đơn vị cơ bản";
  const progress = line.DN_SL === "" || line.DN_SL === undefined
    ? "Không liên kết đơn đặt hàng"
    : `Đặt ${formatNumber(line.DN_SL)} · Đã nhận ${formatNumber(line.DN_Received || 0)} · Còn thiếu ${formatNumber(line.DN_Remaining ?? line.DN_SL)} · Được nhận đợt này tối đa ${formatNumber(line.DN_Available ?? line.DN_SL)}`;
  const maxQuantity = line.DN_Available === undefined ? "" : `max="${esc(line.DN_Available)}"`;
  return `<tr class="edit-line">
    <td><select class="product-select" name="HH_Ma" required>${optionList(state.HangHoa, "HH_Ma", "HH_Ten", line.HH_Ma, "Chọn mặt hàng")}</select><input class="receipt-barcode" name="HH_MaVach" type="text" inputmode="numeric" maxlength="32" autocomplete="off" value="${esc(state.HangHoa.find((item) => item.HH_Ma === line.HH_Ma)?.HH_MaVach || "")}" placeholder="Quét mã vạch rồi Enter"></td>
    <td class="ordered-quantity">${esc(progress)}${line.DN_SL === "" || line.DN_SL === undefined ? "" : `<small class="field-hint">${esc(baseUnit)} · số lượng theo đơn vị cơ bản</small>`}</td>
    <td><input name="PNCT_SL_Nhap" type="number" min="1" ${maxQuantity} step="1" value="${esc(line.PNCT_SL ?? 1)}" required></td>
    <td><select name="PNCT_DViNhap" aria-label="Đơn vị nhập">${unitPackage ? `<option value="1" ${line.PNCT_DViNhap === String(unitPackage.ratio) ? "" : "selected"}>${esc(baseUnit)}</option><option value="${unitPackage.ratio}" ${line.PNCT_DViNhap === String(unitPackage.ratio) ? "selected" : ""}>${esc(unitPackage.name)} (${unitPackage.ratio} ${esc(baseUnit)})</option>` : `<option value="1">${esc(baseUnit)}</option>`}</select></td>
    <td><input name="PNCT_DonGia_Nhap" type="number" min="0" step="1" value="${esc(line.PNCT_DonGia ?? 0)}" required></td>
    <td><input name="PNCT_NSX" type="date" value="${esc(line.PNCT_NSX || "")}"></td>
    <td><input name="PNCT_HSD" type="date" value="${esc(line.PNCT_HSD || "")}"></td>
    <td><input name="PNCT_HSDToiThieu" type="number" min="0" step="1" placeholder="Mặc định" value="${esc(line.PNCT_HSDToiThieu ?? "")}"></td>
    <td><small class="line-conversion"></small><strong class="line-total">${formatCurrency((Number(line.PNCT_SL) || 0) * (Number(line.PNCT_DonGia) || 0))}</strong></td>
    <td><button type="button" class="button button-small button-danger" data-action="remove-line">Xóa</button></td>
  </tr>`;
}

function openModal(title, body, footer, wide = false) {
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="backdrop-close"><section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-header"><h2>${esc(title)}</h2><button type="button" class="button button-small" data-action="close-modal">Đóng</button></div>
    <div class="modal-body">${body}</div><div class="modal-footer">${footer}</div></section></div>`;
}

function closeModal() {
  document.querySelector("#modal-host").innerHTML = "";
}

function openReceiptOrderPicker(state) {
  const summaries = getPurchaseOrderSummary(state).filter((summary) => (
    [PURCHASE_ORDER_STATUSES.waiting, PURCHASE_ORDER_STATUSES.partial].includes(summary.status)
    && summary.lines.some((line) => line.availableToReceive > 0)
  ));
  if (!summaries.length) return toast("Không có đơn đặt hàng nào còn số lượng được nhận.", true);
  const body = `<form id="receipt-order-picker"><div class="field"><label>Đơn đặt hàng *</label><select name="DH_Ma" required>
    <option value="">Chọn đơn hàng chờ giao</option>${summaries.map(({ order, lines, totalReceived, totalOrdered }) => {
    const availableCount = lines.reduce((sum, line) => sum + line.availableToReceive, 0);
    return `<option value="${esc(order.DH_Ma)}">${esc(order.DH_Ma)} · ${esc(supplierName(state, order.DT_Ma))} · còn nhận ${formatNumber(availableCount)} / đã nhận ${formatNumber(totalReceived)} trên ${formatNumber(totalOrdered)}</option>`;
  }).join("")}</select></div></form>`;
  openModal("Tạo phiếu nhập từ đơn đặt hàng", body,
    `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="receipt-order-picker" type="submit">Tiếp tục</button>`);
}

function openReceiptForm(state, receiptId = "", preferredOrderId = "") {
  if (!canManageReceipts()) return toast("Vai trò hiện tại chỉ được xem và đối chiếu phiếu nhập.", true);
  const receipt = state.PhieuNhap.find((row) => row.PN_Ma === receiptId);
  const selectedOrderId = receipt?.DH_Ma || preferredOrderId;
  const lines = receipt ? state.PhieuNhapChiTiet.filter((row) => row.PN_Ma === receiptId).map((line) => ({
    ...line,
    ...(receipt.DH_Ma ? orderLineProgress(state, receipt.DH_Ma, line.HH_Ma, receiptId) : {})
  })) : selectedOrderId ? orderLines(state, selectedOrderId) : [];
  if (selectedOrderId && !lines.length) return toast("Đơn này không còn dòng hàng nào khả dụng để nhận.", true);
  const vendors = state.DoiTacKinhDoanh.filter((row) => row.DT_Loai === "Nhà cung cấp");
  const orders = getPurchaseOrderSummary(state).filter((summary) => (
    [PURCHASE_ORDER_STATUSES.waiting, PURCHASE_ORDER_STATUSES.partial].includes(summary.status)
    && (summary.order.DH_Ma === selectedOrderId || summary.lines.some((line) => line.availableToReceive > 0))
  )).map((summary) => summary.order);
  const body = `<div class="form-error" id="form-error"></div><form id="receipt-form" data-edit-id="${esc(receiptId)}">
    <div class="form-grid">
      <div class="field"><label>Nhà cung cấp *</label><select name="DT_Ma" required>${optionList(vendors, "DT_Ma", "DT_Ten", receipt?.DT_Ma || state.DatHang.find((row) => row.DH_Ma === selectedOrderId)?.DT_Ma, "Chọn nhà cung cấp")}</select></div>
      <div class="field"><label>Đơn đặt hàng</label><select name="DH_Ma" data-order-fill><option value="">Không liên kết đơn đặt hàng</option>${orders.map((order) => `<option value="${esc(order.DH_Ma)}" ${order.DH_Ma === selectedOrderId ? "selected" : ""}>${esc(order.DH_Ma)} · ${esc(supplierName(state, order.DT_Ma))} · ${formatNumber(order.DH_TongSL)} ĐVT cơ bản</option>`).join("")}</select></div>
      <div class="field"><label>Địa điểm nhập *</label><select name="DD_Ma" required>${optionList(state.DiaDiem, "DD_Ma", "DD_Ten", receipt?.DD_Ma || "DD001")}</select></div>
      <div class="field"><label>Ngày nhập *</label><input name="PN_Ngay" type="date" value="${esc(receipt?.PN_Ngay || today())}" required></div>
      <div class="field"><label>Nhân viên lập</label><input value="${esc(employeeName(state, roleEmployees[role]))}" disabled></div>
      <div class="field"><label>Trạng thái</label><input value="Nháp · chưa tác động tồn" disabled></div>
    </div>
    <div class="detail-heading"><span>Chi tiết hàng hóa</span><button class="button button-small" type="button" data-action="add-receipt-line">＋ Thêm dòng</button></div>
    <div class="table-wrap"><table class="detail-table"><thead><tr><th>Mặt hàng / mã vạch</th><th>Tiến độ đơn hàng (ĐVT cơ bản)</th><th>SL nhận đợt này</th><th>Đơn vị nhập</th><th>Đơn giá theo ĐV nhập</th><th>Ngày SX</th><th>Hạn SD</th><th>Ngưỡng cảnh báo (ngày)</th><th>Quy đổi / thành tiền</th><th></th></tr></thead><tbody id="receipt-lines">${(lines.length ? lines : [{}]).map((line) => receiptLineRow(state, line)).join("")}</tbody></table></div>
    <div class="totals-row"><span>Tổng số lượng (ĐVT cơ bản): <strong id="receipt-quantity">0</strong></span><span>Tổng tiền: <strong id="receipt-total">0 ₫</strong></span></div>
  </form>`;
  openModal(receipt ? `Chỉnh sửa phiếu ${receiptId}` : "Tạo phiếu nhập nháp", body,
    `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="receipt-form" type="submit">Lưu nháp</button>`, true);
  document.querySelectorAll("#receipt-lines .edit-line").forEach((row) => refreshReceiptUnits(row, state));
  updateReceiptTotals();
}

function updateReceiptTotals() {
  const form = document.querySelector("#receipt-form");
  if (!form) return;
  let quantity = 0;
  let total = 0;
  const state = getState();
  const errors = [];
  form.querySelectorAll(".edit-line").forEach((row) => {
    const item = state.HangHoa.find((entry) => entry.HH_Ma === row.querySelector('[name="HH_Ma"]').value);
    const enteredQuantity = Number(row.querySelector('[name="PNCT_SL_Nhap"]').value) || 0;
    const enteredPrice = Number(row.querySelector('[name="PNCT_DonGia_Nhap"]').value) || 0;
    const factor = Number(row.querySelector('[name="PNCT_DViNhap"]').value) || 1;
    const conversion = row.querySelector(".line-conversion");
    try {
      const baseQuantity = toBaseQuantity(enteredQuantity, factor);
      const basePrice = toBaseUnitPrice(enteredPrice, factor);
      const lineTotal = enteredQuantity * enteredPrice;
      quantity += baseQuantity;
      total += lineTotal;
      conversion.classList.remove("conversion-error");
      conversion.textContent = factor === 1
        ? `${formatNumber(baseQuantity)} ${item?.HH_DVi || "đơn vị cơ bản"}`
        : `${formatNumber(enteredQuantity)} × ${factor} = ${formatNumber(baseQuantity)} ${item?.HH_DVi}; ${formatCurrency(basePrice)} / ${item?.HH_DVi}`;
      row.querySelector(".line-total").textContent = formatCurrency(lineTotal);
    } catch (error) {
      errors.push(error.message);
      conversion.classList.add("conversion-error");
      conversion.textContent = error.message;
      row.querySelector(".line-total").textContent = "—";
    }
  });
  form.querySelector("#receipt-quantity").textContent = errors.length ? `${formatNumber(quantity)} · kiểm tra dòng lỗi` : formatNumber(quantity);
  form.querySelector("#receipt-total").textContent = errors.length ? "Kiểm tra đơn giá quy đổi" : formatCurrency(total);
  form.querySelector("#receipt-total").classList.toggle("conversion-error", errors.length > 0);
}

function refreshReceiptUnits(row, state = getState()) {
  const itemId = row.querySelector('[name="HH_Ma"]').value;
  const item = state.HangHoa.find((entry) => entry.HH_Ma === itemId);
  const unitPackage = getUnitPackage(item);
  const select = row.querySelector('[name="PNCT_DViNhap"]');
  select.innerHTML = `<option value="1">${esc(item?.HH_DVi || "ĐVT cơ bản")}</option>${unitPackage ? `<option value="${unitPackage.ratio}">${esc(unitPackage.name)} (${unitPackage.ratio} ${esc(item.HH_DVi)})</option>` : ""}`;
  select.value = "1";
  select.dataset.previousFactor = "1";
  const orderId = document.querySelector("#receipt-form [name='DH_Ma']")?.value;
  if (orderId && state.DatChiTiet.some((line) => line.DH_Ma === orderId && line.HH_Ma === itemId)) {
    const progress = orderLineProgress(state, orderId, itemId, document.querySelector("#receipt-form")?.dataset.editId || "");
    row.querySelector(".ordered-quantity").innerHTML = `${esc(`Đặt ${formatNumber(progress.DN_SL)} · Đã nhận ${formatNumber(progress.DN_Received)} · Còn thiếu ${formatNumber(progress.DN_Remaining)} · Được nhận đợt này tối đa ${formatNumber(progress.DN_Available)}`)}<small class="field-hint">${esc(item?.HH_DVi || "ĐVT cơ bản")} · số lượng tính theo đơn vị cơ bản</small>`;
    row.dataset.orderAvailable = String(progress.DN_Available);
  } else {
    row.querySelector(".ordered-quantity").textContent = orderId ? "Mặt hàng không thuộc đơn đã chọn." : "Không liên kết đơn đặt hàng";
    delete row.dataset.orderAvailable;
  }
  updateReceiptLineLimit(row);
}

function updateReceiptLineLimit(row) {
  const availableBase = Number(row.dataset.orderAvailable);
  const quantity = row.querySelector('[name="PNCT_SL_Nhap"]');
  if (!Number.isSafeInteger(availableBase)) {
    quantity.removeAttribute("max");
    return;
  }
  const factor = Number(row.querySelector('[name="PNCT_DViNhap"]').value || 1);
  quantity.max = String(Math.floor(availableBase / factor));
}

function orderLineProgress(state, orderId, itemId, excludeReceiptId = "") {
  const orderSummary = getPurchaseOrderSummary(state).find((summary) => summary.order.DH_Ma === orderId);
  const orderLine = orderSummary?.lines.find((line) => line.HH_Ma === itemId);
  const availableToCreate = getPurchaseOrderAvailableQuantities(state, orderId, excludeReceiptId).get(itemId) || 0;
  const ownReservation = excludeReceiptId
    ? state.PhieuNhapChiTiet.filter((line) => line.PN_Ma === excludeReceiptId && line.HH_Ma === itemId).reduce((sum, line) => sum + Number(line.PNCT_SL || 0), 0)
    : 0;
  return {
    DN_SL: orderLine?.ordered ?? "",
    DN_Received: orderLine?.received ?? 0,
    DN_Remaining: orderLine?.remaining ?? 0,
    DN_Available: availableToCreate + ownReservation
  };
}

function orderLines(state, orderId, excludeReceiptId = "") {
  const available = getPurchaseOrderAvailableQuantities(state, orderId, excludeReceiptId);
  const summary = getPurchaseOrderSummary(state).find((row) => row.order.DH_Ma === orderId);
  return state.DatChiTiet.filter((row) => row.DH_Ma === orderId && (available.get(row.HH_Ma) || 0) > 0).map((row) => ({
    HH_Ma: row.HH_Ma,
    ...orderLineProgress(state, orderId, row.HH_Ma, excludeReceiptId),
    PNCT_SL: available.get(row.HH_Ma),
    PNCT_DonGia: row.DN_DonGia,
    PNCT_NSX: "", PNCT_HSD: "", PNCT_HSDToiThieu: ""
  })).filter((line) => summary?.status !== PURCHASE_ORDER_STATUSES.cancelled);
}

function viewReceipt(state, receiptId) {
  const receipt = state.PhieuNhap.find((row) => row.PN_Ma === receiptId);
  if (!receipt) return toast("Không tìm thấy phiếu nhập.", true);
  const lines = state.PhieuNhapChiTiet.filter((row) => row.PN_Ma === receiptId).map((line) => {
    const item = product(state, line.HH_Ma);
    return `<tr><td>${esc(line.PNCT_Ma)}</td><td>${esc(productName(state, line.HH_Ma))}</td><td>${esc(formatBaseQuantity(line.PNCT_SL, item))}</td><td>${formatCurrency(line.PNCT_DonGia)} / ${esc(item?.HH_DVi || "ĐVT cơ bản")}</td><td>${formatDate(line.PNCT_NSX)}</td><td>${formatDate(line.PNCT_HSD)}</td><td>${formatCurrency(line.PNCT_TTien)}</td></tr>`;
  }).join("");
  openModal(`Chi tiết phiếu nhập ${receiptId}`, `<div class="form-grid"><div><span class="field-label">Nhà cung cấp</span><div>${esc(supplierName(state, receipt.DT_Ma))}</div></div><div><span class="field-label">Đơn đặt hàng</span><div>${esc(receipt.DH_Ma || "Không liên kết")}</div></div><div><span class="field-label">Địa điểm</span><div>${esc(locationName(state, receipt.DD_Ma))}</div></div><div><span class="field-label">Ngày nhập</span><div>${formatDate(receipt.PN_Ngay)}</div></div><div><span class="field-label">Trạng thái</span><div>${badge(receipt.PN_TrangThai)}</div></div><div><span class="field-label">Nhân viên</span><div>${esc(employeeName(state, receipt.NV_Ma))}</div></div></div>
    ${tableCard("Chi tiết hàng hóa", `${formatNumber(receipt.PN_TongSL)} đơn vị cơ bản · ${formatCurrency(receipt.PN_TongTien)}`, ["Mã dòng nhập", "Mặt hàng", "Số lượng quy đổi", "Đơn giá cơ bản", "NSX", "HSD", "Thành tiền"], lines)}`, `<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function openTransferForm(state, prefill = {}) {
  if (!canCreateTransfer()) return toast("Chỉ kế toán hoặc chủ cửa hàng có thể lập phiếu chuyển trong demo.", true);
  const source = prefill.DD_Xuat || currentLocationFilter() || "DD001";
  const destination = prefill.DD_Nhan || state.DiaDiem.find((row) => row.DD_Ma !== source)?.DD_Ma || "";
  const selectedLine = prefill.HH_Ma ? getValidSaleLots(source, prefill.HH_Ma, today(), state)[0]?.line.PNCT_Ma || "" : "";
  const body = `<div class="form-error" id="form-error"></div><form id="transfer-form">
    <div class="form-grid"><div class="field"><label>Địa điểm xuất *</label><select name="DD_Xuat" required>${optionList(state.DiaDiem, "DD_Ma", "DD_Ten", source)}</select></div>
      <div class="field"><label>Địa điểm nhận *</label><select name="DD_Nhan" required>${optionList(state.DiaDiem, "DD_Ma", "DD_Ten", destination, "Chọn địa điểm nhận")}</select></div>
      <div class="field"><label>Ngày chuyển *</label><input type="date" name="PXCN_Ngay" value="${today()}" required></div>
      <div class="field"><label>Người nhận</label><input name="PXCN_NguoiNhan" value="${esc(employeeName(state, "NV004"))}"></div></div>
    <div class="detail-heading"><span>Dòng nhập cần chuyển</span><button type="button" class="button button-small" data-action="add-transfer-line">＋ Thêm dòng</button></div>
    <div class="table-wrap"><table class="detail-table"><thead><tr><th>Dòng nhập / mặt hàng</th><th>Tồn khả dụng</th><th>Số lượng chuyển</th><th></th></tr></thead><tbody id="transfer-lines">${transferLineRow(state, source, selectedLine, 1, prefill.HH_Ma || "")}</tbody></table></div>
  </form>`;
  openModal("Lập phiếu xuất chuyển nội bộ", body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="transfer-form" type="submit">Lưu phiếu chờ xuất</button>`, true);
  if (selectedLine) updateTransferAvailable(document.querySelector(".transfer-line [name='PNCT_Ma']"));
}

function transferLineRow(state, locationId, selected = "", qty = 1, HH_Ma = "") {
  return `<tr class="transfer-line"><td><select class="line-select" name="PNCT_Ma" required><option value="">Chọn dòng nhập</option>${lineOptions(state, locationId, selected, HH_Ma)}</select></td><td class="available-cell">—</td><td><input name="PXCN_SL" type="number" min="1" step="1" value="${qty}" required></td><td><button type="button" class="button button-small button-danger" data-action="remove-line">Xóa</button></td></tr>`;
}

function updateTransferAvailable(select) {
  const row = select.closest("tr");
  const selected = select.selectedOptions[0];
  row.querySelector(".available-cell").textContent = selected?.dataset.stock || "0";
  const qty = row.querySelector('[name="PXCN_SL"]');
  qty.max = selected?.dataset.stock || "0";
}

function viewTransfer(state, id) {
  const transfer = state.PhieuXuatChuyenNoiBo.find((row) => row.PXCN_Ma === id);
  if (!transfer) return toast("Không tìm thấy phiếu chuyển.", true);
  const lines = transferLinesFor(state, id).map((line) => `<tr><td>${esc(line.PNCT_Ma)}</td><td>${esc(productName(state, detail(state, line.PNCT_Ma)?.HH_Ma))}</td><td>${formatNumber(stockQty(state, transfer.DD_Xuat, line.PNCT_Ma))}</td><td>${formatNumber(line.PXCN_SL)}</td><td>${line.PXCN_SLThucNhan === null ? "Chưa nhận" : formatNumber(line.PXCN_SLThucNhan)}</td><td>${line.PXCN_SLThucNhan === null ? "—" : formatNumber(line.PXCN_SL - line.PXCN_SLThucNhan)}</td></tr>`).join("");
  openModal(`Chi tiết phiếu chuyển ${id}`, `<div class="form-grid"><div><span class="field-label">Địa điểm xuất</span><div>${esc(locationName(state, transfer.DD_Xuat))}</div></div><div><span class="field-label">Địa điểm nhận</span><div>${esc(locationName(state, transfer.DD_Nhan))}</div></div><div><span class="field-label">Ngày chuyển</span><div>${formatDate(transfer.PXCN_Ngay)}</div></div><div><span class="field-label">Người nhận</span><div>${esc(transfer.PXCN_NguoiNhan)}</div></div><div><span class="field-label">Trạng thái</span><div>${badge(transfer.PXCN_TrangThai)}</div></div></div>${tableCard("Chi tiết dòng chuyển", `${transfer.PXCN_TongSL} đơn vị dự kiến`, ["Mã dòng nhập", "Mặt hàng", "Tồn hiện tại nơi xuất", "SL chuyển", "SL thực nhận", "Chênh lệch"], lines)}`, `<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function openReceiveForm(state, id) {
  if (!canReceive()) return toast("Chỉ nhân viên cửa hàng hoặc chủ cửa hàng được xác nhận nhận hàng trong demo.", true);
  const transfer = state.PhieuXuatChuyenNoiBo.find((row) => row.PXCN_Ma === id);
  const lines = transferLinesFor(state, id);
  const body = `<div class="info-box">Nhập số lượng thực nhận theo từng dòng. Nếu thiếu hàng, chênh lệch sẽ được ghi nhận để đối chiếu; không tự động cộng đủ số lượng đã xuất.</div>
    <form id="receive-form" data-id="${esc(id)}"><div class="field"><label>Người nhận hàng *</label><input name="PXCN_NguoiNhan" value="${esc(employeeName(state, roleEmployees[role]))}" required maxlength="120"></div><div class="table-wrap" style="margin-top:14px"><table class="detail-table"><thead><tr><th>Mã dòng nhập</th><th>Mặt hàng</th><th>Đã xuất</th><th>Thực nhận</th><th>Chênh lệch</th></tr></thead><tbody>${lines.map((line) => `<tr><td>${esc(line.PNCT_Ma)}<input type="hidden" name="PNCT_Ma" value="${esc(line.PNCT_Ma)}"></td><td>${esc(productName(state, detail(state, line.PNCT_Ma)?.HH_Ma))}</td><td>${line.PXCN_SL}</td><td><input name="received" data-planned="${line.PXCN_SL}" type="number" min="0" max="${line.PXCN_SL}" value="${line.PXCN_SL}" required></td><td class="difference">0</td></tr>`).join("")}</tbody></table></div></form>`;
  openModal(`Xác nhận nhận hàng ${id}`, body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="receive-form" type="submit">Ghi nhận thực nhận</button>`, true);
}

function openCountForm(state) {
  if (!canCount()) return toast("Vai trò hiện tại không được lập phiếu kiểm kê.", true);
  const locationId = currentLocationFilter() || "DD001";
  const rows = state.PhieuNhapChiTiet.filter((line) => state.PhieuNhap.find((pn) => pn.PN_Ma === line.PN_Ma)?.PN_TrangThai === "Đã xác nhận");
  const body = `<div class="form-error" id="form-error"></div><form id="count-form">
    <div class="form-grid two"><div class="field"><label>Địa điểm kiểm kê *</label><select name="DD_Ma" required>${optionList(state.DiaDiem, "DD_Ma", "DD_Ten", locationId)}</select></div><div class="field"><label>Ngày kiểm kê *</label><input name="PKK_Ngay" type="date" value="${today()}" required></div><div class="field"><label>Nhân viên lập</label><input disabled value="${esc(employeeName(state, roleEmployees[role]))}"></div><div class="field"><label>Ghi chú</label><input name="PKK_GhiChu" placeholder="Ghi chú kiểm kê"></div></div>
    <div class="detail-heading">Tồn sổ sách và số lượng thực tế</div>
    <div class="table-wrap"><table class="detail-table"><thead><tr><th>Mã dòng nhập</th><th>Mặt hàng</th><th>Hạn SD</th><th>Tồn sổ sách</th><th>Thực tế</th><th>Chênh lệch</th><th>Lý do</th></tr></thead><tbody id="count-lines">${rows.map((line) => {
      const book = stockQty(state, locationId, line.PNCT_Ma);
      return `<tr class="count-line" data-line="${esc(line.PNCT_Ma)}" data-book="${book}"><td>${esc(line.PNCT_Ma)}</td><td>${esc(productName(state, line.HH_Ma))}</td><td>${formatDate(line.PNCT_HSD)}</td><td class="book-qty">${book}</td><td><input name="PKKCT_SLThucTe" type="number" min="0" step="1" value="${book}" required></td><td class="difference">0</td><td><input name="PKKCT_LyDo" placeholder="Nguyên nhân (nếu lệch)"></td></tr>`;
    }).join("")}</tbody></table></div>
  </form>`;
  openModal("Tạo phiếu kiểm kê nháp", body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="count-form" type="submit">Lưu nháp</button>`, true);
}

function viewCount(state, id) {
  const count = state.PhieuKiemKeKho.find((row) => row.PKK_Ma === id);
  if (!count) return toast("Không tìm thấy phiếu kiểm kê.", true);
  const rows = state.PhieuKiemKeKhoChiTiet.filter((row) => row.PKK_Ma === id).map((line) => `<tr><td>${esc(line.PNCT_Ma)}</td><td>${esc(productName(state, detail(state, line.PNCT_Ma)?.HH_Ma))}</td><td>${formatDate(detail(state, line.PNCT_Ma)?.PNCT_HSD)}</td><td>${line.PKKCT_SLSoSach}</td><td>${line.PKKCT_SLThucTe}</td><td class="${line.PKKCT_ChenhLech > 0 ? "positive" : line.PKKCT_ChenhLech < 0 ? "negative" : ""}">${line.PKKCT_ChenhLech > 0 ? "+" : ""}${line.PKKCT_ChenhLech}</td><td>${esc(line.PKKCT_LyDo || "—")}</td></tr>`).join("");
  openModal(`Chi tiết kiểm kê ${id}`, `<div class="form-grid"><div><span class="field-label">Địa điểm</span><div>${esc(locationName(state, count.DD_Ma))}</div></div><div><span class="field-label">Ngày kiểm kê</span><div>${formatDate(count.PKK_Ngay)}</div></div><div><span class="field-label">Trạng thái</span><div>${badge(count.PKK_TrangThai)}</div></div><div><span class="field-label">Nhân viên lập</span><div>${esc(employeeName(state, count.NV_Ma))}</div></div><div><span class="field-label">Người duyệt</span><div>${esc(employeeName(state, count.NV_Duyet))}</div></div><div><span class="field-label">Ghi chú</span><div>${esc(count.PKK_GhiChu || "—")}</div></div></div>${tableCard("Chi tiết kiểm kê", "", ["Mã dòng nhập", "Mặt hàng", "HSD", "Sổ sách", "Thực tế", "Chênh lệch", "Lý do"], rows)}`, `<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function openSource(state, source, id) {
  if (source === "PhieuNhap") return viewReceipt(state, id);
  if (source === "PhieuXuatChuyenNoiBo") return viewTransfer(state, id);
  if (source === "PhieuKiemKeKho") return viewCount(state, id);
  if (source === "TraHangNCC") return viewSupplierReturn(state, id);
  if (source === "HoaDonBanHang") {
    const sale = state.HoaDonBanHang.find((row) => row.BH_Ma === id);
    return openModal(`Hóa đơn bán hàng ${id}`, `<div class="info-box">Chứng từ mẫu thuộc phân hệ bán hàng, chỉ hiển thị tham chiếu.</div><p>Ngày: ${formatDate(sale?.BH_Ngay)} · Địa điểm: ${esc(locationName(state, sale?.DD_Ma))} · Tổng tiền: ${formatCurrency(sale?.BH_TongCong)}</p>`, `<button class="button" data-action="close-modal">Đóng</button>`);
  }
  toast("Không tìm thấy loại chứng từ nguồn này.", true);
}

function viewLedgerSource(state, movementId) {
  const movement = state.BienDongKho.find((row) => row.BDK_Ma === movementId);
  if (!movement?.BDK_Nguon || !movement.BDK_MaChungTu) {
    return toast("Biến động kho thiếu thông tin chứng từ nguồn để mở chi tiết.", true);
  }
  if (movement.BDK_Nguon !== "HoaDonBanHang") return openSource(state, movement.BDK_Nguon, movement.BDK_MaChungTu);
  const sale = state.HoaDonBanHang.find((row) => row.BH_Ma === movement.BDK_MaChungTu);
  if (!sale) return toast(`Không tìm thấy hóa đơn nguồn ${movement.BDK_MaChungTu}.`, true);
  const lines = state.HoaDonBanHangChiTiet.filter((row) => row.BH_Ma === sale.BH_Ma).map((row) => {
    const inboundLine = detail(state, row.PNCT_Ma);
    const item = product(state, inboundLine?.HH_Ma);
    return `<tr><td>${esc(row.PNCT_Ma)}</td><td>${esc(item?.HH_Ma || "—")}</td><td>${esc(item?.HH_Ten || "—")}</td><td>${esc(formatBaseQuantity(row.BH_SL, item))}</td><td>${formatCurrency(row.BH_DonGia)}</td><td>${formatCurrency(row.BH_TTien)}</td></tr>`;
  }).join("");
  openModal(`Hóa đơn bán hàng ${sale.BH_Ma}`, `<div class="form-grid">
    <div><span class="field-label">Ngày</span><div>${formatDate(sale.BH_Ngay)}</div></div>
    <div><span class="field-label">Địa điểm</span><div>${esc(locationName(state, sale.DD_Ma))}</div></div>
    <div><span class="field-label">Trạng thái</span><div>${esc(sale.BH_TrangThai || "—")}</div></div>
    <div><span class="field-label">Tổng hóa đơn</span><div>${formatCurrency(sale.BH_TongCong)}</div></div>
  </div>${tableCard("Chi tiết hóa đơn", "", ["Mã dòng nhập", "Mã hàng", "Tên hàng", "Số lượng", "Đơn giá", "Thành tiền"], lines || emptyRow(6, "Hóa đơn không có dòng chi tiết."))}`, `<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportStockLedger(state) {
  const item = product(state, stockLedgerFilters.itemId);
  if (!item) return toast("Hãy chọn sản phẩm trước khi xuất thẻ kho.", true);
  const report = buildStockLedgerReport(state, stockLedgerFilters);
  const columns = ["Ngày giờ", "Mã biến động", "Địa điểm", "Mã hàng", "Tên hàng", "Mã dòng nhập", "Loại biến động", "Nguồn", "Mã chứng từ", "Thay đổi (đơn vị cơ bản)", "Số dư sau (đơn vị cơ bản)", "Nhân viên", "Ghi chú"];
  const rows = report.rows.map((row) => {
    const line = detail(state, row.PNCT_Ma);
    const rowItem = product(state, line?.HH_Ma);
    return [
      row.BDK_Ngay, row.BDK_Ma, locationName(state, row.DD_Ma), rowItem?.HH_Ma || item.HH_Ma,
      rowItem?.HH_Ten || item.HH_Ten, row.PNCT_Ma, row.BDK_Loai, row.BDK_Nguon,
      row.BDK_MaChungTu, row.BDK_SoLuong, report.complete ? row.BDK_SoDuSau : "",
      employeeName(state, row.NV_Ma), row.BDK_GhiChu
    ];
  });
  const csv = `\uFEFF${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `the-kho-${item.HH_Ma}-${stockLedgerFilters.from}-${stockLedgerFilters.to}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function toast(message, error = false) {
  const host = document.querySelector("#toast-host");
  const node = document.createElement("div");
  node.className = `toast ${error ? "error" : ""}`;
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), 4200);
}

function showFormError(message) {
  const node = document.querySelector("#form-error");
  if (node) {
    node.textContent = message;
    node.classList.add("visible");
  } else toast(message, true);
}

function values(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  const state = getState();
  if (action === "close-modal") return closeModal();
  if (action === "backdrop-close" && event.target === button) return closeModal();
  if (action === "ledger-source") viewLedgerSource(state, id);
  else if (action === "new-supplier-return") openSupplierReturnForm(state);
  else if (action === "view-supplier-return") viewSupplierReturn(state, id);
  else if (action === "edit-supplier-return") openSupplierReturnForm(state, id);
  else if (action === "supplier-returns-page") {
    returnPage = Math.max(1, Number(button.dataset.page) || 1);
    renderContent();
  } else if (action === "clear-supplier-return-filters") {
    returnFilters = { search: "", status: "", from: "", to: "" };
    returnPage = 1;
    renderContent();
  } else if (action === "submit-supplier-return") {
    if (!confirm(`Gửi phiếu ${id} cho Chủ cửa hàng duyệt? Tồn kho chưa thay đổi.`)) return;
    try { submitSupplierReturn(id, role); renderContent(); toast(`Đã gửi phiếu ${id} chờ duyệt. Tồn kho chưa thay đổi.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "approve-supplier-return") {
    if (!confirm(`Duyệt yêu cầu trả ${id}? Tồn chưa giảm cho đến khi Kho xác nhận xuất.`)) return;
    try { approveSupplierReturn(id, roleEmployees[role], role); renderContent(); toast(`Đã duyệt phiếu ${id}. Tồn kho chưa thay đổi.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "reject-supplier-return") {
    if (!confirm(`Từ chối yêu cầu trả ${id}?`)) return;
    try { rejectSupplierReturn(id, roleEmployees[role], role); renderContent(); toast(`Đã từ chối yêu cầu ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "cancel-supplier-return") {
    if (!confirm(`Hủy phiếu ${id}? Phiếu đã xuất trả không thể hủy.`)) return;
    try { cancelSupplierReturn(id, role); renderContent(); toast(`Đã hủy phiếu ${id}; tồn kho không thay đổi.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "delete-supplier-return") {
    if (!confirm(`Xóa phiếu nháp ${id}?`)) return;
    try { deleteDraftSupplierReturn(id, role); renderContent(); toast(`Đã xóa phiếu nháp ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "confirm-supplier-return") {
    if (!confirm(`Xác nhận đã xuất hàng ${id} cho nhà cung cấp? Tồn kho sẽ giảm và ghi một biến động TraNCC.`)) return;
    try { confirmSupplierReturn(id, roleEmployees[role], role); renderContent(); toast(`Đã xuất trả ${id}; tồn kho và thẻ kho đã cập nhật.`); }
    catch (error) { toast(error.message, true); }
  }
  else if (action === "new-receipt-from-order") openReceiptOrderPicker(state);
  else if (action === "ledger-export") exportStockLedger(state);
  else if (action === "ledger-refresh") renderContent();
  else if (action === "ledger-page") {
    stockLedgerPage = Math.max(1, Number(button.dataset.page) || 1);
    renderContent();
  } else if (action === "reset") {
    if (!confirm("Khôi phục toàn bộ dữ liệu demo ban đầu? Các thay đổi đang lưu trên trình duyệt sẽ bị thay thế.")) return;
    resetDemoData();
    renderContent();
    closeModal();
    toast("Đã khôi phục dữ liệu demo ban đầu.");
  } else if (action === "clear-filters") {
    document.querySelectorAll(".filter-control").forEach((input) => { input.value = ""; });
    applyFilters();
  } else if (action === "new-receipt") openReceiptForm(state);
  else if (action === "edit-receipt") openReceiptForm(state, id);
  else if (action === "view-receipt") viewReceipt(state, id);
  else if (action === "submit-receipt-review") {
    if (!confirm(`Gửi phiếu nhập ${id} cho kế toán xác nhận? Chưa cập nhật tồn kho hoặc công nợ.`)) return;
    try { submitInboundForReview(id); renderContent(); toast(`Đã gửi phiếu ${id} cho kế toán; tồn kho chưa thay đổi.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "cancel-receipt") {
    if (!confirm(`Hủy phiếu nháp ${id}?`)) return;
    try { cancelInbound(id); renderContent(); toast(`Đã hủy ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "add-receipt-line") {
    document.querySelector("#receipt-lines").insertAdjacentHTML("beforeend", receiptLineRow(state));
    updateReceiptTotals();
  } else if (action === "remove-line") {
    const rows = button.closest("tbody").querySelectorAll("tr");
    if (rows.length <= 1) return toast("Phiếu cần có ít nhất một dòng hàng.", true);
    button.closest("tr").remove();
    updateReceiptTotals();
  } else if (action === "new-transfer") openTransferForm(state);
  else if (action === "add-transfer-line") {
    const source = document.querySelector('[name="DD_Xuat"]').value;
    document.querySelector("#transfer-lines").insertAdjacentHTML("beforeend", transferLineRow(state, source));
  } else if (action === "view-transfer") viewTransfer(state, id);
  else if (action === "dispatch-transfer") {
    if (!confirm(`Xác nhận xuất ${id}? Tồn địa điểm xuất sẽ giảm theo số lượng chuyển.`)) return;
    try { dispatchTransfer(id, roleEmployees[role], role); renderContent(); toast(`Đã xuất hàng ${id}; trạng thái phiếu là đang chuyển.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "receive-transfer") openReceiveForm(state, id);
  else if (action === "new-count") openCountForm(state);
  else if (action === "view-count") viewCount(state, id);
  else if (action === "submit-count") {
    if (!confirm(`Gửi phiếu ${id} để chờ duyệt?`)) return;
    try { submitCount(id); renderContent(); toast(`Đã gửi duyệt ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "approve-count") {
    if (!confirm(`Duyệt ${id} và ghi nhận điều chỉnh tồn theo chênh lệch?`)) return;
    try { approveCount(id, roleEmployees[role], role); renderContent(); toast(`Đã duyệt ${id}; tồn và lịch sử kho đã cập nhật.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "stock-mode") {
    stockMode = button.dataset.mode;
    renderContent();
  } else if (action === "transfer-tab") {
    transferTab = button.dataset.status;
    const statusFilter = document.querySelector('.filter-control[data-filter="status"]');
    if (statusFilter) statusFilter.value = "";
    renderContent();
  } else if (action === "source") {
    event.preventDefault();
    openSource(state, button.dataset.source, id);
  }
}

function handleSubmit(event) {
  const form = event.target;
  if (form.id === "supplier-return-filters") {
    event.preventDefault();
    const filterValues = Object.fromEntries(new FormData(form).entries());
    const from = String(filterValues.from || "");
    const to = String(filterValues.to || "");
    if (from && to && from > to) return toast("Ngày bắt đầu không được sau ngày kết thúc.", true);
    returnFilters = {
      search: String(filterValues.search || "").trim(),
      status: String(filterValues.status || ""),
      from,
      to
    };
    returnPage = 1;
    renderContent();
    return;
  }
  if (form.id === "supplier-return-form") {
    event.preventDefault();
    try {
      const lines = [...form.querySelectorAll(".supplier-return-line")].flatMap((row) => {
        const quantity = Number(row.querySelector('[name="TRNCC_SLNhap"]').value || 0);
        if (quantity === 0) return [];
        const factor = Number(row.querySelector('[name="TRNCC_HeSo"]').value || 1);
        return [{
          PNCT_Ma: row.dataset.line,
          TRNCC_SL: toBaseQuantity(quantity, factor),
          TRNCC_SLNhap: quantity,
          TRNCC_HeSo: factor,
          TRNCC_LyDoChiTiet: row.querySelector('[name="TRNCC_LyDoChiTiet"]').value
        }];
      });
      const id = saveSupplierReturn({
        ...values(form),
        TRNCC_Ma: form.dataset.editId || "",
        NV_Ma: roleEmployees[role],
        lines
      }, role);
      closeModal();
      renderContent();
      toast(`Đã lưu phiếu trả nháp ${id}. Tồn kho chưa thay đổi.`);
    } catch (error) {
      showFormError(error.message || "Không thể lưu phiếu trả NCC.");
    }
    return;
  }
  if (form.id === "stock-ledger-filters") {
    event.preventDefault();
    stockLedgerFilters = {
      itemId: String(new FormData(form).get("itemId") || ""),
      locationId: String(new FormData(form).get("locationId") || ""),
      lineId: String(new FormData(form).get("lineId") || ""),
      from: String(new FormData(form).get("from") || ""),
      to: String(new FormData(form).get("to") || ""),
      movementType: String(new FormData(form).get("movementType") || "all")
    };
    stockLedgerPage = 1;
    renderContent();
    return;
  }
  if (!["receipt-form", "transfer-form", "receive-form", "count-form", "receipt-order-picker"].includes(form.id)) return;
  event.preventDefault();
  try {
    if (form.id === "receipt-form") {
      const lines = [...form.querySelectorAll(".edit-line")].map((row) => {
        const line = Object.fromEntries([...row.querySelectorAll("[name]")].map((input) => [input.name, input.value]));
        const factor = Number(line.PNCT_DViNhap || 1);
        line.PNCT_SL = toBaseQuantity(line.PNCT_SL_Nhap, factor);
        line.PNCT_DonGia = toBaseUnitPrice(line.PNCT_DonGia_Nhap, factor);
        delete line.PNCT_SL_Nhap;
        delete line.PNCT_DonGia_Nhap;
        delete line.PNCT_DViNhap;
        return line;
      });
      const formValues = values(form);
      const id = saveInbound({ ...formValues, PN_Ma: form.dataset.editId || "", NV_Ma: roleEmployees[role], lines });
      closeModal();
      renderContent();
      toast(`Đã lưu phiếu nhập nháp ${id}. Tồn kho chưa thay đổi.`);
    } else if (form.id === "transfer-form") {
      const lines = [...form.querySelectorAll(".transfer-line")].map((row) => ({
        PNCT_Ma: row.querySelector('[name="PNCT_Ma"]').value,
        PXCN_SL: row.querySelector('[name="PXCN_SL"]').value
      }));
      const id = createTransfer({ ...values(form), NV_Ma: roleEmployees[role], role, lines });
      closeModal();
      renderContent();
      toast(`Đã tạo phiếu chuyển ${id} ở trạng thái chờ xuất.`);
    } else if (form.id === "receive-form") {
      const actualQuantities = {};
      form.querySelectorAll('input[name="received"]').forEach((input) => {
        const pnct = input.closest("tr").querySelector('input[name="PNCT_Ma"]').value;
        actualQuantities[pnct] = input.value;
      });
      receiveTransfer(form.dataset.id, actualQuantities, roleEmployees[role], values(form).PXCN_NguoiNhan, role);
      closeModal();
      renderContent();
      toast(`Đã ghi nhận hàng thực nhận cho ${form.dataset.id}.`);
    } else if (form.id === "receipt-order-picker") {
      const orderId = values(form).DH_Ma;
      closeModal();
      openReceiptForm(getState(), "", orderId);
    } else {
      const lines = [...form.querySelectorAll(".count-line")].map((row) => ({
        PNCT_Ma: row.dataset.line, PKKCT_SLSoSach: row.dataset.book,
        PKKCT_SLThucTe: row.querySelector('[name="PKKCT_SLThucTe"]').value,
        PKKCT_LyDo: row.querySelector('[name="PKKCT_LyDo"]').value
      }));
      const id = createCount({ ...values(form), NV_Ma: roleEmployees[role], lines });
      closeModal();
      renderContent();
      toast(`Đã lưu phiếu kiểm kê nháp ${id}.`);
    }
  } catch (error) {
    showFormError(error.message || "Không thể lưu dữ liệu.");
  }
}

function handleChange(event) {
  const target = event.target;
  if (target.id === "ledger-item") {
    const lineSelect = document.querySelector("#ledger-line");
    const lines = getState().PhieuNhapChiTiet.filter((row) => row.HH_Ma === target.value);
    lineSelect.innerHTML = `<option value="">Tất cả dòng nhập của sản phẩm</option>${lines.map((row) => `<option value="${esc(row.PNCT_Ma)}">${esc(row.PNCT_Ma)} · ${esc(row.PN_Ma)} · HSD ${esc(formatDate(row.PNCT_HSD))}</option>`).join("")}`;
  } else if (target.id === "global-role") {
    role = target.value;
    localStorage.setItem("stmn-kho-demo-role", role);
    renderContent();
  } else if (target.id === "global-location") {
    localStorage.setItem("stmn-kho-demo-location", target.value);
    renderContent();
  } else if (target.matches("#supplier-return-form [name='DT_Ma']")) {
    const state = getState();
    const form = target.form;
    const receipts = returnReceiptsFor(state, target.value);
    form.querySelector('[name="PN_Ma"]').innerHTML = `<option value="">Chọn phiếu nhập gốc</option>${receipts.map((row) => `<option value="${esc(row.PN_Ma)}">${esc(row.PN_Ma)} · ${formatDate(row.PN_Ngay)}</option>`).join("")}`;
    if (receipts.length) form.querySelector('[name="PN_Ma"]').value = receipts[0].PN_Ma;
    renderSupplierReturnLines(state, form);
  } else if (target.matches("#supplier-return-form [name='PN_Ma'], #supplier-return-form [name='DD_Ma']")) {
    renderSupplierReturnLines(getState(), target.form);
  } else if (target.matches("#supplier-return-lines [name='TRNCC_HeSo']")) {
    const row = target.closest(".supplier-return-line");
    const input = row.querySelector('[name="TRNCC_SLNhap"]');
    const previousFactor = Number(input.dataset.factor || 1);
    const nextFactor = Number(target.value || 1);
    const baseQuantity = Number(input.value || 0) * previousFactor;
    if (baseQuantity % nextFactor !== 0) {
      target.value = String(previousFactor);
      toast("Số lượng hiện tại không thể quy đổi chính xác sang đơn vị đã chọn.", true);
      return;
    }
    input.value = String(baseQuantity / nextFactor);
    input.dataset.factor = String(nextFactor);
    input.max = String(Math.floor(Number(row.dataset.available) / nextFactor));
    updateSupplierReturnTotals();
  } else if (target.matches(".filter-control")) applyFilters();
  else if (target.matches("[data-order-fill]")) {
    const state = getState();
    const order = state.DatHang.find((row) => row.DH_Ma === target.value);
    if (order) document.querySelector("#receipt-form [name='DT_Ma']").value = order.DT_Ma;
    const lines = target.value ? orderLines(state, target.value) : [];
    if (target.value && !lines.length) toast("Đơn này không còn dòng hàng khả dụng để nhận.", true);
    document.querySelector("#receipt-lines").innerHTML = (lines.length ? lines : [{}]).map((line) => receiptLineRow(state, line)).join("");
    document.querySelectorAll("#receipt-lines .edit-line").forEach((row) => refreshReceiptUnits(row, state));
    updateReceiptTotals();
  } else if (target.matches("#receipt-lines [name='HH_Ma']")) {
    const state = getState();
    const selected = state.HangHoa.find((item) => item.HH_Ma === target.value);
    target.closest(".edit-line").querySelector("[name='HH_MaVach']").value = selected?.HH_MaVach || "";
    refreshReceiptUnits(target.closest(".edit-line"), state);
    updateReceiptTotals();
  } else if (target.matches("#receipt-lines [name='PNCT_DViNhap']")) {
    const row = target.closest(".edit-line");
    const previousFactor = Number(target.dataset.previousFactor || 1);
    const nextFactor = Number(target.value || 1);
    const quantity = row.querySelector("[name='PNCT_SL_Nhap']");
    const price = row.querySelector("[name='PNCT_DonGia_Nhap']");
    try {
      const baseQuantity = quantity.value === "" ? null : toBaseQuantity(quantity.value, previousFactor);
      const basePrice = price.value === "" ? null : toBaseUnitPrice(price.value, previousFactor);
      if (baseQuantity !== null && baseQuantity % nextFactor !== 0) {
        throw new Error("Số lượng hiện tại không thể quy đổi chính xác sang đơn vị đã chọn.");
      }
      if (baseQuantity !== null) quantity.value = String(baseQuantity / nextFactor);
      if (basePrice !== null) {
        const nextPrice = basePrice * nextFactor;
        if (!Number.isSafeInteger(nextPrice)) throw new Error("Đơn giá quy đổi vượt giới hạn cho phép.");
        price.value = String(nextPrice);
      }
    } catch (error) {
      target.value = String(previousFactor);
      toast(error.message, true);
      return;
    }
    target.dataset.previousFactor = String(nextFactor);
    updateReceiptLineLimit(target.closest(".edit-line"));
    updateReceiptTotals();
  } else if (target.matches(".transfer-line [name='PNCT_Ma']")) updateTransferAvailable(target);
  else if (target.matches("#transfer-form [name='DD_Xuat']")) {
    const state = getState();
    document.querySelector("#transfer-lines").innerHTML = transferLineRow(state, target.value);
  } else if (target.matches("#count-form [name='DD_Ma']")) {
    const state = getState();
    const rows = state.PhieuNhapChiTiet.filter((line) => state.PhieuNhap.find((pn) => pn.PN_Ma === line.PN_Ma)?.PN_TrangThai === "Đã xác nhận");
    document.querySelector("#count-lines").innerHTML = rows.map((line) => {
      const book = stockQty(state, target.value, line.PNCT_Ma);
      return `<tr class="count-line" data-line="${esc(line.PNCT_Ma)}" data-book="${book}"><td>${esc(line.PNCT_Ma)}</td><td>${esc(productName(state, line.HH_Ma))}</td><td>${formatDate(line.PNCT_HSD)}</td><td class="book-qty">${book}</td><td><input name="PKKCT_SLThucTe" type="number" min="0" value="${book}" required></td><td class="difference">0</td><td><input name="PKKCT_LyDo" placeholder="Nguyên nhân (nếu lệch)"></td></tr>`;
    }).join("");
  }
}

function handleInput(event) {
  const target = event.target;
  if (target.matches("#supplier-return-lines [name='TRNCC_SLNhap']")) updateSupplierReturnTotals();
  if (target.id === "ledger-item-search") {
    const query = target.value.trim().toLocaleLowerCase("vi-VN");
    document.querySelectorAll("#ledger-item option[data-ledger-search]").forEach((option) => {
      option.hidden = Boolean(query) && !option.dataset.ledgerSearch.includes(query);
    });
  }
  if (target.matches(".filter-control")) applyFilters();
  if (target.closest("#receipt-form") && target.matches('[name="PNCT_SL_Nhap"], [name="PNCT_DonGia_Nhap"]')) updateReceiptTotals();
  if (target.matches("#count-form [name='PKKCT_SLThucTe']")) {
    const row = target.closest("tr");
    row.querySelector(".difference").textContent = Number(target.value || 0) - Number(row.dataset.book);
  }
  if (target.matches("#receive-form [name='received']")) {
    const row = target.closest("tr");
    row.querySelector(".difference").textContent = Number(row.querySelector("[data-planned]").dataset.planned) - Number(target.value || 0);
  }
}

function handleKeydown(event) {
  if (event.key === "Enter" && event.target.matches("#receipt-form [name='HH_MaVach']")) {
    event.preventDefault();
    const input = event.target;
    const barcode = String(input.value || "").trim();
    if (!barcode) return;
    const item = getState().HangHoa.find((row) => String(row.HH_MaVach || "").trim() === barcode);
    if (!item) {
      toast("Không tìm thấy hàng hóa có mã vạch này. Bạn có thể chọn mặt hàng thủ công.", true);
      return;
    }
    const row = input.closest(".edit-line");
    row.querySelector("[name='HH_Ma']").value = item.HH_Ma;
    input.value = item.HH_MaVach;
    refreshReceiptUnits(row);
    updateReceiptTotals();
    toast(`Đã chọn ${item.HH_Ten}. Mã dòng nhập sẽ được tạo khi lưu phiếu.`);
  }
  if (event.key === "Escape") closeModal();
}

document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("change", handleChange);
document.addEventListener("input", handleInput);
document.addEventListener("keydown", handleKeydown);

try {
  shell();
} catch (error) {
  document.querySelector("#app").innerHTML = `<main class="content"><div class="warning-box">${esc(error.message || "Không thể tải ứng dụng kho.")}</div><button class="button button-primary" id="restore-data">Khôi phục dữ liệu demo</button></main>`;
  document.querySelector("#restore-data").addEventListener("click", () => {
    try { resetDemoData(); location.reload(); }
    catch (restoreError) { toast(restoreError.message, true); }
  });
}
