import { authenticatedApiRequest } from "./auth-service.js";

const API = "/api/";

async function listAll(path) {
  const rows = [];
  let next = path;
  while (next) {
    const response = await authenticatedApiRequest(next);
    if (Array.isArray(response)) return response;
    if (!Array.isArray(response?.results)) {
      throw new Error(`Backend trả về danh sách không hợp lệ tại ${path}.`);
    }
    rows.push(...response.results);
    if (!response.next) {
      next = "";
      continue;
    }
    const nextUrl = new URL(response.next, window.location.origin);
    if (!nextUrl.pathname.startsWith("/api/")) {
      throw new Error("Backend trả về đường dẫn phân trang không hợp lệ.");
    }
    next = `${nextUrl.pathname}${nextUrl.search}`;
  }
  return rows;
}

function mapReceipt(row) {
  return {
    PN_Ma: row.PN_Ma,
    DH_Ma: row.DH_Ma || "",
    DT_Ma: row.DT_Ma,
    DD_Ma: row.DD_Ma,
    NV_Ma: row.NV_Ma || "",
    PN_Ngay: row.PN_Ngay,
    PN_TongSL: row.PN_TongSL,
    PN_TongTien: row.PN_TongTien,
    PN_TrangThai: row.PN_TrangThai,
    lines: row.lines || []
  };
}

function mapDebt(row) {
  const principal = Math.max(0, row.receipt_amount - row.returned_amount);
  return {
    CTNNCC_Ma: row.code,
    CNNCC_Ma: row.supplier_code,
    PN_Ma: row.code,
    CTNNCC_SoTienNo: principal,
    CTNNCC_TrangThai: row.balance > 0 ? "Còn nợ" : "Đã thanh toán",
    CTNNCC_GhiChu: ""
  };
}

function mapVoucher(row, type) {
  const receipt = type === "receipt";
  return receipt ? {
    PT_Ma: row.code,
    TTBH_Ma: row.sale_payment_code || null,
    DT_Ma: row.customer_code || null,
    NV_Ma: row.employee_code || "",
    PT_Ngay: row.voucher_date,
    PT_SoTien: row.amount,
    PT_LyDo: row.reason,
    PT_PhuongThuc: row.method,
    PT_TrangThai: row.status,
    PT_GhiChu: row.note || ""
  } : {
    PC_Ma: row.code,
    TTNCC_Ma: row.supplier_payment_code || null,
    DT_Ma: row.supplier_code || null,
    NV_Ma: row.employee_code || "",
    PC_Ngay: row.voucher_date,
    PC_SoTien: row.amount,
    PC_LyDo: row.reason,
    PC_PhuongThuc: row.method,
    PC_TrangThai: row.status,
    PC_GhiChu: row.note || ""
  };
}

function mapPurchaseReconciliation(row) {
  return {
    PN_Ma: row.receipt,
    DH_Ma: row.order || "",
    progress: row.progress,
    comparison: (row.comparison || []).map((line) => ({
      HH_Ma: line.product,
      orderQty: line.order_quantity,
      currentQty: line.receipt_quantity,
      deliveredQty: line.delivered_quantity,
      quantityDelta: line.quantity_delta,
      orderUnitPrice: line.order_unit_price,
      currentUnitPrice: line.receipt_unit_price,
      priceDelta: line.receipt_unit_price - line.order_unit_price,
      amount: line.amount
    }))
  };
}

function mapShift(row) {
  return {
    ...row,
    invoiceIds: row.invoiceIds || [],
    paymentIds: row.paymentIds || []
  };
}

