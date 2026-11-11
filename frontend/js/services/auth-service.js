const TOKEN_KEY = "stmn.auth.token";
const ACTIVE_ROLE_KEY = "stmn.auth.active-role";
const ROLE_NAMES = new Set([
  "Chủ cửa hàng",
  "Nhân viên kho",
  "Nhân viên bán hàng",
  "Nhân viên kế toán"
]);
const ROLE_LANDING = {
  "Chủ cửa hàng": "/pages/chu-cua-hang/tong-quan.html",
  "Nhân viên kho": "/pages/kho/tong-quan-kho.html",
  "Nhân viên bán hàng": "/pages/ban-hang-ke-toan/tong-quan-ban-hang.html",
  "Nhân viên kế toán": "/pages/ban-hang-ke-toan/tong-quan-ke-toan.html"
};
const MOCK_ACTOR_BY_ROLE = {
  "Chủ cửa hàng": "NV001",
  "Nhân viên kho": "NV002",
  "Nhân viên kế toán": "NV003",
  "Nhân viên bán hàng": "NV004"
};
const PAGE_ACCESS = {
  owner: {
    overview: ["Chủ cửa hàng"], tasks: ["Chủ cửa hàng"], employees: ["Chủ cửa hàng"],
    accounts: ["Chủ cửa hàng"], roles: ["Chủ cửa hàng"],
    categories: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên bán hàng", "Nhân viên kế toán"],
    products: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên bán hàng", "Nhân viên kế toán"],
    orders: ["Chủ cửa hàng"],
    prices: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên bán hàng", "Nhân viên kế toán"],
    partners: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên bán hàng", "Nhân viên kế toán"],
    receipts: ["Chủ cửa hàng"], operations: ["Chủ cửa hàng"],
    "supplier-returns": ["Chủ cửa hàng"], counts: ["Chủ cửa hàng"],
    sales: ["Chủ cửa hàng"], finance: ["Chủ cửa hàng"], reports: ["Chủ cửa hàng"]
  },
  warehouse: {
    overview: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán"],
    receipts: ["Chủ cửa hàng", "Nhân viên kho"],
    transfers: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên bán hàng", "Nhân viên kế toán"],
    returns: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán"],
    stock: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán"],
    ledger: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán"],
    counts: ["Chủ cửa hàng", "Nhân viên kho"],
    movements: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán"],
    expiry: ["Chủ cửa hàng", "Nhân viên kho", "Nhân viên kế toán"]
  },
  sales: {
    overview: ["Chủ cửa hàng", "Nhân viên bán hàng"],
    pos: ["Chủ cửa hàng", "Nhân viên bán hàng"],
    shifts: ["Chủ cửa hàng", "Nhân viên bán hàng"],
    invoices: ["Chủ cửa hàng", "Nhân viên bán hàng"],
    payments: ["Chủ cửa hàng", "Nhân viên bán hàng"],
    customers: ["Chủ cửa hàng", "Nhân viên bán hàng"],
    debts: ["Chủ cửa hàng", "Nhân viên bán hàng"]
  },
  accounting: {
    "accounting-overview": ["Chủ cửa hàng", "Nhân viên kế toán"],
    "purchase-reconciliation": ["Chủ cửa hàng", "Nhân viên kế toán"],
    "stock-reconciliation": ["Chủ cửa hàng", "Nhân viên kế toán"],
    "supplier-debts": ["Chủ cửa hàng", "Nhân viên kế toán"],
    "supplier-payments": ["Chủ cửa hàng", "Nhân viên kế toán"],
    receipts: ["Chủ cửa hàng", "Nhân viên kế toán"],
    expenses: ["Chủ cửa hàng", "Nhân viên kế toán"],
    "customer-debts": ["Chủ cửa hàng", "Nhân viên kế toán"],
    "revenue-reconciliation": ["Chủ cửa hàng", "Nhân viên kế toán"],
    "payment-reconciliation": ["Chủ cửa hàng", "Nhân viên kế toán"],
    "cash-shift-reconciliation": ["Chủ cửa hàng", "Nhân viên kế toán"],
    reports: ["Chủ cửa hàng", "Nhân viên kế toán"]
  }
};

