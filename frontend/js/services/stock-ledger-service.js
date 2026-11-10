const asDateKey = (value) => {
  if (!value) return "";
  const datePart = String(value).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (datePart && !Number.isNaN(Date.parse(`${datePart}T00:00:00`))) return datePart;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const compareMovements = (left, right) => {
  const leftTime = Date.parse(left.BDK_Ngay);
  const rightTime = Date.parse(right.BDK_Ngay);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return String(left.BDK_Ma || "").localeCompare(String(right.BDK_Ma || ""), "vi");
};

export function getLedgerMovementCategory(movement) {
  const source = String(movement.BDK_Nguon || "");
  const kind = String(movement.BDK_Loai || "").toLocaleLowerCase("vi-VN");
  if (source === "TraHangNCC" || kind.includes("trả ncc")) return "supplier-return";
  if (source === "HoaDonBanHang" || kind.includes("bán")) return "sale";
  if (source === "PhieuXuatChuyenNoiBo" || kind.includes("chuyển")) return "transfer";
  if (source === "PhieuKiemKeKho" || kind.includes("kiểm kê")) return "count";
  if (source === "PhieuNhap" || kind.includes("nhập")) return "inbound";
  return Number(movement.BDK_SoLuong) < 0 ? "outbound" : "other";
}

function matchesMovementFilter(movement, filter) {
  if (!filter || filter === "all") return true;
  return getLedgerMovementCategory(movement) === filter;
}

export function buildStockLedgerReport(state, filters) {
  const itemId = String(filters.itemId || "");
  const locationId = String(filters.locationId || "");
  const lineId = String(filters.lineId || "");
  const from = String(filters.from || "");
  const to = String(filters.to || "");

  if (!itemId || !locationId || !from || !to) {
    return { complete: false, error: "Hãy chọn sản phẩm, cửa hàng và khoảng thời gian để xem thẻ kho.", rows: [] };
  }
  if (from > to) {
    return { complete: false, error: "Ngày bắt đầu không được sau ngày kết thúc.", rows: [] };
  }

  const details = state.PhieuNhapChiTiet.filter((detail) => (
    detail.HH_Ma === itemId && (!lineId || detail.PNCT_Ma === lineId)
  ));
  const detailIds = new Set(details.map((detail) => detail.PNCT_Ma));
  const movements = state.BienDongKho.filter((movement) => (
    movement.DD_Ma === locationId && detailIds.has(movement.PNCT_Ma)
  ));
  const stockRows = state.TonKho.filter((stock) => (
    stock.DD_Ma === locationId && detailIds.has(stock.PNCT_Ma)
  ));
  const currentByLine = new Map(stockRows.map((stock) => [stock.PNCT_Ma, Number(stock.TK_SL)]));
  const confirmedReceiptLines = state.PhieuNhapChiTiet
    .filter((detail) => detailIds.has(detail.PNCT_Ma))
    .filter((detail) => {
      const receipt = state.PhieuNhap.find((entry) => entry.PN_Ma === detail.PN_Ma);
      return receipt && receipt.DD_Ma === locationId && ["Đã xác nhận", "Hoàn tất", "Đã nhận"].includes(receipt.PN_TrangThai);
    });
  const lineIds = new Set([
    ...movements.map((movement) => movement.PNCT_Ma),
    ...stockRows.map((stock) => stock.PNCT_Ma),
    ...confirmedReceiptLines.map((detail) => detail.PNCT_Ma)
  ]);

  if (details.length === 0) {
    return { complete: false, error: "Không tìm thấy dòng hàng nhập tương ứng với sản phẩm.", rows: [] };
  }
  if (lineIds.size === 0) {
    return { complete: false, error: "Không đủ dữ liệu để xác định tồn lịch sử chính xác.", rows: [], current: 0 };
  }

  let complete = true;
  const movementsByLine = new Map();
  for (const id of lineIds) movementsByLine.set(id, []);
  for (const movement of movements) {
    const quantity = Number(movement.BDK_SoLuong);
    if (!Number.isSafeInteger(quantity) || !asDateKey(movement.BDK_Ngay)) complete = false;
    movementsByLine.get(movement.PNCT_Ma).push(movement);
  }

  let current = 0;
  let ledgerBalance = 0;
  for (const id of lineIds) {
    const lineMovements = movementsByLine.get(id);
    const quantity = currentByLine.has(id) ? currentByLine.get(id) : 0;
    if (!Number.isSafeInteger(quantity) || lineMovements.length === 0) complete = false;
    current += Number.isFinite(quantity) ? quantity : 0;
    ledgerBalance += lineMovements.reduce((sum, movement) => {
      const delta = Number(movement.BDK_SoLuong);
      return sum + (Number.isFinite(delta) ? delta : 0);
    }, 0);
  }
  if (ledgerBalance !== current) complete = false;

  const allValidMovements = movements
    .filter((movement) => asDateKey(movement.BDK_Ngay) && Number.isSafeInteger(Number(movement.BDK_SoLuong)))
    .sort(compareMovements);
  let opening = allValidMovements.reduce((sum, movement) => (
    asDateKey(movement.BDK_Ngay) < from ? sum + Number(movement.BDK_SoLuong) : sum
  ), 0);
  let inbound = 0;
  let outbound = 0;
  const periodRows = allValidMovements.filter((movement) => {
    const date = asDateKey(movement.BDK_Ngay);
    return date >= from && date <= to;
  });
  for (const movement of periodRows) {
    const delta = Number(movement.BDK_SoLuong);
    if (delta > 0) inbound += delta;
    if (delta < 0) outbound += Math.abs(delta);
  }

  let runningBalance = opening;
  const rows = periodRows.map((movement) => {
    runningBalance += Number(movement.BDK_SoLuong);
    return {
      ...movement,
      BDK_SoDuSau: complete ? runningBalance : null,
      BDK_NgayKey: asDateKey(movement.BDK_Ngay),
      category: getLedgerMovementCategory(movement)
    };
  }).filter((movement) => matchesMovementFilter(movement, filters.movementType));

  return {
    complete,
    current,
    opening: complete ? opening : null,
    inbound,
    outbound,
    closing: complete ? opening + periodRows.reduce((sum, movement) => sum + Number(movement.BDK_SoLuong), 0) : null,
    rows,
    totalRows: rows.length,
    lineCount: lineIds.size,
    itemId,
    locationId,
    from,
    to,
    error: complete ? "" : "Không đủ dữ liệu để xác định tồn lịch sử chính xác."
  };
}
