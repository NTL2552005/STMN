import { getState, resetDemoData } from "../../services/kho-service.js";
import { getActivePrice, getAvailableStock, getInventoryPosition, getValidSaleLots } from "../../services/inventory-service.js";
import { confirmPayment, createDraftInvoice, createInvoice, deleteDraftInvoice, getDraftInvoiceMetadata, getInvoiceOutstanding, getInvoicePaid, recordPayment, setPaymentStatus } from "../../services/sales-service.js";
import { listCustomers, saveCustomer, validatePartnerData } from "../../services/customer-service.js";
import {
  calculateCashShift, getCashShift, getCashShifts, getOpenCashShift, openCashShift,
  respondCashShiftExplanation, submitCashShift
} from "../../services/cash-register-service.js";
import { getUnitPackage, toBaseQuantity } from "../../services/unit-service.js";
import { escapeHtml as esc, formatCurrency, formatDate, formatNumber } from "../../utils/formatters.js";
import { canAccessPage, getMockActorCode, requirePageAccess } from "../../services/auth-service.js";

const page = document.body.dataset.page;
const session = await requirePageAccess("sales", page);
const role = session.role;
const roleEmployees = { [role]: getMockActorCode(role) || session.employeeCode };
const warehousePages = [
  ["overview", "Tổng quan kho", "tong-quan-kho.html", "▦"],
  ["receipts", "Phiếu nhập kho", "phieu-nhap.html", "⇩"],
  ["stock", "Theo dõi tồn kho", "ton-kho.html", "▤"],
  ["transfers", "Xuất chuyển nội bộ", "xuat-chuyen-noi-bo.html", "⇄"],
  ["returns", "Trả hàng NCC", "tra-hang-ncc.html", "↩"],
  ["counts", "Kiểm kê kho", "kiem-ke-kho.html", "✓"],
  ["ledger", "Thẻ kho", "the-kho.html", "▥"],
  ["movements", "Biến động kho", "bien-dong-kho.html", "↗"],
  ["expiry", "Hạn sử dụng", "han-su-dung.html", "◷"]
];
const salesPages = [
  ["overview", "Tổng quan bán hàng", "tong-quan-ban-hang.html", "▦"],
  ["pos", "Bán hàng tại quầy", "ban-hang.html", "▣"],
  ["shifts", "Ca bán hàng", "ca-ban-hang.html", "◷"],
  ["invoices", "Hóa đơn bán hàng", "hoa-don.html", "▤"],
  ["payments", "Thanh toán", "thanh-toan.html", "＄"],
  ["customers", "Khách hàng", "khach-hang.html", "♙"],
  ["debts", "Công nợ khách hàng", "cong-no-khach-hang.html", "◷"]
];
const accountingPages = [
  ["accounting-overview", "Tổng quan kế toán", "tong-quan-ke-toan.html", "▦"],
  ["purchase-reconciliation", "Đối chiếu nhập hàng", "doi-chieu-nhap-hang.html", "⇩"],
  ["stock-reconciliation", "Đối chiếu chứng từ kho", "doi-chieu-chung-tu-kho.html", "⇄"],
  ["supplier-debts", "Công nợ nhà cung cấp", "cong-no-ncc.html", "◷"],
  ["supplier-payments", "Thanh toán NCC", "thanh-toan-ncc.html", "＄"],
  ["receipts", "Phiếu thu", "phieu-thu.html", "＋"],
  ["expenses", "Phiếu chi", "phieu-chi.html", "－"],
  ["revenue-reconciliation", "Đối soát doanh thu", "doi-soat-doanh-thu.html", "▤"],
  ["payment-reconciliation", "Đối soát thanh toán", "doi-soat-thanh-toan.html", "✓"],
  ["cash-shift-reconciliation", "Đối soát ca bán hàng", "doi-soat-ca-ban-hang.html", "◷"],
  ["reports", "Báo cáo kế toán", "bao-cao-ke-toan.html", "▥"]
];
const pageTitle = salesPages.find(([key]) => key === page)?.[1] || "Bán hàng";
let locationId = localStorage.getItem("stmn-kho-demo-sales-location") || "";
let cart = new Map();
let selectedCustomer = "";
let paymentMethod = "Tiền mặt";
let paymentAmount = null;
let paymentAmountTouched = false;
let paymentSplits = { "Tiền mặt": 0, "Chuyển khoản": 0, QR: 0 };
let allowCredit = false;
let basketDiscount = null;
let activeDraftId = "";
let dashboardFrom = "";
let dashboardTo = "";
let productQuery = "";
let customerQuery = "";
let cameraScanner = null;
let cameraRunning = false;
let cameraStarting = false;
let cameraProcessing = false;
let cameraSession = 0;

const today = () => new Date().toISOString().slice(0, 10);
const itemById = (state, id) => state.HangHoa.find((row) => row.HH_Ma === id);
const itemName = (state, id) => itemById(state, id)?.HH_Ten || id || "—";
const partnerName = (state, id) => state.DoiTacKinhDoanh.find((row) => row.DT_Ma === id)?.DT_Ten || "Khách lẻ";
const locationName = (state, id) => state.DiaDiem.find((row) => row.DD_Ma === id)?.DD_Ten || "—";
const employeeName = (state, id) => id === session.employeeCode
  ? session.user.employee?.NV_Ten || session.user.username
  : state.NhanVien.find((row) => row.NV_Ma === id)?.NV_Ten || "—";
const invoiceLines = (state, id) => state.HoaDonBanHangChiTiet.filter((row) => row.BH_Ma === id);
const cartKey = (HH_Ma, unitFactor = 1) => `${HH_Ma}::${unitFactor}`;
const cartBaseQuantity = (row) => row.quantity * (row.unitFactor || 1);
const cartProductQuantity = (HH_Ma, source = cart, exceptId = "") => [...source.entries()].reduce((sum, [id, row]) => (
  row.HH_Ma === HH_Ma && id !== exceptId ? sum + cartBaseQuantity(row) : sum
), 0);
const cartProductQuantities = (source = cart) => {
  const quantities = new Map();
  for (const row of source.values()) quantities.set(row.HH_Ma, (quantities.get(row.HH_Ma) || 0) + cartBaseQuantity(row));
  return quantities;
};
const saleRoles = new Set(["Chủ cửa hàng", "Nhân viên bán hàng"]);
const accountingRoles = new Set(["Chủ cửa hàng", "Nhân viên kế toán"]);
const paymentRoles = new Set(["Chủ cửa hàng", "Nhân viên bán hàng"]);
const inventoryViewRoles = new Set(["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán"]);
const dateTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(date);
};

function toast(message, error = false, duration = 4200) {
  const host = document.querySelector("#toast-host");
  const node = document.createElement("div");
  node.className = `toast ${error ? "error" : ""}`;
  node.textContent = message;
  host.append(node);
  setTimeout(() => node.remove(), duration);
}

function badge(status) {
  const tone = ({
    "Đã xác nhận": "green", "Thành công": "green", "Đã thanh toán": "green",
    "Chờ xác nhận": "amber", "Còn nợ": "red", "Thất bại": "red", "Đã hủy": "gray"
  })[status] || "gray";
  return `<span class="badge badge-${tone}">${esc(status || "—")}</span>`;
}

function options(rows, valueKey, labelKey, selected = "", first = "") {
  return `${first ? `<option value="">${esc(first)}</option>` : ""}${rows.map((row) => `<option value="${esc(row[valueKey])}" ${row[valueKey] === selected ? "selected" : ""}>${esc(row[labelKey])}</option>`).join("")}`;
}

function tableCard(title, subtitle, headers, rows, note = "") {
  return `<div class="table-card"><div class="table-toolbar"><strong>${title}</strong><span>${subtitle}</span></div><div class="table-wrap"><table><thead><tr>${headers.map((head) => `<th>${head}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="empty-state">Không có dữ liệu.</td></tr>`}</tbody></table></div>${note ? `<div class="table-subnote">${note}</div>` : ""}</div>`;
}

function heading(title, description, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${action}</div></div>`;
}

function shell() {
  const state = getState();
  document.body.classList.toggle("pos-active", page === "pos");
  const stores = state.DiaDiem.filter((row) => row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động");
  if (!stores.some((row) => row.DD_Ma === locationId)) locationId = stores[0]?.DD_Ma || "";
  localStorage.setItem("stmn-kho-demo-sales-location", locationId);
  const salesLinks = salesPages.filter(([key]) => canAccessPage("sales", key, role))
    .map(([key, label, file, icon]) => `<a class="nav-link ${page === key ? "active" : ""}" href="${file}" title="${label}"><span class="nav-icon">${icon}</span><span class="nav-text">${label}</span></a>`).join("");
  const accountingLinks = accountingPages.filter(([key]) => canAccessPage("accounting", key, role))
    .map(([, label, file, icon]) => `<a class="nav-link" href="${file}" title="${label}"><span class="nav-icon">${icon}</span><span class="nav-text">${label}</span></a>`).join("");
  const warehouseLinks = warehousePages.filter(([key]) => canAccessPage("warehouse", key, role))
    .map(([, label, file, icon]) => `<a class="nav-link" href="../kho/${file}" title="${label}"><span class="nav-icon">${icon}</span><span class="nav-text">${label}</span></a>`).join("");
  document.querySelector("#app").innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="tong-quan-ban-hang.html"><span class="brand-mark">S</span><div><strong>Siêu thị mini</strong><small>Hệ thống quản lý</small></div></a>
      ${canAccessPage("owner", "overview", role) ? '<a class="nav-link" href="../chu-cua-hang/tong-quan.html"><span class="nav-icon">⌂</span><span class="nav-text">Chủ cửa hàng</span></a>' : ""}
      <div class="nav-label">Bán hàng</div>${salesLinks}
      ${accountingLinks ? `<div class="module-label">Kế toán</div>${accountingLinks}` : ""}
      ${warehouseLinks ? `<div class="module-label">Quản lý kho</div>${warehouseLinks}` : ""}
      <div class="sidebar-bottom">Dữ liệu kho và POS dùng chung<br>Mock data · lưu trên trình duyệt</div>
    </aside>
    <main class="main-area">
      <header class="topbar">
        <div><div class="topbar-title">${pageTitle}</div><div class="topbar-subtitle">Bán hàng tại quầy · Bản mô phỏng nghiệp vụ</div></div>
        <div class="topbar-actions">
          <select id="sales-location" aria-label="Địa điểm bán">${options(stores, "DD_Ma", "DD_Ten", locationId)}</select>
          <span class="user-role">${esc(session.user.employee?.NV_Ten || session.user.username)} · ${esc(role)}</span>
          <button class="button button-small" data-auth-logout>Đăng xuất</button>
          <button class="button button-small" data-action="reset">Khôi phục demo</button>
        </div>
      </header>
      <section class="content" id="page-content"></section>
    </main>
  </div><div id="modal-host"></div>`;
  renderContent();
}

function availableFor(state, HH_Ma) {
  return getAvailableStock(locationId, HH_Ma, state);
}

function validCustomers(state) {
  return listCustomers(state).filter((row) => row.DT_TrangThai === "Hoạt động");
}

function isActiveInvoice(invoice) {
  return invoice.BH_TrangThai === "Đã xác nhận";
}

