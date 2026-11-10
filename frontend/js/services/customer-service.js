import { getState, runDemoTransaction } from "./kho-service.js";

const customerTypes = new Set(["Khách hàng"]);
const partnerTypes = new Set(["Khách hàng", "Nhà cung cấp"]);
const partnerStatuses = new Set(["Hoạt động", "Ngừng hoạt động"]);

function partnerApiUrl(id = "") {
  const origin = `${window.location.protocol}//${window.location.hostname}:8000`;
  return `${origin}/api/customers/partners/${id ? `${encodeURIComponent(id)}/` : ""}`;
}

function validationError(fieldErrors) {
  const error = new Error(Object.values(fieldErrors).join(" "));
  error.fieldErrors = fieldErrors;
  return error;
}

export function validatePartnerData(input, partners = []) {
  const errors = {};
  const name = String(input.DT_Ten ?? "").trim();
  const type = String(input.DT_Loai ?? "");
  const phone = String(input.DT_SDT ?? "").trim();
  const address = String(input.DT_DChi ?? "").trim();
  const bankAccount = String(input.DT_STK ?? "").trim();

  if (!name) errors.DT_Ten = "Tên đối tác không được để trống.";
  if (!partnerTypes.has(type)) errors.DT_Loai = "Loại đối tác không hợp lệ.";
  if (!partnerStatuses.has(String(input.DT_TrangThai ?? ""))) errors.DT_TrangThai = "Trạng thái đối tác không hợp lệ.";

  if (!phone && type === "Nhà cung cấp") {
    errors.DT_SDT = "Vui lòng nhập số điện thoại nhà cung cấp.";
  } else if (phone && !/^[0-9]{10,11}$/.test(phone)) {
    errors.DT_SDT = "Số điện thoại phải gồm 10 hoặc 11 chữ số.";
  } else if (phone && partners.some((row) => row.DT_Ma !== input.DT_Ma && String(row.DT_SDT ?? "").trim() === phone)) {
    errors.DT_SDT = "Số điện thoại này đã được gắn với một đối tác khác.";
  }

  if (type === "Nhà cung cấp" && !address) errors.DT_DChi = "Vui lòng nhập địa chỉ nhà cung cấp.";
  if (type === "Nhà cung cấp" && !bankAccount) errors.DT_STK = "Vui lòng nhập số tài khoản nhà cung cấp.";
  return errors;
}

async function requestPartner(url, options, allowNotFound = false) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    const error = new Error("Không kết nối được Backend. Kiểm tra Django server rồi thử lại.");
    error.cause = cause;
    throw error;
  }

  if (allowNotFound && response.status === 404) return null;

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error(`Backend trả về phản hồi không hợp lệ (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const fieldErrors = {};
    for (const [field, messages] of Object.entries(payload || {})) {
      if (field === "detail" || field === "non_field_errors") continue;
      fieldErrors[field] = Array.isArray(messages) ? messages.join(" ") : String(messages);
    }
    const general = payload?.detail || payload?.non_field_errors?.join?.(" ") || "";
    const error = new Error(general || Object.values(fieldErrors).join(" ") || `Không thể lưu đối tác (HTTP ${response.status}).`);
    error.fieldErrors = fieldErrors;
    throw error;
  }
  return payload;
}

export async function savePartnerRecord(input, partners = []) {
  const fieldErrors = validatePartnerData(input, partners);
  if (Object.keys(fieldErrors).length) throw validationError(fieldErrors);

  const data = {
    DT_Ma: input.DT_Ma,
    DT_Ten: String(input.DT_Ten).trim(),
    DT_SDT: String(input.DT_SDT ?? "").trim() || null,
    DT_DChi: String(input.DT_DChi ?? "").trim(),
    DT_Loai: input.DT_Loai,
    DT_STK: String(input.DT_STK ?? "").trim(),
    DT_TrangThai: input.DT_TrangThai
  };
  const headers = { "Content-Type": "application/json" };
  const detailUrl = data.DT_Ma ? partnerApiUrl(data.DT_Ma) : "";

  if (detailUrl) {
    const existing = await requestPartner(detailUrl, { method: "GET" }, true);
    if (existing) {
      return requestPartner(detailUrl, {
        method: "PATCH",
        headers,
        body: JSON.stringify(data)
      });
    }
  }
  return requestPartner(partnerApiUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify(data)
  });
}

export function listCustomers(state = getState()) {
  return state.DoiTacKinhDoanh.filter((row) => customerTypes.has(row.DT_Loai));
}

export async function saveCustomer({ DT_Ma = "", DT_Ten, DT_SDT = "", DT_DChi = "", DT_Loai = "Khách hàng", DT_TrangThai = "Hoạt động", role = "" }) {
  if (!["Chủ cửa hàng", "Nhân viên bán hàng"].includes(role)) throw new Error("Vai trò hiện tại không được thêm hoặc chỉnh sửa khách hàng.");
  if (!customerTypes.has(DT_Loai)) throw validationError({ DT_Loai: "Loại đối tác phải là Khách hàng." });

  const state = getState();
  const current = DT_Ma ? state.DoiTacKinhDoanh.find((row) => row.DT_Ma === DT_Ma) : null;
  if (DT_Ma && !current) throw new Error("Không tìm thấy đối tác.");
  const id = DT_Ma;
  const record = {
    ...current,
    DT_Ma: id,
    DT_Ten,
    DT_SDT,
    DT_DChi,
    DT_Loai,
    DT_STK: current?.DT_STK || "",
    DT_TrangThai
  };
  const saved = await savePartnerRecord(record, state.DoiTacKinhDoanh);
  return runDemoTransaction((nextState) => {
    const existing = nextState.DoiTacKinhDoanh.find((row) => row.DT_Ma === saved.DT_Ma);
    if (existing) Object.assign(existing, saved);
    else nextState.DoiTacKinhDoanh.push(saved);
    return saved.DT_Ma;
  });
}
