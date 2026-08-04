"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DATA_PATH = path.join(DIR, "data.json");
const SHEET_ID = "1C6xsW-0ipDh9nv9eAW_y9DZGOEEY5j9g";
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;

const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";

function toNum(raw) {
  if (raw == null) return 0;
  let t = String(raw).trim();
  if (t === "") return 0;
  let neg = false;
  if (t.startsWith("-")) { neg = true; t = t.slice(1); }
  t = t.replace(/R\$/g, "").replace(/%/g, "").trim();
  if (t.startsWith("-")) { neg = true; t = t.slice(1); }
  t = t.replace(/\./g, "").replace(",", ".");
  if (t === "") return 0;
  const v = parseFloat(t);
  if (Number.isNaN(v)) return 0;
  return neg ? -v : v;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function fetchFreshDashboardData() {
  const resp = await fetch(CSV_URL);
  if (!resp.ok) throw new Error("Falha ao buscar a planilha (HTTP " + resp.status + ")");
  const content = await resp.text();

  const lines = content.split(/\r?\n/).filter(function (l) { return l !== ""; });
  const rows = lines.slice(1).map(parseCsvLine);

  const months = [];
  let cur = null;

  rows.forEach(function (r) {
    const mes = (r[0] || "").trim();
    const porte = (r[1] || "").trim();
    const filial = (r[2] || "").trim();

    if (mes !== "" && mes !== "Mês") {
      cur = { mes: mes, despesaCentral: 0, vencimento: 0, stores: [] };
      months.push(cur);
    }
    if (!cur) return;

    if (filial === "VENDA TOTAL" || filial === "" || filial === "Filial") return;
    if (filial === "DESPESAS CENTRAL") { cur.despesaCentral = toNum(r[3]); return; }
    if (filial === "DESP. CENTRAL + VENC.") return;
    if (filial === "VENCIMENTO") { cur.vencimento = toNum(r[3]); return; }
    if (porte !== "") {
      cur.stores.push({
        porte: porte,
        filial: filial,
        faturamento: toNum(r[3]),
        margemTrier: toNum(r[7]),
        margemManipulado: toNum(r[9]),
        despesa: toNum(r[10]),
        manipulados: toNum(r[11]),
        resultadoBruto: toNum(r[13])
      });
    }
  });

  if (months.length === 0) throw new Error("Nenhum mes encontrado na planilha, verifique o formato.");

  return { updatedAt: new Date().toISOString().slice(0, 19), months: months };
}

function checkAuth(req) {
  if (!AUTH_USER && !AUTH_PASS) return true; // auth disabled if not configured
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
  return user === AUTH_USER && pass === AUTH_PASS;
}

const MIME = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8" };

const server = http.createServer(function (req, res) {
  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Dashboard Farmacias"', "Content-Type": "text/plain; charset=utf-8" });
    res.end("Autenticação necessária.");
    return;
  }

  const url = new URL(req.url, "http://localhost");
  let reqPath = decodeURIComponent(url.pathname);

  if (req.method === "POST" && reqPath === "/refresh") {
    fetchFreshDashboardData()
      .then(function (payload) {
        fs.writeFileSync(DATA_PATH, JSON.stringify(payload), "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, updatedAt: payload.updatedAt }));
      })
      .catch(function (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (reqPath === "/" || reqPath === "") reqPath = "/index.html";
  const filePath = path.join(DIR, reqPath);
  if (!filePath.startsWith(DIR)) { res.writeHead(403); res.end("Forbidden"); return; }

  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Não encontrado"); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log("Servidor rodando na porta " + PORT);
  if (!AUTH_USER || !AUTH_PASS) console.log("AVISO: AUTH_USER/AUTH_PASS não configurados — dashboard sem senha.");
});
