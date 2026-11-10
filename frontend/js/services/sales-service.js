import { applyStockMovement, generateDemoId, getState, runDemoTransaction } from "./kho-service.js";
import { getActivePrice, getValidSaleLots } from "./inventory-service.js";
import {
  attachCashShiftPayment, attachCashShiftSale, detachCashShiftPayment, detachCashShiftSale,
  getCashShiftForPayment, getOpenCashShift
} from "./cash-register-service.js";

const paidStatuses = new Set(["Thành công"]);
const reservedStatuses = new Set(["Thành công", "Chờ xác nhận"]);
const creditRoles = new Set(["Chủ cửa hàng", "Nhân viên kế toán"]);
const sellingRoles = new Set(["Chủ cửa hàng", "Nhân viên bán hàng"]);
const paymentRoles = new Set(["Chủ cửa hàng", "Nhân viên bán hàng"]);
const draftMetadataKey = "stmn-pos-draft-meta-v1";

function readDraftMetadata() {
  const raw = localStorage.getItem(draftMetadataKey);
  if (!raw) return {};
  const metadata = JSON.parse(raw);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Metadata hóa đơn nháp không hợp lệ.");
  return metadata;
}

function writeDraftMetadata(metadata) {
  localStorage.setItem(draftMetadataKey, JSON.stringify(metadata));
}

function allocateInvoiceLines(state, DD_Ma, lines, dateOnly) {
  const requestedLines = new Map();
  for (const line of lines) {
    const quantity = Number(line.BH_SL);
    if (!line.HH_Ma || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Số lượng bán phải là số nguyên lớn hơn 0.");
    const rows = requestedLines.get(line.HH_Ma) || [];
    rows.push({ ...line, quantity });
    requestedLines.set(line.HH_Ma, rows);
  }
  const allocated = [];
  for (const [HH_Ma, requested] of requestedLines) {
    const item = state.HangHoa.find((row) => row.HH_Ma === HH_Ma);
    if (!item || item.HH_TrangThai !== "Đang kinh doanh") throw new Error(`Mặt hàng ${HH_Ma} đã ngừng kinh doanh hoặc không tồn tại.`);
    const activePrice = getActivePrice(HH_Ma, dateOnly, state);
    if (activePrice.error) throw new Error(`${item.HH_Ten}: ${activePrice.error}`);
    const quantity = requested.reduce((sum, line) => {
      const total = sum + line.quantity;
      if (!Number.isSafeInteger(total)) throw new Error(`Tổng số lượng ${item.HH_Ten} vượt giới hạn cho phép.`);
      return total;
    }, 0);
    const salePrices = requested.map((line) => {
      if (line.GB_GiaGoc !== undefined && Number(line.GB_GiaGoc) !== activePrice.price) {
        throw new Error(`Giá hiện hành của ${item.HH_Ten} đã thay đổi. Cập nhật giá và xác nhận lại hóa đơn.`);
      }
      const salePrice = line.BH_DonGia === undefined ? activePrice.price : Number(line.BH_DonGia);
      if (!Number.isSafeInteger(salePrice) || salePrice < 0 || salePrice > activePrice.price) {
        throw new Error(`Đơn giá thực bán của ${item.HH_Ten} không hợp lệ.`);
      }
      return salePrice;
    });
    const lots = getValidSaleLots(DD_Ma, HH_Ma, dateOnly, state);
    const available = lots.reduce((sum, lot) => sum + lot.stock.TK_SL, 0);
    if (quantity > available) throw new Error(`${item.HH_Ten}: tồn có thể bán tại cửa hàng là ${available}, không đủ ${quantity}.`);
    let lotIndex = 0;
    let lotRemaining = lots[0]?.stock.TK_SL || 0;
    for (let index = 0; index < requested.length; index += 1) {
      const line = requested[index];
      let remaining = line.quantity;
      const salePrice = salePrices[index];
      while (remaining > 0) {
        while (lotIndex < lots.length && lotRemaining <= 0) {
          lotIndex += 1;
          lotRemaining = lots[lotIndex]?.stock.TK_SL || 0;
        }
        if (lotIndex >= lots.length) throw new Error(`Không thể phân bổ FEFO tồn kho cho ${item.HH_Ten}.`);
        const sold = Math.min(remaining, lotRemaining);
        const lineTotal = sold * salePrice;
        if (!Number.isSafeInteger(lineTotal)) throw new Error(`Thành tiền ${item.HH_Ten} vượt giới hạn cho phép.`);
        allocated.push({
          BH_Ma: "",
          PNCT_Ma: lots[lotIndex].line.PNCT_Ma,
          BH_SL: sold,
          BH_DonGia: salePrice,
          BH_TTien: lineTotal
        });
        remaining -= sold;
        lotRemaining -= sold;
      }
    }
  }
  return allocated;
}

function invoiceTotals(lines) {
  const totalQuantity = lines.reduce((sum, line) => sum + line.BH_SL, 0);
  const total = lines.reduce((sum, line) => sum + line.BH_TTien, 0);
  if (!Number.isSafeInteger(totalQuantity) || !Number.isSafeInteger(total)) {
    throw new Error("Tổng số lượng hoặc thành tiền hóa đơn vượt giới hạn số chính xác.");
  }
  return { totalQuantity, total };
}

function totalPaid(state, BH_Ma) {
  return state.ThanhToanBanHang
    .filter((row) => row.BH_Ma === BH_Ma && paidStatuses.has(row.TTBH_TrangThai))
    .reduce((sum, row) => sum + row.TTBH_SoTien, 0);
}

function totalReserved(state, BH_Ma) {
  return state.ThanhToanBanHang
    .filter((row) => row.BH_Ma === BH_Ma && reservedStatuses.has(row.TTBH_TrangThai))
    .reduce((sum, row) => sum + row.TTBH_SoTien, 0);
}

function syncDebt(state, invoice) {
  if (!invoice.DT_Ma) return;
  const due = invoice.BH_TongCong - totalPaid(state, invoice.BH_Ma);
  let debt = state.CongNoKhachHang.find((row) => row.BH_Ma === invoice.BH_Ma);
  if (due > 0 && !debt) {
    debt = {
      CNKH_Ma: generateDemoId("CNKH", state.CongNoKhachHang, "CNKH_Ma"),
      BH_Ma: invoice.BH_Ma,
      CNKH_TrangThai: "Còn nợ"
    };
    state.CongNoKhachHang.push(debt);
  }
  if (debt) debt.CNKH_TrangThai = due > 0 ? "Còn nợ" : "Đã thanh toán";
}

function validatePaymentAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Số tiền thanh toán phải là số nguyên VND không âm.");
}