function renderPos(state) {
  if (!paymentAmountTouched) paymentAmount = cartTotal(state);
  const customers = validCustomers(state);
  const cartMarkup = [...cart.entries()].map(([cartId, row], index) => {
    const item = itemById(state, row.HH_Ma);
    const available = availableFor(state, row.HH_Ma);
    const factor = row.unitFactor || 1;
    const otherInCart = cartProductQuantity(row.HH_Ma, cart, cartId);
    const remaining = Math.max(0, available - otherInCart);
    const price = row.unitPrice * factor;
    const discountAmount = Math.max(0, row.basePrice - row.unitPrice) * cartBaseQuantity(row);
    const stockWarning = otherInCart + cartBaseQuantity(row) > available ? `Thiếu tồn: còn ${formatNumber(remaining)} ${esc(item?.HH_DVi || "")} cho dòng này` : "";
    return `<tr data-cart-item="${esc(cartId)}">
      <td class="cart-index">${index + 1}</td>
      <td class="cart-code">${esc(row.HH_Ma)}</td>
      <td class="cart-item-name">${esc(item?.HH_Ten || row.HH_Ma)}</td>
      <td>${esc(row.saleUnit || item?.HH_DVi || "—")}${factor > 1 ? `<small class="field-hint">1 ${esc(row.saleUnit)} = ${formatNumber(factor)} ${esc(item?.HH_DVi || "")}</small>` : ""}</td>
      <td><div class="quantity-control"><button data-action="decrease-quantity" data-id="${esc(cartId)}" aria-label="Giảm số lượng">−</button><input aria-label="Số lượng ${esc(item?.HH_Ten)}" data-cart-quantity="${esc(cartId)}" type="number" min="1" max="${Math.floor(remaining / factor)}" value="${row.quantity}"><button data-action="increase-quantity" data-id="${esc(cartId)}" aria-label="Tăng số lượng">＋</button></div><small class="field-hint">${formatNumber(cartBaseQuantity(row))} ${esc(item?.HH_DVi || "")}</small>${stockWarning ? `<small class="stock-shortage">${esc(stockWarning)}</small>` : ""}</td>
      <td class="money">${formatCurrency(price)}</td>
      <td class="money cart-discount">${discountAmount ? `−${formatCurrency(discountAmount)}` : "—"}</td>
      <td class="money cart-line-total">${formatCurrency(row.unitPrice * cartBaseQuantity(row))}</td>
      <td class="cart-note">—</td>
      <td><div class="cart-row-actions"><button class="button button-small" data-action="discount-line" data-id="${esc(cartId)}" aria-label="Chiết khấu ${esc(item?.HH_Ten)}">%</button><button class="button button-small button-danger" data-action="remove-product" data-id="${esc(cartId)}" aria-label="Xóa ${esc(item?.HH_Ten)}">×</button></div></td>
    </tr>`;
  }).join("");
  const total = cartTotal(state);
  const baseTotal = cartBaseTotal();
  const totalDiscount = cartDiscountTotal();
  const quantity = [...cart.values()].reduce((sum, row) => sum + cartBaseQuantity(row), 0);
  const cashierCanCredit = accountingRoles.has(role);
  const cashierId = roleEmployees[role];
  const activeShift = getOpenCashShift(cashierId, locationId);
  const creditWarning = allowCredit && !cashierCanCredit ? "Vai trò hiện tại không có quyền xác nhận bán chịu." : "";
  const tender = Number(paymentAmount ?? total);
  const splitTotal = Object.values(paymentSplits).reduce((sum, amount) => sum + Number(amount || 0), 0);
  const splitInvalid = Object.values(paymentSplits).some((amount) => !Number.isSafeInteger(Number(amount)) || Number(amount) < 0) || splitTotal > total;
  const paidNow = paymentMethod === "Kết hợp"
    ? Number(paymentSplits["Tiền mặt"] || 0)
    : paymentMethod === "Tiền mặt" ? Math.min(tender, total) : 0;
  const reservedNow = paymentMethod === "Kết hợp" ? splitTotal : Math.min(tender, total);
  const due = Math.max(0, total - reservedNow);
  const change = paymentMethod === "Tiền mặt" ? Math.max(0, tender - total) : 0;
  const tenderInvalid = paymentMethod === "Kết hợp"
    ? splitInvalid
    : !Number.isSafeInteger(tender) || tender < 0 || (paymentMethod !== "Tiền mặt" && tender > total);
  const tenderError = splitInvalid ? "Tổng phân bổ thanh toán không hợp lệ"
    : !Number.isSafeInteger(tender) || tender < 0 ? "Số tiền không hợp lệ" : "Vượt mức thanh toán";
  const cartHasShortage = [...cartProductQuantities().entries()].some(([HH_Ma, quantity]) => quantity > availableFor(state, HH_Ma));
  const checkoutDisabled = !cart.size || cartHasShortage || !saleRoles.has(role) || !activeShift || tenderInvalid || (due > 0 && (!selectedCustomer || !allowCredit || !cashierCanCredit));
  const draftCount = state.HoaDonBanHang.filter((invoice) => invoice.BH_TrangThai === "Nháp").length;
  const customerMatches = customers.filter((customer) => `${customer.DT_Ten} ${customer.DT_SDT || ""}`.toLocaleLowerCase("vi-VN").includes(customerQuery.trim().toLocaleLowerCase("vi-VN")));
  const selectedCustomerRow = customers.find((customer) => customer.DT_Ma === selectedCustomer);
  return `${heading("Bán hàng tại quầy", `POS · ${esc(locationName(state, locationId))} · Xuất FEFO theo hạn sử dụng.`, `<a class="button" href="ca-ban-hang.html">Ca bán hàng${activeShift ? ` · ${esc(activeShift.Ca_Ma)}` : ""}</a><a class="button" href="hoa-don.html">Lịch sử hóa đơn</a><a class="button" href="tong-quan-ban-hang.html">Thoát POS</a>`)}
    <div class="pos-layout">
      <section class="pos-cart-area" aria-label="Giỏ hàng">
        <div class="pos-search-panel">
          <form class="pos-product-search" id="product-search-form" autocomplete="off">
            <div class="field grow"><label for="product-search">Tìm sản phẩm · mã hàng / tên / mã vạch</label><input id="product-search" value="${esc(productQuery)}" placeholder="Nhập tên hàng, HH_Ma hoặc mã vạch..." aria-controls="product-suggestions" aria-expanded="${productQuery.trim() ? "true" : "false"}"></div>
            <button class="button button-primary" type="submit">Tìm kiếm</button>
            <button class="button" type="button" data-action="open-camera" aria-label="Quét mã vạch bằng camera" title="Quét mã vạch bằng camera">📷 Camera</button>
          </form>
          <div id="product-suggestions" class="product-suggestions" ${productQuery.trim() ? "" : "hidden"}>${productQuery.trim() ? (matchingProducts(state, productQuery).slice(0, 8).map((item) => productSearchResult(item, state)).join("") || `<div class="suggestion-empty">Không tìm thấy sản phẩm phù hợp.</div>`) : ""}</div>
          <form class="barcode-scan barcode-quick-entry" id="barcode-form" autocomplete="off"><label for="barcode-input">Máy quét USB / nhập mã vạch</label><div class="barcode-entry"><input id="barcode-input" name="barcode" type="text" inputmode="numeric" maxlength="32" autocomplete="off" placeholder="Quét mã rồi nhấn Enter..."></div></form>
        </div>
        <div class="cart-panel cart-table-panel">
          <div class="cart-head"><div><strong>Giỏ hàng hiện tại${activeDraftId ? ` · Nháp ${esc(activeDraftId)}` : ""}</strong><span class="cart-subtitle">${formatNumber(cart.size)} mặt hàng · ${formatNumber(quantity)} đơn vị</span></div><button class="button button-small button-danger" type="button" data-action="clear-cart" ${cart.size ? "" : "disabled"}>Làm mới giỏ hàng</button></div>
          <div class="cart-table-scroll"><table class="cart-table"><thead><tr><th>STT</th><th>Mã hàng</th><th>Tên hàng hóa</th><th>ĐVT</th><th>Số lượng</th><th>Đơn giá</th><th>Ưu đãi</th><th>Thành tiền</th><th>Ghi chú</th><th></th></tr></thead><tbody>${cartMarkup || `<tr><td colspan="10" class="empty-state">Chưa có sản phẩm. Tìm kiếm hoặc quét mã để thêm hàng vào giỏ.</td></tr>`}</tbody></table></div>
          <div class="table-subnote">Đơn giá cơ sở theo GiaBan; chiết khấu POS được trừ vào đơn giá thực bán. Ghi chú dòng hiện không được lưu trong CSDL.</div>
        </div>
      </section>
      <aside class="pos-payment-panel" aria-label="Thanh toán">
        <div class="payment-panel-head"><strong>Thanh toán</strong><span>${esc(locationName(state, locationId))}</span></div>
        ${activeShift ? `<div class="info-box">Ca ${esc(activeShift.Ca_Ma)} đang mở · tiền đầu ca ${formatCurrency(activeShift.TienMatDauCa)}</div>` : `<div class="info-box info-warning">Chưa mở ca bán hàng tại địa điểm này. <a class="text-link" href="ca-ban-hang.html">Mở ca trước khi thanh toán</a>.</div>`}
        <div class="customer-picker">
          <label for="customer-search">Khách hàng</label>
          <div class="customer-search-row"><input id="customer-search" value="${esc(customerQuery)}" placeholder="Tên khách hoặc số điện thoại..." autocomplete="off" aria-controls="customer-suggestions"><button class="button button-small" type="button" data-action="quick-customer" ${saleRoles.has(role) ? "" : "disabled"}>＋ Thêm</button></div>
          <div id="customer-suggestions" class="customer-suggestions" ${customerQuery.trim() ? "" : "hidden"}>${customerMatches.slice(0, 6).map((customer) => `<button type="button" data-action="select-customer" data-id="${esc(customer.DT_Ma)}"><strong>${esc(customer.DT_Ten)}</strong><span>${esc(customer.DT_SDT || "Không có số điện thoại")}</span></button>`).join("")}${customerQuery.trim() && !customerMatches.length ? `<div class="customer-no-match">Không tìm thấy khách hàng phù hợp.</div>` : ""}</div>
          <div class="selected-customer">${selectedCustomerRow ? `<span>Đang chọn</span><strong>${esc(selectedCustomerRow.DT_Ten)}</strong><small>${esc(selectedCustomerRow.DT_SDT || selectedCustomerRow.DT_Ma)}</small><button type="button" class="text-link" data-action="clear-customer">Bỏ chọn</button>` : `<span>Khách lẻ · không ghi nợ</span>`}</div>
        </div>
        <div class="payment-summary">
          <div class="payment-summary-row"><span>Tổng tiền hàng trước chiết khấu</span><strong>${formatCurrency(baseTotal)}</strong></div>
          <div class="payment-summary-row"><span>Tổng chiết khấu</span><strong class="discount-total">${formatCurrency(totalDiscount)}</strong></div>
          ${cartHasShortage ? `<div class="stock-shortage">Tồn khả dụng đã thay đổi. Hãy giảm số lượng trước khi thanh toán.</div>` : ""}
          <div class="payment-grand-total"><span>Tổng phải thu</span><strong>${formatCurrency(total)}</strong></div>
          <div class="field"><label for="pos-payment-amount">${paymentMethod === "Tiền mặt" ? "Tiền khách đưa (VND)" : "Số tiền thanh toán (VND)"}</label><input id="pos-payment-amount" type="number" min="0" ${paymentMethod === "Tiền mặt" ? "" : `max="${total}"`} step="1" value="${tender}" ${paymentMethod === "Kết hợp" ? "hidden" : ""}></div>
          ${paymentMethod === "Kết hợp" ? `<div class="form-grid"><div class="field"><label for="split-cash">Tiền mặt</label><input id="split-cash" data-payment-split="Tiền mặt" type="number" min="0" max="${total}" step="1" value="${paymentSplits["Tiền mặt"] || 0}"></div>
            <div class="field"><label for="split-transfer">Chuyển khoản</label><input id="split-transfer" data-payment-split="Chuyển khoản" type="number" min="0" max="${total}" step="1" value="${paymentSplits["Chuyển khoản"] || 0}"></div>
            <div class="field"><label for="split-qr">QR</label><input id="split-qr" data-payment-split="QR" type="number" min="0" max="${total}" step="1" value="${paymentSplits.QR || 0}"></div></div>` : ""}
          <div class="payment-balance ${tenderInvalid ? "invalid" : ""}"><span>${tenderInvalid ? tenderError : change ? "Tiền thừa" : "Còn phải thu"}</span><strong>${formatCurrency(tenderInvalid && tender > total ? change : due)}</strong></div>
        </div>
        <div class="payment-controls">
          <div class="field"><label for="pos-method">Phương thức thanh toán</label><select id="pos-method"><option ${paymentMethod === "Tiền mặt" ? "selected" : ""}>Tiền mặt</option><option ${paymentMethod === "Chuyển khoản" ? "selected" : ""}>Chuyển khoản</option><option ${paymentMethod === "QR" ? "selected" : ""}>QR</option><option ${paymentMethod === "Kết hợp" ? "selected" : ""}>Kết hợp</option></select></div>
          <div class="payment-method-note">${paymentMethod === "Tiền mặt" ? "Chỉ ghi nhận tiền hóa đơn thực thu; tiền thừa trả khách không vào ca." : paymentMethod === "Kết hợp" ? "Tiền mặt được ghi nhận ngay; chuyển khoản/QR chờ xác nhận riêng." : `${paymentMethod} ở trạng thái chờ xác nhận; chưa được tính là tiền đã thu.`}</div>
          <label class="credit-toggle"><input id="allow-credit" type="checkbox" ${allowCredit ? "checked" : ""} ${cashierCanCredit ? "" : "disabled"}><span>Cho phép khách hàng đã lưu ghi nợ phần còn lại. Chỉ Chủ cửa hàng/Kế toán được xác nhận.<br>${creditWarning}</span></label>
        </div>
        <div class="payment-panel-actions">
          <div class="payment-utility-actions"><button class="button button-small" data-action="open-discount" ${cart.size ? "" : "disabled"}>％ Chiết khấu</button><button class="button button-small" data-action="list-drafts">▤ Lưu tạm (${draftCount})</button></div>
          <button class="button button-small draft-save-button" data-action="save-draft" ${cart.size ? "" : "disabled"}>▣ Lưu tạm hóa đơn</button>
          <button class="button button-primary checkout-submit" data-action="checkout" ${checkoutDisabled ? "disabled" : ""}>THANH TOÁN · F9</button>
          <button class="button button-small" data-action="clear-cart" ${cart.size ? "" : "disabled"}>Làm mới giỏ hàng</button>
        </div>
        <p class="payment-footnote">Chiết khấu lưu theo đơn giá thực bán. Tồn chỉ cập nhật khi xác nhận; FEFO và hạn sử dụng được kiểm tra lại trước khi ghi hóa đơn.</p>
      </aside>
    </div>`;
}

function shiftStatusBadge(status) {
  const tone = status === "Đã bàn giao" || status === "Đã đối soát" ? "green"
    : status === "Cần giải trình" ? "red"
      : status === "Chờ đối soát" ? "amber" : "blue";
  return `<span class="badge badge-${tone}">${esc(status)}</span>`;
}

function renderCashShifts(state) {
  if (!["Nhân viên bán hàng", "Chủ cửa hàng"].includes(role)) {
    return `${heading("Ca bán hàng", "Quản lý ca thu ngân.", "")}<div class="info-box info-warning">Vai trò hiện tại chỉ được xem chức năng thuộc phân hệ của mình.</div>`;
  }
  const employeeId = roleEmployees[role];
  const active = getOpenCashShift(employeeId);
  const shifts = getCashShifts()
    .filter((shift) => role === "Chủ cửa hàng" || shift.NV_Ma === employeeId)
    .sort((a, b) => String(b.GioMo).localeCompare(String(a.GioMo)));
  const currentMetrics = active ? calculateCashShift(active, state) : null;
  const rows = shifts.map((shift) => {
    const summary = calculateCashShift(shift, state);
    const closable = shift.TrangThai === "Đang mở" && shift.NV_Ma === employeeId;
    const canRespond = shift.TrangThai === "Cần giải trình" && shift.NV_Ma === employeeId;
    return `<tr><td class="cell-primary">${esc(shift.Ca_Ma)}</td><td>${dateTime(shift.GioMo)}</td>
      <td>${esc(employeeName(state, shift.NV_Ma))}</td><td>${esc(locationName(state, shift.DD_Ma))}</td>
      <td>${shift.GioDong ? dateTime(shift.GioDong) : "—"}</td><td>${formatCurrency(summary.expectedCash)}</td>
      <td>${shift.TienMatThucDem === null ? "—" : formatCurrency(shift.TienMatThucDem)}</td>
      <td class="${Number(shift.ChenhLech || 0) < 0 ? "negative" : Number(shift.ChenhLech || 0) > 0 ? "positive" : ""}">${shift.ChenhLech === null ? "—" : formatCurrency(shift.ChenhLech)}</td>
      <td>${shiftStatusBadge(shift.TrangThai)}</td><td><div class="inline-actions">
        <button class="button button-small" data-action="view-cash-shift" data-id="${esc(shift.Ca_Ma)}">Chi tiết</button>
        ${closable ? `<button class="button button-small button-primary" data-action="close-cash-shift" data-id="${esc(shift.Ca_Ma)}">Kết ca</button>` : ""}
        ${canRespond ? `<button class="button button-small button-primary" data-action="respond-cash-shift" data-id="${esc(shift.Ca_Ma)}">Bổ sung giải trình</button>` : ""}
        ${shift.TrangThai === "Đang mở" && shift.NV_Ma === employeeId ? `<a class="button button-small" href="ban-hang.html">Mở POS</a>` : ""}
      </div></td></tr>`;
  }).join("");
  return `${heading("Ca bán hàng", "Mở ca, theo dõi các giao dịch đã gắn, kiểm đếm tiền mặt và gửi kết ca cho Kế toán.",
      !active ? `<button class="button button-primary" data-action="open-cash-shift">＋ Mở ca</button>` : "")}
    ${active ? `<div class="metric-grid">${shiftMetric("Ca đang mở", esc(active.Ca_Ma), `${esc(locationName(state, active.DD_Ma))} · mở ${dateTime(active.GioMo)}`)}
      ${shiftMetric("Tiền mặt đầu ca", formatCurrency(active.TienMatDauCa))}
      ${shiftMetric("Tiền mặt POS thành công", formatCurrency(currentMetrics.cash))}
      ${shiftMetric("Tiền mặt dự kiến hiện tại", formatCurrency(currentMetrics.expectedCash))}</div>
      <div class="info-box">Chuyển khoản/QR chờ xác nhận không nằm trong tiền mặt. Các giao dịch thanh toán được gắn trực tiếp với ca demo hiện tại.</div>` : `<div class="info-box">Mỗi nhân viên chỉ có thể duy trì một ca Đang mở. Tiền đầu ca là số dư quỹ, không phải doanh thu hay Phiếu thu.</div>`}
    <div class="table-subnote">Dữ liệu ca lưu riêng trong localStorage của trình duyệt; đây là mô phỏng FE, không tạo bảng SQL, bút toán kế toán hoặc phiếu thu tự động.</div>
    ${tableCard("Lịch sử ca của nhân viên", `${shifts.length} ca`, ["Mã ca", "Giờ mở", "Nhân viên", "Cửa hàng", "Giờ kết", "Tiền dự kiến", "Thực đếm", "Chênh lệch", "Trạng thái", "Thao tác"], rows)}`;
}

function shiftMetric(label, value, note = "") {
  return `<div class="metric-card"><div class="metric-title">${esc(label)}</div><div class="metric-value">${value}</div>${note ? `<div class="metric-caption">${esc(note)}</div>` : ""}</div>`;
}