export class AuthError extends Error {
  constructor(message, status = 0, details = null) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.details = details;
  }
}

function apiBaseUrl() {
  const configured = window.STMN_API_BASE_URL;
  if (configured) {
    const url = new URL(configured, window.location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
      throw new AuthError("Địa chỉ Backend phải là một origin HTTP hoặc HTTPS.");
    }
    return url.origin;
  }
  if (!["http:", "https:"].includes(window.location.protocol)) {
    throw new AuthError("Hãy chạy Frontend qua HTTP thay vì mở trực tiếp bằng file://.");
  }
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

function accountsUrl(path) {
  return `${apiBaseUrl()}/api/accounts/${path}`;
}

function apiUrl(path) {
  const base = new URL(apiBaseUrl());
  const url = new URL(path.replace(/^\/+/, ""), `${base.origin}/`);
  if (url.origin !== base.origin || !url.pathname.startsWith("/api/")) {
    throw new AuthError("Chỉ được gửi token tới các API cùng origin của Backend.");
  }
  return url.href;
}

function currentPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function redirectToLogin() {
  if (window.location.pathname.endsWith("/dang-nhap.html")) return;
  const login = new URL("/pages/dang-nhap.html", window.location.href);
  login.searchParams.set("next", currentPath());
  window.location.replace(login.href);
}

function showForbiddenMessage() {
  let message = document.querySelector("#auth-global-message");
  if (!message) {
    message = document.createElement("div");
    message.id = "auth-global-message";
    message.className = "auth-global-message";
    message.setAttribute("role", "alert");
    document.body.append(message);
  }
  message.textContent = "Bạn không có quyền thực hiện thao tác này. Phiên đăng nhập vẫn còn hiệu lực.";
}

function errorMessage(payload, fallback) {
  if (typeof payload?.detail === "string") return payload.detail;
  if (payload && typeof payload === "object") {
    const first = Object.values(payload).flat(Infinity).find((value) => typeof value === "string");
    if (first) return first;
  }
  return fallback;
}

function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(ACTIVE_ROLE_KEY);
}

async function request(path, {
  method = "GET", body, authenticated = true, redirectOnUnauthorized = true, url = accountsUrl(path)
} = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authenticated) {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      if (redirectOnUnauthorized) redirectToLogin();
      throw new AuthError("Phiên đăng nhập đã hết hạn.", 401);
    }
    headers.Authorization = `Token ${token}`;
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new AuthError("Không thể kết nối Backend. Hãy kiểm tra máy chủ và thử lại.");
  }
  if (response.status === 401) {
    clearSession();
    if (redirectOnUnauthorized) redirectToLogin();
  }
  if (response.status === 403) showForbiddenMessage();
  if (response.status === 204) return null;
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw new AuthError("Backend trả về lỗi không đọc được.", response.status);
  }
  if (!response.ok) {
    throw new AuthError(
      errorMessage(payload, response.status === 401
        ? "Tên đăng nhập hoặc mật khẩu không chính xác."
        : response.status === 403 ? "Bạn không có quyền thực hiện thao tác này." : "Yêu cầu không thành công."),
      response.status,
      payload
    );
  }
  return payload;
}

export function getRoleNames(user) {
  return [...new Set((Array.isArray(user?.roles) ? user.roles : []).filter((name) => ROLE_NAMES.has(name)))];
}

export function canAccessPage(app, page, role) {
  return PAGE_ACCESS[app]?.[page]?.includes(role) || false;
}

export async function login(username, password) {
  clearSession();
  const result = await request("login/", {
    method: "POST",
    authenticated: false,
    body: { username, password }
  });
  if (typeof result?.token !== "string" || !result.token) {
    throw new AuthError("Phản hồi đăng nhập thiếu token hợp lệ.");
  }
  sessionStorage.setItem(TOKEN_KEY, result.token);
  try {
    const user = await getCurrentUser();
    return { user, roles: getRoleNames(user) };
  } catch (error) {
    clearSession();
    throw error;
  }
}

export async function getCurrentUser() {
  return request("me/");
}

export async function authenticatedApiRequest(path, options = {}) {
  return request(path, { ...options, url: apiUrl(path) });
}

export function getActiveRole() {
  return sessionStorage.getItem(ACTIVE_ROLE_KEY);
}