function getPaymentAllocations(payment) {
  const allocations = Array.isArray(payment?.allocations)
    ? payment.allocations.map(({ amount, method }) => ({ amount: Number(amount), method: String(method || "") }))
    : [{ amount: Number(payment?.amount ?? 0), method: String(payment?.method || "Tiền mặt") }];
  for (const allocation of allocations) {
    validatePaymentAmount(allocation.amount);
    if (!["Tiền mặt", "Chuyển khoản", "QR"].includes(allocation.method)) {
      throw new Error("Phương thức thanh toán không hợp lệ.");
    }
  }
  return allocations.filter((row) => row.amount > 0);
}

function ensureSuccessfulSalesReceipt(state, payment, collectorId, sourceHint = "") {
  if (payment.TTBH_TrangThai !== "Thành công") throw new Error("Chỉ tạo phiếu thu cho thanh toán bán hàng thành công.");
  if (!Number.isSafeInteger(payment.TTBH_SoTien) || payment.TTBH_SoTien <= 0) {
    throw new Error("Số tiền thanh toán nguồn không hợp lệ; chưa thể tạo phiếu thu.");
  }
  if (!payment.TTBH_Ngay || Number.isNaN(Date.parse(payment.TTBH_Ngay))) {
    throw new Error("Ngày thanh toán nguồn không hợp lệ; chưa thể tạo phiếu thu.");
  }
  if (!["Tiền mặt", "QR", "Chuyển khoản"].includes(payment.TTBH_PhuongThuc)) {
    throw new Error("Phương thức thanh toán nguồn không hợp lệ; chưa thể tạo phiếu thu.");
  }
  const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === payment.BH_Ma && row.BH_TrangThai === "Đã xác nhận");
  if (!invoice) throw new Error("Không tìm thấy hóa đơn đã xác nhận của thanh toán nguồn.");
  const linkedShift = getCashShiftForPayment(payment.TTBH_Ma);
  const source = sourceHint || (linkedShift
    ? linkedShift.invoiceIds.includes(payment.BH_Ma) ? "Bán hàng POS" : "Thu nợ khách hàng"
    : "Cần đối chiếu");
  const linked = state.PhieuThu.filter((row) => row.TTBH_Ma === payment.TTBH_Ma);
  if (linked.length > 1) throw new Error(`Thanh toán ${payment.TTBH_Ma} đã liên kết với nhiều phiếu thu.`);
  const existing = linked[0];
  if (existing) {
    if (existing.PT_SoTien !== payment.TTBH_SoTien || existing.PT_PhuongThuc !== payment.TTBH_PhuongThuc
      || (existing.DT_Ma || null) !== (invoice.DT_Ma || null)
      || String(existing.PT_Ngay).slice(0, 10) !== String(payment.TTBH_Ngay).slice(0, 10)
      || existing.PT_TrangThai === "Đã hủy") {
      throw new Error(`Phiếu thu ${existing.PT_Ma} không khớp thanh toán ${payment.TTBH_Ma}; cần đối chiếu thủ công.`);
    }
    if (existing.PT_TrangThai === "Nháp") existing.PT_TrangThai = "Đã xác nhận";
    return existing.PT_Ma;
  }
  const voucher = {
    PT_Ma: generateDemoId("PT", state.PhieuThu, "PT_Ma"),
    DT_Ma: invoice.DT_Ma || null,
    NV_Ma: collectorId || invoice.NV_Ma,
    TTBH_Ma: payment.TTBH_Ma,
    PT_Ngay: payment.TTBH_Ngay,
    PT_SoTien: payment.TTBH_SoTien,
    PT_LyDo: `${source === "Thu nợ khách hàng" ? "Thu nợ khách hàng" : "Thu tiền bán hàng"} - Hóa đơn ${invoice.BH_Ma}`,
    PT_PhuongThuc: payment.TTBH_PhuongThuc,
    PT_TrangThai: "Đã xác nhận",
    PT_GhiChu: `Tự động tạo từ thanh toán ${payment.TTBH_Ma}. Nguồn: ${source}.`
  };
  state.PhieuThu.push(voucher);
  return voucher.PT_Ma;
}