function openCashShiftForm(state) {
  if (!["Nhân viên bán hàng", "Chủ cửa hàng"].includes(role)) return toast("Vai trò hiện tại không được mở ca.", true);
  const employeeId = roleEmployees[role];
  if (getOpenCashShift(employeeId)) return toast("Đã có ca đang mở. Tiếp tục ca đó hoặc kết ca trước.", true);
  const stores = state.DiaDiem.filter((row) => row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động");
  openModal("Mở ca bán hàng", `<div class="form-error" id="cash-shift-error"></div><form id="cash-shift-open-form">
    <div class="form-grid two"><div class="field"><label>Nhân viên</label><input value="${esc(employeeName(state, employeeId))}" readonly></div>
      <div class="field"><label>Địa điểm bán *</label><select name="locationId" required>${options(stores, "DD_Ma", "DD_Ten", locationId)}</select></div>
      <div class="field"><label>Tiền mặt đầu ca *</label><input name="openingCash" type="number" min="0" step="1" value="0" required></div>
      <div class="field grow"><label>Ghi chú</label><input name="note" maxlength="250"></div></div>
      <div class="info-box">Mã ca và thời gian mở được tạo tự động. Tiền đầu ca không ghi nhận doanh thu hoặc Phiếu thu.</div></form>`,
  `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="cash-shift-open-form" type="submit">Mở ca</button>`);
}

function cashShiftPrintContent(state, shift) {
  const summary = calculateCashShift(shift, state);
  const invoices = summary.invoices.map((invoice) => `<tr><td>${esc(invoice.BH_Ma)}</td><td>${dateTime(invoice.BH_Ngay)}</td><td>${formatCurrency(invoice.BH_TongCong)}</td></tr>`).join("");
  const payments = summary.payments.map((payment) => `<tr><td>${esc(payment.BH_Ma)}</td><td>${esc(payment.TTBH_Ma)}</td><td>${dateTime(payment.TTBH_Ngay)}</td><td>${formatCurrency(payment.TTBH_SoTien)}</td><td>${esc(payment.TTBH_PhuongThuc)}</td><td>${badge(payment.TTBH_TrangThai)}</td></tr>`).join("");
  return `<div class="shift-print"><h2>BÁO CÁO KẾT CA BÁN HÀNG</h2>
    <p>Mã ca: <strong>${esc(shift.Ca_Ma)}</strong> · Nhân viên: ${esc(employeeName(state, shift.NV_Ma))} · Cửa hàng: ${esc(locationName(state, shift.DD_Ma))}</p>
    <p>Mở: ${dateTime(shift.GioMo)} · Kết: ${shift.GioDong ? dateTime(shift.GioDong) : "Đang mở"}</p>
    <div class="metric-grid">${shiftMetric("Tổng giá trị hóa đơn", formatCurrency(summary.revenue), `${summary.invoiceCount} hóa đơn`)}
      ${shiftMetric("Thu tiền mặt", formatCurrency(summary.cash))}${shiftMetric("Thu chuyển khoản", formatCurrency(summary.transfer))}${shiftMetric("Thu QR", formatCurrency(summary.qr))}
      ${shiftMetric("Tổng thanh toán thành công", formatCurrency(summary.collected), `${summary.paymentCount} giao dịch`)}
      ${shiftMetric("Còn nợ phát sinh", formatCurrency(summary.unpaidFromShiftInvoices))}
      ${shiftMetric("Tiền đầu ca", formatCurrency(shift.TienMatDauCa))}
      ${shiftMetric("Tiền dự kiến", formatCurrency(shift.TienMatDuKien ?? summary.expectedCash))}
      ${shiftMetric("Tiền thực đếm", shift.TienMatThucDem === null ? "Chưa kết ca" : formatCurrency(shift.TienMatThucDem))}
      ${shiftMetric("Chênh lệch", shift.ChenhLech === null ? "—" : formatCurrency(shift.ChenhLech))}</div>
    <h3>Hóa đơn trong ca</h3>${tableCard("Bảng kê hóa đơn", `${summary.invoiceCount} hóa đơn`, ["Mã hóa đơn", "Thời điểm", "Tổng hóa đơn"], invoices)}
    <h3>Giao dịch thanh toán gắn với ca</h3>${tableCard("Bảng kê thanh toán", `${summary.payments.length} giao dịch`, ["Hóa đơn", "Mã thanh toán", "Thời điểm", "Số tiền", "Phương thức", "Trạng thái"], payments)}
    <p>Giải trình thu ngân: ${esc(shift.GiaiTrinh || "—")}</p>
    ${shift.TrangThai === "Đã bàn giao" ? `<h3>BIÊN BẢN BÀN GIAO</h3><p>Thời điểm: ${dateTime(shift.ThoiDiemXacNhanBanGiao)} · Người bàn giao: ${esc(employeeName(state, shift.NV_Ma))} · Người nhận: ${esc(employeeName(state, shift.NguoiNhanBanGiao))}</p>
      <p>Tiền mặt dự kiến: ${formatCurrency(shift.TienMatDuKien)} · Thực đếm: ${formatCurrency(shift.TienMatThucDem)} · Bàn giao: ${formatCurrency(shift.TienMatBanGiao)} · Chênh lệch: ${formatCurrency(shift.ChenhLech)}</p>
      <p>Ghi chú bàn giao: ${esc(shift.GhiChuBanGiao || "—")}</p>` : ""}
    <p class="cell-muted">Bản in demo, không phải chứng từ kế toán hoặc chữ ký điện tử.</p></div>`;
}

function viewCashShift(state, shiftId) {
  const shift = getCashShift(shiftId);
  if (!shift) return toast("Không tìm thấy ca bán hàng.", true);
  openModal(`Chi tiết ca ${shift.Ca_Ma}`, cashShiftPrintContent(state, shift), `<button class="button" data-action="close-modal">Đóng</button><button class="button button-primary" data-action="print-cash-shift">In báo cáo / biên bản</button>`, true);
}

function closeCashShiftForm(state, shiftId) {
  const shift = getCashShift(shiftId);
  if (!shift || shift.TrangThai !== "Đang mở") return toast("Ca không còn ở trạng thái Đang mở.", true);
  const summary = calculateCashShift(shift, state);
  const body = `<div class="form-error" id="cash-shift-error"></div><div class="shift-close-report">
    ${cashShiftPrintContent(state, shift)}
    <div class="info-box ${summary.pendingPayments.length ? "info-warning" : ""}">${summary.pendingPayments.length
      ? `Còn ${summary.pendingPayments.length} thanh toán chờ xác nhận. Cần xử lý trước khi kết ca.`
      : "Tiền dự kiến chỉ gồm tiền mặt đầu ca và thanh toán tiền mặt thành công gắn với ca; chưa gồm điều chỉnh ngoài POS."}</div>
    <form id="cash-shift-close-form" data-id="${esc(shiftId)}"><div class="form-grid two">
      <div class="field"><label>Tiền mặt thực tế đếm được *</label><input name="countedCash" type="number" min="0" step="1" value="${summary.expectedCash}" required></div>
      <div class="field grow"><label>Giải trình nếu chênh lệch</label><textarea name="explanation" rows="3" maxlength="500"></textarea></div></div>
      <div id="cash-shift-preview" class="info-box">Chênh lệch sẽ được tính khi gửi đối soát.</div></form></div>`;
  openModal(`Kết ca ${shift.Ca_Ma}`, body,
    `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="cash-shift-close-form" type="submit" ${summary.pendingPayments.length ? "disabled" : ""}>Gửi đối soát / Bàn giao</button>`, true);
}

function openStockAlert(state, HH_Ma) {
  const item = itemById(state, HH_Ma);
  if (!item) return toast("Không tìm thấy mặt hàng.", true);
  const warehouse = state.DiaDiem.find((row) => row.DD_Loai === "Kho" && row.DD_TrangThai === "Hoạt động");
  const store = getInventoryPosition(locationId, HH_Ma, state);
  const central = warehouse ? getInventoryPosition(warehouse.DD_Ma, HH_Ma, state) : { physical: 0, available: 0, unavailable: 0 };
  const allLocations = state.DiaDiem.filter((row) => row.DD_TrangThai === "Hoạt động");
  const systemAvailable = allLocations.reduce((sum, row) => sum + getAvailableStock(row.DD_Ma, HH_Ma, state), 0);
  const status = item.HH_TrangThai !== "Đang kinh doanh" ? "Mặt hàng đã ngừng kinh doanh."
    : store.available > 0 ? "Mặt hàng còn khả dụng để bán tại cửa hàng."
      : central.available > 0 ? "Hết hàng tại cửa hàng; có thể bổ sung từ kho trung tâm."
        : store.physical > 0 ? "Có tồn vật lý tại cửa hàng nhưng không khả dụng do hết hạn hoặc phiếu nhập chưa xác nhận."
          : systemAvailable > 0 ? "Hết hàng tại cửa hàng; có thể bổ sung từ địa điểm khác."
          : "Hết hàng khả dụng toàn hệ thống.";
  const canViewLocations = inventoryViewRoles.has(role);
  const canTransfer = accountingRoles.has(role) && central.available > 0 && item.HH_TrangThai === "Đang kinh doanh";
  const canOrder = accountingRoles.has(role) && systemAvailable === 0 && item.HH_TrangThai === "Đang kinh doanh";
  const query = new URLSearchParams({ create: "1", source: warehouse?.DD_Ma || "", destination: locationId, product: HH_Ma });
  const purchaseQuery = new URLSearchParams({ purchase: "1", product: HH_Ma });
  const detailRows = canViewLocations ? allLocations.map((location) => {
    const position = getInventoryPosition(location.DD_Ma, HH_Ma, state);
    return `<tr><td>${esc(location.DD_Ten)}</td><td>${formatNumber(position.available)}</td><td>${formatNumber(position.physical)}</td><td>${formatNumber(position.unavailable)}</td></tr>`;
  }).join("") : "";
  const body = `<div class="warning-box"><strong>${esc(status)}</strong><p>Mặt hàng: ${esc(item.HH_Ten)} · Tồn khả dụng tại cửa hàng: ${formatNumber(store.available)} ${esc(item.HH_DVi)}.</p>
    ${canViewLocations && warehouse ? `<p>Tồn khả dụng tại ${esc(warehouse.DD_Ten)}: ${formatNumber(central.available)} ${esc(item.HH_DVi)}.</p>` : ""}
    ${store.available === 0 ? `<p>${systemAvailable ? "Sản phẩm đã hết tại cửa hàng. Vui lòng liên hệ bộ phận phụ trách để chuyển hàng." : "Không thể tạo phiếu chuyển khi toàn hệ thống không có tồn khả dụng. Hãy lập đơn đặt hàng nhà cung cấp."}</p>` : ""}
    </div>
    ${canViewLocations ? tableCard("Tồn theo địa điểm", "Tồn bán được được loại trừ dòng nhập hết hạn/chưa xác nhận", ["Địa điểm", "Khả dụng", "Tồn vật lý", "Không khả dụng"], detailRows) : `<div class="table-subnote">Vai trò hiện tại không có quyền xem tồn chi tiết theo địa điểm.</div>`}`;
  const actions = `${canTransfer ? `<a class="button button-primary" href="../kho/xuat-chuyen-noi-bo.html?${query.toString()}">Tạo phiếu chuyển</a>` : ""}
    ${canOrder ? `<a class="button button-primary" href="../kho/ton-kho.html?${purchaseQuery.toString()}">Tạo đơn đặt hàng</a>` : ""}
    ${canViewLocations ? `<a class="button" href="../kho/ton-kho.html">Xem tồn các địa điểm</a>` : ""}
    <button class="button" data-action="close-modal">Đóng</button>`;
  openModal(store.available === 0 ? "Thông báo hết hàng" : `Tình trạng hàng · ${item.HH_Ten}`, body, actions, true);
}

function cartTotal(state) {
  return [...cart.values()].reduce((sum, row) => sum + row.unitPrice * cartBaseQuantity(row), 0);
}

function cartBaseTotal() {
  return [...cart.values()].reduce((sum, row) => sum + row.basePrice * cartBaseQuantity(row), 0);
}

function cartDiscountTotal() {
  return Math.max(0, cartBaseTotal() - cartTotal());
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a;
}

function modularInverse(value, modulus) {
  if (modulus === 1) return 0;
  for (let candidate = 1; candidate < modulus; candidate += 1) {
    if ((value * candidate) % modulus === 1) return candidate;
  }
  return null;
}

function allocateFixedBasketDiscount(rows, amount) {
  const subtotal = rows.reduce((sum, row) => sum + row.unitPrice * row.quantity, 0);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > subtotal) throw new Error("Mức chiết khấu cố định phải nằm trong tổng giỏ hàng.");
  if (!amount) return rows.map(() => 0);
  const allocations = Array(rows.length).fill(0);
  const remainingGcd = Array(rows.length + 1).fill(0);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    remainingGcd[index] = gcd(rows[index].quantity, remainingGcd[index + 1]);
  }
  let explored = 0;
  const solve = (index, remaining) => {
    if (remaining === 0) return true;
    if (index >= rows.length || remaining % remainingGcd[index] !== 0) return false;
    const row = rows[index];
    const maxUnitDiscount = Math.min(row.unitPrice, Math.floor(remaining / row.quantity));
    if (index === rows.length - 1) {
      if (remaining % row.quantity !== 0) return false;
      const unitDiscount = remaining / row.quantity;
      if (unitDiscount > row.unitPrice) return false;
      allocations[index] = unitDiscount;
      return true;
    }
    const restGcd = remainingGcd[index + 1];
    const divisor = gcd(row.quantity, restGcd);
    if (remaining % divisor !== 0) return false;
    const step = restGcd / divisor;
    const inverse = modularInverse(row.quantity / divisor, step);
    if (inverse === null) return false;
    const residue = step === 1 ? 0 : ((remaining / divisor) * inverse) % step;
    const minK = Math.ceil(-residue / step);
    const maxK = Math.floor((maxUnitDiscount - residue) / step);
    if (maxK < minK) return false;
    const ideal = Math.min(maxUnitDiscount, Math.max(0, remaining * (row.unitPrice * row.quantity / subtotal) / row.quantity));
    const idealK = Math.min(maxK, Math.max(minK, Math.round((ideal - residue) / step)));
    const maxDistance = Math.max(idealK - minK, maxK - idealK);
    for (let distance = 0; distance <= maxDistance && explored < 25000; distance += 1) {
      const candidates = distance ? [idealK - distance, idealK + distance] : [idealK];
      for (const k of candidates) {
        if (k < minK || k > maxK) continue;
        explored += 1;
        const unitDiscount = residue + k * step;
        allocations[index] = unitDiscount;
        if (solve(index + 1, remaining - unitDiscount * row.quantity)) return true;
      }
    }
    return false;
  };
  if (!solve(0, amount)) {
    throw new Error("Mức giảm cố định không thể phân bổ chính xác vào đơn giá từng sản phẩm. Hãy điều chỉnh số tiền giảm.");
  }
  return allocations;
}

function repriceCart(sourceCart, nextBasketDiscount = basketDiscount) {
  const priced = new Map();
  for (const [id, row] of sourceCart) {
    const productDiscount = row.productDiscount || null;
    let unitPrice = row.basePrice;
    if (productDiscount?.type === "percent") {
      unitPrice -= Math.round(unitPrice * productDiscount.value / 100);
    } else if (productDiscount?.type === "amount") {
      if (productDiscount.value > unitPrice) throw new Error(`Chiết khấu sản phẩm ${row.HH_Ma} không được vượt đơn giá.`);
      unitPrice -= productDiscount.value;
    }
    priced.set(id, { ...row, productDiscount, unitPrice });
  }
  if (!nextBasketDiscount || !priced.size) return priced;
  const rows = [...priced.values()];
  if (nextBasketDiscount.type === "percent") {
    if (!Number.isFinite(nextBasketDiscount.value) || nextBasketDiscount.value < 0 || nextBasketDiscount.value > 100) {
      throw new Error("Chiết khấu phần trăm phải từ 0 đến 100%.");
    }
    for (const row of rows) row.unitPrice -= Math.round(row.unitPrice * nextBasketDiscount.value / 100);
  } else if (nextBasketDiscount.type === "amount") {
    const reductions = allocateFixedBasketDiscount(rows.map((row) => ({ ...row, quantity: cartBaseQuantity(row) })), nextBasketDiscount.value);
    rows.forEach((row, index) => { row.unitPrice -= reductions[index]; });
  }
  return new Map([...priced.keys()].map((id, index) => [id, rows[index]]));
}

function updateCartPricing(nextCart, nextBasketDiscount = basketDiscount) {
  cart = repriceCart(nextCart, nextBasketDiscount);
  basketDiscount = nextBasketDiscount;
}

function describeDiscount(discount) {
  if (!discount || !discount.value) return "";
  return discount.type === "percent" ? `${discount.value}%` : `${formatCurrency(discount.value)} / sp`;
}

function discountForPreview({ scope, HH_Ma, type, value }) {
  const candidate = new Map([...cart].map(([id, row]) => [id, { ...row, productDiscount: row.productDiscount ? { ...row.productDiscount } : null }]));
  const discount = value ? { type, value } : null;
  const nextBasket = scope === "basket" ? discount : basketDiscount;
  if (scope === "product") {
    const row = candidate.get(HH_Ma);
    if (!row) throw new Error("Chọn sản phẩm trong giỏ trước khi áp dụng chiết khấu.");
    row.productDiscount = discount;
  }
  const priced = repriceCart(candidate, nextBasket);
  const total = [...priced.values()].reduce((sum, row) => sum + row.unitPrice * cartBaseQuantity(row), 0);
  const discountTotal = [...priced.values()].reduce((sum, row) => sum + (row.basePrice - row.unitPrice) * cartBaseQuantity(row), 0);
  const selected = priced.get(HH_Ma);
  return { total, discountTotal, selected };
}

function matchingProducts(state, query) {
  const normalized = String(query || "").trim().toLocaleLowerCase("vi-VN");
  if (!normalized) return [];
  return state.HangHoa.filter((item) => `${item.HH_Ma} ${item.HH_Ten} ${item.HH_MaVach || ""}`.toLocaleLowerCase("vi-VN").includes(normalized));
}

function saleUnitChoices(item, state, action) {
  const packageUnit = getUnitPackage(item);
  const price = getActivePrice(item.HH_Ma, today(), state);
  const available = availableFor(state, item.HH_Ma);
  const alreadyInBaseUnits = cartProductQuantity(item.HH_Ma);
  const remaining = Math.max(0, available - alreadyInBaseUnits);
  const units = [{ name: item.HH_DVi, factor: 1 }];
  if (packageUnit) units.push({ name: packageUnit.name, factor: packageUnit.ratio });
  return units.map((unit) => {
    const stock = Math.floor(remaining / unit.factor);
    const totalPrice = price.error ? null : price.price * unit.factor;
    const disabled = item.HH_TrangThai !== "Đang kinh doanh" || !stock || price.error || !Number.isSafeInteger(totalPrice);
    const detail = price.error ? price.error : stock ? `Còn ${formatNumber(stock)} ${unit.name} · ${formatCurrency(totalPrice)} / ${unit.name}` : `Không đủ tồn khả dụng theo ${unit.name}`;
    return `<button type="button" class="sale-unit-choice" data-action="${action}" data-id="${esc(item.HH_Ma)}" data-factor="${unit.factor}" data-unit="${esc(unit.name)}" ${disabled ? "disabled" : ""}><strong>${esc(unit.name)}</strong><small>${unit.factor > 1 ? `1 ${esc(unit.name)} = ${formatNumber(unit.factor)} ${esc(item.HH_DVi)}` : `Đơn vị cơ bản · ${esc(item.HH_DVi)}`}</small><span>${esc(detail)}</span></button>`;
  }).join("");
}

function openSaleUnitPicker(state, item, scanned = false) {
  const packageUnit = getUnitPackage(item);
  if (!packageUnit) return addToCart(state, item.HH_Ma, scanned);
  const body = `<p>Chọn đơn vị bán cho <strong>${esc(item.HH_Ten)}</strong>. Tồn và hóa đơn vẫn được quy đổi về ${esc(item.HH_DVi)}.</p><div class="sale-unit-choices">${saleUnitChoices(item, state, "select-sale-unit")}</div>`;
  openModal("Chọn đơn vị bán", body, `<button class="button" data-action="close-modal">Hủy</button>`);
  document.querySelector("#modal-host .modal")?.setAttribute("data-scanned", String(scanned));
}

function productSearchResult(item, state) {
  const price = getActivePrice(item.HH_Ma, today(), state);
  const stock = availableFor(state, item.HH_Ma);
  const canAdd = item.HH_TrangThai === "Đang kinh doanh" && stock > 0 && !price.error;
  const status = item.HH_TrangThai !== "Đang kinh doanh" ? "Ngừng kinh doanh"
    : !stock ? "Hết hàng tại cửa hàng"
      : price.error ? price.error : `${formatNumber(stock)} có thể bán`;
  return `<button type="button" class="product-search-result" data-action="select-product" data-id="${esc(item.HH_Ma)}" data-search="${esc(`${item.HH_Ma} ${item.HH_Ten} ${item.HH_MaVach || ""}`.toLocaleLowerCase("vi-VN"))}">
    <span class="suggestion-name"><strong>${esc(item.HH_Ten)}</strong><small>${esc(item.HH_Ma)} · ${esc(item.HH_MaVach || "Chưa có mã vạch")} · ${esc(status)}</small></span>
    <span class="suggestion-price">${price.price === null ? "Chưa có giá" : `${formatCurrency(price.price)} / ${esc(item.HH_DVi || "đơn vị")}`}${getUnitPackage(item) ? `<small> · Có ${esc(getUnitPackage(item).name)}</small>` : ""}</span>
  </button>`;
}

function refreshProductSuggestions(state = getState()) {
  const container = document.querySelector("#product-suggestions");
  const input = document.querySelector("#product-search");
  if (!container || !input) return;
  productQuery = input.value;
  const matches = matchingProducts(state, productQuery);
  container.innerHTML = matches.length
    ? matches.slice(0, 8).map((item) => productSearchResult(item, state)).join("")
    : `<div class="suggestion-empty">${productQuery.trim() ? "Không tìm thấy sản phẩm phù hợp." : "Nhập mã hàng, tên hoặc mã vạch để tìm."}</div>`;
  container.hidden = !productQuery.trim();
  input.setAttribute("aria-expanded", String(!container.hidden));
}

function refreshCustomerSuggestions(state = getState()) {
  const container = document.querySelector("#customer-suggestions");
  const input = document.querySelector("#customer-search");
  if (!container || !input) return;
  customerQuery = input.value;
  const query = customerQuery.trim().toLocaleLowerCase("vi-VN");
  const matches = validCustomers(state).filter((customer) => `${customer.DT_Ten} ${customer.DT_SDT || ""}`.toLocaleLowerCase("vi-VN").includes(query));
  container.innerHTML = matches.slice(0, 6).map((customer) => `<button type="button" data-action="select-customer" data-id="${esc(customer.DT_Ma)}"><strong>${esc(customer.DT_Ten)}</strong><span>${esc(customer.DT_SDT || "Không có số điện thoại")}</span></button>`).join("") || `<div class="customer-no-match">Không tìm thấy khách hàng phù hợp.</div>`;
  container.hidden = !query;
  input.setAttribute("aria-expanded", String(!container.hidden));
}

