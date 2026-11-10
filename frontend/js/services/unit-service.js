export function getUnitPackage(item) {
  const name = String(item?.HH_DViDongGoi || "").trim();
  const ratio = Number(item?.HH_TyLeQuyDoi);
  if (!name || !Number.isSafeInteger(ratio) || ratio <= 0) return null;
  return { name, ratio };
}

export function normalizeUnitPackage(name, ratio) {
  const unitName = String(name || "").trim();
  if (!unitName) {
    if (ratio !== null && ratio !== undefined && ratio !== "") {
      throw new Error("Nhập tên đơn vị đóng gói hoặc tắt quy đổi.");
    }
    return { HH_DViDongGoi: null, HH_TyLeQuyDoi: null };
  }
  const conversionRatio = Number(ratio);
  if (!Number.isSafeInteger(conversionRatio) || conversionRatio <= 0) {
    throw new Error("Tỷ lệ quy đổi phải là số nguyên dương.");
  }
  if (unitName.length > 50) throw new Error("Tên đơn vị đóng gói không được dài quá 50 ký tự.");
  return { HH_DViDongGoi: unitName, HH_TyLeQuyDoi: conversionRatio };
}

export function formatBaseQuantity(quantity, item) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) return "—";
  const baseUnit = String(item?.HH_DVi || "đơn vị");
  const unitPackage = getUnitPackage(item);
  if (!unitPackage) return `${quantity} ${baseUnit}`;
  const packageCount = Math.floor(quantity / unitPackage.ratio);
  const remainder = quantity % unitPackage.ratio;
  return `${quantity} ${baseUnit} = ${packageCount} ${unitPackage.name}${remainder ? ` + ${remainder} ${baseUnit}` : ""}`;
}

export function toBaseQuantity(quantity, factor) {
  const amount = Number(quantity);
  const multiplier = Number(factor);
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(multiplier) || multiplier <= 0) {
    throw new Error("Số lượng và tỷ lệ quy đổi phải là số nguyên dương.");
  }
  const converted = amount * multiplier;
  if (!Number.isSafeInteger(converted)) throw new Error("Số lượng quy đổi vượt giới hạn cho phép.");
  return converted;
}

export function toBaseUnitPrice(price, factor) {
  const amount = Number(price);
  const multiplier = Number(factor);
  if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(multiplier) || multiplier <= 0) {
    throw new Error("Đơn giá và tỷ lệ quy đổi không hợp lệ.");
  }
  if (amount % multiplier !== 0) {
    throw new Error(`Giá đóng gói ${amount} ₫ không chia hết cho tỷ lệ ${multiplier}; hãy nhập giá theo đơn vị cơ bản hoặc điều chỉnh giá đóng gói.`);
  }
  return amount / multiplier;
}