export function syncSuccessfulSalesReceipt(TTBH_Ma, role) {
  if (!creditRoles.has(role)) throw new Error("Chỉ kế toán hoặc chủ cửa hàng được đồng bộ phiếu thu.");
  return runDemoTransaction((state) => {
    const payment = state.ThanhToanBanHang.find((row) => row.TTBH_Ma === TTBH_Ma);
    if (!payment) throw new Error("Không tìm thấy giao dịch thanh toán bán hàng.");
    if (payment.TTBH_TrangThai !== "Thành công") throw new Error("Chỉ đồng bộ giao dịch thanh toán đã thành công.");
    const existing = state.PhieuThu.find((row) => row.TTBH_Ma === TTBH_Ma);
    if (existing) return { PT_Ma: ensureSuccessfulSalesReceipt(state, payment, existing.NV_Ma), created: false };
    const shift = getCashShiftForPayment(TTBH_Ma);
    return { PT_Ma: ensureSuccessfulSalesReceipt(state, payment, shift?.NV_Ma), created: true };
  });
}

export function syncMissingSuccessfulSalesReceipts(role) {
  if (!creditRoles.has(role)) throw new Error("Chỉ kế toán hoặc chủ cửa hàng được đồng bộ phiếu thu.");
  return runDemoTransaction((state) => state.ThanhToanBanHang
    .filter((payment) => payment.TTBH_TrangThai === "Thành công"
      && !state.PhieuThu.some((voucher) => voucher.TTBH_Ma === payment.TTBH_Ma))
    .map((payment) => {
      const shift = getCashShiftForPayment(payment.TTBH_Ma);
      return ensureSuccessfulSalesReceipt(state, payment, shift?.NV_Ma);
    }));
}

export function getInvoiceOutstanding(BH_Ma, state = getState()) {
  const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === BH_Ma);
  if (!invoice) throw new Error("Không tìm thấy hóa đơn.");
  if (invoice.BH_TrangThai !== "Đã xác nhận") return 0;
  return Math.max(0, invoice.BH_TongCong - totalPaid(state, BH_Ma));
}

export function getInvoicePaid(BH_Ma, state = getState()) {
  return totalPaid(state, BH_Ma);
}