function openProductSearch(state) {
  const query = productQuery.trim();
  const items = query ? matchingProducts(state, query) : state.HangHoa;
  const rows = items.map((item) => productSearchResult(item, state)).join("");
  openModal("Tìm và chọn sản phẩm", `<div class="field product-dialog-search-field"><label for="product-dialog-search">Tên hàng / mã hàng / mã vạch</label><input id="product-dialog-search" value="${esc(query)}" placeholder="Nhập từ khóa tìm kiếm..." autocomplete="off"></div><div class="product-dialog-results">${rows || `<div class="empty-state">Không tìm thấy sản phẩm phù hợp.</div>`}<div class="suggestion-empty" data-search-empty hidden>Không tìm thấy sản phẩm phù hợp.</div></div>`, `<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function saveCurrentDraft() {
  if (!cart.size) {
    toast("Giỏ hàng đang trống, không thể lưu tạm.", true);
    return false;
  }
  try {
    const state = getState();
    const lines = [...cart.values()].map((row) => {
      const item = itemById(state, row.HH_Ma);
      return {
        HH_Ma: row.HH_Ma,
        BH_SL: cartBaseQuantity(row),
        BH_DonGia: row.unitPrice,
        GB_GiaGoc: row.basePrice,
        productDiscount: row.productDiscount || null,
        saleUnit: row.saleUnit || item?.HH_DVi || "",
        unitFactor: row.unitFactor || 1,
        conversionRatio: getUnitPackage(item)?.ratio || null,
        saleQuantity: row.quantity,
        baseUnit: item?.HH_DVi || ""
      };
    });
    const draftId = createDraftInvoice({
      BH_Ma: activeDraftId,
      DD_Ma: locationId,
      NV_Ma: roleEmployees[role],
      DT_Ma: selectedCustomer || null,
      lines,
      role,
      metadata: {
        createdAt: activeDraftId ? getDraftInvoiceMetadata(activeDraftId)?.createdAt : "",
        basketDiscount,
        paymentMethod,
        allowCredit,
        lines
      }
    });
    cart.clear();
    basketDiscount = null;
    activeDraftId = "";
    selectedCustomer = "";
    paymentAmount = null;
    paymentAmountTouched = false;
    allowCredit = false;
    renderContent();
    toast(`Đã lưu tạm hóa đơn ${draftId}. Tồn kho chưa thay đổi.`);
    return true;
  } catch (error) {
    toast(error.message || "Không thể lưu hóa đơn tạm.", true);
    return false;
  }
}

function draftListModal(state) {
  const drafts = state.HoaDonBanHang.filter((invoice) => invoice.BH_TrangThai === "Nháp").sort((a, b) => b.BH_Ngay.localeCompare(a.BH_Ngay));
  const rows = drafts.map((invoice) => {
    const metadata = getDraftInvoiceMetadata(invoice.BH_Ma);
    const customer = partnerName(state, invoice.DT_Ma);
    const employee = employeeName(state, invoice.NV_Ma);
    return `<tr data-draft-row data-search="${esc(`${invoice.BH_Ma} ${customer}`.toLocaleLowerCase("vi-VN"))}">
      <td><strong>${esc(invoice.BH_Ma)}</strong><small class="draft-date">${esc(formatDate(invoice.BH_Ngay))} · ${esc(metadata?.updatedAt ? new Date(metadata.updatedAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) : "")}</small></td>
      <td>${esc(employee)}</td><td>${esc(customer)}</td><td>${formatNumber(invoice.BH_TongSL)}</td><td class="money">${formatCurrency(invoice.BH_TongCong)}</td>
      <td><span class="badge badge-amber">Nháp</span></td>
      <td><div class="draft-actions"><button class="button button-small button-primary" data-action="restore-draft" data-id="${esc(invoice.BH_Ma)}" ${saleRoles.has(role) ? "" : "disabled"}>Mở lại</button><button class="button button-small button-danger" data-action="delete-draft" data-id="${esc(invoice.BH_Ma)}" ${saleRoles.has(role) ? "" : "disabled"}>Xóa</button></div></td>
    </tr>`;
  }).join("");
  const table = drafts.length
    ? tableCard("Hóa đơn lưu tạm", `${drafts.length} hóa đơn`, ["Mã hóa đơn / thời gian lưu", "Nhân viên", "Khách hàng", "Số lượng", "Tổng dự kiến", "Trạng thái", "Thao tác"], rows)
    : `<div class="empty-state">Chưa có hóa đơn lưu tạm.</div>`;
  const body = `<div class="field draft-search"><label for="draft-list-search">Tìm theo mã hóa đơn hoặc khách hàng</label><input id="draft-list-search" placeholder="Nhập mã hóa đơn / tên khách..."></div>${table}`;
  openModal("Hóa đơn lưu tạm", body, `<button class="button" data-action="close-modal">Đóng</button>`, true);
}

function restoreDraft(state, BH_Ma) {
  if (!saleRoles.has(role)) return toast("Vai trò hiện tại không được khôi phục hóa đơn nháp.", true);
  if (cart.size && !confirm("Giỏ hiện tại sẽ được lưu tạm trước khi mở hóa đơn này. Tiếp tục?")) return;
  if (cart.size && !saveCurrentDraft()) return;
  state = getState();
  const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === BH_Ma && row.BH_TrangThai === "Nháp");
  if (!invoice) return toast("Không tìm thấy hóa đơn nháp còn hiệu lực.", true);

  const metadata = getDraftInvoiceMetadata(BH_Ma);
  let lines = metadata?.lines;
  if (!Array.isArray(lines) || !lines.length) {
    const grouped = new Map();
    for (const detail of invoiceLines(state, BH_Ma)) {
      const HH_Ma = state.PhieuNhapChiTiet.find((line) => line.PNCT_Ma === detail.PNCT_Ma)?.HH_Ma;
      if (!HH_Ma) continue;
      const existing = grouped.get(HH_Ma) || { HH_Ma, BH_SL: 0, BH_DonGia: detail.BH_DonGia };
      existing.BH_SL += detail.BH_SL;
      grouped.set(HH_Ma, existing);
    }
    lines = [...grouped.values()].map((line) => ({ ...line, GB_GiaGoc: getActivePrice(line.HH_Ma, today(), state).price }));
  }
  if (!lines.length) return toast("Hóa đơn nháp không có dòng hàng hợp lệ.", true);

  const nextCart = new Map();
  const stalePrices = [];
  const shortages = [];
  const staleConversions = [];
  for (const line of lines) {
    const item = itemById(state, line.HH_Ma);
    if (!item) return toast(`Không tìm thấy mặt hàng ${line.HH_Ma} trong hóa đơn nháp.`, true);
    if (item.HH_TrangThai !== "Đang kinh doanh") return toast(`${item.HH_Ten} đã ngừng kinh doanh; không thể khôi phục hóa đơn để bán.`, true);
    const currentPrice = getActivePrice(line.HH_Ma, today(), state);
    if (currentPrice.error) return toast(`${item.HH_Ten}: ${currentPrice.error}`, true);
    const oldBasePrice = Number(line.GB_GiaGoc ?? currentPrice.price);
    if (oldBasePrice !== currentPrice.price) stalePrices.push(`${item.HH_Ten}: ${formatCurrency(oldBasePrice)} → ${formatCurrency(currentPrice.price)}`);
    const currentPackage = getUnitPackage(item);
    const savedFactor = Number(line.unitFactor || 1);
    const savedRatio = line.conversionRatio === null || line.conversionRatio === undefined ? null : Number(line.conversionRatio);
    const conversionChanged = savedFactor > 1 && (!currentPackage || savedFactor !== currentPackage.ratio || savedRatio !== currentPackage.ratio || line.saleUnit !== currentPackage.name);
    if (conversionChanged) staleConversions.push(`${item.HH_Ten}: ${line.saleUnit} (${savedRatio} ${line.baseUnit || item.HH_DVi}) → ${currentPackage ? `${currentPackage.name} (${currentPackage.ratio} ${item.HH_DVi})` : "không còn đơn vị đóng gói"}`);
    const useSavedUnit = savedFactor === 1 || !conversionChanged;
    const unitFactor = useSavedUnit ? savedFactor : 1;
    const saleUnit = useSavedUnit ? line.saleUnit || item.HH_DVi : item.HH_DVi;
    const saleQuantity = useSavedUnit ? Number(line.saleQuantity || line.BH_SL / unitFactor) : Number(line.BH_SL);
    if (!Number.isSafeInteger(saleQuantity) || saleQuantity <= 0 || saleQuantity * unitFactor !== Number(line.BH_SL)) {
      return toast(`Số lượng quy đổi của ${item.HH_Ten} trong bản nháp không hợp lệ.`, true);
    }
    const id = cartKey(line.HH_Ma, unitFactor);
    const existing = nextCart.get(id);
    const discount = line.productDiscount || null;
    const sameDiscount = JSON.stringify(existing?.productDiscount || null) === JSON.stringify(discount);
    const cartRowId = existing && !sameDiscount ? `${id}::draft-${nextCart.size}` : id;
    nextCart.set(cartRowId, {
      HH_Ma: line.HH_Ma,
      quantity: saleQuantity + (cartRowId === id ? existing?.quantity || 0 : 0),
      unitFactor,
      saleUnit,
      basePrice: currentPrice.price,
      unitPrice: currentPrice.price,
      productDiscount: discount
    });
  }
  for (const [HH_Ma, quantity] of cartProductQuantities(nextCart)) {
    const available = availableFor(state, HH_Ma);
    if (quantity > available) shortages.push(`${itemName(state, HH_Ma)}: cần ${formatNumber(quantity)}, còn ${formatNumber(available)}`);
  }
  if (staleConversions.length && !confirm(`Quy cách đóng gói đã thay đổi:\n${staleConversions.join("\n")}\n\nGiữ nguyên số lượng đơn vị cơ bản của bản nháp và chuyển các dòng này về đơn vị cơ bản?`)) return;
  if (stalePrices.length && !confirm(`Giá hiện hành đã thay đổi:\n${stalePrices.join("\n")}\n\nCập nhật theo giá hiện hành và tính lại chiết khấu?`)) return;
  const restoredBasketDiscount = metadata?.basketDiscount || null;
  let pricedCart;
  try { pricedCart = repriceCart(nextCart, restoredBasketDiscount); }
  catch (error) { return toast(`Không thể khôi phục chiết khấu nháp: ${error.message}`, true); }

  cart = pricedCart;
  basketDiscount = restoredBasketDiscount;
  activeDraftId = BH_Ma;
  selectedCustomer = invoice.DT_Ma || "";
  paymentMethod = metadata?.paymentMethod || "Tiền mặt";
  allowCredit = Boolean(metadata?.allowCredit);
  paymentAmount = cartTotal(state);
  paymentAmountTouched = false;
  productQuery = "";
  closeModal();
  renderContent();
  if (shortages.length) toast(`Đã mở ${BH_Ma}, nhưng cần giảm số lượng trước khi thanh toán: ${shortages.join("; ")}`, true, 7000);
  else toast(`Đã khôi phục hóa đơn ${BH_Ma}. Chưa xác nhận bán hoặc trừ tồn.`);
}

function openDiscountModal(state, scope = "basket", HH_Ma = "") {
  if (!cart.size) return toast("Thêm sản phẩm vào giỏ trước khi áp dụng chiết khấu.", true);
  const firstId = HH_Ma || cart.keys().next().value;
  const currentDiscount = scope === "product" ? cart.get(firstId)?.productDiscount : basketDiscount;
  const productOptions = [...cart.entries()].map(([cartId, row]) => {
    const item = itemById(state, row.HH_Ma);
    return `<option value="${esc(cartId)}" ${cartId === firstId ? "selected" : ""}>${esc(item?.HH_Ten || row.HH_Ma)} · ${esc(row.saleUnit || item?.HH_DVi || "")}</option>`;
  }).join("");
  const body = `<form id="discount-form" data-initial-scope="${scope}">
    <div class="form-error" id="discount-error"></div>
    <div class="form-grid two">
      <div class="field"><label for="discount-scope">Phạm vi</label><select id="discount-scope" name="scope"><option value="product" ${scope === "product" ? "selected" : ""}>Từng sản phẩm</option><option value="basket" ${scope === "basket" ? "selected" : ""}>Toàn bộ giỏ</option></select></div>
      <div class="field" id="discount-product-field" ${scope === "basket" ? "hidden" : ""}><label for="discount-product">Sản phẩm trong giỏ</label><select id="discount-product" name="HH_Ma">${productOptions}</select></div>
      <div class="field"><label for="discount-type">Loại chiết khấu</label><select id="discount-type" name="type"><option value="percent" ${currentDiscount?.type !== "amount" ? "selected" : ""}>Phần trăm (%)</option><option value="amount" ${currentDiscount?.type === "amount" ? "selected" : ""}>Số tiền (VNĐ)</option></select></div>
      <div class="field"><label for="discount-value">Giá trị chiết khấu</label><input id="discount-value" name="value" type="number" min="0" step="any" value="${currentDiscount?.value ?? ""}" required><small id="discount-value-hint" class="field-hint"></small></div>
    </div>
    <div id="discount-preview" class="discount-preview" aria-live="polite"></div>
  </form>`;
  openModal("Áp dụng chiết khấu", body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-danger" type="button" data-action="remove-discount">Xóa chiết khấu</button><button class="button button-primary" type="submit" form="discount-form">Áp dụng</button>`, false);
  refreshDiscountPreview();
}

function refreshDiscountPreview() {
  const form = document.querySelector("#discount-form");
  const preview = document.querySelector("#discount-preview");
  const errorNode = document.querySelector("#discount-error");
  if (!form || !preview) return;
  const scope = form.elements.scope.value;
  const HH_Ma = form.elements.HH_Ma.value;
  const type = form.elements.type.value;
  const rawValue = form.elements.value.value;
  const value = Number(rawValue || 0);
  const productField = document.querySelector("#discount-product-field");
  if (productField) productField.hidden = scope !== "product";
  const valueHint = document.querySelector("#discount-value-hint");
  if (valueHint) valueHint.textContent = type === "amount"
    ? scope === "product" ? "VND / đơn vị cơ bản; áp dụng cho từng đơn vị hàng hóa trong dòng đã chọn." : "Tổng số VND giảm cho toàn bộ giỏ hàng."
    : scope === "product" ? "Phần trăm giảm tính trên giá mỗi đơn vị cơ bản." : "Phần trăm giảm trên tổng giỏ hàng.";
  const apply = document.querySelector('[form="discount-form"][type="submit"]');
  try {
    if (!Number.isFinite(value) || value < 0 || (type === "percent" && value > 100) || (type === "amount" && !Number.isSafeInteger(value))) {
      throw new Error(type === "percent" ? "Chiết khấu phần trăm phải từ 0 đến 100%." : "Chiết khấu tiền phải là số VND nguyên không âm.");
    }
    const result = discountForPreview({ scope, HH_Ma, type, value });
    const selectedRow = result.selected;
    const item = itemById(getState(), selectedRow?.HH_Ma);
    const currentPrice = selectedRow?.basePrice || 0;
    const finalPrice = selectedRow?.unitPrice || 0;
    const factor = selectedRow?.unitFactor || 1;
    preview.innerHTML = `<div><span>Giá cơ bản / ${esc(item?.HH_DVi || "đơn vị")}</span><strong>${formatCurrency(currentPrice)}</strong></div><div><span>Tổng chiết khấu</span><strong>${formatCurrency(result.discountTotal)}</strong></div><div><span>Giá bán ${esc(selectedRow?.saleUnit || item?.HH_DVi || "")}${factor > 1 ? ` · ${factor} ${esc(item?.HH_DVi || "")}` : ""}</span><strong>${formatCurrency(finalPrice * factor)}</strong></div><div class="discount-preview-total"><span>Tổng mới sau giảm</span><strong>${formatCurrency(result.total)}</strong></div>`;
    if (errorNode) {
      errorNode.textContent = "";
      errorNode.classList.remove("visible");
    }
    if (apply) apply.disabled = false;
  } catch (error) {
    preview.innerHTML = `<div class="discount-preview-error">${esc(error.message)}</div>`;
    if (errorNode) errorNode.textContent = error.message;
    if (apply) apply.disabled = true;
  }
}

function applyDiscountForm(form) {
  const scope = form.elements.scope.value;
  const HH_Ma = form.elements.HH_Ma.value;
  const type = form.elements.type.value;
  const rawValue = form.elements.value.value;
  const value = Number(rawValue);
  if (!rawValue || !Number.isFinite(value) || value < 0 || (type === "percent" && value > 100) || (type === "amount" && !Number.isSafeInteger(value))) {
    throw new Error(type === "percent" ? "Chiết khấu phần trăm phải từ 0 đến 100%." : "Chiết khấu tiền phải là số VND nguyên không âm.");
  }
  const next = new Map([...cart].map(([id, row]) => [id, { ...row, productDiscount: row.productDiscount ? { ...row.productDiscount } : null }]));
  const discount = value ? { type, value } : null;
  let nextBasket = basketDiscount;
  if (scope === "product") {
    const row = next.get(HH_Ma);
    if (!row) throw new Error("Sản phẩm không còn trong giỏ hàng.");
    row.productDiscount = discount;
  } else nextBasket = discount;
  updateCartPricing(next, nextBasket);
  paymentAmountTouched = false;
  closeModal();
  renderContent();
  toast("Đã cập nhật chiết khấu. Đơn giá thực bán và tổng tiền đã được tính lại.");
}

function removeDiscountFromModal() {
  const form = document.querySelector("#discount-form");
  if (!form) return;
  const next = new Map([...cart].map(([id, row]) => [id, { ...row, productDiscount: row.productDiscount ? { ...row.productDiscount } : null }]));
  let nextBasket = basketDiscount;
  if (form.elements.scope.value === "product") {
    const row = next.get(form.elements.HH_Ma.value);
    if (row) row.productDiscount = null;
  } else nextBasket = null;
  try {
    updateCartPricing(next, nextBasket);
    paymentAmountTouched = false;
    closeModal();
    renderContent();
    toast("Đã xóa chiết khấu trong phạm vi chọn.");
  } catch (error) { toast(error.message, true); }
}

