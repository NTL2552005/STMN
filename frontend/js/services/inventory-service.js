import { getState } from "./kho-service.js";

const dateOnly = (value) => String(value || "").slice(0, 10);

export const LOW_STOCK_THRESHOLD = 10;

export function getAvailableStock(DD_Ma, HH_Ma, state = getState()) {
  return getValidSaleLots(DD_Ma, HH_Ma, undefined, state)
    .reduce((sum, lot) => sum + lot.stock.TK_SL, 0);
}

export function getPhysicalStock(DD_Ma, HH_Ma, state = getState()) {
  const lineIds = new Set(state.PhieuNhapChiTiet.filter((line) => line.HH_Ma === HH_Ma).map((line) => line.PNCT_Ma));
  return state.TonKho
    .filter((stock) => stock.DD_Ma === DD_Ma && lineIds.has(stock.PNCT_Ma))
    .reduce((sum, stock) => sum + stock.TK_SL, 0);
}

export function getInventoryPosition(DD_Ma, HH_Ma, state = getState()) {
  const physical = getPhysicalStock(DD_Ma, HH_Ma, state);
  const available = getAvailableStock(DD_Ma, HH_Ma, state);
  return { physical, available, unavailable: Math.max(0, physical - available) };
}

export function getReplenishmentItems(DD_CuaHang, DD_Kho, state = getState()) {
  return state.HangHoa.map((item) => {
    const store = getInventoryPosition(DD_CuaHang, item.HH_Ma, state);
    const warehouse = getInventoryPosition(DD_Kho, item.HH_Ma, state);
    const systemPhysical = state.DiaDiem
      .filter((location) => location.DD_TrangThai === "Hoạt động")
      .reduce((sum, location) => sum + getPhysicalStock(location.DD_Ma, item.HH_Ma, state), 0);
    const systemAvailable = state.DiaDiem
      .filter((location) => location.DD_TrangThai === "Hoạt động")
      .reduce((sum, location) => sum + getAvailableStock(location.DD_Ma, item.HH_Ma, state), 0);
    let status = "Đủ hàng";
    if (item.HH_TrangThai !== "Đang kinh doanh") status = "Ngừng kinh doanh";
    else if (store.available === 0 && warehouse.available > 0) status = "Hết hàng tại cửa hàng, kho còn";
    else if (store.available === 0 && systemAvailable > 0) status = "Hết hàng tại cửa hàng, nơi khác còn";
    else if (store.available === 0 && systemAvailable === 0 && systemPhysical > 0) status = "Có tồn nhưng không khả dụng";
    else if (store.available === 0) status = "Hết hàng toàn hệ thống";
    else if (store.available <= LOW_STOCK_THRESHOLD) status = "Sắp hết hàng tại cửa hàng";
    return { item, store, warehouse, systemPhysical, systemAvailable, status };
  });
}

export function getValidSaleLots(DD_Ma, HH_Ma, ngayBan = new Date().toISOString().slice(0, 10), state = getState()) {
  const item = state.HangHoa.find((row) => row.HH_Ma === HH_Ma);
  if (!item || item.HH_TrangThai !== "Đang kinh doanh") return [];
  return state.TonKho
    .filter((stock) => stock.DD_Ma === DD_Ma && stock.TK_SL > 0)
    .map((stock) => ({
      stock,
      line: state.PhieuNhapChiTiet.find((row) => row.PNCT_Ma === stock.PNCT_Ma)
    }))
    .filter(({ line }) => line?.HH_Ma === HH_Ma)
    .filter(({ line }) => {
      const receipt = state.PhieuNhap.find((row) => row.PN_Ma === line.PN_Ma);
      return receipt?.PN_TrangThai === "Đã xác nhận" && (!line.PNCT_HSD || dateOnly(line.PNCT_HSD) >= dateOnly(ngayBan));
    })
    .sort((a, b) => {
      if (!a.line.PNCT_HSD) return b.line.PNCT_HSD ? 1 : a.line.PNCT_Ma.localeCompare(b.line.PNCT_Ma);
      if (!b.line.PNCT_HSD) return -1;
      return a.line.PNCT_HSD.localeCompare(b.line.PNCT_HSD) || a.line.PNCT_Ma.localeCompare(b.line.PNCT_Ma);
    });
}

export function getActivePrice(HH_Ma, ngayBan = new Date().toISOString().slice(0, 10), state = getState()) {
  const validStatuses = new Set(["Đang áp dụng", "Có hiệu lực", "Đang hiệu lực"]);
  const prices = state.GiaBan.filter((row) =>
    row.HH_Ma === HH_Ma &&
    validStatuses.has(row.GB_TrangThai) &&
    dateOnly(row.GB_NgayBD) <= dateOnly(ngayBan) &&
    (!row.GB_NgayKT || dateOnly(row.GB_NgayKT) >= dateOnly(ngayBan))
  );
  if (prices.length !== 1) {
    return {
      price: null,
      error: prices.length ? "Có nhiều giá bán cùng hiệu lực; cần kế toán xử lý." : "Không có giá bán hợp lệ tại ngày bán."
    };
  }
  const price = Number(prices[0].GB_DonGia);
  if (!Number.isSafeInteger(price) || price < 0) return { price: null, error: "Giá bán không hợp lệ." };
  return { price, record: prices[0], error: "" };
}