export function getCustomerDebt(DT_Ma, state = getState()) {
  return state.HoaDonBanHang
    .filter((invoice) => invoice.DT_Ma === DT_Ma && invoice.BH_TrangThai === "Đã xác nhận")
    .reduce((sum, invoice) => sum + getInvoiceOutstanding(invoice.BH_Ma, state), 0);
}

export function createDraftInvoice({ BH_Ma = "", DD_Ma, NV_Ma, DT_Ma = null, lines, role = "", metadata: extraMetadata = {} }) {
  if (!sellingRoles.has(role)) throw new Error("Vai trò hiện tại không được lưu hóa đơn nháp.");
  if (!DD_Ma || !NV_Ma || !Array.isArray(lines) || !lines.length) throw new Error("Hóa đơn cần địa điểm, nhân viên và ít nhất một mặt hàng.");
  const date = new Date().toISOString();
  const dateOnly = date.slice(0, 10);
  const requestedId = BH_Ma || generateDemoId("BH", getState().HoaDonBanHang, "BH_Ma");
  const previousMetadata = readDraftMetadata();
  const metadata = { ...previousMetadata };
  metadata[requestedId] = {
    ...metadata[requestedId],
    ...extraMetadata,
    createdAt: metadata[requestedId]?.createdAt || date,
    updatedAt: date,
    lines
  };
  writeDraftMetadata(metadata);
  try {
    return runDemoTransaction((state) => {
      if (DT_Ma) {
        const customer = state.DoiTacKinhDoanh.find((row) => row.DT_Ma === DT_Ma && ["Khách hàng", "Cả hai"].includes(row.DT_Loai) && row.DT_TrangThai === "Hoạt động");
        if (!customer) throw new Error("Khách hàng không hợp lệ hoặc đã ngừng hoạt động.");
      }
      const invoiceLines = allocateInvoiceLines(state, DD_Ma, lines, dateOnly);
      let invoice = BH_Ma ? state.HoaDonBanHang.find((row) => row.BH_Ma === BH_Ma) : null;
      if (BH_Ma && (!invoice || invoice.BH_TrangThai !== "Nháp")) throw new Error("Chỉ có thể cập nhật hóa đơn đang ở trạng thái nháp.");
      const invoiceId = invoice?.BH_Ma || requestedId;
      if (!invoice && state.HoaDonBanHang.some((row) => row.BH_Ma === invoiceId)) throw new Error("Mã hóa đơn đã tồn tại.");
      if (invoice && (state.ThanhToanBanHang.some((row) => row.BH_Ma === invoiceId) || state.CongNoKhachHang.some((row) => row.BH_Ma === invoiceId))) {
        throw new Error("Hóa đơn nháp có phát sinh thanh toán hoặc công nợ, không thể cập nhật.");
      }
      for (const row of invoiceLines) row.BH_Ma = invoiceId;
      const { totalQuantity, total } = invoiceTotals(invoiceLines);
      if (invoice) {
        invoice.DT_Ma = DT_Ma || null;
        invoice.NV_Ma = NV_Ma;
        invoice.DD_Ma = DD_Ma;
        invoice.BH_Ngay = date;
        invoice.BH_TongSL = totalQuantity;
        invoice.BH_TongCong = total;
        state.HoaDonBanHangChiTiet = state.HoaDonBanHangChiTiet.filter((row) => row.BH_Ma !== invoiceId);
      } else {
        invoice = {
          BH_Ma: invoiceId, DT_Ma: DT_Ma || null, NV_Ma, DD_Ma,
          BH_Ngay: date, BH_TongSL: totalQuantity, BH_TongCong: total,
          BH_TrangThai: "Nháp"
        };
        state.HoaDonBanHang.push(invoice);
      }
      state.HoaDonBanHangChiTiet.push(...invoiceLines);
      return invoiceId;
    });
  } catch (error) {
    if (previousMetadata[requestedId]) metadata[requestedId] = previousMetadata[requestedId];
    else delete metadata[requestedId];
    writeDraftMetadata(metadata);
    throw error;
  }
}

export function getDraftInvoiceMetadata(BH_Ma) {
  return readDraftMetadata()[BH_Ma] || null;
}

