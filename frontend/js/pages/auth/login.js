import { login, navigateAfterLogin } from "../../services/auth-service.js";

const form = document.querySelector("#login-form");
const message = document.querySelector("#auth-message");
const submit = form.querySelector('[type="submit"]');

function showMessage(text) {
  message.textContent = text;
  message.hidden = false;
}

const params = new URLSearchParams(window.location.search);
if (params.has("logout")) {
  showMessage("Đã xóa phiên đăng nhập trên trình duyệt nhưng không thể xác nhận máy chủ đã thu hồi token. Hãy thử đăng nhập lại khi Backend hoạt động.");
} else if (params.has("backend")) {
  showMessage("Không thể kết nối Backend. Hãy kiểm tra máy chủ và thử lại.");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true;
  submit.textContent = "Đang đăng nhập…";
  message.hidden = true;
  const values = new FormData(form);
  try {
    const result = await login(values.get("username"), values.get("password"));
    await navigateAfterLogin(result.roles);
  } catch (error) {
    const messageText = error.status === 401
      ? `${error.message || "Không thể đăng nhập."} Tài khoản có thể đã bị khóa hoặc vô hiệu hóa.`
      : error.message || "Không thể đăng nhập.";
    showMessage(messageText);
    submit.disabled = false;
    submit.textContent = "Đăng nhập";
    form.elements.password.value = "";
  }
});