export async function loadAccountingState() {
  const [
    partners, suppliers, locations, products, receipts, stock, movements, counts,
    transfers, returns, debts, supplierPayments, receiptVouchers, expenseVouchers,
    invoices, salesPayments, shifts, purchaseReconciliations, accountingReports
  ] = await Promise.all([
    listAll(`${API}customers/partners/?page_size=100`),
    listAll(`${API}suppliers/?page_size=100`),
    listAll(`${API}inventory/locations/?page_size=100`),
    listAll(`${API}catalog/products/?page_size=100`),
    listAll(`${API}inventory/receipts/?page_size=100`),
    listAll(`${API}inventory/stock/?view=detail&page_size=100`),
    listAll(`${API}inventory/movements/?page_size=100`),
    listAll(`${API}inventory/stock-counts/?page_size=100`),
    listAll(`${API}inventory/transfers/?page_size=100`),
    listAll(`${API}inventory/supplier-returns/?page_size=100`),
    listAll(`${API}accounting/supplier-debts/`),
    listAll(`${API}accounting/supplier-payments/`),
    listAll(`${API}accounting/receipts/`),
    listAll(`${API}accounting/expenses/`),
    listAll(`${API}sales/invoices/`),
    listAll(`${API}sales/payments/`),
    listAll(`${API}shifts/`),
    listAll(`${API}accounting/purchase-reconciliation/`),
    authenticatedApiRequest(`${API}accounting/reports/`)
  ]);

  const normalizedReceipts = receipts.map(mapReceipt);
  const normalizedDebts = debts.map(mapDebt);
  const normalizedInvoices = invoices.map((row) => ({
    BH_Ma: row.BH_Ma,
    DD_Ma: row.DD_Ma,
    NV_Ma: row.NV_Ma,
    NV_Ten: row.NV_Ten,
    DT_Ma: row.DT_Ma,
    BH_Ngay: row.BH_Ngay,
    BH_TrangThai: row.BH_TrangThai,
    BH_TongSL: row.BH_TongSL,
    BH_TongCong: row.BH_TongCong,
    allowCredit: row.allowCredit
  }));
  const normalizedSalesPayments = salesPayments.map((row) => ({
    TTBH_Ma: row.TTBH_Ma,
    BH_Ma: row.BH_Ma,
    DT_Ma: row.DT_Ma,
    TTBH_Ngay: row.TTBH_Ngay,
    TTBH_SoTien: row.TTBH_SoTien,
    TTBH_PhuongThuc: row.TTBH_PhuongThuc,
    TTBH_TrangThai: row.TTBH_TrangThai
  }));
  const normalizedReceiptVouchers = receiptVouchers.map((row) => mapVoucher(row, "receipt"));
  const normalizedExpenseVouchers = expenseVouchers.map((row) => mapVoucher(row, "expense"));
  const employees = [...new Map([
    ...receipts.map((row) => [row.NV_Ma, row.NV_Ten]),
    ...counts.map((row) => [row.NV_Ma, row.NV_Ten]),
    ...transfers.map((row) => [row.NV_Ma, row.NV_Ten]),
    ...invoices.map((row) => [row.NV_Ma, row.NV_Ten]),
    ...receiptVouchers.map((row) => [row.employee_code, row.employee_name]),
    ...expenseVouchers.map((row) => [row.employee_code, row.employee_name]),
    ...shifts.map((row) => [row.NV_Ma, ""])
  ].filter(([code]) => code).map(([code, name]) => [code, { NV_Ma: code, NV_Ten: name || code }])).values()];
  const normalizedPayments = supplierPayments.map((row) => ({
    TTNCC_Ma: row.code,
    CTNNCC_Ma: row.debt_code,
    TTNCC_Ngay: row.payment_date,
    TTNCC_SoTien: row.amount,
    TTNCC_PhuongThuc: row.method,
    TTNCC_TrangThai: row.status,
    TTNCC_GhiChu: row.note
  }));
  const partnerRows = partners.map((row) => ({
    ...row,
    DT_TrangThai: row.DT_TrangThai || "Hoạt động"
  }));
  const supplierRows = suppliers.map((row) => ({
    ...row,
    DT_TrangThai: row.DT_TrangThai || "Hoạt động"
  }));
  const debtRows = normalizedDebts;
  const creditorRows = [...new Map(debts.map((row) => [row.supplier_code, {
    CNNCC_Ma: row.supplier_code,
    DT_Ma: row.supplier_code,
    CNNCC_TrangThai: row.balance > 0 ? "Còn nợ" : "Đã thanh toán"
  }])).values()];
  const saleLines = invoices.flatMap((invoice) => (invoice.lines || []).map((line) => ({
    BH_Ma: invoice.BH_Ma,
    HH_Ma: line.HH_Ma,
    PNCT_Ma: line.PNCT_Ma,
    BH_SL: line.BH_SL,
    BH_DonGia: line.BH_DonGia,
    BH_TTien: line.BH_TTien
  })));
  const receiptLines = normalizedReceipts.flatMap((receipt) => receipt.lines.map((line) => ({
    ...line,
    PN_Ma: receipt.PN_Ma
  })));
  const countLines = counts.flatMap((count) => (count.lines || []).map((line) => ({
    ...line,
    PKK_Ma: count.PKK_Ma
  })));
  const transferLines = transfers.flatMap((transfer) => (transfer.lines || []).map((line) => ({
    ...line,
    PXCN_Ma: transfer.PXCN_Ma
  })));
  const reconciliationByReceipt = new Map(
    purchaseReconciliations.map((row) => [row.receipt, mapPurchaseReconciliation(row)])
  );
  const invoiceReceivables = invoices.flatMap((invoice) => {
    const paid = normalizedSalesPayments
      .filter((payment) => payment.BH_Ma === invoice.BH_Ma && payment.TTBH_TrangThai === "Thành công")
      .reduce((sum, payment) => sum + Number(payment.TTBH_SoTien || 0), 0);
    return invoice.BH_TrangThai === "Đã xác nhận" && invoice.BH_TongCong > paid
      ? [{ BH_Ma: invoice.BH_Ma, BH_SoTienNo: invoice.BH_TongCong - paid }]
      : [];
  });

  return {
    DoiTacKinhDoanh: partnerRows,
    NhaCungCap: supplierRows,
    NhanVien: employees,
    DiaDiem: locations,
    HangHoa: products,
    GiaBan: [],
    PhieuNhap: normalizedReceipts,
    PhieuNhapChiTiet: receiptLines,
    DatHang: [],
    DatChiTiet: [],
    HoaDonBanHang: normalizedInvoices,
    HoaDonBanHangChiTiet: saleLines,
    ThanhToanBanHang: normalizedSalesPayments,
    PhieuThu: normalizedReceiptVouchers,
    PhieuChi: normalizedExpenseVouchers,
    CongNoNCC: creditorRows,
    ChiTietNoNCC: debtRows,
    ThanhToanNCC: normalizedPayments,
    CongNoKhachHang: invoiceReceivables,
    TonKho: stock,
    PhieuKiemKeKho: counts,
    PhieuKiemKeKhoChiTiet: countLines,
    PhieuXuatChuyenNoiBo: transfers,
    PhieuXuatChuyenNoiBoChiTiet: transferLines,
    BienDongKho: movements,
    TraNCC: returns,
    CaBanHang: shifts.map(mapShift),
    PurchaseReconciliation: reconciliationByReceipt,
    AccountingReports: {
      revenue: accountingReports.revenue,
      invoiceCount: accountingReports.invoice_count,
      soldQuantity: accountingReports.sold_quantity,
      cost: accountingReports.cost,
      grossProfit: accountingReports.gross_profit,
      inventoryValue: accountingReports.inventory_value,
      salesCollected: accountingReports.sales_collected,
      otherIncome: accountingReports.other_income,
      supplierPaid: accountingReports.supplier_paid,
      otherExpense: accountingReports.other_expense,
      cashDifference: accountingReports.cash_difference,
      receivableBalance: accountingReports.receivable_balance,
      payableBalance: accountingReports.payable_balance
    }
  };
}

