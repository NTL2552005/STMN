import { authenticatedApiRequest } from "./auth-service.js";

const SUPPLIERS_API = "/api/suppliers/";
const PARTNERS_API = "/api/partners/";

function collectionPath(filters = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const suffix = query.toString();
  return `${SUPPLIERS_API}${suffix ? `?${suffix}` : ""}`;
}

function requirePage(response) {
  if (
    response && Number.isInteger(response.count)
    && Array.isArray(response.results)
    && (response.next === null || typeof response.next === "string")
    && (response.previous === null || typeof response.previous === "string")
  ) return response;
  throw new Error("Backend trả về trang dữ liệu nhà cung cấp không hợp lệ.");
}

export async function listSuppliers(filters = {}) {
  return requirePage(await authenticatedApiRequest(collectionPath(filters)));
}

export function getSupplier(code) {
  return authenticatedApiRequest(`${SUPPLIERS_API}${encodeURIComponent(code)}/`);
}

export function getPartner(code) {
  return authenticatedApiRequest(`${PARTNERS_API}${encodeURIComponent(code)}/`);
}

export function createSupplier(data) {
  return authenticatedApiRequest(SUPPLIERS_API, { method: "POST", body: supplierPayload(data) });
}

export function updateSupplier(code, data) {
  return authenticatedApiRequest(
    `${SUPPLIERS_API}${encodeURIComponent(code)}/`,
    { method: "PATCH", body: supplierPayload(data) }
  );
}

function supplierPayload(data) {
  return {
    DT_Ten: data.DT_Ten,
    DT_SDT: data.DT_SDT,
    DT_DChi: data.DT_DChi,
    DT_STK: data.DT_STK,
    DT_TrangThai: data.DT_TrangThai
  };
}
