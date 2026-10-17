const KEY = "kho-moc.store.v1";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const emptyData = { products: [], customers: [], orders: [], receipts: [], expenses: [], fishRewards: [], units: [] };
const localData = loadData();
let data = structuredClone(emptyData);
let cloudRevision = 0;
let cloudSaveQueue = Promise.resolve();
let pendingCloudWrites = 0;
let appEventsBound = false;
let cloudRefreshTimer = null;
let cloudRefreshInProgress = false;
let cloudStartupInProgress = false;
let ownerSetupRequired = false;
let activeView = "overview";
let lineId = 0;
let receiptLineId = 0;
let imageDbPromise;
let selectedProductImage = null;
let clearProductImage = false;
let productImagePreviewUrl = null;
const renderedImageUrls = new Set();

function loadData() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY));
    if (!stored || typeof stored !== "object") return structuredClone(emptyData);
    return normalizeData(stored);
  } catch (error) {
    console.error("Could not load store data.", error);
    return structuredClone(emptyData);
  }
}

function normalizeData(stored) {
  const products = Array.isArray(stored.products) ? stored.products.filter((product) => product && typeof product === "object").map((product) => {
    const cleaned = { ...product };
    delete cleaned.stock;
    delete cleaned.lowStock;
    return cleaned;
  }) : [];
  const units = [
    ...(Array.isArray(stored.units) ? stored.units : []),
    ...products.map((product) => product.unit),
  ].filter((unit) => typeof unit === "string").map((unit) => unit.trim()).filter(Boolean);
  return {
    products,
    customers: Array.isArray(stored.customers) ? stored.customers : [],
    orders: Array.isArray(stored.orders) ? stored.orders : [],
    receipts: Array.isArray(stored.receipts) ? stored.receipts : [],
    expenses: Array.isArray(stored.expenses) ? stored.expenses : [],
    fishRewards: Array.isArray(stored.fishRewards) ? stored.fishRewards : [],
    units: [...new Map(units.map((unit) => [unit.toLocaleLowerCase(), unit])).values()],
  };
}

function openImageDb() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("Trình duyệt này không hỗ trợ lưu hình ảnh."));
  if (!imageDbPromise) {
    imageDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("kho-moc.product-images.v1", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("images")) request.result.createObjectStore("images");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Không thể mở kho hình ảnh."));
    });
  }
  return imageDbPromise;
}

async function storeProductImage(file, imageId = id()) {
  const chunkBytes = 3 * 1024 * 1024;
  const parts = Math.ceil(file.size / chunkBytes);
  if (parts < 1 || parts > 3) throw new Error("Ảnh cần có dung lượng tối đa 8 MB.");
  try {
    for (let part = 0; part < parts; part += 1) {
      const blob = file.slice(part * chunkBytes, Math.min((part + 1) * chunkBytes, file.size), file.type);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("Không thể đọc một phần hình ảnh."));
        reader.readAsDataURL(blob);
      });
      if (typeof dataUrl !== "string" || !dataUrl.includes(",")) throw new Error("Không thể mã hóa một phần hình ảnh.");
      const response = await fetch(`/api/images/${encodeURIComponent(imageId)}?part=${part}&parts=${parts}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "Không thể lưu hình ảnh lên cloud.");
      }
    }
  } catch (error) {
    try {
      const cleanup = await fetch(`/api/images/${encodeURIComponent(imageId)}`, { method: "DELETE" });
      if (!cleanup.ok) console.error(`Could not clean up incomplete image ${imageId}.`, cleanup.status);
    } catch (cleanupError) {
      console.error(`Could not clean up incomplete image ${imageId}.`, cleanupError);
    }
    throw error;
  }
  return imageId;
}

async function getProductImage(imageId) {
  const path = `/api/images/${encodeURIComponent(imageId)}`;
  const metadataResponse = await fetch(path);
  if (metadataResponse.status === 404) return null;
  if (!metadataResponse.ok) throw new Error("Không thể tải hình ảnh từ cloud.");
  const metadata = await metadataResponse.json();
  if (!Number.isInteger(metadata.parts) || metadata.parts < 1 || metadata.parts > 3 ||
      !["image/jpeg", "image/png", "image/webp"].includes(metadata.contentType)) {
    throw new Error("Thông tin hình ảnh trên cloud không hợp lệ.");
  }
  const chunks = [];
  for (let part = 0; part < metadata.parts; part += 1) {
    const response = await fetch(`${path}?part=${part}`);
    if (!response.ok) throw new Error("Không thể tải đầy đủ hình ảnh từ cloud.");
    chunks.push(await response.blob());
  }
  const image = new Blob(chunks, { type: metadata.contentType });
  if (image.size > 8 * 1024 * 1024) throw new Error("Hình ảnh trên cloud vượt quá giới hạn 8 MB.");
  return image;
}

async function getLocalProductImage(imageId) {
  const db = await openImageDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("images", "readonly").objectStore("images").get(imageId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Không thể đọc hình ảnh cục bộ."));
  });
}

async function deleteProductImage(imageId) {
  const response = await fetch(`/api/images/${encodeURIComponent(imageId)}`, { method: "DELETE" });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "Không thể xóa hình ảnh trên cloud.");
  }
}

function clearRenderedImages() {
  renderedImageUrls.forEach((url) => URL.revokeObjectURL(url));
  renderedImageUrls.clear();
}

async function hydrateProductImages(container, products) {
  for (const product of products) {
    if (!product.imageId) continue;
    try {
      const blob = await getProductImage(product.imageId);
      if (!blob || !container.isConnected) continue;
      const placeholder = $(`[data-product-image="${CSS.escape(product.id)}"]`, container);
      if (!placeholder) continue;
      const image = document.createElement("img");
      image.src = URL.createObjectURL(blob);
      image.alt = product.name;
      renderedImageUrls.add(image.src);
      placeholder.replaceChildren(image);
      placeholder.classList.add("has-image");
    } catch (error) {
      console.error(`Unable to load image for product ${product.id}.`, error);
      toast(`Không tải được hình ảnh của "${product.name}".`, true);
    }
  }
}

function persist() {
  const snapshot = structuredClone(data);
  const operation = cloudSaveQueue.then(() => persistSnapshot(snapshot), () => persistSnapshot(snapshot));
  pendingCloudWrites += 1;
  const trackedOperation = operation.finally(() => { pendingCloudWrites -= 1; });
  cloudSaveQueue = trackedOperation.then(() => undefined, () => undefined);
  return trackedOperation;
}

async function persistSnapshot(snapshot) {
  try {
    const response = await fetch("/api/store", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: snapshot, revision: cloudRevision }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Không thể đồng bộ dữ liệu lên cloud.");
    cloudRevision = result.revision;
    try { localStorage.setItem(KEY, JSON.stringify(snapshot)); } catch (error) {
      console.error("Could not cache cloud data locally.", error);
      toast("Dữ liệu đã đồng bộ online nhưng không thể lưu bản đệm trên thiết bị.", true);
    }
    return true;
  } catch (error) {
    console.error("Could not save cloud data.", error);
    toast(error.message || "Không thể đồng bộ dữ liệu. Kiểm tra kết nối rồi thử lại.", true);
    return false;
  }
}

function id() { return crypto.randomUUID(); }
function money(value) { return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Number(value) || 0); }
function number(value) { return new Intl.NumberFormat("vi-VN").format(Number(value) || 0); }
function parsePrice(value) {
  const digits = String(value ?? "").replace(/[,\s]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : NaN;
}
function formatPriceInput(input) {
  const start = input.selectionStart ?? input.value.length;
  const digitsBeforeCursor = input.value.slice(0, start).replace(/\D/g, "").length;
  const digits = input.value.replace(/\D/g, "");
  input.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let cursor = 0;
  let counted = 0;
  while (cursor < input.value.length && counted < digitsBeforeCursor) {
    if (/\d/.test(input.value[cursor])) counted += 1;
    cursor += 1;
  }
  input.setSelectionRange(cursor, cursor);
}
function addPriceInput(input) {
  input.type = "text";
  input.inputMode = "numeric";
  input.dataset.priceInput = "true";
  input.addEventListener("input", () => formatPriceInput(input));
  if (input.value) formatPriceInput(input);
}
function dateLabel(value, options = { day: "2-digit", month: "2-digit", year: "numeric" }) {
  return new Date(value).toLocaleDateString("vi-VN", options);
}
function escapeText(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function initials(value = "") {
  return value.trim().split(/\s+/).slice(-2).map((part) => part.charAt(0)).join("").toUpperCase() || "?";
}
function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast${error ? " toast-error" : ""}`;
  item.textContent = message;
  $("#toast-region").append(item);
  window.setTimeout(() => item.remove(), 3600);
}
function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}
function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  if (dialog.id === "product-dialog" && productImagePreviewUrl) {
    URL.revokeObjectURL(productImagePreviewUrl);
    productImagePreviewUrl = null;
    selectedProductImage = null;
  }
}

