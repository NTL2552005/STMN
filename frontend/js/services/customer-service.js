import { generateDemoId, getState, runDemoTransaction } from "./kho-service.js";

const customerTypes = new Set(["Khách hàng", "Cả hai"]);

export function listCustomers(state = getState()) {
  return state.DoiTacKinhDoanh.filter((row) => customerTypes.has(row.DT_Loai));
}

export function saveCustomer({ DT_Ma = "", DT_Ten, DT_SDT = "", DT_DChi = "", DT_Loai = "Khách hàng", DT_TrangThai = "Hoạt động", role = "" }) {
  return runDemoTransaction((state) => {
    if (!["Chủ cửa hàng", "Nhân viên bán hàng"].includes(role)) throw new Error("Vai trò hiện tại không được thêm hoặc chỉnh sửa khách hàng.");
    const name = String(DT_Ten || "").trim();
    if (!name) throw new Error("Tên khách hàng không được để trống.");
    if (!customerTypes.has(DT_Loai)) throw new Error("Loại đối tác phải là Khách hàng hoặc Cả hai.");
    const normalizedPhone = String(DT_SDT || "").trim();
    if (normalizedPhone && state.DoiTacKinhDoanh.some((row) => row.DT_Ma !== DT_Ma && row.DT_SDT === normalizedPhone && customerTypes.has(row.DT_Loai))) {
      throw new Error("Số điện thoại này đã được gắn với một khách hàng.");
    }
    let partner = DT_Ma ? state.DoiTacKinhDoanh.find((row) => row.DT_Ma === DT_Ma) : null;
    if (DT_Ma && !partner) throw new Error("Không tìm thấy đối tác.");
    if (!partner && normalizedPhone) {
      partner = state.DoiTacKinhDoanh.find((row) => row.DT_SDT === normalizedPhone && row.DT_Loai === "Nhà cung cấp");
      if (partner) partner.DT_Loai = "Cả hai";
    }
    if (!partner) {
      partner = {
        DT_Ma: generateDemoId("DT", state.DoiTacKinhDoanh, "DT_Ma"),
        DT_STK: ""
      };
      state.DoiTacKinhDoanh.push(partner);
    }
    Object.assign(partner, {
      DT_Ten: name,
      DT_SDT: normalizedPhone,
      DT_DChi: String(DT_DChi || "").trim(),
      DT_Loai: DT_Loai === "Cả hai" || partner.DT_Loai === "Cả hai" ? "Cả hai" : DT_Loai,
      DT_TrangThai
    });
    return partner.DT_Ma;
  });
}