export function deleteDraftInvoice(BH_Ma, role = "") {
  if (!sellingRoles.has(role)) throw new Error("Vai trò hiện tại không được xóa hóa đơn nháp.");
  runDemoTransaction((state) => {
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === BH_Ma);
    if (!invoice || invoice.BH_TrangThai !== "Nháp") throw new Error("Chỉ có thể xóa hóa đơn đang ở trạng thái nháp.");
    if (state.ThanhToanBanHang.some((row) => row.BH_Ma === BH_Ma) ||
        state.CongNoKhachHang.some((row) => row.BH_Ma === BH_Ma) ||
        state.BienDongKho.some((row) => row.BDK_MaChungTu === BH_Ma)) {
      throw new Error("Không thể xóa nháp đã phát sinh giao dịch.");
    }
    state.HoaDonBanHang = state.HoaDonBanHang.filter((row) => row.BH_Ma !== BH_Ma);
    state.HoaDonBanHangChiTiet = state.HoaDonBanHangChiTiet.filter((row) => row.BH_Ma !== BH_Ma);
  });
  const metadata = readDraftMetadata();
  delete metadata[BH_Ma];
  writeDraftMetadata(metadata);
}

export function createInvoice({ BH_Ma = "", DD_Ma, NV_Ma, DT_Ma = null, lines, payment, allowCredit = false, role = "" }) {
  const shift = getOpenCashShift(NV_Ma, DD_Ma);
  if (!shift) throw new Error("Hãy mở ca bán hàng tại đúng địa điểm trước khi xác nhận hóa đơn.");
  const initialState = getState();
  const paymentAllocations = getPaymentAllocations(payment);
  const invoiceId = BH_Ma || generateDemoId("BH", initialState.HoaDonBanHang, "BH_Ma");
  const paymentIdRows = initialState.ThanhToanBanHang.slice();
  const createdPaymentIds = paymentAllocations.map(() => {
    const id = generateDemoId("TTBH", paymentIdRows, "TTBH_Ma");
    paymentIdRows.push({ TTBH_Ma: id });
    return id;
  });
  attachCashShiftSale(shift.Ca_Ma, invoiceId, createdPaymentIds);
  try {
    runDemoTransaction((state) => {
      if (!sellingRoles.has(role)) throw new Error("Vai trò hiện tại không được xác nhận hóa đơn bán hàng.");
      if (!DD_Ma || !NV_Ma || !Array.isArray(lines) || !lines.length) throw new Error("Hóa đơn cần địa điểm, nhân viên và ít nhất một mặt hàng.");
      if (DT_Ma) {
        const customer = state.DoiTacKinhDoanh.find((row) => row.DT_Ma === DT_Ma && ["Khách hàng", "Cả hai"].includes(row.DT_Loai) && row.DT_TrangThai === "Hoạt động");
        if (!customer) throw new Error("Khách hàng không hợp lệ hoặc đã ngừng hoạt động.");
      }
      const date = new Date().toISOString();
      const dateOnly = date.slice(0, 10);
      const invoiceLines = allocateInvoiceLines(state, DD_Ma, lines, dateOnly);
      const { totalQuantity, total } = invoiceTotals(invoiceLines);
      const reservedAtCheckout = paymentAllocations.reduce((sum, row) => sum + row.amount, 0);
      if (reservedAtCheckout > total) throw new Error("Tổng thanh toán không được vượt tổng hóa đơn.");
      const due = total - reservedAtCheckout;
      if (due > 0 && (!DT_Ma || !allowCredit || !creditRoles.has(role))) {
        throw new Error("Hóa đơn chưa được thanh toán đủ. Cần khách hàng đã lưu, quyền cho phép ghi nợ và xác nhận ghi nợ.");
      }
      let invoice = BH_Ma ? state.HoaDonBanHang.find((row) => row.BH_Ma === BH_Ma) : null;
      if (BH_Ma && (!invoice || invoice.BH_TrangThai !== "Nháp")) throw new Error("Chỉ có thể hoàn tất hóa đơn đang ở trạng thái nháp.");
      if (!BH_Ma && state.HoaDonBanHang.some((row) => row.BH_Ma === invoiceId)) {
        throw new Error("Mã hóa đơn vừa được sử dụng ở một giao dịch khác. Hãy xác nhận lại.");
      }
      if (invoice && (state.ThanhToanBanHang.some((row) => row.BH_Ma === BH_Ma) || state.CongNoKhachHang.some((row) => row.BH_Ma === BH_Ma))) {
        throw new Error("Hóa đơn nháp đã phát sinh thanh toán hoặc công nợ.");
      }
      for (const row of invoiceLines) row.BH_Ma = invoiceId;
      if (invoice) {
        invoice.DT_Ma = DT_Ma || null;
        invoice.NV_Ma = NV_Ma;
        invoice.DD_Ma = DD_Ma;
        invoice.BH_Ngay = date;
        invoice.BH_TongSL = totalQuantity;
        invoice.BH_TongCong = total;
        invoice.BH_TrangThai = "Đã xác nhận";
        state.HoaDonBanHangChiTiet = state.HoaDonBanHangChiTiet.filter((row) => row.BH_Ma !== invoiceId);
      } else {
        invoice = {
          BH_Ma: invoiceId,
          DT_Ma: DT_Ma || null,
          NV_Ma,
          DD_Ma,
          BH_Ngay: date,
          BH_TongSL: totalQuantity,
          BH_TongCong: total,
          BH_TrangThai: "Đã xác nhận"
        };
        state.HoaDonBanHang.push(invoice);
      }
      state.HoaDonBanHangChiTiet.push(...invoiceLines);
      for (const line of invoiceLines) {
        applyStockMovement(state, {
          DD_Ma, PNCT_Ma: line.PNCT_Ma, amount: -line.BH_SL,
          BDK_Loai: "Bán hàng", BDK_Nguon: "HoaDonBanHang",
          BDK_MaChungTu: invoice.BH_Ma, NV_Ma,
          BDK_GhiChu: "Xác nhận bán tại POS"
        });
      }
      for (const [index, allocation] of paymentAllocations.entries()) {
        const TTBH_Ma = createdPaymentIds[index];
        if (state.ThanhToanBanHang.some((row) => row.TTBH_Ma === TTBH_Ma)) {
          throw new Error("Mã thanh toán vừa được sử dụng ở một giao dịch khác. Hãy xác nhận lại.");
        }
        state.ThanhToanBanHang.push({
          TTBH_Ma,
          BH_Ma: invoice.BH_Ma,
          TTBH_Ngay: date,
          TTBH_SoTien: allocation.amount,
          TTBH_PhuongThuc: allocation.method,
          TTBH_TrangThai: allocation.method === "Tiền mặt" ? "Thành công" : "Chờ xác nhận"
        });
        if (allocation.method === "Tiền mặt") {
          ensureSuccessfulSalesReceipt(state, state.ThanhToanBanHang[state.ThanhToanBanHang.length - 1], NV_Ma, "Bán hàng POS");
        }
      }
      syncDebt(state, invoice);
    });
  } catch (error) {
    try {
      detachCashShiftSale(shift.Ca_Ma, invoiceId, createdPaymentIds);
    } catch (cleanupError) {
      throw new Error(`Không thể xác nhận hóa đơn: ${error.message}. Không thể gỡ liên kết tạm với ca ${shift.Ca_Ma}: ${cleanupError.message}`);
    }
    throw error;
  }
  if (BH_Ma) {
    const metadata = readDraftMetadata();
    delete metadata[BH_Ma];
    writeDraftMetadata(metadata);
  }
  return invoiceId;
}