function renderOverview(state) {
  const invoices = state.HoaDonBanHang.filter(isActiveInvoice).filter((row) => (!locationId || row.DD_Ma === locationId) && (!dashboardFrom || row.BH_Ngay.slice(0, 10) >= dashboardFrom) && (!dashboardTo || row.BH_Ngay.slice(0, 10) <= dashboardTo));
  const invoiceIds = new Set(invoices.map((row) => row.BH_Ma));
  const payments = state.ThanhToanBanHang.filter((row) => invoiceIds.has(row.BH_Ma) && row.TTBH_TrangThai === "Thành công");
  const revenue = invoices.reduce((sum, row) => sum + row.BH_TongCong, 0);
  const collected = payments.reduce((sum, row) => sum + row.TTBH_SoTien, 0);
  const sold = invoices.reduce((sum, row) => sum + row.BH_TongSL, 0);
  const debts = invoices.reduce((sum, row) => sum + getInvoiceOutstanding(row.BH_Ma, state), 0);
  const newest = invoices.slice().sort((a, b) => b.BH_Ngay.localeCompare(a.BH_Ngay)).slice(0, 5).map((row) => `<tr><td class="cell-primary">${esc(row.BH_Ma)}</td><td>${formatDate(row.BH_Ngay)}</td><td>${esc(partnerName(state, row.DT_Ma))}</td><td>${formatCurrency(row.BH_TongCong)}</td><td>${formatCurrency(getInvoicePaid(row.BH_Ma, state))}</td><td>${badge(row.BH_TrangThai)}</td></tr>`).join("");
  const pending = state.ThanhToanBanHang.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận" && invoiceIds.has(row.BH_Ma)).slice(0, 5).map((row) => `<tr><td>${esc(row.TTBH_Ma)}</td><td>${esc(row.BH_Ma)}</td><td>${esc(partnerName(state, state.HoaDonBanHang.find((doc) => doc.BH_Ma === row.BH_Ma)?.DT_Ma))}</td><td>${formatCurrency(row.TTBH_SoTien)}</td><td>${esc(row.TTBH_PhuongThuc)}</td><td>${badge(row.TTBH_TrangThai)}</td></tr>`).join("");
  const outstanding = invoices.filter((row) => row.DT_Ma && getInvoiceOutstanding(row.BH_Ma, state) > 0).slice(0, 5).map((row) => `<tr><td>${esc(row.BH_Ma)}</td><td>${esc(partnerName(state, row.DT_Ma))}</td><td>${formatCurrency(row.BH_TongCong)}</td><td>${formatCurrency(getInvoicePaid(row.BH_Ma, state))}</td><td class="negative">${formatCurrency(getInvoiceOutstanding(row.BH_Ma, state))}</td></tr>`).join("");
  return `${heading("Tổng quan bán hàng", "Phân biệt doanh thu hóa đơn, tiền đã thu hợp lệ và công nợ còn phải thu.", `<a class="button button-primary" href="ban-hang.html">＋ Bán hàng tại quầy</a>`)}
    <div class="filters"><div class="field"><label>Từ ngày</label><input data-dashboard-date="from" type="date" value="${esc(dashboardFrom)}"></div><div class="field"><label>Đến ngày</label><input data-dashboard-date="to" type="date" value="${esc(dashboardTo)}"></div><button class="button" data-action="clear-dashboard">Xóa ngày</button><span class="role-note">Địa điểm lọc theo lựa chọn trên thanh đầu trang.</span></div>
    <div class="metric-grid">
      <div class="metric-card"><div class="metric-title">Giá trị hóa đơn xác nhận</div><div class="metric-value">${formatCurrency(revenue)}</div><div class="metric-caption">Doanh thu theo hóa đơn bán</div></div>
      <div class="metric-card"><div class="metric-title">Tiền đã thu hợp lệ</div><div class="metric-value">${formatCurrency(collected)}</div><div class="metric-caption">Chỉ giao dịch Thành công</div></div>
      <div class="metric-card"><div class="metric-title">Hóa đơn đã xác nhận</div><div class="metric-value">${formatNumber(invoices.length)}</div><div class="metric-caption">Tại địa điểm và kỳ đang chọn</div></div>
      <div class="metric-card"><div class="metric-title">Sản phẩm đã bán</div><div class="metric-value">${formatNumber(sold)}</div><div class="metric-caption">Tổng BH_TongSL</div></div>
      <div class="metric-card"><div class="metric-title">Công nợ còn phải thu</div><div class="metric-value">${formatCurrency(debts)}</div><div class="metric-caption">Doanh thu trừ thanh toán thành công</div></div>
    </div>
    <div class="dashboard-grid">${tableCard("Hóa đơn mới nhất", `${invoices.length} hóa đơn trong kỳ`, ["Mã hóa đơn", "Ngày", "Khách hàng", "Tổng tiền", "Đã thu", "Trạng thái"], newest)}${tableCard("Thanh toán chờ xác nhận", "Chuyển khoản/QR mô phỏng", ["Mã thanh toán", "Hóa đơn", "Khách hàng", "Số tiền", "Phương thức", "Trạng thái"], pending)}</div>
    ${tableCard("Hóa đơn còn nợ", "Không cộng PhieuThu vào doanh thu bán hàng", ["Hóa đơn", "Khách hàng", "Tổng tiền", "Đã thu", "Còn nợ"], outstanding)}`;
}

function invoiceRow(state, invoice) {
  const paid = getInvoicePaid(invoice.BH_Ma, state);
  const due = getInvoiceOutstanding(invoice.BH_Ma, state);
  return `<tr data-search="${esc(`${invoice.BH_Ma} ${partnerName(state, invoice.DT_Ma)} ${employeeName(state, invoice.NV_Ma)}`.toLocaleLowerCase("vi-VN"))}" data-customer="${esc(invoice.DT_Ma || "")}" data-staff="${esc(invoice.NV_Ma)}" data-location="${esc(invoice.DD_Ma)}" data-status="${esc(invoice.BH_TrangThai)}" data-date="${esc(invoice.BH_Ngay.slice(0, 10))}">
    <td class="cell-primary">${esc(invoice.BH_Ma)}</td><td>${formatDate(invoice.BH_Ngay)}</td><td>${esc(partnerName(state, invoice.DT_Ma))}</td><td>${esc(employeeName(state, invoice.NV_Ma))}</td><td>${esc(locationName(state, invoice.DD_Ma))}</td><td>${formatNumber(invoice.BH_TongSL)}</td><td>${formatCurrency(invoice.BH_TongCong)}</td><td>${formatCurrency(paid)}</td><td>${formatCurrency(due)}</td><td>${badge(invoice.BH_TrangThai)}</td><td><button class="button button-small" data-action="view-invoice" data-id="${esc(invoice.BH_Ma)}">Chi tiết</button></td></tr>`;
}

function filters(items) {
  return `<div class="filters">${items.join("")}<button class="button" data-action="clear-filters">Xóa lọc</button></div>`;
}
function searchFilter(label = "Tìm kiếm", placeholder = "Nhập từ khóa…") {
  return `<div class="field grow"><label>${label}</label><input class="list-filter" data-filter="search" placeholder="${placeholder}"></div>`;
}
function selectFilter(key, label, rows, first = "Tất cả", selected = "") {
  return `<div class="field"><label>${label}</label><select class="list-filter" data-filter="${key}"><option value="">${first}</option>${rows.map(([value, text]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></div>`;
}
function dateFilter(key, label) {
  return `<div class="field"><label>${label}</label><input class="list-filter" data-filter="${key}" type="date"></div>`;
}

function renderInvoices(state) {
  const invoices = state.HoaDonBanHang.filter(isActiveInvoice).slice().sort((a, b) => b.BH_Ngay.localeCompare(a.BH_Ngay));
  const rows = invoices.map((invoice) => invoiceRow(state, invoice)).join("");
  return `${heading("Hóa đơn bán hàng", "Tra cứu hóa đơn đã xác nhận, xem chi tiết và in hóa đơn.", saleRoles.has(role) ? `<a class="button button-primary" href="ban-hang.html">＋ Tạo hóa đơn tại POS</a>` : "")}
    ${filters([searchFilter("Mã hóa đơn / khách hàng"), selectFilter("customer", "Khách hàng", validCustomers(state).map((x) => [x.DT_Ma, x.DT_Ten])), selectFilter("staff", "Nhân viên", state.NhanVien.map((x) => [x.NV_Ma, x.NV_Ten])), selectFilter("location", "Địa điểm", state.DiaDiem.filter((x) => x.DD_Loai === "Cửa hàng").map((x) => [x.DD_Ma, x.DD_Ten])), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày"), selectFilter("status", "Trạng thái", [...new Set(invoices.map((x) => x.BH_TrangThai))].map((x) => [x, x]))])}
    ${tableCard("Danh sách hóa đơn", `${invoices.length} hóa đơn`, ["Mã hóa đơn", "Ngày lập", "Khách hàng", "Nhân viên", "Địa điểm", "Tổng SL", "Tổng tiền", "Đã thanh toán", "Còn phải thu", "Trạng thái", "Thao tác"], rows, "Hóa đơn đã xác nhận không cho sửa/xóa. Chưa triển khai hoàn hàng, hoàn tiền hoặc hủy ghi giảm tồn.")}`;
}

function invoicePrintHtml(state, invoice) {
  const lines = invoiceLines(state, invoice.BH_Ma).map((line) => `<tr><td>${esc(itemName(state, state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === line.PNCT_Ma)?.HH_Ma))}</td><td>${esc(line.PNCT_Ma)}</td><td>${line.BH_SL}</td><td>${formatCurrency(line.BH_DonGia)}</td><td>${formatCurrency(line.BH_TTien)}</td></tr>`).join("");
  return `<div class="invoice-print"><h2>HÓA ĐƠN BÁN HÀNG</h2><p>Siêu thị mini · ${esc(locationName(state, invoice.DD_Ma))}</p>
    <p>Mã hóa đơn: <strong>${esc(invoice.BH_Ma)}</strong> · Ngày: ${formatDate(invoice.BH_Ngay)}</p>
    <p>Khách hàng: ${esc(partnerName(state, invoice.DT_Ma))} · Nhân viên: ${esc(employeeName(state, invoice.NV_Ma))}</p>
    <table><thead><tr><th>Mặt hàng</th><th>Dòng nhập</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead><tbody>${lines}</tbody></table>
    <p><strong>Tổng cộng: ${formatCurrency(invoice.BH_TongCong)}</strong></p>
    <p>Đã thanh toán: ${formatCurrency(getInvoicePaid(invoice.BH_Ma, state))} · Còn phải thu: ${formatCurrency(getInvoiceOutstanding(invoice.BH_Ma, state))}</p><p>Cảm ơn quý khách!</p></div>`;
}

function openModal(title, body, footer = "", wide = false) {
  document.querySelector("#modal-host").innerHTML = `<div class="modal-backdrop" data-action="backdrop-close"><section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-header"><h2>${esc(title)}</h2><button class="button button-small" data-action="close-modal">Đóng</button></div><div class="modal-body">${body}</div><div class="modal-footer">${footer}</div></section></div>`;
}

function closeModal() {
  const returnToProductSearch = page === "pos" && Boolean(document.querySelector("#camera-reader"));
  disposeCameraScanner();
  document.querySelector("#modal-host").innerHTML = "";
  if (returnToProductSearch) document.querySelector("#product-search")?.focus();
}

function cameraStatus(message, error = false) {
  const status = document.querySelector("#camera-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("error", error);
}

function cameraErrorMessage(error) {
  const detail = String(error?.message || "").toLocaleLowerCase("en-US");
  if (!window.isSecureContext && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
    return "Camera cần kết nối an toàn. Vui lòng chạy ứng dụng bằng localhost hoặc HTTPS.";
  }
  if (["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error?.name) || /permission denied|notallowederror|permission was denied/.test(detail)) {
    return "Bạn chưa cấp quyền sử dụng camera. Vui lòng cấp quyền trong trình duyệt hoặc nhập mã vạch thủ công.";
  }
  if (["NotFoundError", "DevicesNotFoundError"].includes(error?.name) || /devicesnotfound|no camera|notfounderror/.test(detail)) {
    return "Thiết bị không có camera khả dụng.";
  }
  if (["NotReadableError", "TrackStartError", "AbortError"].includes(error?.name) || /notreadable|trackstart|device in use|could not start video source/.test(detail)) {
    return "Camera đang được ứng dụng khác sử dụng. Hãy đóng ứng dụng đó rồi thử lại.";
  }
  return error?.message || "Không thể khởi động camera. Vui lòng thử lại hoặc nhập mã vạch thủ công.";
}

function openCameraScanner() {
  cameraProcessing = false;
  openModal("Quét mã vạch sản phẩm", `<div class="camera-scan-modal">
    <div class="camera-reader-wrap"><div id="camera-reader" class="camera-reader"></div><div class="camera-reticle" aria-hidden="true"></div></div>
    <p class="camera-instruction">Đưa mã vạch sản phẩm vào giữa khung hình</p>
    <div class="field"><label for="camera-select">Camera</label><select id="camera-select" aria-label="Chọn camera" disabled><option>Đang tìm camera...</option></select></div>
    <div id="camera-status" class="camera-status" role="status" aria-live="polite">Đang khởi động camera...</div>
    <div id="camera-scan-result" class="camera-scan-result" hidden></div>
    <div class="camera-actions"><button class="button button-primary" type="button" data-action="camera-toggle">Tắt camera</button><button class="button" type="button" data-action="camera-continue" hidden>Tiếp tục quét</button></div>
  </div>`);
  const session = ++cameraSession;
  startCameraScanner(session);
}

async function startCameraScanner(session = cameraSession) {
  const status = document.querySelector("#camera-status");
  const toggle = document.querySelector('[data-action="camera-toggle"]');
  const select = document.querySelector("#camera-select");
  const continueButton = document.querySelector('[data-action="camera-continue"]');
  if (!status || session !== cameraSession || cameraStarting) return;
  cameraProcessing = false;
  if (toggle) {
    toggle.disabled = true;
    toggle.textContent = "Đang khởi động...";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatus(!window.isSecureContext && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)
      ? cameraErrorMessage({ name: "SecurityError" })
      : "Trình duyệt không hỗ trợ truy cập camera. Vui lòng nhập mã vạch thủ công.", true);
    if (toggle) {
      toggle.disabled = false;
      toggle.textContent = "Thử lại";
    }
    return;
  }
  if (!window.Html5Qrcode || !window.Html5QrcodeSupportedFormats) {
    cameraStatus("Không tải được thư viện quét mã vạch. Vui lòng nhập mã thủ công hoặc thử lại khi có kết nối Internet.", true);
    if (toggle) {
      toggle.disabled = false;
      toggle.textContent = "Thử lại";
    }
    return;
  }

  cameraStarting = true;
  try {
    cameraStatus("Đang tìm camera...");
    if (!cameraScanner) {
      cameraScanner = new window.Html5Qrcode("camera-reader", {
        formatsToSupport: [
          window.Html5QrcodeSupportedFormats.EAN_13,
          window.Html5QrcodeSupportedFormats.EAN_8,
          window.Html5QrcodeSupportedFormats.UPC_A,
          window.Html5QrcodeSupportedFormats.CODE_128
        ]
      });
    }
    const scanner = cameraScanner;
    const cameras = await window.Html5Qrcode.getCameras();
    if (session !== cameraSession || !document.querySelector("#camera-reader")) return;
    if (!cameras.length) {
      cameraStatus("Thiết bị không có camera khả dụng.", true);
      if (toggle) {
        toggle.disabled = false;
        toggle.textContent = "Thử lại";
      }
      return;
    }
    if (select) {
      const previousId = select.value;
      select.innerHTML = cameras.map((camera, index) => `<option value="${esc(camera.id)}">${esc(camera.label || `Camera ${index + 1}`)}</option>`).join("");
      const preferredCamera = cameras.find((camera) => /back|rear|environment|sau/i.test(camera.label));
      select.value = cameras.some((camera) => camera.id === previousId) ? previousId : (preferredCamera?.id || cameras[0].id);
      select.disabled = cameras.length < 2;
    }
    cameraStatus("Đang quét...");
    if (continueButton) continueButton.hidden = true;
    if (continueButton) continueButton.textContent = "Tiếp tục quét";
    await scanner.start(select?.value || { facingMode: "environment" }, {
      fps: 10,
      qrbox: { width: 280, height: 120 },
      aspectRatio: 1.777
    }, handleCameraDecode, () => {});
    if (session !== cameraSession || !document.querySelector("#camera-reader")) {
      await scanner.stop();
      return;
    }
    cameraRunning = true;
    if (toggle) {
      toggle.disabled = false;
      toggle.textContent = "Tắt camera";
    }
  } catch (error) {
    cameraRunning = false;
    if (session === cameraSession) {
      cameraStatus(cameraErrorMessage(error), true);
      if (toggle) {
        toggle.disabled = false;
        toggle.textContent = "Thử lại";
      }
    }
  } finally {
    cameraStarting = false;
    if (session !== cameraSession && document.querySelector("#camera-reader")) startCameraScanner(cameraSession);
  }
}

async function stopCameraFeed() {
  if (!cameraScanner || !cameraRunning) return;
  cameraRunning = false;
  try {
    await cameraScanner.stop();
  } catch (error) {
    cameraStatus(`Không thể tắt camera sạch sẽ: ${error.message || "vui lòng thử đóng cửa sổ quét."}`, true);
  }
}

function disposeCameraScanner() {
  cameraSession += 1;
  cameraProcessing = false;
  if (!cameraScanner) return;
  const scanner = cameraScanner;
  cameraScanner = null;
  const wasRunning = cameraRunning;
  cameraRunning = false;
  const cleanup = async () => {
    if (wasRunning) {
      try { await scanner.stop(); }
      catch (error) { console.error("Không thể dừng camera khi đóng modal.", error); }
    }
    try { scanner.clear(); }
    catch (error) { console.error("Không thể giải phóng giao diện camera.", error); }
  };
  cleanup();
}

async function handleCameraDecode(decodedText) {
  if (cameraProcessing || !cameraRunning) return;
  cameraProcessing = true;
  const session = cameraSession;
  const result = processBarcode(decodedText, { notify: false, camera: true });
  const resultNode = document.querySelector("#camera-scan-result");
  const continueButton = document.querySelector('[data-action="camera-continue"]');
  const toggle = document.querySelector('[data-action="camera-toggle"]');
  if (result.success) {
    cameraStatus("Quét thành công. Camera đã tắt để tránh quét lặp.");
    if (resultNode) {
      resultNode.hidden = false;
      resultNode.textContent = `${result.item.HH_Ten} · số lượng ${formatNumber(result.quantity)} · ${formatCurrency(result.price)}`;
    }
    if (continueButton) continueButton.hidden = false;
    if (toggle) toggle.hidden = true;
    toast(`${result.item.HH_Ten} · số lượng ${formatNumber(result.quantity)}`, false, 1800);
  } else if (result.needsUnitSelection) {
    cameraStatus(`Đã nhận mã ${decodedText}. Chọn đơn vị bán; camera đã tắt để tránh quét lặp.`);
    if (resultNode) {
      resultNode.hidden = false;
      resultNode.innerHTML = `<strong>${esc(result.item.HH_Ten)}</strong><div class="sale-unit-choices">${saleUnitChoices(result.item, getState(), "select-camera-unit")}</div>`;
    }
    if (continueButton) continueButton.hidden = true;
    if (toggle) toggle.hidden = true;
  } else {
    cameraStatus(result.message, true);
    if (continueButton) {
      continueButton.hidden = false;
      continueButton.textContent = "Thử quét lại";
    }
    if (toggle) toggle.hidden = true;
  }
  await stopCameraFeed();
  if (session !== cameraSession) return;
}

function processBarcode(barcode, { notify = true, camera = false } = {}) {
  try {
    const state = getState();
    const item = state.HangHoa.find((row) => String(row.HH_MaVach || "").trim() === String(barcode || "").trim());
    if (!item) {
      const message = camera ? "Không tìm thấy sản phẩm tương ứng với mã vạch vừa quét." : "Không tìm thấy sản phẩm có mã vạch này.";
      if (notify) toast(message, true, 2200);
      return { success: false, message };
    }
    if (getUnitPackage(item)) {
      if (item.HH_TrangThai !== "Đang kinh doanh") {
        const message = "Sản phẩm đã ngừng kinh doanh.";
        if (notify) toast(message, true);
        return { success: false, message };
      }
      if (availableFor(state, item.HH_Ma) <= 0) {
        const message = `Sản phẩm hiện đã hết hàng tại cửa hàng (${item.HH_DVi}).`;
        if (notify) toast(message, true);
        return { success: false, message };
      }
      const activePrice = getActivePrice(item.HH_Ma, today(), state);
      if (activePrice.error) {
        if (notify) toast(`${item.HH_Ten}: ${activePrice.error}`, true);
        return { success: false, message: `${item.HH_Ten}: ${activePrice.error}` };
      }
      if (camera) return { success: false, needsUnitSelection: true, item };
      openSaleUnitPicker(state, item, true);
      return { success: false, needsUnitSelection: true, item };
    }
    const outcome = addToCart(state, item.HH_Ma, true, notify);
    return outcome.success ? { ...outcome, item } : { ...outcome, message: outcome.message || "Không thể thêm sản phẩm vào giỏ." };
  } catch (error) {
    const message = error.message || "Không thể đọc dữ liệu sản phẩm.";
    if (notify) toast(message, true);
    return { success: false, message };
  }
}

function viewInvoice(state, id) {
  const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === id);
  if (!invoice) return toast("Không tìm thấy hóa đơn.", true);
  const lines = invoiceLines(state, id).map((line) => {
    const detail = state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === line.PNCT_Ma);
    return `<tr><td>${esc(line.PNCT_Ma)}</td><td>${esc(itemName(state, detail?.HH_Ma))}</td><td>${formatNumber(line.BH_SL)}</td><td>${formatCurrency(line.BH_DonGia)}</td><td>${formatCurrency(line.BH_TTien)}</td></tr>`;
  }).join("");
  const payments = state.ThanhToanBanHang.filter((row) => row.BH_Ma === id).map((row) => `<tr><td>${esc(row.TTBH_Ma)}</td><td>${formatDate(row.TTBH_Ngay)}</td><td>${formatCurrency(row.TTBH_SoTien)}</td><td>${esc(row.TTBH_PhuongThuc)}</td><td>${badge(row.TTBH_TrangThai)}</td></tr>`).join("");
  const body = `<div class="form-grid"><div><span class="field-label">Khách hàng</span><div>${esc(partnerName(state, invoice.DT_Ma))}</div></div><div><span class="field-label">Địa điểm bán</span><div>${esc(locationName(state, invoice.DD_Ma))}</div></div><div><span class="field-label">Nhân viên</span><div>${esc(employeeName(state, invoice.NV_Ma))}</div></div><div><span class="field-label">Ngày lập</span><div>${formatDate(invoice.BH_Ngay)}</div></div><div><span class="field-label">Trạng thái</span><div>${badge(invoice.BH_TrangThai)}</div></div><div><span class="field-label">Tổng tiền</span><div><strong>${formatCurrency(invoice.BH_TongCong)}</strong></div></div></div>
    ${tableCard("Sản phẩm", `${formatNumber(invoice.BH_TongSL)} đơn vị`, ["PNCT_Ma", "Mặt hàng", "Số lượng", "Đơn giá", "Thành tiền"], lines)}
    <div class="detail-heading">Lịch sử thanh toán · đã thu ${formatCurrency(getInvoicePaid(id, state))} · còn nợ ${formatCurrency(getInvoiceOutstanding(id, state))}</div>
    ${tableCard("Các lần thanh toán", `${state.ThanhToanBanHang.filter((x) => x.BH_Ma === id).length} giao dịch`, ["Mã thanh toán", "Ngày", "Số tiền", "Phương thức", "Trạng thái"], payments)}
    ${invoicePrintHtml(state, invoice)}`;
  openModal(`Hóa đơn ${id}`, body, `<button class="button" data-action="close-modal">Đóng</button><button class="button button-primary" data-action="print-invoice">In hóa đơn</button>`, true);
  document.querySelector("#modal-host").dataset.invoiceId = id;
}

