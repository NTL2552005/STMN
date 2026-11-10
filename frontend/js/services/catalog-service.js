import { authenticatedApiRequest } from "./auth-service.js";

const CATALOG_API = "/api/catalog/";

function collectionPath(resource, filters = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const suffix = query.toString();
  return `${CATALOG_API}${resource}/${suffix ? `?${suffix}` : ""}`;
}

function requirePage(response) {
  if (
    response && Number.isInteger(response.count)
    && Array.isArray(response.results)
    && (response.next === null || typeof response.next === "string")
    && (response.previous === null || typeof response.previous === "string")
  ) return response;
  throw new Error("Backend trả về trang dữ liệu Catalog không hợp lệ.");
}

async function listAll(resource) {
  const results = [];
  let page = 1;
  let hasNext = true;
  while (hasNext) {
    const response = requirePage(await authenticatedApiRequest(
      collectionPath(resource, { page, page_size: 100 })
    ));
    results.push(...response.results);
    hasNext = response.next !== null;
    page += 1;
  }
  return results;
}

export async function listCategories(filters = {}) {
  return requirePage(await authenticatedApiRequest(collectionPath("categories", filters)));
}

export async function listAllCategories() {
  return listAll("categories");
}

export async function getCategory(code) {
  return authenticatedApiRequest(`${CATALOG_API}categories/${encodeURIComponent(code)}/`);
}

export function saveCategory(category, data) {
  const path = category.DM_Ma
    ? `${CATALOG_API}categories/${encodeURIComponent(category.DM_Ma)}/`
    : `${CATALOG_API}categories/`;
  return authenticatedApiRequest(path, {
    method: category.DM_Ma ? "PATCH" : "POST",
    body: data
  });
}

export async function listProducts(filters = {}) {
  return requirePage(await authenticatedApiRequest(collectionPath("products", filters)));
}

export async function listAllProducts(filters = {}) {
  const results = [];
  let page = 1;
  let hasNext = true;
  while (hasNext) {
    const response = requirePage(await authenticatedApiRequest(
      collectionPath("products", { ...filters, page, page_size: 100 })
    ));
    results.push(...response.results);
    hasNext = response.next !== null;
    page += 1;
  }
  return results;
}

export function getProduct(code) {
  return authenticatedApiRequest(`${CATALOG_API}products/${encodeURIComponent(code)}/`);
}

export function saveProduct(product, data) {
  const path = product.HH_Ma
    ? `${CATALOG_API}products/${encodeURIComponent(product.HH_Ma)}/`
    : `${CATALOG_API}products/`;
  return authenticatedApiRequest(path, {
    method: product.HH_Ma ? "PATCH" : "POST",
    body: data
  });
}

export function getActivePrice(productCode, date) {
  const query = new URLSearchParams({ date });
  return authenticatedApiRequest(
    `${CATALOG_API}products/${encodeURIComponent(productCode)}/active-price/?${query}`
  );
}

export async function listPrices(filters = {}) {
  return requirePage(await authenticatedApiRequest(collectionPath("prices", filters)));
}

export function getPrice(code) {
  return authenticatedApiRequest(`${CATALOG_API}prices/${encodeURIComponent(code)}/`);
}

export function savePrice(price, data) {
  const path = price.GB_Ma
    ? `${CATALOG_API}prices/${encodeURIComponent(price.GB_Ma)}/`
    : `${CATALOG_API}prices/`;
  return authenticatedApiRequest(path, {
    method: price.GB_Ma ? "PATCH" : "POST",
    body: data
  });
}

export function endPrice(code, endDate) {
  return authenticatedApiRequest(
    `${CATALOG_API}prices/${encodeURIComponent(code)}/end/`,
    { method: "POST", body: { GB_NgayKT: endDate } }
  );
}
