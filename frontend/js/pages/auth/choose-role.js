import {
  escapeAuthText, getCurrentUser, getRoleNames, selectRole
} from "../../services/auth-service.js";

const host = document.querySelector("#role-options");
try {
  const user = await getCurrentUser();
  const roles = getRoleNames(user);
  if (roles.length < 2) {
    window.location.replace("../index.html");
  } else {
    host.innerHTML = roles.map((role) =>
      `<button class="button auth-role-option" type="button" data-role="${escapeAuthText(role)}">${escapeAuthText(role)}</button>`
    ).join("");
    host.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-role]");
      if (!button) return;
      button.disabled = true;
      try {
        await selectRole(button.dataset.role);
      } catch (error) {
        host.textContent = error.message || "Không thể chọn vai trò.";
      }
    });
  }
} catch (error) {
  host.textContent = error.message || "Không thể xác thực phiên đăng nhập.";
}
