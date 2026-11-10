import { DEMO_THRESHOLD_DAYS } from "../data/kho-mock-data.js";
import { getAccountingDashboard, getAccountingReports, getPaymentReconciliation, getSalesRevenueReconciliation } from "./accounting-service.js";
import { getActivePrice, getInventoryPosition, getReplenishmentItems } from "./inventory-service.js";
import { approveCount, generateDemoId, getState, runDemoTransaction } from "./kho-service.js";
import { normalizeUnitPackage } from "./unit-service.js";
import { savePartnerRecord, validatePartnerData } from "./customer-service.js";

const OWNER = "Chủ cửa hàng";
const ACTIVE_PRICE_STATUSES = new Set(["Đang áp dụng", "Có hiệu lực", "Đang hiệu lực"]);
const dateOnly = (value) => String(value || "").slice(0, 10);
const activeInvoice = (invoice) => invoice.BH_TrangThai === "Đã xác nhận";
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const shiftDate = (value, days) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

function assertOwner(role) {
  if (role !== OWNER) throw new Error("Chỉ chủ cửa hàng được thực hiện thao tác này.");
}

function nextKey(state, table, field, prefix) {
  return generateDemoId(prefix, state[table], field);
}

function requireText(value, label) {
  if (!String(value || "").trim()) throw new Error(`${label} không được để trống.`);
  return String(value).trim();
}

function validateUnique(state, table, key, value, label, exceptKey = "", exceptValue = "") {
  const normalized = String(value || "").trim().toLocaleLowerCase("vi-VN");
  if (state[table].some((row) => row[exceptKey] !== exceptValue && String(row[key] || "").trim().toLocaleLowerCase("vi-VN") === normalized)) {
    throw new Error(`${label} đã tồn tại.`);
  }
}

export function saveEmployee(input, role = "") {
  assertOwner(role);
  return runDemoTransaction((state) => {
    const name = requireText(input.NV_Ten, "Họ tên");
    const id = input.NV_Ma || nextKey(state, "NhanVien", "NV_Ma", "NV");
    const existing = state.NhanVien.find((row) => row.NV_Ma === id);
    if (input.NV_Ma && !existing) throw new Error("Không thể thay đổi mã nhân viên hoặc tạo lại mã đã tồn tại.");
    if (input.NV_SDT) validateUnique(state, "NhanVien", "NV_SDT", input.NV_SDT, "Số điện thoại", "NV_Ma", id);
    const record = {
      NV_Ma: id, NV_Ten: name, NV_SDT: String(input.NV_SDT || "").trim(),
      NV_DChi: String(input.NV_DChi || "").trim(), NV_NgaySinh: input.NV_NgaySinh || "",
      NV_GioiTinh: input.NV_GioiTinh || "", NV_NgayVaoLam: input.NV_NgayVaoLam || new Date().toISOString().slice(0, 10),
      NV_TrangThai: input.NV_TrangThai === "Nghỉ việc" ? "Nghỉ việc" : "Đang làm"
    };
    if (existing) Object.assign(existing, record);
    else state.NhanVien.push(record);
    return id;
  });
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function passwordVerifier(username, password) {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("Trình duyệt không hỗ trợ Web Crypto; không thể tạo thông tin xác minh mật khẩu.");
  }
  const iterations = 150000;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(`${username}:${toHex(salt)}`), iterations, hash: "SHA-256" },
    key,
    256
  );
  return `pbkdf2-sha256$${iterations}$${toHex(salt)}$${toHex(bits)}`;
}

