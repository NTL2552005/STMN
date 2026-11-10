import { getCurrentUser, getRoleNames } from "../../services/auth-service.js";

const params = new URLSearchParams(window.location.search);
const message = document.querySelector("#access-message");
if (params.has("unassigned")) {
  message.textContent = "Tài khoản chưa được gán vai trò STMN. Hãy liên hệ Chủ cửa hàng hoặc quản trị viên.";
} else if (params.has("forbidden")) {
  message.textContent = "Vai trò hiện tại không được phép mở trang này.";
}

try {
  const user = await getCurrentUser();
  const actions = document.querySelector("#access-actions");
  actions.replaceChildren();
  if (getRoleNames(user).length) {
    actions.innerHTML = '<a class="button button-primary auth-role-option" href="../index.html">Về giao diện của tôi</a>';
  }
} catch (error) {
  message.textContent = error.message || "Phiên đăng nhập không hợp lệ.";
}
