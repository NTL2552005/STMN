export const PURCHASE_ORDER_STATUSES = {
  draft: "Nháp",
  waiting: "Chờ giao",
  partial: "Đã nhận một phần",
  complete: "Đã nhận đủ",
  cancelled: "Đã hủy"
};

const isConfirmedReceipt = (receipt) => receipt.PN_TrangThai === "Đã xác nhận";
const isReservedReceipt = (receipt) => ["Nháp", "Chờ kế toán xác nhận"].includes(receipt.PN_TrangThai);

function sumReceiptLines(state, receipts) {
  const totals = new Map();
  const receiptIds = new Set(receipts.map((receipt) => receipt.PN_Ma));
  for (const line of state.PhieuNhapChiTiet) {
    if (!receiptIds.has(line.PN_Ma)) continue;
    totals.set(line.HH_Ma, (totals.get(line.HH_Ma) || 0) + Number(line.PNCT_SL || 0));
  }
  return totals;
}

export function getPurchaseOrderReceiptSummary(state, order) {
  const orderLines = state.DatChiTiet.filter((line) => line.DH_Ma === order.DH_Ma);
  const relatedReceipts = state.PhieuNhap.filter((receipt) => receipt.DH_Ma === order.DH_Ma);
  const confirmed = sumReceiptLines(state, relatedReceipts.filter(isConfirmedReceipt));
  const reserved = sumReceiptLines(state, relatedReceipts.filter(isReservedReceipt));
  const lines = orderLines.map((line) => {
    const ordered = Number(line.DN_SL || 0);
    const received = confirmed.get(line.HH_Ma) || 0;
    const pending = reserved.get(line.HH_Ma) || 0;
    return {
      ...line,
      ordered,
      received,
      pending,
      remaining: Math.max(0, ordered - received),
      availableToReceive: Math.max(0, ordered - received - pending)
    };
  });
  const totalOrdered = lines.reduce((sum, line) => sum + line.ordered, 0);
  const totalReceived = lines.reduce((sum, line) => sum + line.received, 0);
  const totalOutstandingValue = lines.reduce((sum, line) => (
    sum + Math.max(0, line.ordered - line.received) * Number(line.DN_DonGia || 0)
  ), 0);
  let status = order.DH_TrangThai || PURCHASE_ORDER_STATUSES.waiting;
  if (status !== PURCHASE_ORDER_STATUSES.draft && status !== PURCHASE_ORDER_STATUSES.cancelled) {
    status = lines.length > 0 && lines.every((line) => line.received >= line.ordered)
      ? PURCHASE_ORDER_STATUSES.complete
      : totalReceived > 0
        ? PURCHASE_ORDER_STATUSES.partial
        : PURCHASE_ORDER_STATUSES.waiting;
  }
  return {
    order,
    lines,
    receipts: relatedReceipts,
    totalOrdered,
    totalReceived,
    totalOutstandingValue,
    status
  };
}

export function getPurchaseOrderAvailableQuantities(state, orderId, excludeReceiptId = "") {
  const order = state.DatHang.find((row) => row.DH_Ma === orderId);
  if (!order) throw new Error("Không tìm thấy đơn đặt hàng.");
  const relatedReceipts = state.PhieuNhap.filter((receipt) => (
    receipt.DH_Ma === orderId && receipt.PN_Ma !== excludeReceiptId
  ));
  const confirmed = sumReceiptLines(state, relatedReceipts.filter(isConfirmedReceipt));
  const reserved = sumReceiptLines(state, relatedReceipts.filter(isReservedReceipt));
  return new Map(state.DatChiTiet.filter((line) => line.DH_Ma === orderId).map((line) => [
    line.HH_Ma,
    Math.max(0, Number(line.DN_SL || 0) - (confirmed.get(line.HH_Ma) || 0) - (reserved.get(line.HH_Ma) || 0))
  ]));
}

export function getConfirmedOrderRemainingQuantities(state, orderId) {
  const order = state.DatHang.find((row) => row.DH_Ma === orderId);
  if (!order) throw new Error("Không tìm thấy đơn đặt hàng.");
  const relatedReceipts = state.PhieuNhap.filter((receipt) => receipt.DH_Ma === orderId && isConfirmedReceipt(receipt));
  const confirmed = sumReceiptLines(state, relatedReceipts);
  return new Map(state.DatChiTiet.filter((line) => line.DH_Ma === orderId).map((line) => [
    line.HH_Ma,
    Math.max(0, Number(line.DN_SL || 0) - (confirmed.get(line.HH_Ma) || 0))
  ]));
}

export function validateOrderReceiptLines(state, orderId, lines, excludeReceiptId = "", confirmedOnly = false) {
  const order = state.DatHang.find((row) => row.DH_Ma === orderId);
  if (!order) throw new Error("Không tìm thấy đơn đặt hàng.");
  const status = getPurchaseOrderReceiptSummary(state, order).status;
  if ([PURCHASE_ORDER_STATUSES.draft, PURCHASE_ORDER_STATUSES.cancelled, PURCHASE_ORDER_STATUSES.complete].includes(status)) {
    throw new Error("Đơn đặt hàng chưa được xác nhận, đã hủy hoặc đã nhận đủ.");
  }
  const remaining = confirmedOnly
    ? getConfirmedOrderRemainingQuantities(state, orderId)
    : getPurchaseOrderAvailableQuantities(state, orderId, excludeReceiptId);
  const orderProducts = new Set(state.DatChiTiet.filter((line) => line.DH_Ma === orderId).map((line) => line.HH_Ma));
  const requested = new Map();
  for (const line of lines) {
    const quantity = Number(line.PNCT_SL);
    if (!orderProducts.has(line.HH_Ma)) {
      throw new Error(`${line.HH_Ma} không nằm trong đơn đặt hàng ${orderId}.`);
    }
    requested.set(line.HH_Ma, (requested.get(line.HH_Ma) || 0) + quantity);
  }
  for (const [itemId, quantity] of requested) {
    const available = remaining.get(itemId) || 0;
    if (quantity > available) {
      throw new Error(`Số lượng ${itemId} vượt số còn được nhận: còn ${available}, đang nhập ${quantity}.`);
    }
  }
}
