// odoo-proxy.cjs
const express = require("express");
const cors    = require("cors");

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

const ODOO_URL = "https://importax.odoo.com";
const DB       = "importax";

async function jsonRpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: 1, params })
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d.result;
}

async function autenticar(username, password) {
  const uid = await jsonRpc(`${ODOO_URL}/web/dataset/call_kw`, "call", {
    model: "res.users", method: "authenticate",
    args: [DB, username, password, {}], kwargs: {}
  });
  if (!uid) throw new Error("Credenciales incorrectas");
  return uid;
}

// ─── TEST ─────────────────────────────────────────────────────
app.post("/api/odoo/test", async (req, res) => {
  const { username, password } = req.body;
  try {
    const uid = await autenticar(username, password);
    res.json({ ok: true, uid });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── RPC GENERICO ─────────────────────────────────────────────
app.post("/api/odoo/rpc", async (req, res) => {
  const { username, password, args } = req.body;
  try {
    const uid = await autenticar(username, password);
    const model       = args[3];
    const modelMethod = args[4];
    const domain      = args[5] || [];
    const options     = args[6] || {};
    const result = await jsonRpc(`${ODOO_URL}/web/dataset/call_kw`, "call", {
      model, method: modelMethod,
      args: [domain], kwargs: { ...options, context: { uid } }
    });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── ACTUALIZAR STOCK ─────────────────────────────────────────
app.post("/api/odoo/stock/actualizar", async (req, res) => {
  const { username, password, product_id, cantidad } = req.body;
  if (!product_id || cantidad === undefined) {
    return res.status(400).json({ ok: false, error: "Faltan product_id o cantidad" });
  }
  try {
    const uid = await autenticar(username, password);

    const call = (model, method, args, kwargs={}) =>
      jsonRpc(`${ODOO_URL}/web/dataset/call_kw`, "call", {
        model, method, args, kwargs: { ...kwargs, context: {} }
      });

    // Buscar variante del producto
    const variantes = await call("product.product", "search_read",
      [[["product_tmpl_id", "=", product_id], ["active", "=", true]]],
      { fields: ["id"], limit: 1 }
    );
    if (!variantes.length) throw new Error("No se encontró variante del producto");
    const product_product_id = variantes[0].id;

    // Buscar ubicación interna
    const ubicaciones = await call("stock.location", "search_read",
      [[["usage", "=", "internal"], ["active", "=", true]]],
      { fields: ["id"], limit: 1 }
    );
    if (!ubicaciones.length) throw new Error("No se encontró ubicación de stock");
    const location_id = ubicaciones[0].id;

    // Buscar o crear quant
    const quants = await call("stock.quant", "search_read",
      [[["product_id", "=", product_product_id], ["location_id", "=", location_id]]],
      { fields: ["id"], limit: 1 }
    );

    if (quants.length > 0) {
      await call("stock.quant", "write", [[quants[0].id], { inventory_quantity: cantidad }]);
      await call("stock.quant", "action_apply_inventory", [[quants[0].id]]);
    } else {
      const newId = await call("stock.quant", "create",
        [{ product_id: product_product_id, location_id, inventory_quantity: cantidad }]
      );
      await call("stock.quant", "action_apply_inventory", [[newId]]);
    }

    res.json({ ok: true, mensaje: "Stock actualizado a " + cantidad + " unidades" });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Proxy corriendo en puerto ${PORT}`));
