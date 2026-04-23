// odoo-proxy.cjs
const express = require("express");
const xmlrpc  = require("xmlrpc");

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

function crearCliente(url, path) {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const host = u.hostname;
  const port = u.port ? parseInt(u.port) : isHttps ? 443 : 80;
  const cfg = { host, port, path, cookies: true };
  return isHttps ? xmlrpc.createSecureClient(cfg) : xmlrpc.createClient(cfg);
}

function llamar(client, method, params) {
  return new Promise((resolve, reject) =>
    client.methodCall(method, params, (err, val) => err ? reject(err) : resolve(val))
  );
}

async function autenticar(url, db, username, password) {
  const client = crearCliente(url, "/xmlrpc/2/common");
  const uid = await llamar(client, "authenticate", [db, username, password, {}]);
  if (!uid) throw new Error("Credenciales incorrectas");
  return uid;
}

app.post("/api/odoo/test", async (req, res) => {
  const { url, db, username, password } = req.body;
  try {
    const uid = await autenticar(url, db, username, password);
    res.json({ ok: true, uid });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/odoo/rpc", async (req, res) => {
  const { url, db, username, password, args } = req.body;
  try {
    const uid = await autenticar(url, db, username, password);
    const client = crearCliente(url, "/xmlrpc/2/object");
    const model = args[3], modelMethod = args[4];
    const domain = args[5] || [], options = args[6] || {};
    const result = await llamar(client, "execute_kw",
      [db, uid, password, model, modelMethod, domain, options]);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/odoo/stock/actualizar", async (req, res) => {
  const { url, db, username, password, product_id, cantidad } = req.body;
  if (!product_id || cantidad === undefined) {
    return res.status(400).json({ ok: false, error: "Faltan product_id o cantidad" });
  }
  try {
    const uid = await autenticar(url, db, username, password);
    const obj = crearCliente(url, "/xmlrpc/2/object");

    const call = (model, method, domain, opts={}) =>
      llamar(obj, "execute_kw", [db, uid, password, model, method, domain, opts]);

    // Buscar ubicacion interna
    const locs = await call("stock.location", "search",
      [[["usage","=","internal"],["active","=",true]]], { limit: 1 });
    if (!locs.length) throw new Error("Sin ubicacion de stock");
    const location_id = locs[0];

    // Buscar variante
    const vars = await call("product.product", "search",
      [[["product_tmpl_id","=",product_id],["active","=",true]]], { limit: 1 });
    if (!vars.length) throw new Error("Sin variante de producto");
    const prod_id = vars[0];

    // Actualizar cantidad via inventory_quantity
    const quants = await call("stock.quant", "search",
      [[["product_id","=",prod_id],["location_id","=",location_id]]], { limit: 1 });

    if (quants.length) {
      await call("stock.quant", "write", [[quants[0]], { inventory_quantity: cantidad }]);
      await call("stock.quant", "action_apply_inventory", [[quants[0]]]);
    } else {
      const nq = await call("stock.quant", "create",
        [[{ product_id: prod_id, location_id, inventory_quantity: cantidad }]]);
      await call("stock.quant", "action_apply_inventory", [[nq]]);
    }

    res.json({ ok: true, mensaje: `Stock actualizado a ${cantidad} unidades` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Proxy en puerto ${PORT}`));