function customerFor(order) { return data.customers.find((customer) => customer.id === order.customerId); }
function orderTotal(order) { return order.lines.reduce((total, line) => total + line.quantity * line.price, 0); }
function lineCostInfo(line) {
  if (typeof line.costPrice === "number" && Number.isFinite(line.costPrice)) {
    return { cost: line.quantity * line.costPrice, estimated: false, missing: false };
  }
  const product = data.products.find((item) => item.id === line.productId);
  const size = Array.isArray(product?.sizes) ? product.sizes.find((item) => item.label === line.size) : null;
  const costPrice = typeof size?.costPrice === "number" ? size.costPrice : product?.costPrice;
  if (typeof costPrice === "number" && Number.isFinite(costPrice)) {
    return { cost: line.quantity * costPrice, estimated: true, missing: false };
  }
  return { cost: 0, estimated: true, missing: true };
}
function orderProfitInfo(order) {
  return order.lines.reduce((total, line) => {
    const lineCost = lineCostInfo(line);
    return {
      cost: total.cost + lineCost.cost,
      estimated: total.estimated || lineCost.estimated,
      missing: total.missing + Number(lineCost.missing),
    };
  }, { cost: 0, estimated: false, missing: 0 });
}
function ordersForPeriod(period) {
  const activeOrders = data.orders.filter((order) => order.status !== "cancelled");
  if (period === "all") return activeOrders;
  const now = new Date();
  return activeOrders.filter((order) => {
    const created = new Date(order.createdAt);
    return created.getFullYear() === now.getFullYear() && created.getMonth() === now.getMonth();
  });
}
function isFishUnit(unit = "") {
  const normalized = unit.trim().toLocaleLowerCase("vi").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "");
  return ["con", "ca", "conca"].includes(normalized);
}
function fishBought(customerId) {
  return data.orders
    .filter((order) => order.customerId === customerId && order.status !== "cancelled")
    .reduce((sum, order) => sum + order.lines.reduce((lineSum, line) => lineSum + (isFishUnit(line.unit) ? line.quantity : 0), 0), 0);
}
function reconcileFishRewards(customerId, sourceOrderId = "") {
  const earnedMilestones = Math.floor(fishBought(customerId) / 10);
  let rewards = [...data.fishRewards];
  let newlyPending = 0;
  for (let milestone = 1; milestone <= earnedMilestones; milestone += 1) {
    const index = rewards.findIndex((reward) => reward.customerId === customerId && reward.milestone === milestone);
    if (index < 0) {
      rewards.push({ id: id(), customerId, milestone, sourceOrderId, status: "pending", createdAt: new Date().toISOString(), giftedAt: "" });
      newlyPending += 1;
    } else if (rewards[index].status === "void") {
      rewards[index] = { ...rewards[index], sourceOrderId, status: "pending", createdAt: new Date().toISOString() };
      newlyPending += 1;
    }
  }
  rewards = rewards.map((reward) => {
    if (reward.customerId === customerId && reward.status === "pending" && reward.milestone > earnedMilestones) {
      return { ...reward, status: "void" };
    }
    return reward;
  });
  return { rewards, newlyPending, fishCount: fishBought(customerId) };
}
function pendingFishRewards(customerId = "") {
  return data.fishRewards.filter((reward) => reward.status === "pending" && (!customerId || reward.customerId === customerId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
async function markFishRewardGifted(rewardId) {
  const reward = data.fishRewards.find((item) => item.id === rewardId && item.status === "pending");
  if (!reward) return;
  const previousData = data;
  data = {
    ...data,
    fishRewards: data.fishRewards.map((item) => item.id === rewardId ? { ...item, status: "gifted", giftedAt: new Date().toISOString() } : item),
  };
  if (!await persist()) { data = previousData; return; }
  renderCurrentView();
  const customer = data.customers.find((item) => item.id === reward.customerId);
  toast(`Đã ghi nhận tặng cá cho ${customer?.name || "khách hàng"} tại mốc ${reward.milestone * 10} con.`);
}
async function initializeFishRewards() {
  const previousRewards = data.fishRewards;
  let rewards = [...previousRewards];
  data.customers.forEach((customer) => {
    data = { ...data, fishRewards: rewards };
    const result = reconcileFishRewards(customer.id);
    rewards = result.rewards;
  });
  if (JSON.stringify(previousRewards) !== JSON.stringify(rewards)) {
    const previousData = data;
    data = { ...data, fishRewards: rewards };
    if (!await persist()) { data = previousData; return false; }
  }
  return true;
}
function unitsSold(customerId) {
  return data.orders.filter((order) => order.customerId === customerId && order.status !== "cancelled")
    .reduce((total, order) => total + order.lines.reduce((sum, line) => sum + line.quantity, 0), 0);
}

function renderCounts() {
  $("#order-count").textContent = number(data.orders.length);
  $("#receiving-count").textContent = number(data.receipts.length);
  $("#expense-count").textContent = number(data.expenses.length);
  $("#reward-count").textContent = number(pendingFishRewards().length);
  $("#gifted-fish-count").textContent = number(data.fishRewards.filter((reward) => reward.status === "gifted").length);
}

function renderOverview() {
  clearRenderedImages();
  $("#metric-revenue").textContent = money(data.orders.filter((order) => order.status !== "cancelled").reduce((sum, order) => sum + orderTotal(order), 0));
  $("#metric-orders").textContent = number(data.orders.length);
  $("#metric-pending").textContent = "Giao trực tiếp";
  $("#metric-products").textContent = number(data.products.length);
  $("#metric-customers").textContent = number(data.customers.length);
  const recent = $("#recent-orders");
  recent.replaceChildren();
  const latest = [...data.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  if (!latest.length) {
    recent.innerHTML = '<div class="empty-inline"><span class="empty-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 1.9-1.4L22 9H7"/></svg></span><strong>Chưa có đơn hàng</strong><span>Tạo đơn đầu tiên để bắt đầu theo dõi bán hàng.</span><button class="button button-secondary" data-create-order>Tạo đơn hàng</button></div>';
    $("[data-create-order]", recent).addEventListener("click", openOrderDialog);
  } else {
    recent.innerHTML = `<div class="table-wrap"><table><thead><tr><th>MÃ ĐƠN</th><th>KHÁCH HÀNG</th><th>NGÀY TẠO</th><th>TỔNG TIỀN</th></tr></thead><tbody>${latest.map((order) => {
      const customer = customerFor(order);
      return `<tr><td><button class="order-link" data-order="${order.id}">#${escapeText(order.number)}</button></td><td>${escapeText(customer?.name || "Khách đã xóa")}</td><td>${dateLabel(order.createdAt)}</td><td class="amount-cell">${money(orderTotal(order))}</td></tr>`;
    }).join("")}</tbody></table></div>`;
    $$("[data-order]", recent).forEach((button) => button.addEventListener("click", () => showView("orders")));
  }
  renderFishRewards();
  const featured = $("#featured-products");
  const latestProducts = [...data.products].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  if (!latestProducts.length) {
    featured.innerHTML = '<div class="empty-inline"><span class="empty-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/></svg></span><strong>Chưa có sản phẩm</strong><span>Thêm sản phẩm kèm hình ảnh để dễ nhận diện.</span><button class="button button-secondary" data-create-product>Thêm sản phẩm</button></div>';
    $("[data-create-product]", featured).addEventListener("click", () => openProductDialog());
  } else {
    featured.innerHTML = latestProducts.map((product) => `<div class="featured-product"><span class="product-thumb" data-product-image="${escapeText(product.id)}">${escapeText(initials(product.name))}</span><span class="featured-product-name"><strong>${escapeText(product.name)}</strong><small>${escapeText(product.sku || product.unit || "Sản phẩm")}</small></span><span class="featured-price">${money(product.costPrice ?? 0)}</span></div>`).join("");
    hydrateProductImages(featured, latestProducts);
  }
  renderCounts();
}

function renderFishRewards() {
  const container = $("#fish-rewards");
  const rewards = pendingFishRewards();
  const customerIds = [...new Set(rewards.map((reward) => reward.customerId))];
  if (!rewards.length) {
    container.innerHTML = '<div class="empty-inline reward-empty"><strong>Chưa có quà tặng cần chuẩn bị</strong><span>Mỗi khách đủ 10 con cá đã mua sẽ được ghi nhận tại đây.</span></div>';
    return;
  }
  container.innerHTML = `<div class="reward-summary">${number(rewards.length)} con cá tặng đang chờ · ${number(customerIds.length)} khách</div><div class="reward-list">${rewards.map((reward) => {
    const customer = data.customers.find((item) => item.id === reward.customerId);
    const count = fishBought(reward.customerId);
    return `<div class="reward-row"><span class="reward-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 12v8H4v-8m-2-5h20v5H2zm10 0v13m0-13H7.5a2.5 2.5 0 1 1 2.3-3.5L12 7m0 0h4.5a2.5 2.5 0 1 0-2.3-3.5L12 7"/></svg></span><span class="reward-details"><strong>${escapeText(customer?.name || "Khách hàng đã xóa")} · ${escapeText(customer?.phone || "Không có số điện thoại")}</strong><small>Đã mua ${number(count)} con cá · Mốc ${number(reward.milestone * 10)} con · Tặng 1 con</small></span><button type="button" class="button button-secondary reward-action" data-gift-reward="${escapeText(reward.id)}">Đã tặng</button></div>`;
  }).join("")}</div>`;
  $$("[data-gift-reward]", container).forEach((button) => button.addEventListener("click", () => markFishRewardGifted(button.dataset.giftReward)));
}

function pageHeading(tag, title, description, buttonText, buttonId) {
  return `<div class="page-heading content-heading"><div><div class="eyebrow"><span></span>${tag}</div><h1>${title}</h1><p>${description}</p></div>${buttonText ? `<button class="button button-primary" id="${buttonId}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>${buttonText}</button>` : ""}</div>`;
}
function emptyState(icon, title, description, label, action) {
  return `<div class="empty-state"><span class="empty-state-icon">${icon}</span><h2>${title}</h2><p>${description}</p>${label ? `<button class="button button-primary" data-empty-action>${label}</button>` : ""}</div>`;
}
function searchToolbar(placeholder, idValue = "view-search") {
  return `<div class="toolbar"><label class="search-box" for="${idValue}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="${idValue}" type="search" autocomplete="off" placeholder="${placeholder}"></label><span class="result-count" id="${idValue}-count"></span></div>`;
}

function renderProducts(query = "") {
  clearRenderedImages();
  const panel = $("#products-view");
  const filtered = data.products.filter((product) => `${product.name} ${product.sku}`.toLowerCase().includes(query.toLowerCase()));
  panel.innerHTML = `${pageHeading("DANH MỤC", "Sản phẩm", "Quản lý thông tin, hình ảnh, đơn vị và giá mua của từng mặt hàng.", "Thêm sản phẩm", "add-product-button")}${searchToolbar("Tìm tên sản phẩm hoặc mã hàng...")}<div id="products-content"></div>`;
  $("#add-product-button").addEventListener("click", () => openProductDialog());
  $("#view-search").value = query;
  $("#view-search").addEventListener("input", (event) => renderProducts(event.target.value));
  $("#view-search-count").textContent = `${number(filtered.length)} mặt hàng`;
  const container = $("#products-content");
  if (!filtered.length) {
    container.innerHTML = emptyState('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>', query ? "Không tìm thấy sản phẩm" : "Chưa có sản phẩm", query ? "Thử tìm theo tên khác hoặc mã hàng." : "Thêm sản phẩm kèm hình ảnh để dễ nhận diện.", query ? "" : "Thêm sản phẩm", () => openProductDialog());
    const action = $("[data-empty-action]", container);
    if (action) action.addEventListener("click", () => openProductDialog());
    return;
  }
  container.innerHTML = `<div class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>SẢN PHẨM</th><th>MÃ HÀNG</th><th>ĐƠN VỊ</th><th>GIÁ MUA MẶC ĐỊNH</th><th>SIZE · GIÁ BÁN · GIÁ MUA</th><th></th></tr></thead><tbody>${filtered.map((product) => {
    const sizes = Array.isArray(product.sizes) ? product.sizes : [];
    const sizeSummary = sizes.length ? sizes.map((size) => `${escapeText(size.label)}: bán ${money(size.price)} · mua ${typeof size.costPrice === "number" || typeof product.costPrice === "number" ? money(size.costPrice ?? product.costPrice) : "chưa cài"}`).join("<br>") : "—";
    return `<tr><td><div class="product-cell"><span class="product-thumb" data-product-image="${escapeText(product.id)}">${escapeText(initials(product.name))}</span><span><strong>${escapeText(product.name)}</strong><small>${escapeText(product.description || "—")}</small></span></div></td><td>${escapeText(product.sku || "—")}</td><td>${escapeText(product.unit || "cái")}</td><td class="amount-cell">${product.costPrice == null ? "—" : money(product.costPrice)}</td><td class="size-summary">${sizeSummary}</td><td><div class="row-actions"><button data-edit-product="${product.id}" class="row-action">Sửa</button><button data-delete-product="${product.id}" class="row-action row-danger">Xóa</button></div></td></tr>`;
  }).join("")}</tbody></table></div><div class="table-footer">Hiển thị ${number(filtered.length)} / ${number(data.products.length)} sản phẩm</div></div>`;
  hydrateProductImages(container, filtered);
  $$("[data-edit-product]").forEach((button) => button.addEventListener("click", () => openProductDialog(button.dataset.editProduct)));
  $$("[data-delete-product]").forEach((button) => button.addEventListener("click", () => deleteProduct(button.dataset.deleteProduct)));
}

function renderOrders(query = "") {
  const panel = $("#orders-view");
  const filtered = data.orders.filter((order) => {
    const customer = customerFor(order);
    return `${order.number} ${customer?.name || ""} ${customer?.phone || ""}`.toLowerCase().includes(query.toLowerCase());
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  panel.innerHTML = `${pageHeading("BÁN HÀNG", "Đơn hàng", "Danh sách sản phẩm và tổng tiền các đơn giao trực tiếp.", "Tạo đơn hàng", "add-order-button")}<div class="toolbar"><label class="search-box" for="view-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input id="view-search" type="search" placeholder="Tìm mã đơn, tên hoặc số điện thoại..."></label><span class="result-count" id="orders-result-count"></span></div><div id="orders-content"></div>`;
  $("#view-search").value = query;
  $("#view-search").addEventListener("input", (event) => renderOrders(event.target.value));
  $("#add-order-button").addEventListener("click", openOrderDialog);
  $("#orders-result-count").textContent = `${number(filtered.length)} đơn`;
  const container = $("#orders-content");
  if (!filtered.length) {
    container.innerHTML = emptyState('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 1.9-1.4L22 9H7"/></svg>', query ? "Không tìm thấy đơn hàng" : "Chưa có đơn hàng", query ? "Thử đổi từ khóa tìm kiếm." : "Tạo đơn hàng để ghi nhận mặt hàng đã bán.", query ? "" : "Tạo đơn hàng", () => openOrderDialog());
    const action = $("[data-empty-action]", container);
    if (action) action.addEventListener("click", openOrderDialog);
    return;
  }
  container.innerHTML = `<div class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>MÃ ĐƠN</th><th>KHÁCH HÀNG</th><th>NGÀY TẠO</th><th>MẶT HÀNG</th><th>TỔNG TIỀN</th><th></th></tr></thead><tbody>${filtered.map((order) => {
    const customer = customerFor(order);
    const itemSummary = order.lines.map((line) => `${line.name}${line.size ? ` · ${line.size}` : ""} × ${number(line.quantity)} ${line.unit || ""}`).join(", ");
    return `<tr><td><strong class="order-number">#${escapeText(order.number)}</strong></td><td><div class="customer-cell"><span class="customer-avatar">${escapeText(initials(customer?.name || "?"))}</span><span><strong>${escapeText(customer?.name || "Khách đã xóa")}</strong><small>${escapeText(customer?.phone || "")}</small></span></div></td><td>${dateLabel(order.createdAt)}</td><td class="receipt-item-summary">${escapeText(itemSummary)}</td><td class="amount-cell">${money(orderTotal(order))}</td><td><button class="row-action row-danger" data-delete-order="${order.id}">Xóa</button></td></tr>`;
  }).join("")}</tbody></table></div><div class="table-footer">Hiển thị ${number(filtered.length)} / ${number(data.orders.length)} đơn hàng</div></div>`;
  $$("[data-delete-order]").forEach((button) => button.addEventListener("click", () => deleteOrder(button.dataset.deleteOrder)));
}

function renderRevenue(period = "month") {
  const panel = $("#revenue-view");
  const orders = ordersForPeriod(period).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const revenue = orders.reduce((sum, order) => sum + orderTotal(order), 0);
  const cost = orders.reduce((sum, order) => sum + orderProfitInfo(order).cost, 0);
  const profit = revenue - cost;
  const estimatedOrders = orders.filter((order) => orderProfitInfo(order).estimated).length;
  const missingCosts = orders.reduce((sum, order) => sum + orderProfitInfo(order).missing, 0);
  const products = new Map();
  orders.forEach((order) => order.lines.forEach((line) => {
    const key = `${line.productId || line.name}\\u0000${line.size || ""}`;
    const current = products.get(key) || { name: line.name, size: line.size || "", unit: line.unit || "", quantity: 0, revenue: 0, cost: 0 };
    const lineCost = lineCostInfo(line);
    current.quantity += line.quantity;
    current.revenue += line.quantity * line.price;
    current.cost += lineCost.cost;
    products.set(key, current);
  }));
  const productRows = [...products.values()].sort((a, b) => b.revenue - a.revenue);
  const periodLabel = period === "month" ? new Date().toLocaleDateString("vi-VN", { month: "long", year: "numeric" }) : "Toàn bộ thời gian";
  panel.innerHTML = `<div class="revenue-heading">
    <div><div class="eyebrow"><span></span>BÁO CÁO BÁN HÀNG</div><h1>Chi tiết doanh thu</h1><p>Doanh thu, giá vốn và lãi gộp ước tính · ${escapeText(periodLabel)}</p></div>
    <div class="revenue-actions"><label class="filter-select"><span class="sr-only">Chọn khoảng thời gian doanh thu</span><select id="revenue-period"><option value="month">Tháng này</option><option value="all">Toàn bộ thời gian</option></select></label><button class="button button-secondary" type="button" data-go="overview">← Tổng quan</button></div>
  </div>
  <div class="revenue-metrics">
    <article class="revenue-summary-card"><span>Doanh thu</span><strong>${money(revenue)}</strong><small>${number(orders.length)} đơn, không tính đơn đã hủy</small></article>
    <article class="revenue-summary-card"><span>Giá vốn</span><strong>${money(cost)}</strong><small>Dựa trên giá mua / đơn vị của từng size</small></article>
    <article class="revenue-summary-card ${profit < 0 ? "is-loss" : "is-profit"}"><span>${profit < 0 ? "Lỗ gộp ước tính" : "Lãi gộp ước tính"}</span><strong>${money(profit)}</strong><small>${revenue > 0 ? `Biên lãi gộp ${number((profit / revenue) * 100)}%` : "Chưa có doanh thu trong khoảng này"}</small></article>
  </div>
  <div class="profit-notice" role="note"><strong>Cách tính:</strong> Lãi gộp = doanh thu − giá vốn của mặt hàng đã bán. Chưa trừ chi phí vận hành; phiếu nhập vật tư hiện là nhật ký riêng và không được trừ lần nữa.${estimatedOrders ? ` ${number(estimatedOrders)} đơn cũ đang ước tính giá vốn theo giá mua hiện tại của sản phẩm.` : ""}${missingCosts ? ` Chưa có giá vốn cho ${number(missingCosts)} dòng hàng; lãi thực tế có thể thấp hơn.` : ""}</div>
  <section class="panel revenue-table-panel"><div class="panel-heading"><div><h2>Hiệu quả theo sản phẩm và size</h2><p>Số lượng bán, doanh thu, giá vốn và lãi gộp</p></div></div>
    ${productRows.length ? `<div class="table-wrap"><table><thead><tr><th>SẢN PHẨM / SIZE</th><th>SỐ LƯỢNG</th><th>DOANH THU</th><th>GIÁ VỐN</th><th>LÃI GỘP</th></tr></thead><tbody>${productRows.map((item) => `<tr><td><strong>${escapeText(item.name)}</strong>${item.size ? `<small class="revenue-size">${escapeText(item.size)}</small>` : ""}</td><td>${number(item.quantity)} ${escapeText(item.unit)}</td><td>${money(item.revenue)}</td><td>${money(item.cost)}</td><td class="amount-cell">${money(item.revenue - item.cost)}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty-inline"><strong>Chưa có doanh thu trong khoảng này</strong><span>Các đơn đã hủy không được tính vào báo cáo.</span></div>'}
  </section>
  <section class="panel revenue-table-panel"><div class="panel-heading"><div><h2>Chi tiết đơn hàng</h2><p>Giá vốn được chụp tại thời điểm tạo đơn khi có dữ liệu</p></div></div>
    ${orders.length ? `<div class="table-wrap"><table><thead><tr><th>ĐƠN HÀNG</th><th>NGÀY TẠO</th><th>MẶT HÀNG</th><th>DOANH THU</th><th>GIÁ VỐN</th><th>LÃI GỘP</th></tr></thead><tbody>${orders.map((order) => { const customer = customerFor(order); const orderCost = orderProfitInfo(order); const orderRevenue = orderTotal(order); const summary = order.lines.map((line) => `${line.name}${line.size ? ` · ${line.size}` : ""} × ${number(line.quantity)}`).join(", "); return `<tr><td><strong class="order-number">#${escapeText(order.number)}</strong><small class="revenue-size">${escapeText(customer?.name || "Khách đã xóa")}</small></td><td>${dateLabel(order.createdAt)}</td><td class="receipt-item-summary">${escapeText(summary)}</td><td>${money(orderRevenue)}</td><td>${money(orderCost.cost)}${orderCost.estimated ? '<small class="revenue-size">Ước tính</small>' : ""}</td><td class="amount-cell">${money(orderRevenue - orderCost.cost)}</td></tr>`; }).join("")}</tbody></table></div>` : '<div class="empty-inline"><strong>Chưa có đơn hàng</strong><span>Tạo đơn để bắt đầu theo dõi doanh thu và lãi gộp.</span></div>'}
  </section>`;
  $("#revenue-period").value = period;
  $("#revenue-period").addEventListener("change", (event) => renderRevenue(event.target.value));
  $$("[data-go]", panel).forEach((button) => button.addEventListener("click", () => showView(button.dataset.go)));
}

function renderCustomers(query = "") {
  const panel = $("#customers-view");
  const filtered = data.customers.filter((customer) => `${customer.name} ${customer.phone} ${customer.social}`.toLowerCase().includes(query.toLowerCase()));
  panel.innerHTML = `${pageHeading("DANH BẠ CỬA HÀNG", "Khách hàng", "Thông tin liên hệ và lịch sử mua hàng của khách.", "Thêm khách hàng", "add-customer-button")}${searchToolbar("Tìm theo tên, số điện thoại...")}<div id="customers-content"></div>`;
  $("#add-customer-button").addEventListener("click", () => openCustomerDialog());
  $("#view-search").value = query;
  $("#view-search").addEventListener("input", (event) => renderCustomers(event.target.value));
  $("#view-search-count").textContent = `${number(filtered.length)} khách hàng`;
  const container = $("#customers-content");
  if (!filtered.length) {
    container.innerHTML = emptyState('<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1m1-14a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v1"/></svg>', query ? "Không tìm thấy khách hàng" : "Danh bạ còn trống", query ? "Thử tìm theo số điện thoại hoặc tên khác." : "Thêm khách hàng mới hoặc tạo đơn để lưu thông tin khách.", query ? "" : "Thêm khách hàng", () => openCustomerDialog());
    const action = $("[data-empty-action]", container);
    if (action) action.addEventListener("click", () => openCustomerDialog());
    return;
  }
  container.innerHTML = `<div class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>KHÁCH HÀNG</th><th>SỐ ĐIỆN THOẠI</th><th>MẠNG XÃ HỘI</th><th>SỐ ĐƠN</th><th>SẢN PHẨM ĐÃ MUA</th><th>CÁ ĐÃ MUA</th><th>QUÀ TẶNG</th><th>TỔNG CHI TIÊU</th><th></th></tr></thead><tbody>${filtered.map((customer) => {
    const customerOrders = data.orders.filter((order) => order.customerId === customer.id && order.status !== "cancelled");
    const items = unitsSold(customer.id);
    const fishCount = fishBought(customer.id);
    const pendingGifts = pendingFishRewards(customer.id).length;
    const spent = customerOrders.reduce((sum, order) => sum + orderTotal(order), 0);
    return `<tr><td><div class="customer-cell"><span class="customer-avatar">${escapeText(initials(customer.name))}</span><span><strong>${escapeText(customer.name)}</strong><small>Khách từ ${dateLabel(customer.createdAt)}</small></span></div></td><td><a class="phone-link" href="tel:${escapeText(customer.phone)}">${escapeText(customer.phone)}</a></td><td>${customer.social ? `<a class="social-link" href="${escapeText(customer.social)}" target="_blank" rel="noopener noreferrer">Mở trang cá nhân ↗</a>` : '<span class="muted-cell">Chưa cập nhật</span>'}</td><td>${number(customerOrders.length)}</td><td><strong>${number(items)}</strong> đơn vị</td><td><strong>${number(fishCount)}</strong> con</td><td>${pendingGifts ? `<strong class="reward-pending">${number(pendingGifts)} con cần tặng</strong>` : '<span class="muted-cell">Chưa đến mốc</span>'}</td><td class="amount-cell">${money(spent)}</td><td><div class="row-actions"><button class="row-action" data-edit-customer="${customer.id}">Sửa</button><button class="row-action row-danger" data-delete-customer="${customer.id}">Xóa</button></div></td></tr>`;
  }).join("")}</tbody></table></div><div class="table-footer">Hiển thị ${number(filtered.length)} / ${number(data.customers.length)} khách hàng</div></div>`;
  $$("[data-edit-customer]").forEach((button) => button.addEventListener("click", () => openCustomerDialog(button.dataset.editCustomer)));
  $$("[data-delete-customer]").forEach((button) => button.addEventListener("click", () => deleteCustomer(button.dataset.deleteCustomer)));
}

function renderReceipts(query = "") {
  const panel = $("#receiving-view");
  const filtered = data.receipts.filter((receipt) => `${receipt.supplier} ${receipt.note} ${receipt.lines.map((line) => line.name).join(" ")}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  panel.innerHTML = `${pageHeading("NHẬP HÀNG", "Nhập vật tư", "Lưu lịch sử nhập hàng và chi phí mua; không theo dõi hay thay đổi tồn kho.", "Ghi phiếu nhập", "add-receipt-button")}${searchToolbar("Tìm vật tư hoặc nhà cung cấp...")}<div id="receipts-content"></div>`;
  $("#add-receipt-button").addEventListener("click", openReceiptDialog);
  $("#view-search").value = query;
  $("#view-search").addEventListener("input", (event) => renderReceipts(event.target.value));
  $("#view-search-count").textContent = `${number(filtered.length)} phiếu`;
  const container = $("#receipts-content");
  if (!filtered.length) {
    container.innerHTML = emptyState('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 16v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/></svg>', query ? "Không tìm thấy phiếu nhập" : "Chưa có phiếu nhập", query ? "Thử từ khóa vật tư hoặc nhà cung cấp khác." : "Ghi lại mặt hàng, số lượng và chi phí mỗi lần nhập.", query ? "" : "Ghi phiếu nhập", openReceiptDialog);
    const action = $("[data-empty-action]", container);
    if (action) action.addEventListener("click", openReceiptDialog);
    return;
  }
  container.innerHTML = `<div class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>NGÀY NHẬP</th><th>VẬT TƯ</th><th>NHÀ CUNG CẤP</th><th>GHI CHÚ</th><th>TỔNG CHI PHÍ</th></tr></thead><tbody>${filtered.map((receipt) => {
    const itemSummary = receipt.lines.map((line) => `${line.name} · ${number(line.quantity)} ${line.unit}`).join(", ");
    const total = receipt.lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
    return `<tr><td>${dateLabel(`${receipt.date}T00:00:00`)}</td><td class="receipt-item-summary">${escapeText(itemSummary)}</td><td>${escapeText(receipt.supplier || "—")}</td><td>${escapeText(receipt.note || "—")}</td><td class="amount-cell">${money(total)}</td></tr>`;
  }).join("")}</tbody></table></div><div class="table-footer">Hiển thị ${number(filtered.length)} / ${number(data.receipts.length)} phiếu nhập</div></div>`;
}

function renderExpenses(query = "") {
  const panel = $("#expenses-view");
  const normalizedQuery = query.toLocaleLowerCase();
  const filtered = data.expenses.filter((expense) => `${expense.name} ${expense.note}`.toLocaleLowerCase().includes(normalizedQuery))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const now = new Date();
  const thisMonthTotal = data.expenses.reduce((sum, expense) => {
    const date = new Date(`${expense.date}T00:00:00`);
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() ? sum + expense.amount : sum;
  }, 0);
  const allTimeTotal = data.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  panel.innerHTML = `${pageHeading("THEO DÕI CHI TIÊU", "Chi phí vận hành", "Ghi các khoản chi thường ngày như cám, thức ăn và vật dụng chăm sóc cá.", "Ghi chi phí", "add-expense-button")}
    <div class="expense-summary">
      <article class="expense-summary-card"><span>Chi phí tháng này</span><strong>${money(thisMonthTotal)}</strong></article>
      <article class="expense-summary-card"><span>Tổng chi phí đã ghi</span><strong>${money(allTimeTotal)}</strong></article>
    </div>
    ${searchToolbar("Tìm khoản chi hoặc ghi chú...")}<div id="expenses-content"></div>`;
  $("#add-expense-button").addEventListener("click", openExpenseDialog);
  $("#view-search").value = query;
  $("#view-search").addEventListener("input", (event) => renderExpenses(event.target.value));
  $("#view-search-count").textContent = `${number(filtered.length)} khoản chi`;
  const container = $("#expenses-content");
  if (!filtered.length) {
    container.innerHTML = emptyState('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z"/><path d="M9 8h6m-6 4h6m-6 4h3"/></svg>', query ? "Không tìm thấy khoản chi" : "Chưa có chi phí vận hành", query ? "Thử tìm bằng tên khoản chi hoặc ghi chú khác." : "Ghi lại các khoản như cám cá, thức ăn hoặc vật dụng chăm sóc.", query ? "" : "Ghi chi phí", openExpenseDialog);
    const action = $("[data-empty-action]", container);
    if (action) action.addEventListener("click", openExpenseDialog);
    return;
  }
  container.innerHTML = `<div class="panel table-panel"><div class="table-wrap"><table><thead><tr><th>NGÀY CHI</th><th>KHOẢN CHI</th><th>GHI CHÚ</th><th>SỐ TIỀN</th><th></th></tr></thead><tbody>${filtered.map((expense) => `
    <tr><td>${dateLabel(`${expense.date}T00:00:00`)}</td><td><strong>${escapeText(expense.name)}</strong></td><td>${escapeText(expense.note || "—")}</td><td class="amount-cell">${money(expense.amount)}</td><td><button class="row-action row-danger" data-delete-expense="${escapeText(expense.id)}">Xóa</button></td></tr>`).join("")}
    </tbody></table></div><div class="table-footer">Hiển thị ${number(filtered.length)} / ${number(data.expenses.length)} khoản chi</div></div>`;
  $$("[data-delete-expense]", container).forEach((button) => button.addEventListener("click", () => deleteExpense(button.dataset.deleteExpense)));
}

function openExpenseDialog() {
  const form = $("#expense-form");
  form.reset();
  $("#expense-date").value = new Date().toISOString().slice(0, 10);
  clearDialogError("expense-error");
  openDialog($("#expense-dialog"));
}

async function createExpense(event) {
  event.preventDefault();
  const amount = parsePrice($("#expense-amount").value);
  const expense = {
    id: id(),
    date: $("#expense-date").value,
    name: $("#expense-name").value.trim(),
    amount,
    note: $("#expense-note").value.trim(),
    createdAt: new Date().toISOString(),
  };
  if (!expense.date || !expense.name || !Number.isSafeInteger(expense.amount) || expense.amount <= 0) {
    showDialogError("expense-error", "Nhập ngày chi, tên khoản chi và số tiền lớn hơn 0.");
    return;
  }
  const previousData = data;
  data = { ...data, expenses: [expense, ...data.expenses] };
  if (!await persist()) { data = previousData; return; }
  closeDialog($("#expense-dialog"));
  renderCurrentView();
  toast("Đã lưu chi phí vận hành.");
}

async function deleteExpense(expenseId) {
  const expense = data.expenses.find((item) => item.id === expenseId);
  if (!expense || !window.confirm(`Xóa khoản chi “${expense.name}”?`)) return;
  const previousData = data;
  data = { ...data, expenses: data.expenses.filter((item) => item.id !== expenseId) };
  if (!await persist()) { data = previousData; return; }
  renderCurrentView();
  toast("Đã xóa khoản chi.");
}

function openReceiptDialog() {
  const form = $("#receipt-form");
  form.reset();
  $("#receipt-date").value = new Date().toISOString().slice(0, 10);
  $("#receipt-lines").replaceChildren();
  clearDialogError("receipt-error");
  addReceiptLine();
  openDialog($("#receipt-dialog"));
}

function addReceiptLine() {
  const row = document.createElement("div");
  row.className = "receipt-line";
  row.dataset.receiptLine = String(++receiptLineId);
  const products = data.products.map((product) => `<option value="${escapeText(product.name)}"></option>`).join("");
  const name = document.createElement("input");
  name.type = "text";
  name.className = "receipt-item-name";
  name.setAttribute("list", "receipt-product-options");
  name.setAttribute("aria-label", "Tên vật tư");
  name.placeholder = "Tên vật tư";
  name.required = true;
  const list = document.createElement("datalist");
  list.id = `receipt-product-options-${receiptLineId}`;
  name.setAttribute("list", list.id);
  list.innerHTML = products;
  const unit = document.createElement("input");
  unit.type = "text";
  unit.className = "receipt-item-unit";
  unit.setAttribute("aria-label", "Đơn vị tính");
  unit.placeholder = "Đơn vị";
  unit.maxLength = 24;
  const quantity = document.createElement("input");
  quantity.type = "number";
  quantity.className = "receipt-item-quantity";
  quantity.min = "0.01";
  quantity.step = "any";
  quantity.value = "1";
  quantity.required = true;
  quantity.setAttribute("aria-label", "Số lượng nhập");
  const unitCost = document.createElement("input");
  unitCost.className = "receipt-item-cost";
  unitCost.required = true;
  unitCost.placeholder = "Đơn giá";
  unitCost.setAttribute("aria-label", "Đơn giá mua");
  addPriceInput(unitCost);
  const lineTotal = document.createElement("span");
  lineTotal.className = "receipt-line-total";
  lineTotal.textContent = "—";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "line-remove";
  remove.setAttribute("aria-label", "Xóa vật tư khỏi phiếu nhập");
  remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18m-2 0-.9 14H5.9L5 6m4 0V4h6v2m-5 4v6m4-6v6"/></svg>';
  name.addEventListener("input", () => {
    const product = data.products.find((item) => item.name.toLocaleLowerCase() === name.value.trim().toLocaleLowerCase());
    if (product && !unit.value) unit.value = product.unit || "";
  });
  remove.addEventListener("click", () => { row.remove(); updateReceiptTotal(); });
  row.append(name, list, unit, quantity, unitCost, lineTotal, remove);
  $("#receipt-lines").append(row);
  updateReceiptTotal();
}

function updateReceiptTotal() {
  let total = 0;
  $$(".receipt-line", $("#receipt-lines")).forEach((row) => {
    const quantity = Number($(".receipt-item-quantity", row).value || 0);
    const parsedCost = parsePrice($(".receipt-item-cost", row).value);
    const unitCost = Number.isFinite(parsedCost) ? parsedCost : 0;
    const lineTotal = quantity * unitCost;
    total += lineTotal;
    $(".receipt-line-total", row).textContent = quantity > 0 ? money(lineTotal) : "—";
  });
  $("#receipt-total").textContent = money(total);
}

async function createReceipt(event) {
  event.preventDefault();
  const lines = $$(".receipt-line", $("#receipt-lines")).map((row) => {
    const name = $(".receipt-item-name", row).value.trim();
    const product = data.products.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    return {
      productId: product?.id || "",
      name,
      unit: $(".receipt-item-unit", row).value.trim() || product?.unit || "",
      quantity: Number($(".receipt-item-quantity", row).value),
      unitCost: parsePrice($(".receipt-item-cost", row).value),
    };
  });
  if (!lines.length || lines.some((line) => !line.name || !Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unitCost) || line.unitCost < 0)) {
    showDialogError("receipt-error", "Nhập tên vật tư, số lượng lớn hơn 0 và đơn giá hợp lệ cho từng dòng.");
    return;
  }
  const receipt = {
    id: id(),
    date: $("#receipt-date").value,
    supplier: $("#receipt-supplier").value.trim(),
    note: $("#receipt-note").value.trim(),
    lines,
    createdAt: new Date().toISOString(),
  };
  const previousData = data;
  data = { ...data, receipts: [receipt, ...data.receipts] };
  if (!await persist()) { data = previousData; return; }
  closeDialog($("#receipt-dialog"));
  renderCurrentView();
  toast("Đã lưu phiếu nhập vật tư. Tồn kho không thay đổi.");
}

function showView(view) {
  activeView = view;
  $$(".view-panel").forEach((panel) => { panel.hidden = panel.id !== `${view}-view`; });
  $$(".nav-item[data-view]").forEach((button) => {
    const current = button.dataset.view === view;
    button.classList.toggle("active", current);
    if (current) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#breadcrumb-title").textContent = { overview: "Tổng quan", revenue: "Chi tiết doanh thu", products: "Sản phẩm", orders: "Đơn hàng", receiving: "Nhập vật tư", expenses: "Chi phí vận hành", customers: "Khách hàng" }[view];
  if (view === "overview") renderOverview();
  if (view === "revenue") renderRevenue();
  if (view === "products") renderProducts();
  if (view === "orders") renderOrders();
  if (view === "receiving") renderReceipts();
  if (view === "expenses") renderExpenses();
  if (view === "customers") renderCustomers();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearDialogError(idValue) {
  const error = $(`#${idValue}`);
  error.hidden = true;
  error.textContent = "";
}
function showDialogError(idValue, message) {
  const error = $(`#${idValue}`);
  error.textContent = message;
  error.hidden = false;
}

function openProductDialog(productId = "") {
  const form = $("#product-form");
  form.reset();
  clearDialogError("product-error");
  const product = data.products.find((item) => item.id === productId);
  populateProductUnits(product?.unit || "cái");
  form.elements.id.value = product?.id || "";
  form.elements.name.value = product?.name || "";
  form.elements.sku.value = product?.sku || "";
  form.elements.unit.value = product?.unit || "cái";
  form.elements.costPrice.value = product?.costPrice ?? "";
  formatPriceInput(form.elements.costPrice);
  form.elements.description.value = product?.description || "";
  $("#size-price-list").replaceChildren();
  (Array.isArray(product?.sizes) ? product.sizes : []).forEach((size) => addSizePriceRow({
    ...size,
    costPrice: size.costPrice ?? product.costPrice ?? "",
  }));
  selectedProductImage = null;
  clearProductImage = false;
  if (productImagePreviewUrl) URL.revokeObjectURL(productImagePreviewUrl);
  productImagePreviewUrl = null;
  $("#product-image-input").value = "";
  $("#product-image-preview").replaceChildren();
  $("#product-image-preview").hidden = true;
  $("#remove-product-image").hidden = true;
  if (product?.imageId) {
    getProductImage(product.imageId).then((blob) => {
      if (blob && form.elements.id.value === product.id && !selectedProductImage && !clearProductImage) setProductImagePreview(blob);
    }).catch((error) => {
      console.error("Unable to load product image in editor.", error);
      showDialogError("product-error", "Không thể tải hình ảnh hiện tại của sản phẩm.");
    });
  }
  $("#product-dialog-title").textContent = product ? "Cập nhật sản phẩm" : "Thêm sản phẩm";
  openDialog($("#product-dialog"));
}
function populateProductUnits(selectedUnit) {
  const select = $("#product-unit");
  const usedUnits = data.products.map((product) => product.unit).filter(Boolean);
  const units = [...new Map([...data.units, ...usedUnits, selectedUnit]
    .map((unit) => [unit.toLocaleLowerCase(), unit])).values()];
  select.replaceChildren(new Option("Chọn đơn vị", ""));
  units.forEach((unit) => select.add(new Option(unit, unit)));
  select.add(new Option("+ Thêm mới", "__add_new__"));
  select.value = selectedUnit;
  select.dataset.previousValue = selectedUnit;
  $("#unit-create").hidden = true;
  $("#new-product-unit").value = "";
}
function handleProductUnitChange(event) {
  const select = event.currentTarget;
  if (select.value !== "__add_new__") {
    select.dataset.previousValue = select.value;
    return;
  }
  select.value = select.dataset.previousValue || "";
  $("#unit-create").hidden = false;
  $("#new-product-unit").focus();
}
async function addProductUnit() {
  const select = $("#product-unit");
  const unit = $("#new-product-unit").value.trim();
  if (!unit || unit.length > 24) {
    $("#new-product-unit").focus();
    if (unit.length > 24) toast("Tên đơn vị tối đa 24 ký tự.", true);
    return;
  }
  const existing = [...select.options].find((option) => option.value.toLocaleLowerCase() === unit.toLocaleLowerCase());
  const savedUnit = existing?.value || unit;
  const knownUnit = data.units.some((item) => item.toLocaleLowerCase() === savedUnit.toLocaleLowerCase());
  if (!knownUnit) {
    const oldData = data;
    const addButton = $("#add-product-unit");
    const cancelButton = $("#cancel-product-unit");
    addButton.disabled = true;
    cancelButton.disabled = true;
    addButton.textContent = "Đang lưu...";
    data = { ...data, units: [...data.units, savedUnit] };
    const saved = await persist();
    addButton.disabled = false;
    cancelButton.disabled = false;
    addButton.textContent = "Thêm";
    if (!saved) {
      data = oldData;
      return;
    }
  }
  if (!existing) select.add(new Option(savedUnit, savedUnit), select.options.length - 1);
  select.value = savedUnit;
  select.dataset.previousValue = savedUnit;
  $("#new-product-unit").value = "";
  $("#unit-create").hidden = true;
  if (!knownUnit) toast("Đã lưu đơn vị tính lên database.");
}
function cancelProductUnit() {
  const select = $("#product-unit");
  select.value = select.dataset.previousValue || "";
  $("#new-product-unit").value = "";
  $("#unit-create").hidden = true;
}
function addSizePriceRow(size = {}) {
  const row = document.createElement("div");
  row.className = "size-price-row";
  const sizeField = document.createElement("div");
  const sizeLabel = document.createElement("label");
  const sizeInput = document.createElement("input");
  sizeInput.type = "text";
  sizeInput.className = "size-label";
  sizeInput.maxLength = 40;
  sizeInput.placeholder = "Ví dụ: Size 1 / 100–200g";
  sizeInput.value = size.label || "";
  sizeInput.setAttribute("aria-label", "Tên hoặc khoảng size");
  sizeLabel.textContent = "Size";
  sizeField.append(sizeLabel, sizeInput);
  const priceField = document.createElement("div");
  const priceLabel = document.createElement("label");
  const priceInput = document.createElement("input");
  priceInput.className = "size-price";
  priceInput.required = true;
  priceInput.placeholder = "0";
  priceInput.value = size.price ?? "";
  addPriceInput(priceInput);
  priceInput.setAttribute("aria-label", "Giá bán cho size này");
  priceLabel.textContent = "Giá bán / đơn vị";
  priceField.append(priceLabel, priceInput);
  const costField = document.createElement("div");
  const costLabel = document.createElement("label");
  const costInput = document.createElement("input");
  costInput.className = "size-cost";
  costInput.required = true;
  costInput.placeholder = "Giá mua";
  costInput.value = size.costPrice ?? "";
  addPriceInput(costInput);
  costInput.setAttribute("aria-label", "Giá mua cho size này");
  costLabel.textContent = "Giá mua / đơn vị";
  costField.append(costLabel, costInput);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "line-remove";
  remove.setAttribute("aria-label", "Xóa mức size và giá");
  remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18m-2 0-.9 14H5.9L5 6m4 0V4h6v2m-5 4v6m4-6v6"/></svg>';
  remove.addEventListener("click", () => row.remove());
  row.append(sizeField, priceField, costField, remove);
  $("#size-price-list").append(row);
}
function setProductImagePreview(blob) {
  if (productImagePreviewUrl) URL.revokeObjectURL(productImagePreviewUrl);
  productImagePreviewUrl = URL.createObjectURL(blob);
  const image = document.createElement("img");
  image.src = productImagePreviewUrl;
  image.alt = "Xem trước hình ảnh sản phẩm";
  $("#product-image-preview").replaceChildren(image);
  $("#product-image-preview").hidden = false;
  $("#remove-product-image").hidden = false;
}
async function submitProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const productId = values.get("id");
  const previous = data.products.find((item) => item.id === productId);
  const sku = String(values.get("sku")).trim();
  const duplicateSku = sku && data.products.some((product) => product.sku.toLowerCase() === sku.toLowerCase() && product.id !== productId);
  if (duplicateSku) {
    showDialogError("product-error", "Mã hàng này đã được sử dụng cho một sản phẩm khác.");
    return;
  }
  const sizeRows = $$(".size-price-row", $("#size-price-list")).map((row) => ({
    label: $(".size-label", row).value.trim(),
    rawPrice: $(".size-price", row).value,
    rawCost: $(".size-cost", row).value,
  }));
  if (sizeRows.some((size) => !size.label && (size.rawPrice !== "" || size.rawCost !== "") || size.label && (size.rawPrice === "" || size.rawCost === ""))) {
    showDialogError("product-error", "Hoàn tất tên size, giá bán và giá mua cho từng dòng, hoặc xóa dòng chưa dùng.");
    return;
  }
  const sizes = sizeRows.filter((size) => size.label && size.rawPrice !== "" && size.rawCost !== "").map((size) => ({ label: size.label, price: parsePrice(size.rawPrice), costPrice: parsePrice(size.rawCost) }));
  if (sizes.some((size) => !Number.isFinite(size.price) || size.price < 0 || !Number.isFinite(size.costPrice) || size.costPrice < 0)) {
    showDialogError("product-error", "Giá bán và giá mua theo size phải là số hợp lệ, từ 0 trở lên.");
    return;
  }
  if (new Set(sizes.map((size) => size.label.toLocaleLowerCase())).size !== sizes.length) {
    showDialogError("product-error", "Tên size không được trùng nhau.");
    return;
  }
  const rawCostPrice = values.get("costPrice");
  const costPrice = rawCostPrice === "" ? null : parsePrice(rawCostPrice);
  if (costPrice !== null && (!Number.isFinite(costPrice) || costPrice < 0)) {
    showDialogError("product-error", "Giá mua mặc định phải là số hợp lệ, từ 0 trở lên.");
    return;
  }
  if (!sizes.length && costPrice === null) {
    showDialogError("product-error", "Nhập giá mua mặc định cho sản phẩm không chia size.");
    return;
  }
  let imageId = previous?.imageId || "";
  try {
    if (selectedProductImage) imageId = await storeProductImage(selectedProductImage);
    if (clearProductImage) imageId = "";
  } catch (error) {
    console.error("Unable to save product image.", error);
    showDialogError("product-error", error.message || "Không thể lưu hình ảnh. Hãy thử lại.");
    return;
  }
  const unit = String(values.get("unit")).trim();
  const knownUnit = data.units.some((item) => item.toLocaleLowerCase() === unit.toLocaleLowerCase());
  const product = {
    id: productId || id(),
    name: String(values.get("name")).trim(),
    sku,
    unit,
    costPrice,
    sizes,
    imageId,
    description: String(values.get("description")).trim(),
    createdAt: previous?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const oldData = data;
  data = {
    ...data,
    products: productId ? data.products.map((item) => item.id === productId ? product : item) : [product, ...data.products],
    units: knownUnit ? data.units : [...data.units, unit],
  };
  if (!await persist()) {
    data = oldData;
    if (selectedProductImage && imageId && imageId !== previous?.imageId) {
      try { await deleteProductImage(imageId); } catch (error) { console.error("Unable to clean up unsaved product image.", error); }
    }
    return;
  }
  if (previous?.imageId && previous.imageId !== imageId) {
    try { await deleteProductImage(previous.imageId); } catch (error) {
      console.error("Unable to remove replaced product image.", error);
      toast("Đã cập nhật sản phẩm nhưng không xóa được ảnh cũ trên cloud.", true);
    }
  }
  closeDialog($("#product-dialog"));
  renderCurrentView();
  toast(productId ? "Đã cập nhật sản phẩm." : "Đã thêm sản phẩm vào danh mục.");
}
async function deleteProduct(productId) {
  if (data.orders.some((order) => order.status !== "cancelled" && order.lines.some((line) => line.productId === productId))) {
    toast("Sản phẩm nằm trong đơn hàng. Hãy hủy các đơn liên quan trước khi xóa.", true);
    return;
  }
  const product = data.products.find((item) => item.id === productId);
  if (!product || !window.confirm(`Xóa sản phẩm “${product.name}” khỏi danh mục?`)) return;
  const oldData = data;
  data = { ...data, products: data.products.filter((item) => item.id !== productId) };
  if (!await persist()) { data = oldData; return; }
  if (product.imageId) {
    try { await deleteProductImage(product.imageId); } catch (error) {
      console.error("Unable to remove deleted product image.", error);
      toast("Đã xóa sản phẩm nhưng không xóa được tệp hình ảnh.", true);
    }
  }
  renderCurrentView();
  toast("Đã xóa sản phẩm.");
}

function openCustomerDialog(customerId = "") {
  const form = $("#customer-form");
  form.reset();
  clearDialogError("customer-error");
  const customer = data.customers.find((item) => item.id === customerId);
  form.elements.id.value = customer?.id || "";
  form.elements.name.value = customer?.name || "";
  form.elements.phone.value = customer?.phone || "";
  form.elements.social.value = customer?.social || "";
  $("#customer-dialog-title").textContent = customer ? "Cập nhật khách hàng" : "Thêm khách hàng";
  openDialog($("#customer-dialog"));
}
function normalizePhone(phone) { return phone.replace(/[^\d+]/g, ""); }
async function submitCustomer(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const customerId = values.get("id");
  const phone = String(values.get("phone")).trim();
  if (phone.replace(/\D/g, "").length < 8) {
    showDialogError("customer-error", "Vui lòng nhập số điện thoại hợp lệ (ít nhất 8 chữ số).");
    return;
  }
  const duplicate = data.customers.find((customer) => normalizePhone(customer.phone) === normalizePhone(phone) && customer.id !== customerId);
  if (duplicate) {
    showDialogError("customer-error", `Số điện thoại này đã thuộc về ${duplicate.name}.`);
    return;
  }
  const social = String(values.get("social")).trim();
  if (social) {
    try {
      const url = new URL(social);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid URL protocol");
    } catch {
      showDialogError("customer-error", "Link mạng xã hội cần là đường dẫn hợp lệ, bắt đầu bằng http:// hoặc https://.");
      return;
    }
  }
  const previous = data.customers.find((customer) => customer.id === customerId);
  const customer = { id: customerId || id(), name: String(values.get("name")).trim(), phone, social, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  const oldData = data;
  data = { ...data, customers: customerId ? data.customers.map((item) => item.id === customerId ? customer : item) : [customer, ...data.customers] };
  if (!await persist()) { data = oldData; return; }
  closeDialog($("#customer-dialog"));
  renderCurrentView();
  toast(customerId ? "Đã cập nhật thông tin khách hàng." : "Đã thêm khách hàng.");
}
async function deleteCustomer(customerId) {
  if (pendingFishRewards(customerId).length) {
    toast("Khách hàng đang có quà tặng cá cần chuẩn bị. Hãy ghi nhận quà đã tặng trước khi xóa hồ sơ.", true);
    return;
  }
  if (data.orders.some((order) => order.customerId === customerId && order.status !== "cancelled")) {
    toast("Khách hàng có đơn chưa hủy. Không thể xóa hồ sơ này.", true);
    return;
  }
  const customer = data.customers.find((item) => item.id === customerId);
  if (!customer || !window.confirm(`Xóa hồ sơ khách hàng “${customer.name}”?`)) return;
  const oldData = data;
  data = { ...data, customers: data.customers.filter((item) => item.id !== customerId) };
  if (!await persist()) { data = oldData; return; }
  renderCurrentView();
  toast("Đã xóa khách hàng.");
}

function openOrderDialog() {
  if (!data.products.length) {
    toast("Hãy thêm ít nhất một sản phẩm trước khi tạo đơn.", true);
    showView("products");
    return;
  }
  $("#order-form").reset();
  clearDialogError("order-error");
  $("#order-note").value = "";
  $("#order-customer-name").readOnly = false;
  $("#order-customer-name").required = true;
  $("#order-name-required").hidden = false;
  $("#order-customer-match").textContent = "Nếu số điện thoại chưa có trong danh bạ, hãy nhập tên để tạo hồ sơ mới.";
  $("#order-customer-match").className = "order-customer-match";
  $("#order-lines").replaceChildren();
  addOrderLine();
  openDialog($("#order-dialog"));
}
function updateOrderCustomerMatch() {
  const phone = $("#order-customer-phone").value.trim();
  const nameInput = $("#order-customer-name");
  const nameRequired = $("#order-name-required");
  const status = $("#order-customer-match");
  if (phone.replace(/\D/g, "").length < 8) {
    if (nameInput.readOnly) nameInput.value = "";
    nameInput.readOnly = false;
    nameInput.required = true;
    nameRequired.hidden = false;
    status.textContent = phone ? "Nhập số điện thoại hợp lệ (ít nhất 8 chữ số)." : "Nếu số điện thoại chưa có trong danh bạ, hãy nhập tên để tạo hồ sơ mới.";
    status.className = "order-customer-match";
    return;
  }
  const customer = data.customers.find((item) => normalizePhone(item.phone) === normalizePhone(phone));
  if (customer) {
    nameInput.value = customer.name;
    nameInput.readOnly = true;
    nameInput.required = false;
    nameRequired.hidden = true;
    status.textContent = `Đã tìm thấy khách hàng: ${customer.name}. Đơn sẽ được lưu vào hồ sơ này.`;
    status.className = "order-customer-match is-matched";
  } else {
    if (nameInput.readOnly) nameInput.value = "";
    nameInput.readOnly = false;
    nameInput.required = true;
    nameRequired.hidden = false;
    status.textContent = "Số điện thoại chưa có trong danh bạ. Nhập họ tên để tạo hồ sơ cùng lúc lưu đơn.";
    status.className = "order-customer-match is-new";
  }
}
function addOrderLine() {
  const available = data.products;
  if (!available.length) {
    showDialogError("order-error", "Thêm sản phẩm vào danh mục trước khi tạo đơn.");
    return;
  }
  const row = document.createElement("div");
  row.className = "order-line";
  row.dataset.line = String(++lineId);
  const select = document.createElement("select");
  select.className = "line-product";
  select.setAttribute("aria-label", "Chọn sản phẩm");
  select.innerHTML = `<option value="">Chọn sản phẩm</option>${available.map((product) => `<option value="${escapeText(product.id)}" data-unit="${escapeText(product.unit || "cái")}">${escapeText(product.name)}</option>`).join("")}`;
  const sizeSelect = document.createElement("select");
  sizeSelect.className = "line-size";
  sizeSelect.setAttribute("aria-label", "Chọn size sản phẩm");
  sizeSelect.hidden = true;
  const qty = document.createElement("input");
  qty.type = "number";
  qty.className = "line-quantity";
  qty.min = "1";
  qty.step = "1";
  qty.value = "1";
  qty.setAttribute("aria-label", "Số lượng sản phẩm");
  const priceInput = document.createElement("input");
  priceInput.className = "line-unit-price";
  priceInput.required = true;
  priceInput.placeholder = "Giá bán";
  priceInput.setAttribute("aria-label", "Đơn giá bán cho mặt hàng này");
  addPriceInput(priceInput);
  const unit = document.createElement("span");
  unit.className = "line-unit";
  unit.textContent = "đơn vị";
  const price = document.createElement("span");
  price.className = "line-price";
  price.textContent = "—";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "line-remove";
  remove.setAttribute("aria-label", "Xóa mặt hàng khỏi đơn");
  remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18m-2 0-.9 14H5.9L5 6m4 0V4h6v2m-5 4v6m4-6v6"/></svg>';
  select.addEventListener("change", () => configureOrderLine(row));
  sizeSelect.addEventListener("change", () => updateLinePrice(row, true));
  qty.addEventListener("input", () => updateLinePrice(row));
  priceInput.addEventListener("input", () => updateLinePrice(row));
  remove.addEventListener("click", () => { row.remove(); updateOrderTotal(); });
  row.append(select, sizeSelect, qty, unit, priceInput, price, remove);
  $("#order-lines").append(row);
  updateOrderTotal();
}
function configureOrderLine(row) {
  const product = data.products.find((item) => item.id === $(".line-product", row).value);
  const sizeSelect = $(".line-size", row);
  const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
  row.classList.toggle("has-sizes", sizes.length > 0);
  sizeSelect.replaceChildren();
  sizeSelect.hidden = !sizes.length;
  sizeSelect.required = sizes.length > 0;
  if (sizes.length) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Chọn size";
    sizeSelect.append(placeholder);
    sizes.forEach((size) => {
      const option = document.createElement("option");
      option.value = size.label;
      option.textContent = `${size.label} · ${money(size.price)}`;
      option.dataset.price = String(size.price);
      option.dataset.costPrice = String(typeof size.costPrice === "number" ? size.costPrice : typeof product.costPrice === "number" ? product.costPrice : "");
      sizeSelect.append(option);
    });
  }
  $(".line-unit-price", row).value = "";
  updateLinePrice(row);
}
function updateLinePrice(row, useSizePrice = false) {
  const select = $(".line-product", row);
  const option = select.selectedOptions[0];
  const selectedSize = $(".line-size", row).selectedOptions[0];
  const quantity = Number($(".line-quantity", row).value);
  $(".line-unit", row).textContent = option?.dataset.unit || "đơn vị";
  if (useSizePrice) {
    $(".line-unit-price", row).value = selectedSize?.dataset.price || "";
    formatPriceInput($(".line-unit-price", row));
  }
  if (selectedSize?.value) $(".line-unit-price", row).setAttribute("aria-label", `Đơn giá bán cho ${selectedSize.value}`);
  else $(".line-unit-price", row).setAttribute("aria-label", "Đơn giá bán cho mặt hàng này");
  const itemPrice = parsePrice($(".line-unit-price", row).value);
  $(".line-price", row).textContent = option?.value && quantity > 0 && $(".line-unit-price", row).value !== "" ? money(quantity * itemPrice) : "—";
  updateOrderTotal();
}
function updateOrderTotal() {
  const rows = $$(".order-line", $("#order-lines"));
  const total = rows.reduce((sum, row) => {
    const parsedPrice = parsePrice($(".line-unit-price", row).value);
    const price = Number.isFinite(parsedPrice) ? parsedPrice : 0;
    return sum + price * Number($(".line-quantity", row).value || 0);
  }, 0);
  $("#order-total").textContent = money(total);
  const quantitiesByUnit = new Map();
  rows.forEach((row) => {
    const product = data.products.find((item) => item.id === $(".line-product", row).value);
    const quantity = Number($(".line-quantity", row).value);
    if (!product || !Number.isInteger(quantity) || quantity <= 0) return;
    const unit = (product.unit || "cái").trim();
    quantitiesByUnit.set(unit, (quantitiesByUnit.get(unit) || 0) + quantity);
  });
  $("#order-quantity-total").textContent = quantitiesByUnit.size
    ? `Tổng số lượng: ${[...quantitiesByUnit].map(([unit, quantity]) => `${number(quantity)} ${unit}`).join(" · ")}`
    : "Chưa có mặt hàng";
  updateOrderFishRewardSummary();
}
function updateOrderFishRewardSummary() {
  const summary = $("#order-reward-summary");
  const body = $("#order-reward-lines");
  const phone = $("#order-customer-phone").value.trim();
  if (phone.replace(/\D/g, "").length < 8) {
    summary.hidden = true;
    body.replaceChildren();
    return;
  }

  const customer = data.customers.find((item) => normalizePhone(item.phone) === normalizePhone(phone));
  let runningFishCount = customer ? fishBought(customer.id) : 0;
  const existingRewards = customer ? data.fishRewards.filter((reward) => reward.customerId === customer.id) : [];
  const giftByRow = new Map();
  const rows = $$(".order-line", $("#order-lines"));
  rows.forEach((row) => {
    const product = data.products.find((item) => item.id === $(".line-product", row).value);
    const quantity = Number($(".line-quantity", row).value);
    if (!product || !isFishUnit(product.unit || "") || !Number.isInteger(quantity) || quantity <= 0) return;
    const firstMilestone = Math.floor(runningFishCount / 10) + 1;
    const lastMilestone = Math.floor((runningFishCount + quantity) / 10);
    let giftCount = 0;
    for (let milestone = firstMilestone; milestone <= lastMilestone; milestone += 1) {
      const reward = existingRewards.find((item) => item.milestone === milestone);
      if (!reward || reward.status === "void") giftCount += 1;
    }
    if (giftCount) giftByRow.set(row, giftCount);
    runningFishCount += quantity;
  });

  if (!giftByRow.size) {
    summary.hidden = true;
    body.replaceChildren();
    return;
  }

  const orderRows = rows.filter((row) => {
    const product = data.products.find((item) => item.id === $(".line-product", row).value);
    return product && $(".line-product", row).value;
  });
  const giftTotal = [...giftByRow.values()].reduce((sum, count) => sum + count, 0);
  $("#order-reward-count").textContent = `${number(giftTotal)} con tặng`;
  body.innerHTML = orderRows.map((row) => {
    const product = data.products.find((item) => item.id === $(".line-product", row).value);
    const size = $(".line-size", row).value;
    const quantity = Number($(".line-quantity", row).value);
    const price = parsePrice($(".line-unit-price", row).value);
    const lineName = `${product.name}${size ? ` · ${size}` : ""}`;
    const amount = Number.isFinite(price) && Number.isInteger(quantity) && quantity > 0 ? money(price * quantity) : "—";
    return `<tr><td data-label="Tên mặt hàng">${escapeText(lineName)}</td><td data-label="Số lượng">${Number.isInteger(quantity) && quantity > 0 ? number(quantity) : "—"} ${escapeText(product.unit || "cái")}</td><td data-label="Đơn giá">${Number.isFinite(price) && price >= 0 ? money(price) : "—"}</td><td data-label="Thành tiền">${amount}</td><td data-label="Số lượng tặng">${number(giftByRow.get(row) || 0)} con</td></tr>`;
  }).join("");
  summary.hidden = false;
}
async function createOrder(event) {
  event.preventDefault();
  const customerPhone = $("#order-customer-phone").value.trim();
  const customerName = $("#order-customer-name").value.trim();
  if (customerPhone.replace(/\D/g, "").length < 8) {
    showDialogError("order-error", "Vui lòng nhập số điện thoại hợp lệ (ít nhất 8 chữ số).");
    return;
  }
  let customer = data.customers.find((item) => normalizePhone(item.phone) === normalizePhone(customerPhone));
  if (!customer && !customerName) {
    showDialogError("order-error", "Nhập họ tên khách hàng mới để lưu vào danh bạ.");
    $("#order-customer-name").focus();
    return;
  }
  const lines = $$(".order-line", $("#order-lines")).map((row) => {
    const productId = $(".line-product", row).value;
    const product = data.products.find((item) => item.id === productId);
    const size = $(".line-size", row).selectedOptions[0];
    const rawCostPrice = size?.value ? size.dataset.costPrice : product?.costPrice;
    const costPrice = rawCostPrice === "" || rawCostPrice == null ? null : Number(rawCostPrice);
    return product ? { productId, name: product.name, sku: product.sku, unit: product.unit || "cái", size: size?.value || "", quantity: Number($(".line-quantity", row).value), price: parsePrice($(".line-unit-price", row).value), costPrice: Number.isFinite(costPrice) ? costPrice : null } : null;
  }).filter(Boolean);
  if (!lines.length) { showDialogError("order-error", "Thêm ít nhất một mặt hàng vào đơn."); return; }
  const missingSize = $$(".order-line", $("#order-lines")).some((row) => {
    const product = data.products.find((item) => item.id === $(".line-product", row).value);
    return Array.isArray(product?.sizes) && product.sizes.length > 0 && !$(".line-size", row).value;
  });
  if (missingSize) {
    showDialogError("order-error", "Chọn size cho từng mặt hàng có bảng giá theo size.");
    return;
  }
  if (lines.some((line) => !Number.isFinite(line.price) || line.price < 0 || !Number.isInteger(line.quantity) || line.quantity < 1)) {
    showDialogError("order-error", "Nhập số lượng và giá bán hợp lệ cho từng mặt hàng.");
    return;
  }
  const now = new Date().toISOString();
  const isNewCustomer = !customer;
  if (isNewCustomer) {
    customer = { id: id(), name: customerName, phone: customerPhone, social: "", createdAt: now, updatedAt: now };
  }
  const serial = (Math.max(0, ...data.orders.map((order) => Number(order.number.replace(/\D/g, "")) || 0)) + 1).toString().padStart(4, "0");
  const order = { id: id(), number: `KM-${serial}`, customerId: customer.id, lines, note: $("#order-note").value.trim(), status: "delivered", createdAt: now, updatedAt: now };
  const previousData = data;
  data = {
    ...data,
    customers: isNewCustomer ? [customer, ...data.customers] : data.customers,
    orders: [order, ...data.orders],
  };
  const rewardResult = reconcileFishRewards(customer.id, order.id);
  data = { ...data, fishRewards: rewardResult.rewards };
  if (!await persist()) { data = previousData; return; }
  closeDialog($("#order-dialog"));
  renderCurrentView();
  const baseMessage = isNewCustomer ? `Đã tạo đơn #${order.number} và thêm khách hàng ${customer.name} vào danh bạ.` : `Đã tạo đơn #${order.number} cho ${customer.name}.`;
  toast(rewardResult.newlyPending ? `${baseMessage} Khách đã mua ${rewardResult.fishCount} con cá: nhớ tặng ${rewardResult.newlyPending} con.` : baseMessage);
}
async function deleteOrder(orderId) {
  const order = data.orders.find((item) => item.id === orderId);
  if (!order || !window.confirm(`Xóa đơn #${order.number}?`)) return;
  const previousData = data;
  data = { ...data, orders: data.orders.filter((item) => item.id !== orderId) };
  const rewardResult = reconcileFishRewards(order.customerId);
  data = { ...data, fishRewards: rewardResult.rewards };
  if (!await persist()) { data = previousData; return; }
  renderCurrentView();
  const customer = customerFor(order);
  toast(rewardResult.newlyPending
    ? `Đã xóa đơn. ${customer?.name || "Khách hàng"} vẫn đủ mốc tặng cá; cần tặng ${rewardResult.newlyPending} con.`
    : "Đã xóa đơn hàng.");
}

function renderCurrentView() {
  if (activeView === "overview") renderOverview();
  if (activeView === "revenue") renderRevenue($("#revenue-period")?.value || "month");
  if (activeView === "products") renderProducts($("#view-search")?.value || "");
  if (activeView === "orders") renderOrders($("#view-search")?.value || "");
  if (activeView === "receiving") renderReceipts($("#view-search")?.value || "");
  if (activeView === "expenses") renderExpenses($("#view-search")?.value || "");
  if (activeView === "customers") renderCustomers($("#view-search")?.value || "");
  renderCounts();
}

async function downloadBackup(store, imageLoader) {
  const productImages = [];
  for (const product of store.products) {
    if (product.imageId) {
      const image = await imageLoader(product.imageId);
      if (!image) throw new Error(`Không tìm thấy hình ảnh của sản phẩm “${product.name}”.`);
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("Không thể đọc hình ảnh."));
        reader.readAsDataURL(image);
      });
      productImages.push({ id: product.imageId, dataUrl });
    }
  }
  const contents = { exportedAt: new Date().toISOString(), ...store, productImages };
  const blob = new Blob([JSON.stringify(contents, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fish-store-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportData() {
  try {
    await downloadBackup(data, getProductImage);
    toast("Đã tải bản sao lưu dữ liệu cửa hàng, bao gồm hình ảnh sản phẩm.");
  } catch (error) {
    console.error("Could not export store data.", error);
    toast(error.message || "Không thể tạo bản sao lưu. Hãy thử lại.", true);
  }
}

function bindEvents() {
  $$(".nav-item[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $("#overview-new-order").addEventListener("click", openOrderDialog);
  $("#metric-revenue").addEventListener("click", () => showView("revenue"));
  $("#product-form").addEventListener("submit", submitProduct);
  $("#add-size-price").addEventListener("click", () => addSizePriceRow());
  $("#choose-product-image").addEventListener("click", () => $("#product-image-input").click());
  $("#product-image-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      event.target.value = "";
      showDialogError("product-error", "Chọn ảnh JPG, PNG hoặc WEBP có dung lượng tối đa 8 MB.");
      return;
    }
    clearDialogError("product-error");
    selectedProductImage = file;
    clearProductImage = false;
    setProductImagePreview(file);
  });
  $("#remove-product-image").addEventListener("click", () => {
    selectedProductImage = null;
    clearProductImage = true;
    $("#product-image-input").value = "";
    $("#product-image-preview").replaceChildren();
    $("#product-image-preview").hidden = true;
    $("#remove-product-image").hidden = true;
    if (productImagePreviewUrl) URL.revokeObjectURL(productImagePreviewUrl);
    productImagePreviewUrl = null;
  });
  $("#customer-form").addEventListener("submit", submitCustomer);
  $("#order-form").addEventListener("submit", createOrder);
  $(".order-payment-qr-open").addEventListener("click", () => openDialog($("#qr-lightbox")));
  $("#qr-lightbox").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog($("#qr-lightbox"));
    }
  });
  $("#order-customer-phone").addEventListener("input", () => {
    updateOrderCustomerMatch();
    updateOrderFishRewardSummary();
  });
  $("#receipt-form").addEventListener("submit", createReceipt);
  $("#expense-form").addEventListener("submit", createExpense);
  $("#add-receipt-line").addEventListener("click", addReceiptLine);
  $("#receipt-lines").addEventListener("input", updateReceiptTotal);
  $("#add-order-line").addEventListener("click", addOrderLine);
  $("#order-lines").addEventListener("input", updateOrderTotal);
  $("#data-info-button").addEventListener("click", () => openDialog($("#data-dialog")));
  $("#about-button").addEventListener("click", () => openDialog($("#data-dialog")));
  $("#footer-data-button").addEventListener("click", () => openDialog($("#data-dialog")));
  $("#export-data-button").addEventListener("click", exportData);
  $("#dialog-export-button").addEventListener("click", exportData);
  $$("[data-close]").forEach((button) => button.addEventListener("click", () => closeDialog(button.closest("dialog"))));
  $$("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  }));
  $$("[data-go]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.go)));
}

function setLoginMode(setupRequired) {
  ownerSetupRequired = setupRequired;
  $("#login-setup-note").hidden = !setupRequired;
  $("#login-account-label").textContent = setupRequired ? "Tài khoản chủ mới" : "Tài khoản";
  $("#login-password-label").textContent = setupRequired ? "Mật khẩu mới (tối thiểu 12 ký tự)" : "Mật khẩu";
  $("#login-account").minLength = setupRequired ? 3 : 0;
  $("#login-password").minLength = setupRequired ? 12 : 0;
  $("#login-password").autocomplete = "off";
  $("#login-password-confirm-label").hidden = !setupRequired;
  $("#login-password-confirm").hidden = !setupRequired;
  $("#login-password-confirm").required = setupRequired;
  $("#login-password-confirm").minLength = setupRequired ? 12 : 0;
  $("#login-password-confirm").value = "";
  $("#login-submit").textContent = setupRequired ? "Tạo tài khoản chủ" : "Đăng nhập";
}

function showLogin(message = "") {
  $("#app-shell").hidden = true;
  $("#login-screen").hidden = false;
  $("#login-error").textContent = message;
  $("#login-error").hidden = !message;
}

async function apiJson(path, options = {}) {
  const response = await fetch(path, { ...options, credentials: "same-origin" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Không thể kết nối với dịch vụ online.");
  return result;
}

function hasLocalData(store) {
  return Object.values(store).some((items) => items.length > 0);
}

async function migrateLocalData() {
  data = structuredClone(localData);
  for (const product of data.products) {
    if (!product.imageId) continue;
    const image = await getLocalProductImage(product.imageId);
    if (!image) throw new Error(`Không tìm thấy ảnh cục bộ của sản phẩm “${product.name}”. Hãy nhập file sao lưu JSON có hình ảnh.`);
    await storeProductImage(image, product.imageId);
  }
}

async function startCloudApp() {
  if (cloudStartupInProgress) return;
  cloudStartupInProgress = true;
  try {
    const cloud = await apiJson("/api/store");
    cloudRevision = cloud.revision;
    if (cloud.data) {
      data = normalizeData(cloud.data);
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (error) {
        console.error("Could not cache cloud data locally.", error);
      }
    } else {
      if (hasLocalData(localData)) {
        await migrateLocalData();
        if (!await persist()) throw new Error("Không thể nhập dữ liệu hiện có vào cloud. Dữ liệu trên thiết bị cũ vẫn được giữ nguyên.");
        toast("Đã nhập dữ liệu cửa hàng lên cloud thành công.");
      } else {
        data = structuredClone(emptyData);
        if (!await persist()) throw new Error("Không thể khởi tạo dữ liệu cửa hàng.");
      }
    }

    if (!await initializeFishRewards()) throw new Error("Không thể đồng bộ dữ liệu quà tặng cá.");
    $("#login-screen").hidden = true;
    $("#app-shell").hidden = false;
    if (!appEventsBound) {
      bindEvents();
      appEventsBound = true;
    }
    if (!cloudRefreshTimer) cloudRefreshTimer = window.setInterval(refreshCloudData, 30000);
    renderOverview();
    return true;
  } catch (error) {
    console.error("Could not initialize cloud store.", error);
    showLogin(error.message || "Không thể tải dữ liệu online. Kiểm tra kết nối rồi thử lại.");
    return false;
  } finally {
    cloudStartupInProgress = false;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const button = $("#login-submit");
  button.disabled = true;
  button.textContent = ownerSetupRequired ? "Đang tạo tài khoản..." : "Đang đăng nhập...";
  $("#login-error").hidden = true;
  try {
    const form = new FormData(event.currentTarget);
    const account = form.get("account");
    const password = form.get("password");
    if (ownerSetupRequired && password !== form.get("passwordConfirm")) {
      throw new Error("Mật khẩu nhập lại không khớp.");
    }
    await apiJson(ownerSetupRequired ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account, password }),
    });
    setLoginMode(false);
    await startCloudApp();
  } catch (error) {
    showLogin(error.message || "Không thể đăng nhập. Hãy thử lại.");
  } finally {
    button.disabled = false;
    button.textContent = ownerSetupRequired ? "Tạo tài khoản chủ" : "Đăng nhập";
  }
}

async function handleLogout() {
  try {
    await apiJson("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.error("Could not end the cloud session.", error);
    toast("Không thể đăng xuất an toàn. Kiểm tra kết nối rồi thử lại.", true);
    return;
  }
  if (cloudRefreshTimer) window.clearInterval(cloudRefreshTimer);
  cloudRefreshTimer = null;
  cloudRevision = 0;
  data = structuredClone(emptyData);
  showLogin();
}

async function refreshCloudData() {
  if (cloudRefreshInProgress || document.hidden || pendingCloudWrites || $$("dialog[open]").length) return;
  cloudRefreshInProgress = true;
  try {
    const remote = await apiJson("/api/store");
    if (pendingCloudWrites || $$("dialog[open]").length) return;
    if (remote.revision <= cloudRevision) return;
    data = normalizeData(remote.data);
    cloudRevision = remote.revision;
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (error) {
      console.error("Could not cache refreshed cloud data locally.", error);
    }
    renderCurrentView();
    toast("Đã cập nhật dữ liệu mới nhất từ thiết bị khác.");
  } catch (error) {
    console.error("Could not refresh cloud data.", error);
  } finally {
    cloudRefreshInProgress = false;
  }
}

async function init() {
  const today = new Date();
  $$("form").forEach((form) => { form.autocomplete = "off"; });
  $$("input:not([type='password']), textarea, select").forEach((field) => field.setAttribute("autocomplete", "off"));
  $("#today-label").textContent = today.toLocaleDateString("vi-VN", { weekday: "long" }).toUpperCase();
  $("#today-date").textContent = today.toLocaleDateString("vi-VN", { day: "numeric", month: "long", year: "numeric" }).toUpperCase();
  addPriceInput($("#product-cost-price"));
  addPriceInput($("#expense-amount"));
  $("#product-unit").addEventListener("change", handleProductUnitChange);
  $("#add-product-unit").addEventListener("click", addProductUnit);
  $("#cancel-product-unit").addEventListener("click", cancelProductUnit);
  $("#new-product-unit").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addProductUnit();
    }
  });
  $("#login-form").addEventListener("submit", handleLogin);
  $("#logout-button").addEventListener("click", handleLogout);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCloudData();
  });
  showLogin();
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Không thể kiểm tra trạng thái đăng nhập.");
    if (result.authenticated) {
      setLoginMode(false);
      await startCloudApp();
    } else {
      setLoginMode(Boolean(result.setupRequired));
    }
  } catch (error) {
    console.error("Could not check owner session.", error);
    showLogin("Không kết nối được máy chủ. Kiểm tra kết nối internet rồi tải lại trang.");
  }
}

init();