export function confirmGoodsReceipt(receiptCode) {
  return authenticatedApiRequest(
    `${API}inventory/receipts/${encodeURIComponent(receiptCode)}/confirm/`,
    { method: "POST", body: {} }
  );
}

export function createSupplierDebt(receiptCode) {
  return authenticatedApiRequest(
    `${API}accounting/supplier-debts/from-receipt/${encodeURIComponent(receiptCode)}/`,
    { method: "POST", body: {} }
  );
}

export function requestCashShiftExplanation(shiftCode, note, employeeCode) {
  return authenticatedApiRequest(
    `${API}shifts/${encodeURIComponent(shiftCode)}/request-explanation/`,
    { method: "POST", body: { GhiChuKeToan: note, employeeId: employeeCode } }
  );
}

export function reconcileCashShift(shiftCode, employeeCode, note) {
  return authenticatedApiRequest(
    `${API}shifts/${encodeURIComponent(shiftCode)}/reconcile/`,
    { method: "POST", body: { employeeId: employeeCode, note } }
  );
}

export function confirmCashHandover(shiftCode, values, employeeCode) {
  return authenticatedApiRequest(
    `${API}shifts/${encodeURIComponent(shiftCode)}/handover/`,
    {
      method: "POST",
      body: {
        amount: Number(values.amount),
        note: values.note || "",
        employeeId: employeeCode
      }
    }
  );
}