function paymentRow(state, payment) {
  const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === payment.BH_Ma);
  const canReconcile = accountingRoles.has(role) && payment.TTBH_TrangThai === "Chờ xác nhận";
  return `<tr data-search="${esc(`${payment.TTBH_Ma} ${payment.BH_Ma} ${partnerName(state, invoice?.DT_Ma)} ${payment.TTBH_PhuongThuc}`.toLocaleLowerCase("vi-VN"))}" data-invoice="${esc(payment.BH_Ma)}" data-method="${esc(payment.TTBH_PhuongThuc)}" data-status="${esc(payment.TTBH_TrangThai)}" data-date="${esc(payment.TTBH_Ngay.slice(0, 10))}">
    <td class="cell-primary">${esc(payment.TTBH_Ma)}</td><td><button class="text-link" data-action="view-invoice" data-id="${esc(payment.BH_Ma)}">${esc(payment.BH_Ma)}</button></td><td>${formatDate(payment.TTBH_Ngay)}</td><td>${esc(partnerName(state, invoice?.DT_Ma))}</td><td>${formatCurrency(payment.TTBH_SoTien)}</td><td>${esc(payment.TTBH_PhuongThuc)}</td><td>${badge(payment.TTBH_TrangThai)}</td><td><div class="inline-actions">${canReconcile ? `<button class="button button-small button-primary" data-action="confirm-payment" data-id="${esc(payment.TTBH_Ma)}">Xác nhận</button><button class="button button-small button-danger" data-action="fail-payment" data-id="${esc(payment.TTBH_Ma)}">Đánh dấu thất bại</button>` : `<button class="button button-small" data-action="view-invoice" data-id="${esc(payment.BH_Ma)}">Chi tiết</button>`}</div></td></tr>`;
}

function renderPayments(state) {
  const payments = state.ThanhToanBanHang.slice().sort((a, b) => b.TTBH_Ngay.localeCompare(a.TTBH_Ngay));
  const pendingCount = payments.filter((row) => row.TTBH_TrangThai === "Chờ xác nhận").length;
  return `${heading("Thanh toán bán hàng", "Chỉ giao dịch Thành công được tính là tiền đã thu.", paymentRoles.has(role) ? `<button class="button button-primary" data-action="new-payment">＋ Ghi nhận thanh toán</button>` : "")}
    <div class="info-box" style="margin-bottom:12px">Chuyển khoản/QR là trạng thái mô phỏng Chờ xác nhận; không có kết nối ngân hàng. Kế toán/chủ cửa hàng phải xác nhận trước khi cộng vào tiền đã thu. ${pendingCount} giao dịch đang chờ.</div>
    ${filters([searchFilter("Mã thanh toán / hóa đơn / khách"), selectFilter("invoice", "Mã hóa đơn", [...new Set(payments.map((x) => x.BH_Ma))].map((x) => [x, x])), selectFilter("method", "Phương thức", [...new Set(payments.map((x) => x.TTBH_PhuongThuc))].map((x) => [x, x])), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày"), selectFilter("status", "Trạng thái", [...new Set(payments.map((x) => x.TTBH_TrangThai))].map((x) => [x, x]))])}
    ${tableCard("Danh sách giao dịch", `${payments.length} giao dịch`, ["Mã thanh toán", "Mã hóa đơn", "Ngày thanh toán", "Khách hàng", "Số tiền", "Phương thức", "Trạng thái", "Thao tác"], payments.map((row) => paymentRow(state, row)).join(""))}`;
}

function openPaymentForm(state, invoiceId = "") {
  if (!paymentRoles.has(role)) return toast("Vai trò hiện tại không được ghi nhận thanh toán.", true);
  const invoices = state.HoaDonBanHang.filter((row) => isActiveInvoice(row) && getInvoiceOutstanding(row.BH_Ma, state) > 0);
  const chosen = invoices.find((row) => row.BH_Ma === invoiceId) || invoices[0];
  if (!chosen) return toast("Không có hóa đơn còn phải thu.");
  const outstanding = getInvoiceOutstanding(chosen.BH_Ma, state);
  const body = `<div class="form-error" id="payment-error"></div><form id="payment-form">
    <div class="form-grid two"><div class="field"><label>Hóa đơn *</label><select name="BH_Ma" required>${invoices.map((row) => `<option value="${esc(row.BH_Ma)}" ${row.BH_Ma === chosen.BH_Ma ? "selected" : ""} data-due="${getInvoiceOutstanding(row.BH_Ma, state)}">${esc(row.BH_Ma)} · ${esc(partnerName(state, row.DT_Ma))} · còn ${formatCurrency(getInvoiceOutstanding(row.BH_Ma, state))}</option>`).join("")}</select></div>
    <div class="field"><label>Số còn phải thu</label><input id="payment-due" disabled value="${formatCurrency(outstanding)}"></div>
    <div class="field"><label>Số tiền thanh toán *</label><input name="amount" type="number" min="1" max="${outstanding}" step="1" required></div>
    <div class="field"><label>Phương thức *</label><select name="method"><option>Tiền mặt</option><option>Chuyển khoản</option><option>QR</option></select></div></div>
    <div class="info-box">Chỉ thanh toán tiền mặt được ghi nhận thành công ngay. Chuyển khoản/QR cần đối chiếu xác nhận riêng; không ghi PhieuThu trùng giao dịch này.</div></form>`;
  openModal("Ghi nhận thanh toán", body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="payment-form" type="submit">Lưu giao dịch</button>`);
}

function renderCustomers(state) {
  const customers = listCustomers(state);
  const rows = customers.map((row) => `<tr data-search="${esc(`${row.DT_Ma} ${row.DT_Ten} ${row.DT_SDT}`.toLocaleLowerCase("vi-VN"))}" data-status="${esc(row.DT_TrangThai)}">
    <td class="cell-primary">${esc(row.DT_Ma)}</td><td>${esc(row.DT_Ten)}</td><td>${esc(row.DT_SDT || "—")}</td><td>${esc(row.DT_DChi || "—")}</td><td>${esc(row.DT_Loai)}</td><td>${badge(row.DT_TrangThai)}</td><td><div class="inline-actions"><button class="button button-small" data-action="view-customer" data-id="${esc(row.DT_Ma)}">Hồ sơ</button>${saleRoles.has(role) ? `<button class="button button-small" data-action="edit-customer" data-id="${esc(row.DT_Ma)}">Sửa</button>` : ""}</div></td></tr>`).join("");
  return `${heading("Khách hàng", "Quản lý khách hàng từ DoiTacKinhDoanh; không tạo bảng KhachHang riêng.", saleRoles.has(role) ? `<button class="button button-primary" data-action="new-customer">＋ Thêm khách hàng</button>` : "")}
    ${filters([searchFilter("Tìm mã / tên / số điện thoại"), selectFilter("status", "Trạng thái", [["Hoạt động", "Hoạt động"], ["Ngừng hoạt động", "Ngừng hoạt động"]])])}
    ${tableCard("Danh sách khách hàng", `${customers.length} đối tác`, ["Mã đối tác", "Tên khách hàng", "Số điện thoại", "Địa chỉ", "Loại đối tác", "Trạng thái", "Thao tác"], rows, "Mỗi đối tác chỉ thuộc một loại: Khách hàng hoặc Nhà cung cấp.")}`;
}

function customerForm(state, id = "") {
  if (!saleRoles.has(role)) return toast("Vai trò hiện tại không được chỉnh sửa hồ sơ khách hàng.", true);
  const customer = state.DoiTacKinhDoanh.find((row) => row.DT_Ma === id);
  const body = `<div class="form-error" id="customer-error"></div><form id="customer-form" data-id="${esc(id)}">
    <div class="form-grid two"><div class="field"><label>Tên khách hàng *</label><input name="DT_Ten" value="${esc(customer?.DT_Ten || "")}" maxlength="120"><small class="field-validation-error" data-field-error="DT_Ten" aria-live="polite"></small></div>
    <div class="field"><label>Số điện thoại</label><input name="DT_SDT" value="${esc(customer?.DT_SDT || "")}" maxlength="20"><small class="field-validation-error" data-field-error="DT_SDT" aria-live="polite"></small></div>
    <div class="field"><label>Địa chỉ</label><input name="DT_DChi" value="${esc(customer?.DT_DChi || "")}" maxlength="200"><small class="field-validation-error" data-field-error="DT_DChi" aria-live="polite"></small></div>
    <div class="field"><label>Loại đối tác</label><select name="DT_Loai"><option ${customer?.DT_Loai === "Khách hàng" || !customer ? "selected" : ""}>Khách hàng</option></select></div>
    <div class="field"><label>Trạng thái</label><select name="DT_TrangThai"><option ${customer?.DT_TrangThai !== "Ngừng hoạt động" ? "selected" : ""}>Hoạt động</option><option ${customer?.DT_TrangThai === "Ngừng hoạt động" ? "selected" : ""}>Ngừng hoạt động</option></select></div></div>
    <p class="role-note">Không xóa vật lý đối tác đã phát sinh hóa đơn. Mỗi đối tác chỉ thuộc một loại được chọn ban đầu.</p></form>`;
  openModal(customer ? `Chỉnh sửa ${id}` : "Thêm khách hàng", body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="customer-form" type="submit">Lưu khách hàng</button>`);
}

function viewCustomer(state, id) {
  const customer = state.DoiTacKinhDoanh.find((row) => row.DT_Ma === id);
  if (!customer) return toast("Không tìm thấy khách hàng.", true);
  const customerInvoices = state.HoaDonBanHang.filter((row) => row.DT_Ma === id && isActiveInvoice(row));
  const invoices = customerInvoices.map((row) => `<tr><td><button class="text-link" data-action="view-invoice" data-id="${esc(row.BH_Ma)}">${esc(row.BH_Ma)}</button></td><td>${formatDate(row.BH_Ngay)}</td><td>${formatCurrency(row.BH_TongCong)}</td><td>${formatCurrency(getInvoicePaid(row.BH_Ma, state))}</td><td>${formatCurrency(getInvoiceOutstanding(row.BH_Ma, state))}</td></tr>`).join("");
  openModal(`Hồ sơ khách hàng ${id}`, `<div class="form-grid two"><div><span class="field-label">Tên</span><div>${esc(customer.DT_Ten)}</div></div><div><span class="field-label">Điện thoại</span><div>${esc(customer.DT_SDT || "—")}</div></div><div><span class="field-label">Địa chỉ</span><div>${esc(customer.DT_DChi || "—")}</div></div><div><span class="field-label">Loại / trạng thái</span><div>${esc(customer.DT_Loai)} · ${esc(customer.DT_TrangThai)}</div></div><div><span class="field-label">Công nợ còn lại</span><div><strong>${formatCurrency(customerInvoices.reduce((sum, row) => sum + getInvoiceOutstanding(row.BH_Ma, state), 0))}</strong></div></div></div>${tableCard("Lịch sử hóa đơn", `${customerInvoices.length} hóa đơn`, ["Mã hóa đơn", "Ngày", "Tổng tiền", "Đã thu", "Còn nợ"], invoices)}`, `<button class="button" data-action="close-modal">Đóng</button><a class="button button-primary" href="cong-no-khach-hang.html?customer=${encodeURIComponent(id)}">Xem công nợ</a>`, true);
}

function renderDebts(state) {
  const selectedCustomer = new URLSearchParams(location.search).get("customer") || "";
  const debts = state.CongNoKhachHang.map((debt) => {
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === debt.BH_Ma);
    return { debt, invoice, paid: invoice ? getInvoicePaid(invoice.BH_Ma, state) : 0, due: invoice ? getInvoiceOutstanding(invoice.BH_Ma, state) : 0 };
  }).filter((row) => row.invoice && row.invoice.DT_Ma && (!selectedCustomer || row.invoice.DT_Ma === selectedCustomer));
  const rows = debts.map(({ debt, invoice, paid, due }) => `<tr data-search="${esc(`${debt.CNKH_Ma} ${invoice.BH_Ma} ${partnerName(state, invoice.DT_Ma)}`.toLocaleLowerCase("vi-VN"))}" data-customer="${esc(invoice.DT_Ma)}" data-status="${due > 0 ? "Còn nợ" : "Đã thanh toán"}" data-date="${esc(invoice.BH_Ngay.slice(0, 10))}">
    <td class="cell-primary">${esc(debt.CNKH_Ma)}</td><td><button class="text-link" data-action="view-invoice" data-id="${esc(invoice.BH_Ma)}">${esc(invoice.BH_Ma)}</button></td><td>${esc(partnerName(state, invoice.DT_Ma))}</td><td>${formatDate(invoice.BH_Ngay)}</td><td>${formatCurrency(invoice.BH_TongCong)}</td><td>${formatCurrency(paid)}</td><td class="${due ? "negative" : "positive"}">${formatCurrency(due)}</td><td>${badge(due > 0 ? "Còn nợ" : "Đã thanh toán")}</td><td>${due > 0 && paymentRoles.has(role) ? `<button class="button button-small button-primary" data-action="pay-invoice" data-id="${esc(invoice.BH_Ma)}">Ghi nhận trả nợ</button>` : `<button class="button button-small" data-action="view-invoice" data-id="${esc(invoice.BH_Ma)}">Chi tiết</button>`}</td></tr>`).join("");
  return `${heading("Công nợ khách hàng", "Theo dõi theo hóa đơn gốc; khoản thu chỉ lấy từ ThanhToanBanHang thành công.", "")}
    ${filters([searchFilter("Tìm công nợ / hóa đơn / khách"), selectFilter("customer", "Khách hàng", listCustomers(state).map((row) => [row.DT_Ma, row.DT_Ten]), "Tất cả", selectedCustomer), selectFilter("status", "Trạng thái", [["Còn nợ", "Còn nợ"], ["Đã thanh toán", "Đã thanh toán"]]), dateFilter("from", "Từ ngày"), dateFilter("to", "Đến ngày")])}
    ${tableCard("Công nợ theo hóa đơn", `${debts.length} hóa đơn`, ["Mã công nợ", "Mã hóa đơn", "Khách hàng", "Ngày hóa đơn", "Tổng tiền", "Đã thanh toán", "Còn nợ", "Trạng thái", "Thao tác"], rows, "Số còn nợ = tổng hóa đơn − tổng thanh toán thành công. Thanh toán trả nợ không trừ tồn kho lần nữa.")}`;
}

