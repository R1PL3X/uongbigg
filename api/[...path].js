const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("@neondatabase/serverless");

const scrypt = promisify(crypto.scrypt);
let pool;

function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  pool ||= new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

function send(res, status, data) {
  res.status(status).json(data);
}

function fail(res, status, message) {
  send(res, status, { message });
  return null;
}

function userView(user) {
  return { maNguoiDung: Number(user.id), hoTen: user.ho_ten, email: user.email, vaiTro: user.vai_tro };
}

function menuView(row) {
  return {
    maMon: Number(row.id), tenMon: row.ten_mon, donGia: Number(row.don_gia),
    moTa: row.mo_ta || "", hinhAnh: row.hinh_anh || "", trangThai: row.trang_thai,
  };
}

function signSession(user) {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is not configured.");
  const payload = Buffer.from(JSON.stringify({ id: Number(user.id), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function currentUser(req) {
  const token = req.headers["x-ubg-token"];
  if (!token || typeof token !== "string" || !process.env.AUTH_SECRET) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isInteger(data.id) || data.exp < Date.now()) return null;
    const { rows } = await database().query("SELECT id, ho_ten, email, vai_tro FROM users WHERE id = $1", [data.id]);
    return rows[0] || null;
  } catch (_) {
    return null;
  }
}

async function requireUser(req, res, roles) {
  const user = await currentUser(req);
  if (!user) return fail(res, 401, "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
  if (roles && !roles.includes(user.vai_tro)) return fail(res, 403, "Bạn không có quyền thực hiện thao tác này.");
  return user;
}

function legacyHash(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

async function passwordMatches(password, stored) {
  if (!stored.startsWith("scrypt$")) {
    const actual = Buffer.from(legacyHash(password));
    const expected = Buffer.from(stored);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  const [, salt, expected] = stored.split("$");
  const derived = await scrypt(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return expectedBuffer.length === derived.length && crypto.timingSafeEqual(expectedBuffer, derived);
}

async function orderView(client, order) {
  const { rows: items } = await client.query(
    "SELECT ma_mon, ten_mon, so_luong, don_gia FROM order_items WHERE ma_don_hang = $1 ORDER BY id",
    [order.id],
  );
  return {
    maDonHang: Number(order.id), maDonRutGon: order.ma_don_rut_gon, ngayDat: order.ngay_dat,
    thoiGianNhan: order.thoi_gian_nhan, trangThai: order.trang_thai, tongTien: Number(order.tong_tien),
    chiTietDonHangs: items.map((item) => ({
      maMon: Number(item.ma_mon), tenMon: item.ten_mon, soLuong: Number(item.so_luong), donGia: Number(item.don_gia),
    })),
  };
}

function pathFromRequest(req) {
  if (Array.isArray(req.query.path)) return `/${req.query.path.join("/")}`;
  if (typeof req.query.path === "string") return `/${req.query.path}`;
  return "/";
}

function requestBody(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return req.body || {};
}

async function createOrder(user, body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw Object.assign(new Error("Giỏ hàng đang trống."), { status: 400 });
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const details = [];
    let total = 0;
    for (const item of items) {
      const id = Number(item.maMon);
      const quantity = Math.max(1, Number.parseInt(item.soLuong, 10) || 1);
      const { rows } = await client.query(
        "SELECT id, ten_mon, don_gia FROM menu_items WHERE id = $1 AND trang_thai = 'CON_HANG'",
        [id],
      );
      if (!rows[0]) continue;
      details.push({ ...rows[0], quantity });
      total += Number(rows[0].don_gia) * quantity;
    }
    if (!details.length) throw Object.assign(new Error("Các món trong giỏ hàng hiện không còn hàng."), { status: 400 });
    const pickup = body.thoiGianNhan ? new Date(body.thoiGianNhan) : new Date();
    if (Number.isNaN(pickup.getTime())) throw Object.assign(new Error("Thời gian nhận món không hợp lệ."), { status: 400 });
    const { rows } = await client.query(
      `INSERT INTO orders (ma_nguoi_dung, ma_don_rut_gon, ngay_dat, thoi_gian_nhan, trang_thai, tong_tien)
       VALUES ($1, 'PENDING', NOW(), $2, 'CHO_THANH_TOAN', $3) RETURNING *`,
      [user.id, pickup.toISOString(), total],
    );
    const order = rows[0];
    order.ma_don_rut_gon = `DH${String(order.id).padStart(4, "0")}`;
    await client.query("UPDATE orders SET ma_don_rut_gon = $1 WHERE id = $2", [order.ma_don_rut_gon, order.id]);
    for (const detail of details) {
      await client.query(
        "INSERT INTO order_items (ma_don_hang, ma_mon, ten_mon, so_luong, don_gia) VALUES ($1, $2, $3, $4, $5)",
        [order.id, detail.id, detail.ten_mon, detail.quantity, detail.don_gia],
      );
    }
    await client.query("COMMIT");
    return await orderView(client, order);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = async (req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  const path = pathFromRequest(req);
  const body = requestBody(req);
  try {
    if (method === "GET" && path === "/health") return send(res, 200, { ok: true });

    if (method === "POST" && path === "/auth/login") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.matKhau || "");
      const { rows } = await database().query("SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1", [email]);
      const user = rows[0];
      if (!user || !(await passwordMatches(password, user.mat_khau))) return fail(res, 401, "Sai email hoặc mật khẩu.");
      if (!user.mat_khau.startsWith("scrypt$")) await database().query("UPDATE users SET mat_khau = $1 WHERE id = $2", [await hashPassword(password), user.id]);
      const redirect = { ROLE_BUYER: "menu.html", ROLE_STAFF: "kds.html", ROLE_ADMIN: "admin/dashboard.html" }[user.vai_tro] || "index.html";
      return send(res, 200, { accessToken: signSession(user), nguoiDung: userView(user), redirectTo: redirect });
    }

    if (method === "POST" && path === "/auth/register") {
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.hoTen || "").trim();
      const password = String(body.matKhau || "");
      const role = ["ROLE_BUYER", "ROLE_STAFF"].includes(body.vaiTro) ? body.vaiTro : "ROLE_BUYER";
      if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6) return fail(res, 400, "Vui lòng nhập đầy đủ thông tin hợp lệ.");
      try {
        await database().query("INSERT INTO users (ho_ten, email, mat_khau, vai_tro) VALUES ($1, $2, $3, $4)", [name, email, await hashPassword(password), role]);
      } catch (error) {
        if (error.code === "23505") return fail(res, 409, "Email này đã được sử dụng.");
        throw error;
      }
      return send(res, 201, { message: "Đăng ký thành công." });
    }

    if (method === "POST" && path === "/auth/forgot-password") {
      return fail(res, 501, "Chức năng gửi email đặt lại mật khẩu chưa được cấu hình.");
    }

    if (method === "GET" && path === "/menu") {
      const { rows } = await database().query("SELECT * FROM menu_items WHERE trang_thai <> 'DA_XOA' ORDER BY id");
      return send(res, 200, rows.map(menuView));
    }

    if (method === "GET" && path === "/donhang/cua-toi") {
      const user = await requireUser(req, res, ["ROLE_BUYER"]); if (!user) return;
      const { rows } = await database().query("SELECT * FROM orders WHERE ma_nguoi_dung = $1 ORDER BY ngay_dat DESC", [user.id]);
      return send(res, 200, await Promise.all(rows.map((order) => orderView(database(), order))));
    }

    if (method === "POST" && path === "/donhang") {
      const user = await requireUser(req, res, ["ROLE_BUYER"]); if (!user) return;
      return send(res, 201, await createOrder(user, body));
    }

    const qrMatch = path.match(/^\/thanhtoan\/(\d+)\/qr$/);
    if (method === "POST" && qrMatch) {
      const user = await requireUser(req, res, ["ROLE_BUYER"]); if (!user) return;
      const id = Number(qrMatch[1]);
      const { rows } = await database().query("SELECT * FROM orders WHERE id = $1 AND ma_nguoi_dung = $2", [id, user.id]);
      const order = rows[0];
      if (!order) return fail(res, 404, "Không tìm thấy đơn hàng.");
      if (order.trang_thai !== "CHO_THANH_TOAN") return fail(res, 400, "Đơn hàng này không ở trạng thái chờ thanh toán.");
      const qr = `QR${id}-${Date.now()}`;
      const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await database().query("UPDATE orders SET ma_qr = $1, thoi_han_thanh_toan = $2 WHERE id = $3", [qr, expires, id]);
      return send(res, 200, { maDonHang: id, maQr: qr, phuongThuc: req.query.phuongThuc || "VIETQR", soTien: Number(order.tong_tien), qrImageBase64: null, thoiHanThanhToan: expires });
    }

    if (method === "POST" && path === "/thanhtoan/webhook") {
      const user = await requireUser(req, res, ["ROLE_BUYER"]); if (!user) return;
      const { rows } = await database().query("SELECT * FROM orders WHERE id = $1 AND ma_qr = $2 AND ma_nguoi_dung = $3", [Number(body.maDonHang), String(body.maQr || ""), user.id]);
      const order = rows[0];
      if (!order) return fail(res, 404, "Không tìm thấy giao dịch thanh toán.");
      const status = body.ketQua === "THANH_CONG" ? "DA_THANH_TOAN" : "CHO_THANH_TOAN";
      const { rows: updated } = await database().query("UPDATE orders SET trang_thai = $1 WHERE id = $2 RETURNING *", [status, order.id]);
      return send(res, 200, await orderView(database(), updated[0]));
    }

    if (method === "GET" && path === "/kds/orders") {
      const user = await requireUser(req, res, ["ROLE_STAFF", "ROLE_ADMIN"]); if (!user) return;
      const { rows } = await database().query("SELECT * FROM orders WHERE trang_thai = ANY($1) ORDER BY ngay_dat ASC", [["DA_THANH_TOAN", "DANG_CHUAN_BI", "SAN_SANG_NHAN"]]);
      return send(res, 200, await Promise.all(rows.map((order) => orderView(database(), order))));
    }

    const kdsOrder = path.match(/^\/kds\/orders\/(\d+)\/status$/);
    if (method === "PATCH" && kdsOrder) {
      const user = await requireUser(req, res, ["ROLE_STAFF", "ROLE_ADMIN"]); if (!user) return;
      const next = String(body.trangThaiMoi || "");
      if (!["DANG_CHUAN_BI", "SAN_SANG_NHAN", "HOAN_THANH"].includes(next)) return fail(res, 400, "Trạng thái mới không hợp lệ.");
      const { rows } = await database().query("UPDATE orders SET trang_thai = $1 WHERE id = $2 RETURNING *", [next, Number(kdsOrder[1])]);
      if (!rows[0]) return fail(res, 404, "Không tìm thấy đơn hàng.");
      return send(res, 200, await orderView(database(), rows[0]));
    }

    const toggleMenu = path.match(/^\/kds\/mon\/(\d+)\/toggle$/);
    if (method === "PATCH" && toggleMenu) {
      const user = await requireUser(req, res, ["ROLE_STAFF", "ROLE_ADMIN"]); if (!user) return;
      const { rows } = await database().query(
        "UPDATE menu_items SET trang_thai = CASE WHEN trang_thai = 'CON_HANG' THEN 'HET_HANG' ELSE 'CON_HANG' END WHERE id = $1 AND trang_thai <> 'DA_XOA' RETURNING *",
        [Number(toggleMenu[1])],
      );
      if (!rows[0]) return fail(res, 404, "Không tìm thấy món ăn.");
      return send(res, 200, menuView(rows[0]));
    }

    if (method === "GET" && path === "/admin/thong-ke") {
      const user = await requireUser(req, res, ["ROLE_ADMIN"]); if (!user) return;
      const { rows } = await database().query(`SELECT
        COALESCE(SUM(tong_tien) FILTER (WHERE trang_thai = ANY($1)), 0) AS doanh_thu,
        COUNT(*) FILTER (WHERE trang_thai = 'HOAN_THANH') AS don_hoan_thanh,
        COUNT(*) AS tong_don FROM orders`, [["DA_THANH_TOAN", "DANG_CHUAN_BI", "SAN_SANG_NHAN", "HOAN_THANH"]]);
      const { rows: menu } = await database().query("SELECT COUNT(*) FILTER (WHERE trang_thai = 'CON_HANG') AS dang_ban, COUNT(*) FILTER (WHERE trang_thai = 'HET_HANG') AS het_hang FROM menu_items");
      return send(res, 200, { tongDoanhThu: Number(rows[0].doanh_thu), tongSoDonHoanThanh: Number(rows[0].don_hoan_thanh), tongSoDonTatCa: Number(rows[0].tong_don), soMonDangBan: Number(menu[0].dang_ban), soMonHetHang: Number(menu[0].het_hang) });
    }

    if (method === "GET" && path === "/admin/don-hang") {
      const user = await requireUser(req, res, ["ROLE_ADMIN"]); if (!user) return;
      const { rows } = await database().query("SELECT * FROM orders ORDER BY ngay_dat DESC");
      return send(res, 200, await Promise.all(rows.map((order) => orderView(database(), order))));
    }

    if (method === "GET" && path === "/admin/mon-an") {
      const user = await requireUser(req, res, ["ROLE_ADMIN"]); if (!user) return;
      const { rows } = await database().query("SELECT * FROM menu_items ORDER BY id");
      return send(res, 200, rows.map(menuView));
    }

    if (method === "POST" && path === "/admin/mon-an") {
      const user = await requireUser(req, res, ["ROLE_ADMIN"]); if (!user) return;
      const name = String(body.tenMon || "").trim(); const price = Number(body.donGia);
      if (!name || !Number.isFinite(price) || price <= 0) return fail(res, 400, "Tên món và đơn giá không hợp lệ.");
      const { rows } = await database().query("INSERT INTO menu_items (ten_mon, don_gia, mo_ta, hinh_anh, trang_thai) VALUES ($1, $2, $3, $4, 'CON_HANG') RETURNING *", [name, price, String(body.moTa || ""), String(body.hinhAnh || "")]);
      return send(res, 201, menuView(rows[0]));
    }

    const adminMenu = path.match(/^\/admin\/mon-an\/(\d+)$/);
    if (adminMenu && ["PUT", "DELETE"].includes(method)) {
      const user = await requireUser(req, res, ["ROLE_ADMIN"]); if (!user) return;
      const id = Number(adminMenu[1]);
      if (method === "DELETE") {
        await database().query("UPDATE menu_items SET trang_thai = 'DA_XOA' WHERE id = $1", [id]);
        return send(res, 200, { message: "Đã xóa món ăn." });
      }
      const name = String(body.tenMon || "").trim(); const price = Number(body.donGia);
      if (!name || !Number.isFinite(price) || price <= 0) return fail(res, 400, "Tên món và đơn giá không hợp lệ.");
      const status = ["CON_HANG", "HET_HANG", "DA_XOA"].includes(body.trangThai) ? body.trangThai : null;
      const { rows } = await database().query("UPDATE menu_items SET ten_mon = $1, don_gia = $2, mo_ta = $3, hinh_anh = $4, trang_thai = COALESCE($5, trang_thai) WHERE id = $6 RETURNING *", [name, price, String(body.moTa || ""), String(body.hinhAnh || ""), status, id]);
      if (!rows[0]) return fail(res, 404, "Không tìm thấy món ăn.");
      return send(res, 200, menuView(rows[0]));
    }

    return fail(res, 404, "Không tìm thấy endpoint.");
  } catch (error) {
    console.error(error);
    return fail(res, error.status || 500, error.status ? error.message : "Lỗi máy chủ. Vui lòng thử lại sau.");
  }
};