export async function saveAccount(input, role = "") {
  assertOwner(role);
  const username = requireText(input.TK_TenDangNhap, "Tên đăng nhập");
  const verifier = input.password ? await passwordVerifier(username, String(input.password)) : "";
  if (!input.TK_Ma && !verifier) throw new Error("Nhập mật khẩu khởi tạo để tạo tài khoản.");
  return runDemoTransaction((state) => {
    const employee = state.NhanVien.find((row) => row.NV_Ma === input.NV_Ma);
    const account = state.TaiKhoan.find((row) => row.TK_Ma === input.TK_Ma);
    if (!employee) throw new Error("Nhân viên không tồn tại.");
    if (employee.NV_TrangThai === "Nghỉ việc" && !account) throw new Error("Không thể tạo tài khoản cho nhân viên đã nghỉ việc.");
    if (state.TaiKhoan.some((row) => row.NV_Ma === employee.NV_Ma && row.TK_Ma !== input.TK_Ma)) {
      throw new Error("Nhân viên này đã có tài khoản.");
    }
    validateUnique(state, "TaiKhoan", "TK_TenDangNhap", username, "Tên đăng nhập", "TK_Ma", input.TK_Ma);
    if (!state.VaiTro.some((row) => row.VT_Ma === input.VT_Ma)) throw new Error("Vai trò không hợp lệ.");
    if (account) {
      if (account.TK_TenDangNhap !== username && !verifier) throw new Error("Đổi tên đăng nhập cần nhập mật khẩu mới để tạo lại chuỗi xác minh.");
      account.NV_Ma = employee.NV_Ma;
      account.TK_TenDangNhap = username;
      account.VT_Ma = input.VT_Ma;
      account.TK_TrangThai = input.TK_TrangThai === "Khóa" ? "Khóa" : "Hoạt động";
      if (verifier) account.TK_MatKhau = verifier;
      return account.TK_Ma;
    }
    const id = nextKey(state, "TaiKhoan", "TK_Ma", "TK");
    state.TaiKhoan.push({
      TK_Ma: id, NV_Ma: employee.NV_Ma, TK_TenDangNhap: username,
      TK_MatKhau: verifier, VT_Ma: input.VT_Ma, TK_TrangThai: "Hoạt động"
    });
    return id;
  });
}

export function saveCategory(input, role = "") {
  assertOwner(role);
  return runDemoTransaction((state) => {
    const name = requireText(input.DM_Ten, "Tên danh mục");
    const id = input.DM_Ma || nextKey(state, "DanhMuc", "DM_Ma", "DM");
    validateUnique(state, "DanhMuc", "DM_Ten", name, "Tên danh mục", "DM_Ma", id);
    const record = { DM_Ma: id, DM_Ten: name, DM_MoTa: String(input.DM_MoTa || "").trim() };
    const existing = state.DanhMuc.find((row) => row.DM_Ma === id);
    if (existing) Object.assign(existing, record);
    else state.DanhMuc.push(record);
    return id;
  });
}

export function saveProduct(input, role = "") {
  assertOwner(role);
  return runDemoTransaction((state) => {
    const name = requireText(input.HH_Ten, "Tên hàng hóa");
    if (!state.DanhMuc.some((row) => row.DM_Ma === input.DM_Ma)) throw new Error("Danh mục không hợp lệ.");
    const id = input.HH_Ma || nextKey(state, "HangHoa", "HH_Ma", "HH");
    const barcode = String(input.HH_MaVach || "").trim();
    if (barcode.length > 32) throw new Error("Mã vạch không được dài quá 32 ký tự.");
    if (barcode && state.HangHoa.some((row) => row.HH_Ma !== id && String(row.HH_MaVach || "").trim() === barcode)) {
      throw new Error("Mã vạch này đã được sử dụng cho một mặt hàng khác.");
    }
    validateUnique(state, "HangHoa", "HH_Ten", name, "Tên hàng hóa", "HH_Ma", id);
    const unitPackage = normalizeUnitPackage(input.HH_DViDongGoi, input.HH_TyLeQuyDoi);
    const existing = state.HangHoa.find((row) => row.HH_Ma === id);
    if (existing) {
      const currentName = String(existing.HH_DViDongGoi || "").trim();
      const currentRatio = existing.HH_TyLeQuyDoi === null || existing.HH_TyLeQuyDoi === undefined
        ? null : Number(existing.HH_TyLeQuyDoi);
      const changed = String(existing.HH_DVi || "").trim() !== String(input.HH_DVi || "").trim()
        || currentName !== (unitPackage.HH_DViDongGoi || "")
        || currentRatio !== unitPackage.HH_TyLeQuyDoi;
      if (changed && hasProductUnitHistory(state, id) && input.HH_ConfirmUnitChange !== true && input.HH_ConfirmUnitChange !== "true") {
        throw new Error("Hàng hóa đã có chứng từ nhập, bán hoặc hóa đơn nháp. Cần xác nhận thay đổi quy cách để tránh diễn giải sai dữ liệu lịch sử.");
      }
    }
    const record = {
      HH_Ma: id, DM_Ma: input.DM_Ma, HH_MaVach: barcode, HH_Ten: name,
      HH_DVi: requireText(input.HH_DVi, "Đơn vị tính"), HH_Hinh: String(input.HH_Hinh || "").trim(),
      ...unitPackage,
      HH_TrangThai: input.HH_TrangThai === "Ngừng kinh doanh" ? "Ngừng kinh doanh" : "Đang kinh doanh"
    };
    if (existing) Object.assign(existing, record);
    else state.HangHoa.push(record);
    return id;
  });
}