function renderContent() {
  try {
    const state = getState();
    const renderers = { overview: renderOverview, pos: renderPos, shifts: renderCashShifts, invoices: renderInvoices, payments: renderPayments, customers: renderCustomers, debts: renderDebts };
    document.querySelector("#page-content").innerHTML = (renderers[page] || renderOverview)(state);
    applyFilters();
  } catch (error) {
    document.querySelector("#page-content").innerHTML = `<div class="warning-box">Không thể tải dữ liệu bán hàng: ${esc(error.message)} <button class="button button-small" data-action="reset">Khôi phục dữ liệu demo</button></div>`;
  }
}

function applyFilters() {
  const content = document.querySelector("#page-content");
  const controls = [...content.querySelectorAll(".list-filter")];
  for (const tbody of content.querySelectorAll("tbody")) {
    const rows = [...tbody.querySelectorAll("tr[data-search]")];
    let visible = 0;
    for (const row of rows) {
      let match = true;
      for (const control of controls) {
        const value = control.value.trim().toLocaleLowerCase("vi-VN");
        if (!value) continue;
        const key = control.dataset.filter;
        if (key === "search") match = match && row.dataset.search.includes(value);
        else if (key === "from") match = match && row.dataset.date >= value;
        else if (key === "to") match = match && row.dataset.date <= value;
        else match = match && (row.dataset[key] || "").toLocaleLowerCase("vi-VN") === value;
      }
      row.hidden = !match;
      if (match) visible++;
    }
    let empty = tbody.querySelector("[data-filter-empty]");
    if (rows.length && !visible) {
      if (!empty) {
        const count = tbody.closest("table").querySelectorAll("thead th").length;
        tbody.insertAdjacentHTML("beforeend", `<tr data-filter-empty><td colspan="${count}" class="empty-state">Không có dữ liệu phù hợp.</td></tr>`);
        empty = tbody.querySelector("[data-filter-empty]");
      }
    } else if (empty) empty.remove();
  }
}

function addToCart(state, HH_Ma, scanned = false, notify = true, unitFactor = 1, saleUnit = "") {
  const fail = (message) => {
    if (notify) toast(message, true);
    return { success: false, message };
  };
  if (!saleRoles.has(role)) return fail("Vai trò hiện tại chỉ được xem dữ liệu bán hàng.");
  const item = itemById(state, HH_Ma);
  const available = availableFor(state, HH_Ma);
  const packageUnit = getUnitPackage(item);
  if (unitFactor !== 1 && (!packageUnit || unitFactor !== packageUnit.ratio || saleUnit !== packageUnit.name)) {
    return fail("Đơn vị bán đã thay đổi. Hãy chọn lại đơn vị hiện hành.");
  }
  if (scanned && item && item.HH_TrangThai !== "Đang kinh doanh") return fail("Sản phẩm đã ngừng kinh doanh.");
  if (!item || item.HH_TrangThai !== "Đang kinh doanh" || !available) {
    if (scanned && item && item.HH_TrangThai === "Đang kinh doanh") {
      const warehouse = state.DiaDiem.find((row) => row.DD_Loai === "Kho" && row.DD_TrangThai === "Hoạt động");
      const warehouseQty = inventoryViewRoles.has(role) && warehouse ? getAvailableStock(warehouse.DD_Ma, HH_Ma, state) : 0;
      return fail(`Sản phẩm hiện đã hết hàng tại cửa hàng.${warehouseQty ? ` Kho trung tâm còn ${formatNumber(warehouseQty)}.` : ""}`);
    }
    if (notify) openStockAlert(state, HH_Ma);
    return { success: false, message: "Sản phẩm hiện đã hết hàng tại cửa hàng." };
  }
  const price = getActivePrice(HH_Ma, today(), state);
  if (price.error) return fail(scanned ? `${item.HH_Ten}: ${price.error}` : price.error);
  if (!Number.isSafeInteger(price.price * unitFactor)) return fail("Giá bán theo đơn vị đã chọn vượt giới hạn số chính xác.");
  const id = cartKey(HH_Ma, unitFactor);
  const currentRow = cart.get(id);
  const current = currentRow?.quantity || 0;
  const alreadyInBaseUnits = cartProductQuantity(HH_Ma);
  let baseQuantity;
  try { baseQuantity = toBaseQuantity(current + 1, unitFactor); }
  catch (error) { return fail(error.message); }
  if (alreadyInBaseUnits + unitFactor > available) return fail(`Không đủ tồn khả dụng. Cửa hàng chỉ còn ${formatNumber(Math.max(0, available - alreadyInBaseUnits))} ${item.HH_DVi}.`);
  const activeElement = document.activeElement;
  const restoreProductSearch = activeElement?.id === "product-search" || Boolean(activeElement?.closest("#product-suggestions"));
  const nextCart = new Map(cart);
  nextCart.set(id, currentRow
    ? { ...currentRow, quantity: current + 1 }
    : { HH_Ma, quantity: 1, unitFactor, saleUnit: saleUnit || item.HH_DVi, basePrice: price.price, unitPrice: price.price, productDiscount: null });
  try { updateCartPricing(nextCart); }
  catch (error) { return fail(error.message); }
  paymentAmountTouched = false;
  renderContent();
  if (scanned && notify) {
    document.querySelector("#barcode-input")?.focus();
    toast(`${item.HH_Ten} · ${formatNumber(current + 1)} ${saleUnit || item.HH_DVi} (${formatNumber(baseQuantity)} ${item.HH_DVi})`, false, 1600);
  } else if (restoreProductSearch) {
    document.querySelector("#product-search")?.focus();
  }
  if (current === 0) {
    document.querySelector(`[data-cart-item="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }
  return { success: true, item, quantity: current + 1, price: cart.get(id).unitPrice * unitFactor };
}

function handleBarcodeSubmit(event) {
  if (event.target.id !== "barcode-form") return;
  event.preventDefault();
  const input = event.target.querySelector("#barcode-input");
  const barcode = String(input.value || "").trim();
  input.value = "";
  if (!barcode) {
    input.focus();
    return;
  }
  const outcome = processBarcode(barcode);
  if (!outcome.success) input.focus();
}

function changeQuantity(state, cartId, quantity) {
  const value = Number(quantity);
  const row = cart.get(cartId);
  if (!row) return toast("Mặt hàng không còn trong giỏ.", true);
  const factor = row.unitFactor || 1;
  const available = availableFor(state, row.HH_Ma);
  if (!Number.isSafeInteger(value) || value <= 0) {
    toast("Số lượng phải là số nguyên lớn hơn 0.", true);
    renderContent();
    return;
  }
  let baseQuantity;
  try { baseQuantity = toBaseQuantity(value, factor); }
  catch (error) {
    toast(error.message, true);
    renderContent();
    return;
  }
  const otherInCart = cartProductQuantity(row.HH_Ma, cart, cartId);
  if (otherInCart + baseQuantity > available) {
    const remaining = Math.max(0, available - otherInCart);
    toast(`Số lượng vượt tồn có thể bán (${Math.floor(remaining / factor)} ${row.saleUnit || "đơn vị bán"} còn lại).`, true);
    renderContent();
    return;
  }
  const nextCart = new Map(cart);
  nextCart.set(cartId, { ...row, quantity: value });
  try { updateCartPricing(nextCart); }
  catch (error) {
    if (basketDiscount?.type !== "amount") {
      toast(error.message, true);
      return;
    }
    try {
      updateCartPricing(nextCart, null);
      toast("Đã cập nhật số lượng; chiết khấu toàn giỏ cố định được gỡ vì không còn phân bổ chính xác.", true);
    } catch (pricingError) {
      toast(pricingError.message, true);
      return;
    }
  }
  paymentAmountTouched = false;
  renderContent();
}

function revalidateCartForCheckout(state) {
  const changedPrices = [];
  const nextCart = new Map(cart);
  for (const [HH_Ma, quantity] of cartProductQuantities()) {
    const available = availableFor(state, HH_Ma);
    if (quantity > available) {
      const item = itemById(state, HH_Ma);
      toast(`${item?.HH_Ten || HH_Ma}: tồn khả dụng hiện còn ${formatNumber(available)} ${item?.HH_DVi || ""}, không đủ ${formatNumber(quantity)}.`, true);
      return false;
    }
  }
  for (const [cartId, row] of cart) {
    const item = itemById(state, row.HH_Ma);
    if (!item || item.HH_TrangThai !== "Đang kinh doanh") {
      toast(`${row.HH_Ma}: sản phẩm không còn được kinh doanh.`, true);
      return false;
    }
    if ((row.unitFactor || 1) > 1) {
      const currentPackage = getUnitPackage(item);
      if (!currentPackage || currentPackage.ratio !== row.unitFactor || currentPackage.name !== row.saleUnit) {
        toast(`${item.HH_Ten}: quy cách đóng gói đã thay đổi. Hãy xóa dòng này và thêm lại theo đơn vị hiện hành.`, true);
        return false;
      }
    }
    const currentPrice = getActivePrice(row.HH_Ma, today(), state);
    if (currentPrice.error) {
      toast(`${item.HH_Ten}: ${currentPrice.error}`, true);
      return false;
    }
    if (row.basePrice !== currentPrice.price) {
      changedPrices.push(`${item.HH_Ten}: ${formatCurrency(row.basePrice)} → ${formatCurrency(currentPrice.price)}`);
      nextCart.set(cartId, { ...row, basePrice: currentPrice.price });
    }
  }
  if (!changedPrices.length) return true;
  if (!confirm(`Giá hiện hành đã thay đổi:\n${changedPrices.join("\n")}\n\nCập nhật đơn giá cơ sở và tính lại chiết khấu? Sau đó vui lòng kiểm tra tổng mới rồi xác nhận lại.`)) return false;
  try {
    updateCartPricing(nextCart);
    paymentAmountTouched = false;
    renderContent();
    toast("Đã cập nhật giá và tổng tiền theo GiaBan hiện hành. Kiểm tra lại rồi nhấn THANH TOÁN.");
  } catch (error) {
    toast(`Không thể cập nhật giá/chiết khấu: ${error.message}`, true);
  }
  return false;
}

function openCustomerQuickForm() {
  if (!saleRoles.has(role)) return toast("Vai trò hiện tại không được tạo khách hàng.", true);
  const body = `<div class="form-error" id="customer-error"></div><form id="customer-form"><div class="form-grid two"><div class="field"><label>Tên khách hàng *</label><input name="DT_Ten" maxlength="120"><small class="field-validation-error" data-field-error="DT_Ten" aria-live="polite"></small></div><div class="field"><label>Số điện thoại</label><input name="DT_SDT" maxlength="20"><small class="field-validation-error" data-field-error="DT_SDT" aria-live="polite"></small></div><div class="field"><label>Địa chỉ</label><input name="DT_DChi" maxlength="200"><small class="field-validation-error" data-field-error="DT_DChi" aria-live="polite"></small></div></div></form>`;
  openModal("Tạo khách hàng nhanh", body, `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="customer-form" type="submit">Lưu khách hàng</button>`);
}

function openPayInvoice(state, id) {
  const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === id);
  if (!invoice || getInvoiceOutstanding(id, state) <= 0) return toast("Hóa đơn không còn khoản phải thu.", true);
  openPaymentForm(state, id);
}

function showError(message, target = "#form-error") {
  const node = document.querySelector(target);
  if (node) {
    node.textContent = message;
    node.classList.add("visible");
  } else toast(message, true);
}

function setCustomerFieldErrors(form, errors = {}, generalMessage = "") {
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
  const errorNode = form.querySelector("#customer-error");
  if (errorNode) {
    const message = [generalMessage, ...unbound].filter(Boolean).join(" ");
    errorNode.textContent = message;
    errorNode.classList.toggle("visible", Boolean(message));
  }
}

function refreshCustomerValidation(form, changedField = "") {
  const serverErrors = JSON.parse(form.dataset.serverFieldErrors || "{}");
  if (changedField) delete serverErrors[changedField];
  form.dataset.serverFieldErrors = JSON.stringify(serverErrors);
  form.dataset.serverGeneralError = "";
  const values = Object.fromEntries(new FormData(form).entries());
  const localErrors = validatePartnerData({
    ...values,
    DT_Ma: form.dataset.id || "",
    DT_Loai: "Khách hàng",
    DT_TrangThai: values.DT_TrangThai || "Hoạt động"
  }, getState().DoiTacKinhDoanh);
  setCustomerFieldErrors(form, { ...serverErrors, ...localErrors }, form.dataset.serverGeneralError);
}

function handleClick(event) {
  const navigationLink = event.target.closest("#app a[href]");
  if (page === "pos" && navigationLink && cart.size && navigationLink.href !== window.location.href) {
    event.preventDefault();
    if (!confirm("Giỏ hàng đang có sản phẩm. Lưu tạm trước khi rời POS?")) return;
    if (saveCurrentDraft()) window.location.href = navigationLink.href;
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === "open-cash-shift") return openCashShiftForm(getState());
  if (action === "view-cash-shift") return viewCashShift(getState(), id);
  if (action === "close-cash-shift") return closeCashShiftForm(getState(), id);
  if (action === "respond-cash-shift") {
    const shift = getCashShift(id);
    if (!shift) return toast("Không tìm thấy ca bán hàng.", true);
    openModal(`Bổ sung giải trình ${id}`, `<div class="form-error" id="cash-shift-error"></div><div class="info-box">${esc(shift.GhiChuKeToan || "Kế toán chưa nêu nội dung yêu cầu.")}</div>
      <form id="cash-shift-explanation-form" data-id="${esc(id)}"><div class="field"><label>Giải trình bổ sung *</label><textarea name="explanation" rows="4" required maxlength="500"></textarea></div></form>`,
    `<button class="button" data-action="close-modal">Hủy</button><button class="button button-primary" form="cash-shift-explanation-form" type="submit">Gửi giải trình</button>`);
    return;
  }
  if (action === "print-cash-shift") return window.print();
  if (action === "open-camera") return openCameraScanner();
  if (action === "camera-toggle") {
    if (cameraRunning) {
      cameraProcessing = true;
      cameraStatus("Camera đã tắt.");
      button.disabled = true;
      button.textContent = "Đang tắt...";
      stopCameraFeed().then(() => {
        cameraProcessing = false;
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = "Bật camera";
        }
      });
    } else startCameraScanner();
    return;
  }
  if (action === "camera-continue") {
    const result = document.querySelector("#camera-scan-result");
    if (result) result.hidden = true;
    const toggle = document.querySelector('[data-action="camera-toggle"]');
    if (toggle) {
      toggle.hidden = false;
      toggle.textContent = "Tắt camera";
    }
    button.hidden = true;
    return startCameraScanner();
  }
  if (action === "select-product") {
    const previousQuery = productQuery;
    const state = getState();
    const item = itemById(state, id);
    if (!item) return toast("Không tìm thấy sản phẩm.", true);
    if (getUnitPackage(item)) {
      productQuery = previousQuery;
      return openSaleUnitPicker(state, item);
    }
    productQuery = "";
    const outcome = addToCart(state, id);
    if (outcome.success) {
      if (button.closest("#modal-host")) closeModal();
      document.querySelector("#product-search")?.focus();
    } else productQuery = previousQuery;
    return;
  }
  if (action === "select-sale-unit") {
    const modal = button.closest(".modal");
    const scanned = modal?.dataset.scanned === "true";
    const outcome = addToCart(getState(), id, scanned, true, Number(button.dataset.factor), button.dataset.unit || "");
    if (!outcome.success) return;
    closeModal();
    document.querySelector(scanned ? "#barcode-input" : "#product-search")?.focus();
    return;
  }
  if (action === "select-camera-unit") {
    const outcome = addToCart(getState(), id, true, false, Number(button.dataset.factor), button.dataset.unit || "");
    if (!outcome.success) {
      cameraStatus(outcome.message || "Không thể thêm sản phẩm vào giỏ.", true);
      return;
    }
    const result = document.querySelector("#camera-scan-result");
    if (result) result.textContent = `${outcome.item.HH_Ten} · ${formatNumber(outcome.quantity)} ${button.dataset.unit} · ${formatCurrency(outcome.price)}`;
    cameraStatus("Quét thành công. Camera đã tắt để tránh quét lặp.");
    const continueButton = document.querySelector('[data-action="camera-continue"]');
    const toggle = document.querySelector('[data-action="camera-toggle"]');
    if (continueButton) continueButton.hidden = false;
    if (toggle) toggle.hidden = true;
    toast(`${outcome.item.HH_Ten} · ${formatNumber(outcome.quantity)} ${button.dataset.unit}`, false, 1800);
    return;
  }
  if (action === "select-customer") {
    selectedCustomer = id;
    customerQuery = "";
    renderContent();
    return;
  }
  if (action === "clear-customer") {
    selectedCustomer = "";
    customerQuery = "";
    allowCredit = false;
    renderContent();
    return;
  }
  if (action === "clear-cart") {
    if (!cart.size) return;
    if (!confirm("Làm mới giỏ hàng? Tất cả mặt hàng hiện tại sẽ bị xóa.")) return;
    cart.clear();
    basketDiscount = null;
    activeDraftId = "";
    paymentAmount = 0;
    paymentAmountTouched = false;
    allowCredit = false;
    renderContent();
    document.querySelector("#product-search")?.focus();
    return;
  }
  let state;
  try { state = getState(); } catch (error) { return toast(error.message, true); }

  if (action === "close-modal") return closeModal();
  if (action === "backdrop-close" && event.target === button) return closeModal();
  if (action === "save-draft") return saveCurrentDraft();
  if (action === "list-drafts") {
    try { return draftListModal(state); }
    catch (error) { return toast(error.message || "Không thể tải danh sách hóa đơn nháp.", true); }
  }
  if (action === "open-discount") return openDiscountModal(state);
  if (action === "discount-line") return openDiscountModal(state, "product", id);
  if (action === "restore-draft") {
    try { return restoreDraft(state, id); }
    catch (error) { return toast(error.message || "Không thể khôi phục hóa đơn nháp.", true); }
  }
  if (action === "delete-draft") {
    if (!confirm(`Xóa hóa đơn nháp ${id}? Hành động này không ảnh hưởng tồn kho hoặc thanh toán.`)) return;
    try {
      deleteDraftInvoice(id, role);
      if (activeDraftId === id) activeDraftId = "";
      draftListModal(getState());
      toast(`Đã xóa hóa đơn nháp ${id}.`);
    } catch (error) { toast(error.message || "Không thể xóa hóa đơn nháp.", true); }
    return;
  }
  if (action === "remove-discount") return removeDiscountFromModal();
  if (action === "clear-filters") {
    document.querySelectorAll(".list-filter").forEach((control) => { control.value = ""; });
    applyFilters();
  } else if (action === "clear-dashboard") {
    dashboardFrom = "";
    dashboardTo = "";
    renderContent();
  } else if (action === "reset") {
    if (!confirm("Khôi phục dữ liệu demo dùng chung cho Kho và Bán hàng? Thay đổi hiện có sẽ bị xóa.")) return;
    resetDemoData();
    cart.clear();
    basketDiscount = null;
    activeDraftId = "";
    selectedCustomer = "";
    paymentAmount = null;
    paymentAmountTouched = false;
    allowCredit = false;
    renderContent();
    closeModal();
    toast("Đã khôi phục dữ liệu demo dùng chung.");
  } else if (action === "add-product") addToCart(state, id);
  else if (action === "remove-product") {
    const nextCart = new Map(cart);
    nextCart.delete(id);
    try { updateCartPricing(nextCart); }
    catch (error) {
      if (basketDiscount?.type !== "amount") return toast(error.message, true);
      updateCartPricing(nextCart, null);
      toast("Đã xóa mặt hàng; chiết khấu toàn giỏ cố định được gỡ vì không còn phân bổ chính xác.", true);
    }
    paymentAmountTouched = false;
    renderContent();
  } else if (action === "increase-quantity") changeQuantity(state, id, (cart.get(id)?.quantity || 0) + 1);
  else if (action === "decrease-quantity") {
    const quantity = (cart.get(id)?.quantity || 0) - 1;
    if (quantity > 0) return changeQuantity(state, id, quantity);
    const nextCart = new Map(cart);
    nextCart.delete(id);
    try { updateCartPricing(nextCart); }
    catch (error) {
      if (basketDiscount?.type !== "amount") return toast(error.message, true);
      updateCartPricing(nextCart, null);
      toast("Đã xóa mặt hàng; chiết khấu toàn giỏ cố định được gỡ vì không còn phân bổ chính xác.", true);
    }
    paymentAmountTouched = false;
    renderContent();
  } else if (action === "checkout") {
    if (!cart.size) return toast("Giỏ hàng đang trống.", true);
    if (!saleRoles.has(role)) return toast("Vai trò hiện tại không được xác nhận hóa đơn.", true);
    if (!revalidateCartForCheckout(getState())) return;
    if (!confirm("Xác nhận bán hàng? Hệ thống sẽ kiểm tra lại giá, HSD và tồn tại cửa hàng.")) return;
    try {
      const invoiceId = createInvoice({
        BH_Ma: activeDraftId,
        DD_Ma: locationId,
        NV_Ma: roleEmployees[role],
        DT_Ma: selectedCustomer || null,
        lines: [...cart.values()].map((row) => ({ HH_Ma: row.HH_Ma, BH_SL: cartBaseQuantity(row), BH_DonGia: row.unitPrice, GB_GiaGoc: row.basePrice })),
        payment: paymentMethod === "Kết hợp"
          ? { allocations: Object.entries(paymentSplits).map(([method, amount]) => ({ method, amount: Number(amount || 0) })) }
          : { amount: paymentMethod === "Tiền mặt" ? Math.min(Number(paymentAmount || 0), cartTotal(getState())) : Number(paymentAmount || 0), method: paymentMethod },
        allowCredit,
        role
      });
      cart.clear();
      basketDiscount = null;
      activeDraftId = "";
      paymentAmount = null;
      paymentAmountTouched = false;
      paymentSplits = { "Tiền mặt": 0, "Chuyển khoản": 0, QR: 0 };
      allowCredit = false;
      renderContent();
      toast(`Đã xác nhận bán ${invoiceId}. Tồn và biến động kho đã cập nhật.`);
      viewInvoice(getState(), invoiceId);
    } catch (error) {
      toast(error.message || "Không thể xác nhận hóa đơn.", true);
    }
  } else if (action === "view-invoice") viewInvoice(state, id);
  else if (action === "print-invoice") window.print();
  else if (action === "new-payment") openPaymentForm(state);
  else if (action === "pay-invoice") openPayInvoice(state, id);
  else if (action === "confirm-payment") {
    if (!confirm(`Xác nhận giao dịch ${id} thành công? Chỉ thực hiện sau khi đã đối chiếu thực tế.`)) return;
    try { confirmPayment(id, role); renderContent(); toast(`Đã xác nhận thanh toán ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "fail-payment") {
    if (!confirm(`Đánh dấu giao dịch ${id} thất bại?`)) return;
    try { setPaymentStatus(id, "Thất bại", role); renderContent(); toast(`Đã cập nhật giao dịch ${id}.`); }
    catch (error) { toast(error.message, true); }
  } else if (action === "new-customer") customerForm(state);
  else if (action === "quick-customer") openCustomerQuickForm();
  else if (action === "edit-customer") customerForm(state, id);
  else if (action === "view-customer") viewCustomer(state, id);
}

async function handleSubmit(event) {
  const form = event.target;
  if (form.id === "barcode-form") return handleBarcodeSubmit(event);
  if (form.id === "product-search-form") {
    event.preventDefault();
    try { openProductSearch(getState()); }
    catch (error) { toast(error.message || "Không thể tìm sản phẩm.", true); }
    return;
  }
  if (form.id === "discount-form") {
    event.preventDefault();
    try { applyDiscountForm(form); }
    catch (error) { showError(error.message, "#discount-error"); }
    return;
  }
  if (form.id === "cash-shift-open-form") {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const shiftId = openCashShift({
        employeeId: roleEmployees[role], locationId: values.locationId,
        openingCash: values.openingCash, note: values.note
      }, role);
      locationId = values.locationId;
      localStorage.setItem("stmn-kho-demo-sales-location", locationId);
      const locationSelect = document.querySelector("#sales-location");
      if (locationSelect) locationSelect.value = locationId;
      closeModal();
      renderContent();
      toast(`Đã mở ca ${shiftId}.`);
    } catch (error) { showError(error.message, "#cash-shift-error"); }
    return;
  }
  if (form.id === "cash-shift-close-form") {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const shiftId = submitCashShift(form.dataset.id, values, role, roleEmployees[role]);
      closeModal();
      renderContent();
      toast(`Đã gửi ca ${shiftId} chờ Kế toán đối soát.`);
    } catch (error) { showError(error.message, "#cash-shift-error"); }
    return;
  }
  if (form.id === "cash-shift-explanation-form") {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const shiftId = respondCashShiftExplanation(form.dataset.id, values.explanation, role, roleEmployees[role]);
      closeModal();
      renderContent();
      toast(`Đã gửi bổ sung giải trình ca ${shiftId}.`);
    } catch (error) { showError(error.message, "#cash-shift-error"); }
    return;
  }
  if (!["payment-form", "customer-form"].includes(form.id)) return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form).entries());
  if (form.id === "customer-form") {
    form.dataset.validationAttempted = "true";
    form.dataset.serverFieldErrors = "{}";
    form.dataset.serverGeneralError = "";
    const errors = validatePartnerData({
      ...values,
      DT_Ma: form.dataset.id || "",
      DT_Loai: "Khách hàng",
      DT_TrangThai: values.DT_TrangThai || "Hoạt động"
    }, getState().DoiTacKinhDoanh);
    setCustomerFieldErrors(form, errors);
    if (Object.keys(errors).length) return;
  }
  try {
    if (form.id === "payment-form") {
      const paymentId = recordPayment(values.BH_Ma, {
        amount: values.amount, method: values.method, role,
        cashierId: roleEmployees[role], locationId
      });
      closeModal();
      renderContent();
      toast(`Đã ghi nhận giao dịch ${paymentId}.`);
    } else {
      const customerId = await saveCustomer({ ...values, DT_Ma: form.dataset.id || "", role });
      closeModal();
      if (page === "pos") {
        selectedCustomer = customerId;
        customerQuery = "";
        renderContent();
      } else renderContent();
      toast(`Đã lưu hồ sơ khách hàng ${customerId}.`);
    }
  } catch (error) {
    if (form.id === "customer-form") {
      const fieldErrors = error.fieldErrors || {};
      form.dataset.serverFieldErrors = JSON.stringify(fieldErrors);
      form.dataset.serverGeneralError = Object.keys(fieldErrors).length ? "" : error.message || "Không thể lưu dữ liệu.";
      setCustomerFieldErrors(form, fieldErrors, form.dataset.serverGeneralError);
    } else {
      showError(error.message || "Không thể lưu dữ liệu.", "#payment-error");
    }
  }
}