export function getMockActorCode(role) {
  return MOCK_ACTOR_BY_ROLE[role] || "";
}

export async function continueToLanding() {
  try {
    const user = await getCurrentUser();
    const roles = getRoleNames(user);
    if (!roles.length) {
      window.location.replace("/pages/truy-cap.html?unassigned=1");
      return;
    }
    const activeRole = getActiveRole();
    if (roles.length > 1 && !roles.includes(activeRole)) {
      window.location.replace("/pages/chon-vai-tro.html");
      return;
    }
    const role = roles.includes(activeRole) ? activeRole : roles[0];
    sessionStorage.setItem(ACTIVE_ROLE_KEY, role);
    window.location.replace(ROLE_LANDING[role]);
  } catch (error) {
    if (error instanceof AuthError && error.status === 0) {
      const login = new URL("/pages/dang-nhap.html", window.location.href);
      login.searchParams.set("backend", "unavailable");
      window.location.replace(login.href);
    } else if (!(error instanceof AuthError && error.status === 401)) {
      window.location.replace("/pages/truy-cap.html");
    }
  }
}

export async function selectRole(roleName) {
  const user = await getCurrentUser();
  if (!getRoleNames(user).includes(roleName)) {
    clearSession();
    throw new AuthError("Vai trò không được gán cho tài khoản này.", 403);
  }
  sessionStorage.setItem(ACTIVE_ROLE_KEY, roleName);
  window.location.replace(ROLE_LANDING[roleName]);
}

export async function navigateAfterLogin(roles) {
  if (!roles.length) {
    window.location.replace("/pages/truy-cap.html?unassigned=1");
    return;
  }
  if (roles.length > 1) {
    window.location.replace("/pages/chon-vai-tro.html");
    return;
  }
  sessionStorage.setItem(ACTIVE_ROLE_KEY, roles[0]);
  const requested = new URLSearchParams(window.location.search).get("next");
  if (requested) {
    try {
      const target = new URL(requested, window.location.origin);
      if (target.origin === window.location.origin && target.pathname.startsWith("/pages/")) {
        window.location.replace(`${target.pathname}${target.search}${target.hash}`);
        return;
      }
    } catch {
      // Ignore malformed return paths and use the role's landing page.
    }
  }
  window.location.replace(ROLE_LANDING[roles[0]]);
}

export async function requirePageAccess(app, page) {
  let user;
  try {
    user = await getCurrentUser();
  } catch (error) {
    if (error instanceof AuthError && error.status === 0) {
      const login = new URL("/pages/dang-nhap.html", window.location.href);
      login.searchParams.set("backend", "unavailable");
      window.location.replace(login.href);
      return new Promise(() => {});
    }
    if (error instanceof AuthError && error.status === 401) return new Promise(() => {});
    throw error;
  }
  const roles = getRoleNames(user);
  if (!roles.length) {
    window.location.replace("/pages/truy-cap.html?unassigned=1");
    return new Promise(() => {});
  }
  let role = getActiveRole();
  if (roles.length > 1 && !roles.includes(role)) {
    window.location.replace("/pages/chon-vai-tro.html");
    return new Promise(() => {});
  }
  if (!roles.includes(role)) {
    role = roles[0];
    sessionStorage.setItem(ACTIVE_ROLE_KEY, role);
  }
  if (!canAccessPage(app, page, role)) {
    window.location.replace("/pages/truy-cap.html?forbidden=1");
    return new Promise(() => {});
  }
  return { user, role, employeeCode: user.employee?.NV_Ma || user.NV_Ma || "" };
}

export async function logout() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  let logoutError;
  if (token) {
    try {
      await request("logout/", { method: "POST", redirectOnUnauthorized: false });
    } catch (error) {
      if (!(error instanceof AuthError) || error.status !== 401) logoutError = error;
    }
  }
  clearSession();
  if (logoutError) throw logoutError;
}

export function escapeAuthText(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-auth-logout]");
  if (!button) return;
  button.disabled = true;
  let message = "";
  try {
    await logout();
  } catch {
    message = "?logout=local-only";
  }
  const login = new URL("/pages/dang-nhap.html", window.location.href);
  if (message) login.search = message.slice(1);
  window.location.replace(login.href);
});