export function recordPayment(BH_Ma, { amount, method, role = "", cashierId = "", locationId = "" }) {
  const state = getState();
  const invoiceForPayment = state.HoaDonBanHang.find((row) => row.BH_Ma === BH_Ma && row.BH_TrangThai === "Đã xác nhận");
  if (!invoiceForPayment) throw new Error("Chỉ có thể thanh toán hóa đơn đã xác nhận.");
  const shift = getOpenCashShift(cashierId, locationId || invoiceForPayment.DD_Ma);
  if (!shift) throw new Error("Hãy mở ca bán hàng tại đúng địa điểm trước khi thu tiền.");
  const paymentId = generateDemoId("TTBH", state.ThanhToanBanHang, "TTBH_Ma");
  attachCashShiftPayment(shift.Ca_Ma, paymentId);
  try {
    runDemoTransaction((draft) => {
      if (!paymentRoles.has(role)) throw new Error("Chỉ thu ngân hoặc Chủ cửa hàng đang có ca mở được ghi nhận thanh toán bán hàng.");
      const invoice = draft.HoaDonBanHang.find((row) => row.BH_Ma === BH_Ma && row.BH_TrangThai === "Đã xác nhận");
      if (!invoice) throw new Error("Chỉ có thể thanh toán hóa đơn đã xác nhận.");
      if (draft.ThanhToanBanHang.some((row) => row.TTBH_Ma === paymentId)) {
        throw new Error("Mã thanh toán vừa được sử dụng ở một giao dịch khác. Hãy xác nhận lại.");
      }
      const paymentAmount = Number(amount);
      if (!Number.isSafeInteger(paymentAmount) || paymentAmount <= 0) throw new Error("Số tiền thanh toán phải lớn hơn 0.");
      if (!["Tiền mặt", "Chuyển khoản", "QR"].includes(method)) throw new Error("Phương thức thanh toán không hợp lệ.");
      const outstanding = invoice.BH_TongCong - totalReserved(draft, BH_Ma);
      if (paymentAmount > outstanding) throw new Error(`Số tiền vượt số còn phải thu (${Math.max(0, outstanding)} ₫).`);
      const payment = {
        TTBH_Ma: paymentId,
        BH_Ma,
        TTBH_Ngay: new Date().toISOString(),
        TTBH_SoTien: paymentAmount,
        TTBH_PhuongThuc: method,
        TTBH_TrangThai: method === "Tiền mặt" ? "Thành công" : "Chờ xác nhận"
      };
      draft.ThanhToanBanHang.push(payment);
      if (payment.TTBH_TrangThai === "Thành công") ensureSuccessfulSalesReceipt(draft, payment, cashierId, "Thu nợ khách hàng");
      syncDebt(draft, invoice);
    });
  } catch (error) {
    try {
      detachCashShiftPayment(shift.Ca_Ma, paymentId);
    } catch (cleanupError) {
      throw new Error(`Không thể ghi nhận thanh toán: ${error.message}. Không thể gỡ thanh toán tạm khỏi ca ${shift.Ca_Ma}: ${cleanupError.message}`);
    }
    throw error;
  }
  return paymentId;
}