function handleInput(event) {
  const target = event.target;
  const customerForm = target.closest("#customer-form");
  if (customerForm && customerForm.dataset.validationAttempted === "true") {
    refreshCustomerValidation(customerForm, target.name);
  }
  if (target.closest("#discount-form")) refreshDiscountPreview();
  if (target.id === "product-search") refreshProductSuggestions();
  if (target.id === "customer-search") refreshCustomerSuggestions();
  if (target.id === "product-dialog-search") {
    const query = target.value.trim().toLocaleLowerCase("vi-VN");
    const rows = [...document.querySelectorAll(".product-dialog-results [data-search]")];
    rows.forEach((row) => {
      row.hidden = Boolean(query && !row.dataset.search.includes(query));
    });
    const noMatches = document.querySelector("[data-search-empty]");
    if (noMatches) noMatches.hidden = rows.some((row) => !row.hidden);
  }
  if (target.id === "draft-list-search") {
    const query = target.value.trim().toLocaleLowerCase("vi-VN");
    document.querySelectorAll("[data-draft-row]").forEach((row) => {
      row.hidden = Boolean(query && !row.dataset.search.includes(query));
    });
  }
  if (target.matches("[data-cart-quantity]")) {
    target.dataset.changed = "true";
  }
  if (target.id === "pos-payment-amount") {
    paymentAmountTouched = true;
    paymentAmount = Number(target.value);
    const total = cartTotal(getState());
    const invalid = !Number.isSafeInteger(paymentAmount) || paymentAmount < 0 || (paymentMethod !== "Tiền mặt" && paymentAmount > total);
    const difference = Math.abs(total - paymentAmount);
    const balance = document.querySelector(".payment-balance");
    if (balance) {
      balance.classList.toggle("invalid", invalid);
      balance.querySelector("span").textContent = invalid ? !Number.isSafeInteger(paymentAmount) || paymentAmount < 0 ? "Số tiền không hợp lệ" : "Vượt mức thanh toán" : paymentMethod === "Tiền mặt" && paymentAmount > total ? "Tiền thừa" : "Còn phải thu";
      balance.querySelector("strong").textContent = formatCurrency(paymentMethod === "Tiền mặt" ? difference : Math.max(0, total - paymentAmount));
    }
    const checkout = document.querySelector('[data-action="checkout"]');
    const state = getState();
    const hasShortage = [...cartProductQuantities().entries()].some(([HH_Ma, quantity]) => quantity > availableFor(state, HH_Ma));
    const currentShift = getOpenCashShift(roleEmployees[role], locationId);
    if (checkout) checkout.disabled = !cart.size || hasShortage || !saleRoles.has(role) || !currentShift || invalid || (paymentMethod !== "Tiền mặt" || paymentAmount < total) && (!selectedCustomer || !allowCredit || !accountingRoles.has(role));
  }
  if (target.matches("[data-payment-split]")) {
    paymentSplits[target.dataset.paymentSplit] = target.value === "" ? 0 : Number(target.value);
    const state = getState();
    const total = cartTotal(state);
    const splitTotal = Object.values(paymentSplits).reduce((sum, amount) => sum + Number(amount || 0), 0);
    const invalid = Object.values(paymentSplits).some((amount) => !Number.isSafeInteger(Number(amount)) || Number(amount) < 0) || splitTotal > total;
    const balance = document.querySelector(".payment-balance");
    if (balance) {
      balance.classList.toggle("invalid", invalid);
      balance.querySelector("span").textContent = invalid ? "Tổng phân bổ thanh toán không hợp lệ" : "Còn phải thu";
      balance.querySelector("strong").textContent = formatCurrency(Math.max(0, total - splitTotal));
    }
    const hasShortage = [...cartProductQuantities().entries()].some(([HH_Ma, quantity]) => quantity > availableFor(state, HH_Ma));
    const currentShift = getOpenCashShift(roleEmployees[role], locationId);
    const checkout = document.querySelector('[data-action="checkout"]');
    if (checkout) checkout.disabled = !cart.size || hasShortage || !saleRoles.has(role) || !currentShift || invalid || (total > splitTotal && (!selectedCustomer || !allowCredit || !accountingRoles.has(role)));
  }
  if (target.matches("#cash-shift-close-form [name='countedCash']")) {
    const shift = getCashShift(target.form.dataset.id);
    const preview = document.querySelector("#cash-shift-preview");
    if (shift && preview) {
      const counted = Number(target.value);
      const variance = counted - calculateCashShift(shift).expectedCash;
      preview.textContent = Number.isSafeInteger(counted)
        ? `Tiền dự kiến: ${formatCurrency(calculateCashShift(shift).expectedCash)} · Chênh lệch: ${formatCurrency(variance)}${variance ? " · Cần giải trình" : ""}`
        : "Tiền thực đếm phải là số nguyên VND.";
      preview.classList.toggle("info-warning", variance !== 0 || !Number.isSafeInteger(counted));
    }
  }
  if (target.matches(".list-filter")) applyFilters();
}

function handleChange(event) {
  const target = event.target;
  if (target.id === "camera-select") {
    const session = cameraSession;
    cameraProcessing = true;
    stopCameraFeed().then(() => {
      cameraProcessing = false;
      startCameraScanner(session);
    });
  } else if (target.id === "sales-location") {
    const nextLocation = target.value;
    const activeShift = getOpenCashShift(roleEmployees[role]);
    if (activeShift && activeShift.DD_Ma !== nextLocation) {
      target.value = locationId;
      toast(`Ca ${activeShift.Ca_Ma} đang mở tại ${locationName(getState(), activeShift.DD_Ma)}. Hãy kết ca trước khi đổi cửa hàng.`, true);
      return;
    }
    if (activeDraftId) {
      target.value = locationId;
      toast("Hãy hoàn tất, lưu tạm hoặc bỏ chỉnh sửa hóa đơn nháp trước khi đổi cửa hàng.", true);
      return;
    }
    if (cart.size) {
      if (confirm("Lưu tạm giỏ hàng tại cửa hàng hiện tại trước khi đổi địa điểm?")) {
        if (!saveCurrentDraft()) { target.value = locationId; return; }
      } else if (confirm("Bỏ giỏ hàng hiện tại và tiếp tục đổi địa điểm?")) {
        cart.clear();
        basketDiscount = null;
        selectedCustomer = "";
      } else { target.value = locationId; return; }
    }
    locationId = nextLocation;
    localStorage.setItem("stmn-kho-demo-sales-location", locationId);
    renderContent();
  } else if (target.id === "pos-customer") {
    selectedCustomer = target.value;
  } else if (target.id === "product-dialog-search") {
    handleInput(event);
  } else if (target.closest("#discount-form")) {
    refreshDiscountPreview();
  } else if (target.id === "pos-method") {
    paymentMethod = target.value;
    renderContent();
  } else if (target.matches("[data-payment-split]")) {
    paymentSplits[target.dataset.paymentSplit] = target.value === "" ? 0 : Number(target.value);
    renderContent();
  } else if (target.id === "allow-credit") {
    allowCredit = target.checked;
  } else if (target.matches("[data-cart-quantity]")) {
    const state = getState();
    changeQuantity(state, target.dataset.cartQuantity, target.value);
  } else if (target.matches("[data-dashboard-date]")) {
    if (target.dataset.dashboardDate === "from") dashboardFrom = target.value;
    else dashboardTo = target.value;
    renderContent();
  } else if (target.matches("#payment-form [name='BH_Ma']")) {
    const due = Number(target.selectedOptions[0]?.dataset.due || 0);
    const amount = document.querySelector("#payment-form [name='amount']");
    amount.max = String(due);
    document.querySelector("#payment-due").value = formatCurrency(due);
  } else if (target.matches(".list-filter")) applyFilters();
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    if (document.querySelector("#modal-host .modal")) closeModal();
    return;
  }
  if (page !== "pos" || document.querySelector("#modal-host .modal")) return;
  if (event.key === "F3") {
    event.preventDefault();
    document.querySelector("#product-search")?.focus();
  } else if (event.key === "F9") {
    event.preventDefault();
    document.querySelector('[data-action="checkout"]')?.click();
  } else if (event.key === "Enter" && event.target.id === "product-search") {
    const firstResult = document.querySelector("#product-suggestions [data-action='select-product']");
    if (firstResult) {
      event.preventDefault();
      firstResult.click();
    }
  } else if (event.key === "Enter" && event.target.id === "customer-search") {
    const firstResult = document.querySelector("#customer-suggestions [data-action='select-customer']");
    if (firstResult) {
      event.preventDefault();
      firstResult.click();
    }
  } else if (event.key === "Enter" && event.target.id === "product-dialog-search") {
    const firstResult = [...document.querySelectorAll(".product-dialog-results [data-action='select-product']")].find((row) => !row.hidden);
    if (firstResult) {
      event.preventDefault();
      firstResult.click();
    }
  }
}

window.addEventListener("pagehide", disposeCameraScanner);
window.addEventListener("beforeunload", disposeCameraScanner);
document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
document.addEventListener("input", handleInput);
document.addEventListener("change", handleChange);
document.addEventListener("keydown", handleKeydown);

try {
  shell();
} catch (error) {
  document.querySelector("#app").innerHTML = `<main class="content"><div class="warning-box">${esc(error.message || "Không thể tải phân hệ bán hàng.")}</div><button class="button button-primary" id="restore-data">Khôi phục dữ liệu demo</button></main>`;
  document.querySelector("#restore-data").addEventListener("click", () => {
    try { resetDemoData(); location.reload(); }
    catch (restoreError) { toast(restoreError.message, true); }
  });
}