export function hasProductUnitHistory(state, HH_Ma) {
  const receiptHistory = state.PhieuNhapChiTiet.some((line) => line.HH_Ma === HH_Ma);
  if (receiptHistory) return true;
  const itemLots = new Set(state.PhieuNhapChiTiet.filter((line) => line.HH_Ma === HH_Ma).map((line) => line.PNCT_Ma));
  return state.HoaDonBanHangChiTiet.some((line) => itemLots.has(line.PNCT_Ma));
}

export function savePrice(input, role = "") {
  assertOwner(role);
  return runDemoTransaction((state) => {
    const item = state.HangHoa.find((row) => row.HH_Ma === input.HH_Ma);
    if (!item) throw new Error("Mặt hàng không tồn tại.");
    const amount = Number(input.GB_DonGia);
    const start = dateOnly(input.GB_NgayBD);
    const end = dateOnly(input.GB_NgayKT);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Giá bán phải là số nguyên không âm.");
    if (!validDate(start) || (end && (!validDate(end) || end < start))) throw new Error("Ngày hiệu lực không hợp lệ hoặc ngày kết thúc trước ngày bắt đầu.");
    const id = input.GB_Ma || nextKey(state, "GiaBan", "GB_Ma", "GB");
    const status = input.GB_TrangThai === "Ngừng áp dụng" ? "Ngừng áp dụng" : "Đang áp dụng";
    const overlaps = (left, right) => dateOnly(left.GB_NgayBD) <= (right.GB_NgayKT || "9999-12-31")
      && dateOnly(right.GB_NgayBD) <= (left.GB_NgayKT || "9999-12-31");
    const candidate = { GB_Ma: id, HH_Ma: item.HH_Ma, GB_DonGia: amount, GB_NgayBD: start, GB_NgayKT: end, GB_TrangThai: status };
    if (ACTIVE_PRICE_STATUSES.has(status)) {
      for (const previous of state.GiaBan.filter((row) => row.HH_Ma === item.HH_Ma && row.GB_Ma !== id && ACTIVE_PRICE_STATUSES.has(row.GB_TrangThai))) {
        if (!overlaps(previous, candidate)) continue;
        if (dateOnly(previous.GB_NgayBD) < start) {
          previous.GB_NgayKT = shiftDate(start, -1);
        } else {
          throw new Error(`Khoảng giá bị chồng với ${previous.GB_Ma}; hãy điều chỉnh ngày hiệu lực.`);
        }
      }
    }
    const existing = state.GiaBan.find((row) => row.GB_Ma === id);
    if (existing) Object.assign(existing, candidate);
    else state.GiaBan.push(candidate);
    return id;
  });
}

export function endPrice(GB_Ma, endDate, role = "") {
  assertOwner(role);
  return runDemoTransaction((state) => {
    const price = state.GiaBan.find((row) => row.GB_Ma === GB_Ma);
    const end = dateOnly(endDate);
    if (!price || !validDate(end) || end < dateOnly(price.GB_NgayBD)) throw new Error("Giá bán hoặc ngày kết thúc không hợp lệ.");
    price.GB_NgayKT = end;
    return GB_Ma;
  });
}

