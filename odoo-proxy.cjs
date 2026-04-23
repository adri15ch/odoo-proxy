// odoo-proxy.cjs
// Ejecutar con: node odoo-proxy.cjs

const express = require("express");
const xmlrpc  = require("xmlrpc");
const cors    = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ─── HELPER: crear cliente XML-RPC ───────────────────────────
function crearCliente(url, path) {
  const u       = new URL(url);
  const isHttps = u.protocol === "https:";
  const host    = u.hostname;
  const port    = u.port ? parseInt(u.port) : isHttps ? 443 : 80;
  const cfg     = { host, port, path, allow_nil: true };
  return isHttps ? xmlrpc.createSecureClient(cfg) : xmlrpc.createClient(cfg);
}

function llamar(client, method, params) {
  return new Promise((resolve, reject) =>
    client.methodCall(method, params, (err, val) => err ? reject(err) : resolve(val))
  );
}

// ─── AUTENTICAR ───────────────────────────────────────────────
async function autenticar(url, db, username, password) {
  const client = crearCliente(url, "/xmlrpc/2/common");
  const uid    = await llamar(client, "authenticate", [db, username, password, {}]);
  if (!uid) throw new Error("Usuario o contraseña incorrectos");
  return uid;
}

// ─── PROBAR CONEXIÓN ──────────────────────────────────────────
app.post("/api/odoo/test", async (req, res) => {
  const { url, db, username, password } = req.body;
  try {
    const common  = crearCliente(url, "/xmlrpc/2/common");
    const version = await llamar(common, "version", []);
    const uid     = await autenticar(url, db, username, password);
    res.json({ ok: true, uid, server_version: version.server_version });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── LLAMADA GENÉRICA ─────────────────────────────────────────
app.post("/api/odoo/rpc", async (req, res) => {
  const { url, db, username, password, args } = req.body;
  try {
    const uid    = await autenticar(url, db, username, password);
    const client = crearCliente(url, "/xmlrpc/2/object");

    const model       = args[3];
    const modelMethod = args[4];
    const domain      = args[5] || [];
    const options     = args[6] || {};

    const result = await llamar(client, "execute_kw", [
      db, uid, password,
      model, modelMethod,
      domain,
      options
    ]);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── ACTUALIZAR STOCK ─────────────────────────────────────────
// Recibe: { url, db, username, password, product_id, cantidad }
// Crea un ajuste de inventario en Odoo directamente
app.post("/api/odoo/stock/actualizar", async (req, res) => {
  const { url, db, username, password, product_id, cantidad } = req.body;

  if (!product_id || cantidad === undefined || cantidad === null) {
    return res.status(400).json({ ok: false, error: "Faltan product_id o cantidad" });
  }

  try {
    const uid    = await autenticar(url, db, username, password);
    const client = crearCliente(url, "/xmlrpc/2/object");

    const call = (model, method, domain, options = {}) =>
      llamar(client, "execute_kw", [db, uid, password, model, method, domain, options]);

    // 1. Buscar la ubicación de stock principal (Internal)
    const ubicaciones = await call(
      "stock.location", "search_read",
      [[["usage", "=", "internal"], ["active", "=", true]]],
      { fields: ["id", "complete_name"], limit: 1 }
    );

    if (!ubicaciones.length) {
      return res.status(400).json({ ok: false, error: "No se encontró ubicación de stock" });
    }
    const location_id = ubicaciones[0].id;

    // 2. Buscar el product.product (variante) a partir del product.template id
    const variantes = await call(
      "product.product", "search_read",
      [[["product_tmpl_id", "=", product_id], ["active", "=", true]]],
      { fields: ["id"], limit: 1 }
    );

    if (!variantes.length) {
      return res.status(400).json({ ok: false, error: "No se encontró variante del producto" });
    }
    const product_product_id = variantes[0].id;

    // 3. Crear quant de inventario (ajuste directo de cantidad)
    // Odoo 16/17: stock.quant con inventory_quantity + action_apply_inventory
    const quantIds = await call(
      "stock.quant", "search",
      [[["product_id", "=", product_product_id], ["location_id", "=", location_id]]]
    );

    if (quantIds.length > 0) {
      // Actualizar quant existente
      await call(
        "stock.quant", "write",
        [[quantIds[0]], { inventory_quantity: cantidad }]
      );
      await call(
        "stock.quant", "action_apply_inventory",
        [[quantIds[0]]]
      );
    } else {
      // Crear nuevo quant
      const newQuantId = await call(
        "stock.quant", "create",
        [{ product_id: product_product_id, location_id, inventory_quantity: cantidad }]
      );
      await call(
        "stock.quant", "action_apply_inventory",
        [[newQuantId]]
      );
    }

    // 4. Leer el stock actualizado para confirmar
    const productoActualizado = await call(
      "product.template", "read",
      [[product_id]],
      { fields: ["id", "name", "qty_available"] }
    );

    res.json({
      ok: true,
      mensaje: "Stock actualizado correctamente",
      producto: productoActualizado[0] || null
    });

  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── SINCRONIZAR TODOS LOS MÓDULOS ───────────────────────────
app.post("/api/odoo/sync", async (req, res) => {
  const { url, db, username, password } = req.body;
  try {
    const uid    = await autenticar(url, db, username, password);
    const client = crearCliente(url, "/xmlrpc/2/object");

    const call = (model, method, domain, options) =>
      llamar(client, "execute_kw", [db, uid, password, model, method, domain, options]);

    const [productos, inventario, pedidos, facturas, clientes] = await Promise.all([
      call("product.template", "search_read", [[]], { fields: ["id","name","list_price","qty_available"], limit: 10 }),
      call("stock.move.line",  "search_read", [[]], { fields: ["id","product_id","quantity"], limit: 10 }),
      call("sale.order",       "search_read", [[]], { fields: ["id","name","amount_total","state"], limit: 10 }),
      call("account.move",     "search_read", [[]], { fields: ["id","name","amount_total","state"], limit: 10 }),
      call("res.partner",      "search_read", [[]], { fields: ["id","name","email"], limit: 10 }),
    ]);

    res.json({ ok: true, uid, data: { productos, inventario, pedidos, facturas, clientes } });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── INICIAR ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Proxy Odoo corriendo en puerto ${PORT}`);
  console.log(`   POST /api/odoo/test              — probar conexión`);
  console.log(`   POST /api/odoo/rpc               — llamadas generales`);
  console.log(`   POST /api/odoo/stock/actualizar  — actualizar stock`);
  console.log(`   POST /api/odoo/sync              — sincronizar módulos`);
});