export function confirmPayment(TTBH_Ma, role) {
  return runDemoTransaction((state) => {
    if (!creditRoles.has(role)) throw new Error("Chỉ kế toán hoặc chủ cửa hàng được xác nhận giao dịch không dùng tiền mặt trong demo.");
    const payment = state.ThanhToanBanHang.find((row) => row.TTBH_Ma === TTBH_Ma);
    if (!payment || payment.TTBH_TrangThai !== "Chờ xác nhận") throw new Error("Giao dịch không còn chờ xác nhận.");
    const shift = getCashShiftForPayment(TTBH_Ma);
    if (!shift || shift.TrangThai !== "Đang mở") {
      throw new Error("Thanh toán chưa gắn với một ca đang mở. Không thể xác nhận âm thầm vào ca đã đóng.");
    }
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === payment.BH_Ma);
    if (!invoice || totalPaid(state, invoice.BH_Ma) + payment.TTBH_SoTien > invoice.BH_TongCong) throw new Error("Xác nhận giao dịch sẽ làm tổng thu vượt hóa đơn.");
    payment.TTBH_TrangThai = "Thành công";
    const source = shift?.invoiceIds.includes(invoice.BH_Ma) ? "Bán hàng POS" : "Thu nợ khách hàng";
    ensureSuccessfulSalesReceipt(state, payment, shift?.NV_Ma || invoice.NV_Ma, source);
    syncDebt(state, invoice);
  });
}

export function setPaymentStatus(TTBH_Ma, status, role) {
  if (!["Thất bại", "Đã hủy"].includes(status)) throw new Error("Trạng thái giao dịch không được hỗ trợ.");
  return runDemoTransaction((state) => {
    if (!creditRoles.has(role)) throw new Error("Chỉ kế toán hoặc chủ cửa hàng được đối chiếu giao dịch trong demo.");
    const payment = state.ThanhToanBanHang.find((row) => row.TTBH_Ma === TTBH_Ma);
    if (!payment || payment.TTBH_TrangThai !== "Chờ xác nhận") throw new Error("Chỉ được cập nhật giao dịch đang chờ xác nhận.");
    payment.TTBH_TrangThai = status;
    const invoice = state.HoaDonBanHang.find((row) => row.BH_Ma === payment.BH_Ma);
    if (invoice) syncDebt(state, invoice);
  });
}