export async function savePartner(input, role = "") {
  assertOwner(role);
  const state = getState();
  const id = input.DT_Ma || "";
  const record = {
    DT_Ma: id,
    DT_Ten: input.DT_Ten,
    DT_SDT: input.DT_SDT,
    DT_DChi: input.DT_DChi,
    DT_Loai: input.DT_Loai,
    DT_STK: input.DT_STK,
    DT_TrangThai: input.DT_TrangThai
  };
  const fieldErrors = validatePartnerData(record, state.DoiTacKinhDoanh);
  if (Object.keys(fieldErrors).length) {
    const error = new Error(Object.values(fieldErrors).join(" "));
    error.fieldErrors = fieldErrors;
    throw error;
  }
  const saved = await savePartnerRecord(record, state.DoiTacKinhDoanh);
  return runDemoTransaction((nextState) => {
    const existing = nextState.DoiTacKinhDoanh.find((row) => row.DT_Ma === saved.DT_Ma);
    if (existing) Object.assign(existing, saved);
    else nextState.DoiTacKinhDoanh.push(saved);
    return saved.DT_Ma;
  });
}

export function approveManagerCount(PKK_Ma, role = "", employeeId = "NV001") {
  assertOwner(role);
  approveCount(PKK_Ma, employeeId, role);
}

