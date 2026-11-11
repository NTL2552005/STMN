import { authenticatedApiRequest } from "./auth-service.js";

const ACCOUNTS_API = "/api/accounts/";

function listFromResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.results)) return response.results;
  throw new Error("Backend trả về danh sách dữ liệu không hợp lệ.");
}

export async function listEmployees() {
  return listFromResponse(await authenticatedApiRequest(`${ACCOUNTS_API}employees/`));
}

export async function listAccounts() {
  return listFromResponse(await authenticatedApiRequest(`${ACCOUNTS_API}users/`));
}

export async function listRoles() {
  return listFromResponse(await authenticatedApiRequest(`${ACCOUNTS_API}roles/`));
}

export function saveEmployee(employee, data) {
  const method = employee.id ? "PATCH" : "POST";
  const path = employee.id
    ? `${ACCOUNTS_API}employees/${employee.id}/`
    : `${ACCOUNTS_API}employees/`;
  return authenticatedApiRequest(path, { method, body: data });
}

export function saveAccount(account, data) {
  const method = account.id ? "PATCH" : "POST";
  const path = account.id
    ? `${ACCOUNTS_API}users/${account.id}/`
    : `${ACCOUNTS_API}users/`;
  return authenticatedApiRequest(path, { method, body: data });
}

export function setAccountActive(account, isActive) {
  return authenticatedApiRequest(`${ACCOUNTS_API}users/${account.id}/`, {
    method: "PATCH",
    body: { is_active: isActive }
  });
}