function recentExpiry(state) {
  const today = new Date().toISOString().slice(0, 10);
  return state.TonKho.filter((row) => row.TK_SL > 0).map((stock) => {
    const line = state.PhieuNhapChiTiet.find((entry) => entry.PNCT_Ma === stock.PNCT_Ma);
    if (!line?.PNCT_HSD) return null;
    const days = Math.ceil((new Date(`${line.PNCT_HSD}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000);
    return days < 0 || days > (line.PNCT_HSDToiThieu ?? DEMO_THRESHOLD_DAYS) ? null : { stock, line, days };
  }).filter(Boolean);
}

export function getManagerOverview(filters = {}, state = getState()) {
  const reports = getAccountingReports(state);
  const dateMatches = (value) => (!filters.from || dateOnly(value) >= filters.from) && (!filters.to || dateOnly(value) <= filters.to);
  const invoices = state.HoaDonBanHang.filter((row) => activeInvoice(row) && dateMatches(row.BH_Ngay)
    && (!filters.location || row.DD_Ma === filters.location));
  const payments = state.ThanhToanBanHang.filter((row) => row.TTBH_TrangThai === "Thành công" && dateMatches(row.TTBH_Ngay)
    && (!filters.location || state.HoaDonBanHang.find((invoice) => invoice.BH_Ma === row.BH_Ma)?.DD_Ma === filters.location));
  const replenishment = state.DiaDiem.filter((row) => row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động")
    .flatMap((store) => getReplenishmentItems(store.DD_Ma, "", state).map((entry) => ({ ...entry, store })));
  const soldByItem = new Map();
  const employeeRevenue = new Map();
  const revenueByDay = new Map();
  for (const invoice of invoices) {
    const day = dateOnly(invoice.BH_Ngay);
    revenueByDay.set(day, (revenueByDay.get(day) || 0) + Number(invoice.BH_TongCong || 0));
    employeeRevenue.set(invoice.NV_Ma, (employeeRevenue.get(invoice.NV_Ma) || 0) + Number(invoice.BH_TongCong || 0));
  }
  for (const line of state.HoaDonBanHangChiTiet.filter((row) => invoices.some((invoice) => invoice.BH_Ma === row.BH_Ma))) {
    const item = state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === line.PNCT_Ma);
    if (!item) continue;
    const current = soldByItem.get(item.HH_Ma) || { HH_Ma: item.HH_Ma, quantity: 0, revenue: 0 };
    current.quantity += Number(line.BH_SL || 0);
    current.revenue += Number(line.BH_TTien || 0);
    soldByItem.set(item.HH_Ma, current);
  }
  const taskData = getManagerTasks(state);
  const anomalies = getSalesRevenueReconciliation({}, state).filter((row) => row.reasons?.length);
  const paymentAlerts = getPaymentReconciliation({}, state).alerts;
  const stores = state.DiaDiem.filter((row) => row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động");
  const depleted = replenishment.filter(({ item, store, status }) => item.HH_TrangThai === "Đang kinh doanh" && (
    status === "Hết hàng tại cửa hàng, kho còn" || status === "Hết hàng tại cửa hàng, nơi khác còn" || status === "Hết hàng toàn hệ thống"
  ));
  return {
    revenue: invoices.reduce((sum, row) => sum + Number(row.BH_TongCong || 0), 0),
    salesCollected: payments.reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0),
    invoiceCount: invoices.length,
    receivableBalance: reports.receivableBalance,
    payableBalance: reports.payableBalance,
    inventoryValue: reports.inventoryValue,
    outOfStockCount: new Set(depleted.map(({ item }) => item.HH_Ma)).size,
    outOfStock: depleted,
    expiryCount: recentExpiry(state).length,
    expiryItems: recentExpiry(state),
    pendingCounts: state.PhieuKiemKeKho.filter((row) => row.PKK_TrangThai === "Chờ duyệt").length,
    activeTransfers: state.PhieuXuatChuyenNoiBo.filter((row) => ["Chờ xuất", "Đang chuyển", "Chờ đối chiếu", "Cần đối chiếu"].includes(row.PXCN_TrangThai)).length,
    revenueByDay: [...revenueByDay].map(([date, revenue]) => ({ date, revenue })).sort((a, b) => a.date.localeCompare(b.date)),
    bestSellers: [...soldByItem.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 8),
    employeeRevenue: [...employeeRevenue].map(([employeeId, revenue]) => ({ employeeId, revenue })),
    tasks: taskData.slice(0, 8),
    anomalies,
    paymentAlerts,
    stores
  };
}

export function getManagerTasks(state = getState()) {
  const tasks = [];
  for (const doc of (state.TraHangNCC || []).filter((row) => row.TRNCC_TrangThai === "Chờ duyệt")) {
    const supplier = state.DoiTacKinhDoanh.find((row) => row.DT_Ma === doc.DT_Ma);
    tasks.push({
      type: "Trả hàng NCC chờ duyệt",
      id: doc.TRNCC_Ma,
      label: `${doc.TRNCC_Ma} · ${supplier?.DT_Ten || doc.DT_Ma}`,
      amount: doc.TRNCC_TongTien,
      href: `/pages/chu-cua-hang/tra-hang-ncc.html?return=${encodeURIComponent(doc.TRNCC_Ma)}`,
      priority: 1
    });
  }
  for (const count of state.PhieuKiemKeKho.filter((row) => row.PKK_TrangThai === "Chờ duyệt")) {
    tasks.push({ type: "Kiểm kê chờ duyệt", id: count.PKK_Ma, label: `Duyệt phiếu kiểm kê ${count.PKK_Ma}`, href: "../kho/kiem-ke-kho.html?count=" + encodeURIComponent(count.PKK_Ma), priority: 1 });
  }
  for (const transfer of state.PhieuXuatChuyenNoiBo.filter((row) => ["Chờ đối chiếu", "Cần đối chiếu"].includes(row.PXCN_TrangThai))) {
    tasks.push({ type: "Chuyển hàng chênh lệch", id: transfer.PXCN_Ma, label: `Đối chiếu phiếu chuyển ${transfer.PXCN_Ma}`, href: "../kho/xuat-chuyen-noi-bo.html", priority: 1 });
  }
  for (const { item, store, status } of state.DiaDiem.filter((row) => row.DD_Loai === "Cửa hàng" && row.DD_TrangThai === "Hoạt động")
    .flatMap((location) => getReplenishmentItems(location.DD_Ma, "", state).filter(({ status }) => ["Hết hàng tại cửa hàng, kho còn", "Hết hàng tại cửa hàng, nơi khác còn", "Hết hàng toàn hệ thống", "Sắp hết hàng tại cửa hàng"].includes(status)).map((entry) => ({ ...entry, store: location })))) {
    tasks.push({ type: status, id: item.HH_Ma, label: `${item.HH_Ten} · ${store.DD_Ten}: ${status}`, href: "../kho/ton-kho.html", priority: status.startsWith("Hết") ? 1 : 2 });
  }
  for (const entry of recentExpiry(state)) {
    const item = state.HangHoa.find((row) => row.HH_Ma === entry.line.HH_Ma);
    tasks.push({ type: "Hạn sử dụng", id: entry.line.PNCT_Ma, label: `${item?.HH_Ten || entry.line.HH_Ma} · ${entry.days < 0 ? "đã hết hạn" : `còn ${entry.days} ngày`}`, href: "../kho/han-su-dung.html", priority: 1 });
  }
  for (const row of getSalesRevenueReconciliation({}, state).filter((entry) => entry.reasons?.length)) {
    tasks.push({ type: "Hóa đơn cần đối soát", id: row.invoice.BH_Ma, label: `${row.invoice.BH_Ma} · ${row.reasons.join(", ")}`, href: "../ban-hang-ke-toan/doi-soat-doanh-thu.html", priority: 1 });
  }
  for (const alert of getPaymentReconciliation({}, state).alerts) {
    tasks.push({ type: "Thanh toán cần đối soát", id: alert.split(":")[0], label: alert, href: "../ban-hang-ke-toan/doi-soat-thanh-toan.html", priority: 1 });
  }
  for (const debt of getAccountingDashboard({}, state).payables.filter((row) => row.due > 0)) {
    const partner = state.DoiTacKinhDoanh.find((row) => row.DT_Ma === debt.creditor.DT_Ma);
    tasks.push({ type: "Công nợ NCC", id: debt.creditor.DT_Ma, label: `${partner?.DT_Ten || "Nhà cung cấp"} · còn phải trả`, amount: debt.due, href: "../ban-hang-ke-toan/cong-no-ncc.html", priority: 2 });
  }
  for (const debt of getAccountingDashboard({}, state).receivables.filter((row) => row.due > 0)) {
    tasks.push({ type: "Công nợ khách hàng", id: debt.invoice.BH_Ma, label: `Hóa đơn ${debt.invoice.BH_Ma} · còn phải thu`, amount: debt.due, href: "../ban-hang-ke-toan/cong-no-khach-hang.html", priority: 2 });
  }
  return tasks.sort((a, b) => a.priority - b.priority);
}

export function getManagerReports(state = getState(), filters = {}) {
  const base = getAccountingReports(state);
  const matches = (date) => (!filters.from || dateOnly(date) >= filters.from) && (!filters.to || dateOnly(date) <= filters.to);
  const invoices = state.HoaDonBanHang.filter((row) => activeInvoice(row) && matches(row.BH_Ngay)
    && (!filters.location || row.DD_Ma === filters.location));
  const invoiceIds = new Set(invoices.map((row) => row.BH_Ma));
  const invoiceLines = state.HoaDonBanHangChiTiet.filter((row) => invoiceIds.has(row.BH_Ma));
  const products = new Map();
  for (const line of invoiceLines) {
    const inputLine = state.PhieuNhapChiTiet.find((entry) => entry.PNCT_Ma === line.PNCT_Ma);
    const item = state.HangHoa.find((entry) => entry.HH_Ma === inputLine?.HH_Ma);
    if (!item) continue;
    const row = products.get(item.HH_Ma) || { HH_Ma: item.HH_Ma, quantity: 0, revenue: 0, categoryId: item.DM_Ma };
    row.quantity += Number(line.BH_SL || 0);
    row.revenue += Number(line.BH_TTien || 0);
    products.set(item.HH_Ma, row);
  }
  const byEmployee = new Map();
  const byLocation = new Map();
  const byMonth = new Map();
  for (const invoice of invoices) {
    byEmployee.set(invoice.NV_Ma, (byEmployee.get(invoice.NV_Ma) || 0) + Number(invoice.BH_TongCong || 0));
    byLocation.set(invoice.DD_Ma, (byLocation.get(invoice.DD_Ma) || 0) + Number(invoice.BH_TongCong || 0));
    const month = dateOnly(invoice.BH_Ngay).slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + Number(invoice.BH_TongCong || 0));
  }
  const revenueByCategory = new Map();
  for (const product of products.values()) revenueByCategory.set(product.categoryId, (revenueByCategory.get(product.categoryId) || 0) + product.revenue);
  const inventoryByLocation = state.DiaDiem.map((location) => ({
    id: location.DD_Ma, quantity: state.TonKho.filter((row) => row.DD_Ma === location.DD_Ma).reduce((sum, row) => sum + Number(row.TK_SL || 0), 0),
    value: state.TonKho.filter((row) => row.DD_Ma === location.DD_Ma).reduce((sum, row) => {
      const line = state.PhieuNhapChiTiet.find((entry) => entry.PNCT_Ma === row.PNCT_Ma);
      return sum + Number(row.TK_SL || 0) * Number(line?.PNCT_DonGia || 0);
    }, 0)
  }));
  const datedPayments = state.ThanhToanBanHang.filter((row) => row.TTBH_TrangThai === "Thành công" && matches(row.TTBH_Ngay)
    && (!filters.location || state.HoaDonBanHang.find((invoice) => invoice.BH_Ma === row.BH_Ma)?.DD_Ma === filters.location));
  const periodCost = invoiceLines.reduce((sum, row) => {
    const line = state.PhieuNhapChiTiet.find((entry) => entry.PNCT_Ma === row.PNCT_Ma);
    return sum + Number(row.BH_SL || 0) * Number(line?.PNCT_DonGia || 0);
  }, 0);
  return {
    ...base,
    periodRevenue: invoices.reduce((sum, row) => sum + Number(row.BH_TongCong || 0), 0),
    periodInvoiceCount: invoices.length,
    periodSoldQuantity: invoices.reduce((sum, row) => sum + Number(row.BH_TongSL || 0), 0),
    periodCollected: datedPayments.reduce((sum, row) => sum + Number(row.TTBH_SoTien || 0), 0),
    periodCost,
    revenueByMonth: [...byMonth].map(([month, revenue]) => ({ month, revenue })).sort((a, b) => a.month.localeCompare(b.month)),
    revenueByEmployee: [...byEmployee].map(([id, revenue]) => ({ id, revenue })),
    revenueByLocation: [...byLocation].map(([id, revenue]) => ({ id, revenue })),
    products: [...products.values()].sort((a, b) => b.quantity - a.quantity),
    revenueByCategory: [...revenueByCategory].map(([id, revenue]) => ({ id, revenue })),
    inventoryByLocation,
    movementTypes: [...new Set(state.BienDongKho.map((row) => row.BDK_Loai))].map((type) => ({
      type, quantity: state.BienDongKho.filter((row) => row.BDK_Loai === type && matches(row.BDK_Ngay)).reduce((sum, row) => sum + Number(row.BDK_SoLuong || 0), 0)
    })),
    periodGrossProfit: invoices.reduce((sum, row) => sum + Number(row.BH_TongCong || 0), 0) - periodCost
  };
}

export function getProductStockSummary(state = getState()) {
  return state.HangHoa.map((item) => {
    const stockByLocation = state.DiaDiem.map((location) => ({
      location, ...getInventoryPosition(location.DD_Ma, item.HH_Ma, state)
    })).filter((entry) => entry.physical > 0);
    const activePrice = getActivePrice(item.HH_Ma, new Date().toISOString().slice(0, 10), state);
    return {
      item, stockByLocation,
      totalStock: stockByLocation.reduce((sum, row) => sum + row.physical, 0),
      currentPrice: activePrice.price
    };
  });
}
