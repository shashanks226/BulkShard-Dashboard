import React, { useState, useRef, useCallback, useEffect } from "react";
import Papa from "papaparse";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  Settings2,
  Sparkles,
  RotateCcw,
  Radio,
} from "lucide-react";

import.meta.env.VITE_apiBase;

// Mirrors the backend exactly: utils/shard.util.js + validators/order.validator.js
const TOTAL_SHARDS = 4;

function getShardKey(customerId) {
  let hash = 0;
  for (let i = 0; i < customerId.length; i++) hash += customerId.charCodeAt(i);
  return hash % TOTAL_SHARDS;
}

function validateOrder(row) {
  const order = {
    order_id: row.order_id?.trim(),
    customer_id: row.customer_id?.trim(),
    order_date: new Date(row.order_date),
    order_amount: Number(row.order_amount),
    status: row.status?.trim(),
  };
  if (!order.order_id) throw new Error("Invalid order_id");
  if (!order.customer_id) throw new Error("Invalid customer_id");
  if (Number.isNaN(order.order_date.getTime()))
    throw new Error("Invalid order_date");
  if (Number.isNaN(order.order_amount)) throw new Error("Invalid order_amount");
  if (!order.status) throw new Error("Invalid status");
  return order;
}

const SHARD_COLORS = [
  { name: "sky", hex: "#38BDF8", glow: "rgba(56,189,248,0.45)" },
  { name: "teal", hex: "#2DD4BF", glow: "rgba(45,212,191,0.45)" },
  { name: "violet", hex: "#A78BFA", glow: "rgba(167,139,250,0.45)" },
  { name: "amber", hex: "#FBBF24", glow: "rgba(251,191,36,0.45)" },
];

const SAMPLE_CSV = `order_id,customer_id,order_date,order_amount,status
ORD-10231,CUST-4471,2026-08-01,129.99,fulfilled
ORD-10232,CUST-8820,2026-08-01,45.00,fulfilled
ORD-10233,CUST-1190,2026-08-02,,pending
ORD-10234,CUST-3345,2026-08-02,899.50,fulfilled
ORD-10235,,2026-08-02,19.99,cancelled
ORD-10236,CUST-9982,2026-08-03,210.00,fulfilled
ORD-10237,CUST-2201,not-a-date,58.20,pending
ORD-10238,CUST-7734,2026-08-03,74.00,fulfilled
ORD-10239,CUST-1190,2026-08-04,305.10,fulfilled
ORD-10240,CUST-4471,2026-08-04,12.50,cancelled
ORD-10241,CUST-6650,2026-08-04,540.00,fulfilled
ORD-10242,CUST-8820,2026-08-05,88.88,pending
ORD-10243,CUST-3345,2026-08-05,,fulfilled
ORD-10244,CUST-2298,2026-08-05,164.20,fulfilled
ORD-10245,CUST-9982,2026-08-06,29.00,cancelled
ORD-10246,CUST-7734,2026-08-06,412.75,fulfilled
ORD-10247,CUST-6650,2026-08-06,97.40,pending
ORD-10248,CUST-1190,2026-08-07,238.00,fulfilled
ORD-10249,CUST-2298,2026-08-07,15.60,fulfilled
ORD-10250,CUST-4471,2026-08-07,681.00,fulfilled`;

function nowStamp() {
  return new Date().toISOString();
}

export default function BulkShardDashboard() {
  const [file, setFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [mode, setMode] = useState("demo"); // "demo" | "live"

  const [apiBase, setApiBase] = useState(
    import.meta.env.VITE_apiBase || "/api",
  );
  const [showSettings, setShowSettings] = useState(false);
  const [health, setHealth] = useState("unknown"); // unknown | ok | down | checking

  const [status, setStatus] = useState("idle"); // idle | parsing | processing | done | error
  const [stats, setStats] = useState({ total: 0, success: 0, failed: 0 });
  const [shardCounts, setShardCounts] = useState([0, 0, 0, 0]);
  const [activeShard, setActiveShard] = useState(null);
  const [logLines, setLogLines] = useState([]);
  const [failedRows, setFailedRows] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");

  const inputRef = useRef(null);
  const logEndRef = useRef(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logLines]);

  const appendLog = useCallback((level, message) => {
    setLogLines((prev) => {
      const next = [...prev, { ts: nowStamp(), level, message }];
      return next.length > 300 ? next.slice(next.length - 300) : next;
    });
  }, []);

  const reset = useCallback(() => {
    cancelRef.current = true;
    setFile(null);
    setStatus("idle");
    setStats({ total: 0, success: 0, failed: 0 });
    setShardCounts([0, 0, 0, 0]);
    setActiveShard(null);
    setLogLines([]);
    setFailedRows([]);
    setErrorMsg("");
  }, []);

  const pickFile = useCallback(
    (f) => {
      if (!f) return;
      if (!/\.csv$/i.test(f.name) && f.type !== "text/csv") {
        setErrorMsg("Only .csv files are accepted.");
        return;
      }
      reset();
      setFile(f);
    },
    [reset],
  );

  const useSample = useCallback(() => {
    reset();
    const blob = new Blob([SAMPLE_CSV], { type: "text/csv" });
    const sampleFile = new File([blob], "sample-orders.csv", {
      type: "text/csv",
    });
    setFile(sampleFile);
  }, [reset]);

  const testConnection = useCallback(async () => {
    setHealth("checking");
    try {
      const res = await fetch(`${apiBase}/health`, { method: "GET" });
      setHealth(res.ok ? "ok" : "down");
    } catch {
      setHealth("down");
    }
  }, [apiBase]);

  const runDemoPipeline = useCallback(
    async (rows) => {
      const BATCH_SIZE = 1000;
      const total = rows.length;
      const chunkSize = Math.max(1, Math.ceil(total / 40));
      let successCount = 0;
      let failedCount = 0;
      const shards = [0, 0, 0, 0];
      let sinceFlush = 0;

      for (let i = 0; i < total; i += chunkSize) {
        if (cancelRef.current) return;
        const chunk = rows.slice(i, i + chunkSize);
        let touchedShard = null;

        for (let j = 0; j < chunk.length; j++) {
          const rowNum = i + j + 1;
          const row = chunk[j];
          try {
            const order = validateOrder(row);
            const shard = getShardKey(order.customer_id);
            shards[shard] += 1;
            touchedShard = shard;
            successCount += 1;
            sinceFlush += 1;
          } catch (err) {
            failedCount += 1;
            setFailedRows((prev) => [
              ...prev,
              { row: rowNum, reason: err.message, data: row },
            ]);
            appendLog(
              "FAILED_RECORD",
              `Row ${rowNum}: ${err.message} | ${JSON.stringify(row)}`,
            );
          }
        }

        setShardCounts([...shards]);
        setActiveShard(touchedShard);
        setStats({
          total: i + chunk.length,
          success: successCount,
          failed: failedCount,
        });

        if (sinceFlush >= BATCH_SIZE) {
          appendLog("INFO", `Inserted batch of ${sinceFlush} records`);
          sinceFlush = 0;
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 45));
      }

      if (sinceFlush > 0) {
        appendLog("INFO", `Inserted batch of ${sinceFlush} records`);
      }
      setActiveShard(null);
      setStatus("done");
    },
    [appendLog],
  );

  const submitLive = useCallback(
    async (parsedRows) => {
      // Client-side pass purely to drive the shard visualization, since the
      // real insert + sharding happens server-side and only aggregate stats
      // come back.
      const shards = [0, 0, 0, 0];
      parsedRows.forEach((row) => {
        try {
          const order = validateOrder(row);
          shards[getShardKey(order.customer_id)] += 1;
        } catch {
          /* server will report the authoritative failure count */
        }
      });
      setShardCounts(shards);

      const formData = new FormData();
      formData.append("file", file);

      appendLog("INFO", `POST ${apiBase}/upload-orders`);
      const res = await fetch(`${apiBase}/upload-orders`, {
        method: "POST",
        body: formData,
      });
      const body = await res.json().catch(() => null);

      if (!res.ok || !body?.success) {
        throw new Error(
          body?.message || `Request failed with status ${res.status}`,
        );
      }

      const {
        totalRows = 0,
        successfulRows = 0,
        failedRows: fr = 0,
      } = body.data || {};
      setStats({ total: totalRows, success: successfulRows, failed: fr });
      appendLog(
        "INFO",
        `Server reported ${successfulRows}/${totalRows} rows inserted`,
      );
      setStatus("done");
    },
    [apiBase, file, appendLog],
  );

  const process = useCallback(() => {
    if (!file) return;
    cancelRef.current = false;
    setErrorMsg("");
    setStatus("parsing");
    setLogLines([]);
    setFailedRows([]);
    setStats({ total: 0, success: 0, failed: 0 });
    setShardCounts([0, 0, 0, 0]);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (results) => {
        const rows = results.data;
        appendLog("INFO", `Parsed ${rows.length} rows from ${file.name}`);
        setStatus("processing");
        try {
          if (mode === "demo") {
            await runDemoPipeline(rows);
          } else {
            await submitLive(rows);
          }
        } catch (err) {
          setErrorMsg(err.message || "Something went wrong while processing.");
          appendLog("ERROR", err.message || "Processing failed");
          setStatus("error");
        }
      },
      error: (err) => {
        setErrorMsg(err.message);
        setStatus("error");
      },
    });
  }, [file, mode, runDemoPipeline, submitLive, appendLog]);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragActive(false);
      const f = e.dataTransfer.files?.[0];
      pickFile(f);
    },
    [pickFile],
  );

  const maxShard = Math.max(1, ...shardCounts);
  const isBusy = status === "parsing" || status === "processing";
  const totalRouted = shardCounts.reduce((a, b) => a + b, 0);

  return (
    <div
      className="min-h-screen w-full text-[#E7EBF3]"
      style={{
        background:
          "radial-gradient(1200px 600px at 15% -10%, #121a2c 0%, #0A0E14 55%), #0A0E14",
        fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        .font-display { font-family: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif; }
        .font-mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
        @keyframes bs-pulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
        .bs-pulse { animation: bs-pulse 1.1s ease-in-out infinite; }
        .bs-silo-fill { transition: height 220ms cubic-bezier(.22,.61,.36,1); }
        @media (prefers-reduced-motion: reduce) {
          .bs-silo-fill { transition: none; }
          .bs-pulse { animation: none; }
        }
      `}</style>

      <div className="mx-auto max-w-6xl px-5 py-8 md:px-10 md:py-12">
        {/* Header */}
        <header className="flex flex-col gap-4 border-b border-[#232C3D] pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.25em] text-[#8A93A6]">
              order ingestion &amp; shard routing
            </p>
            <h1 className="font-display mt-1 text-3xl font-semibold tracking-tight md:text-4xl">
              BulkShard
            </h1>
            <p className="mt-1.5 max-w-md text-sm text-[#8A93A6]">
              Upload a CSV of orders. Each valid row is hashed by customer and
              routed to one of {TOTAL_SHARDS} shards for insert.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSettings((s) => !s)}
              className="flex items-center gap-1.5 rounded-md border border-[#232C3D] bg-[#121826] px-3 py-1.5 text-xs text-[#8A93A6] transition hover:border-[#38BDF8]/40 hover:text-[#E7EBF3]"
            >
              <Settings2 size={14} />
              Connection
            </button>
            <span
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-xs ${
                health === "ok"
                  ? "border-[#2DD4BF]/40 bg-[#2DD4BF]/10 text-[#2DD4BF]"
                  : health === "down"
                    ? "border-[#FB7185]/40 bg-[#FB7185]/10 text-[#FB7185]"
                    : "border-[#232C3D] bg-[#121826] text-[#8A93A6]"
              }`}
            >
              <Radio
                size={12}
                className={health === "checking" ? "bs-pulse" : ""}
              />
              {health === "ok" && "api reachable"}
              {health === "down" && "api unreachable"}
              {health === "checking" && "checking\u2026"}
              {health === "unknown" && "not connected"}
            </span>
          </div>
        </header>

        {showSettings && (
          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-[#232C3D] bg-[#121826] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex overflow-hidden rounded-md border border-[#232C3D]">
                <button
                  onClick={() => setMode("demo")}
                  className={`px-3 py-1.5 text-xs font-medium transition ${
                    mode === "demo"
                      ? "bg-[#F5A623] text-[#0A0E14]"
                      : "bg-transparent text-[#8A93A6] hover:text-[#E7EBF3]"
                  }`}
                >
                  Demo (in-browser)
                </button>
                <button
                  onClick={() => setMode("live")}
                  className={`px-3 py-1.5 text-xs font-medium transition ${
                    mode === "live"
                      ? "bg-[#F5A623] text-[#0A0E14]"
                      : "bg-transparent text-[#8A93A6] hover:text-[#E7EBF3]"
                  }`}
                >
                  Live (call /api)
                </button>
              </div>
              <input
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder="/api"
                className="w-48 rounded-md border border-[#232C3D] bg-[#0A0E14] px-3 py-1.5 font-mono text-xs text-[#E7EBF3] outline-none focus:border-[#38BDF8]/60"
              />
              <button
                onClick={testConnection}
                className="rounded-md border border-[#232C3D] px-3 py-1.5 text-xs text-[#8A93A6] transition hover:border-[#38BDF8]/40 hover:text-[#E7EBF3]"
              >
                Test connection
              </button>
            </div>
            <p className="max-w-xs text-xs leading-relaxed text-[#8A93A6]">
              Demo mode parses and routes entirely in your browser \u2014
              nothing is sent anywhere. Live mode posts the file to{" "}
              <span className="font-mono">{apiBase}/upload-orders</span>.
            </p>
          </div>
        )}

        {/* Main grid */}
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-5">
          {/* Left: dropzone */}
          <div className="lg:col-span-2">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`flex min-h-[220px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${
                dragActive
                  ? "border-[#F5A623] bg-[#F5A623]/5"
                  : "border-[#232C3D] bg-[#121826] hover:border-[#38BDF8]/40"
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
              <UploadCloud size={30} className="mb-3 text-[#8A93A6]" />
              {file ? (
                <>
                  <p className="flex items-center gap-1.5 font-mono text-sm text-[#E7EBF3]">
                    <FileText size={14} /> {file.name}
                  </p>
                  <p className="mt-1 text-xs text-[#8A93A6]">
                    {(file.size / 1024).toFixed(1)} KB \u2014 click to replace
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-[#E7EBF3]">
                    Drop a CSV here to route
                  </p>
                  <p className="mt-1 text-xs text-[#8A93A6]">
                    or click to browse \u2014 up to 20MB
                  </p>
                </>
              )}
            </div>

            {errorMsg && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-[#FB7185]">
                <XCircle size={13} /> {errorMsg}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={process}
                disabled={!file || isBusy}
                className="flex items-center gap-1.5 rounded-md bg-[#F5A623] px-4 py-2 text-sm font-medium text-[#0A0E14] transition disabled:cursor-not-allowed disabled:opacity-40 hover:brightness-110"
              >
                {isBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {isBusy ? "Routing\u2026" : "Process file"}
              </button>
              <button
                onClick={useSample}
                disabled={isBusy}
                className="rounded-md border border-[#232C3D] px-4 py-2 text-sm text-[#8A93A6] transition hover:border-[#38BDF8]/40 hover:text-[#E7EBF3] disabled:opacity-40"
              >
                Try sample data
              </button>
              {(status === "done" || status === "error") && (
                <button
                  onClick={reset}
                  className="flex items-center gap-1.5 rounded-md border border-[#232C3D] px-4 py-2 text-sm text-[#8A93A6] transition hover:border-[#38BDF8]/40 hover:text-[#E7EBF3]"
                >
                  <RotateCcw size={13} /> Reset
                </button>
              )}
            </div>

            {/* Stats */}
            <div className="mt-6 grid grid-cols-3 gap-3">
              <StatCard
                label="total rows"
                value={stats.total}
                color="#E7EBF3"
              />
              <StatCard
                label="inserted"
                value={stats.success}
                color="#2DD4BF"
              />
              <StatCard label="failed" value={stats.failed} color="#FB7185" />
            </div>
          </div>

          {/* Right: shard router (signature element) */}
          <div className="rounded-xl border border-[#232C3D] bg-[#121826] p-6 lg:col-span-3">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-[#8A93A6]">
                  shard router
                </p>
                <p className="mt-1 font-mono text-[11px] text-[#8A93A6]">
                  shard = \u03a3 charcode(customer_id) mod {TOTAL_SHARDS}
                </p>
              </div>
              <span className="font-mono text-xs text-[#8A93A6]">
                {totalRouted} routed
              </span>
            </div>

            <div className="grid grid-cols-4 gap-4">
              {shardCounts.map((count, idx) => {
                const c = SHARD_COLORS[idx];
                const pct = Math.max(4, Math.round((count / maxShard) * 100));
                const isActive = activeShard === idx;
                return (
                  <div key={idx} className="flex flex-col items-center">
                    <p
                      className="font-mono text-lg font-medium"
                      style={{ color: c.hex }}
                    >
                      {count}
                    </p>
                    <div
                      className="relative mt-1 h-40 w-full overflow-hidden rounded-md border"
                      style={{
                        borderColor: isActive ? c.hex : "#232C3D",
                        background: "#0A0E14",
                        boxShadow: isActive ? `0 0 16px ${c.glow}` : "none",
                        transition:
                          "box-shadow 200ms ease, border-color 200ms ease",
                      }}
                    >
                      <div
                        className="bs-silo-fill absolute bottom-0 left-0 w-full"
                        style={{
                          height: `${count === 0 ? 0 : pct}%`,
                          background: `linear-gradient(180deg, ${c.hex}cc, ${c.hex}55)`,
                        }}
                      />
                    </div>
                    <p className="mt-2 font-mono text-[11px] text-[#8A93A6]">
                      shard {idx}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Log console */}
        <div className="mt-6 overflow-hidden rounded-xl border border-[#232C3D] bg-[#0D131F]">
          <div className="flex items-center justify-between border-b border-[#232C3D] px-4 py-2.5">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-[#8A93A6]">
              activity log
            </p>
            {status === "done" && (
              <span className="flex items-center gap-1.5 font-mono text-xs text-[#2DD4BF]">
                <CheckCircle2 size={13} /> complete
              </span>
            )}
          </div>
          <div className="h-56 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
            {logLines.length === 0 && (
              <p className="text-[#4B5468]">
                Waiting for a file to process\u2026
              </p>
            )}
            {logLines.map((l, i) => (
              <p key={i} className="whitespace-pre-wrap break-all">
                <span className="text-[#4B5468]">[{l.ts.slice(11, 19)}]</span>{" "}
                <span
                  className={
                    l.level === "FAILED_RECORD"
                      ? "text-[#FB7185]"
                      : l.level === "ERROR"
                        ? "text-[#FB7185]"
                        : "text-[#38BDF8]"
                  }
                >
                  [{l.level}]
                </span>{" "}
                <span className="text-[#C7CDDA]">{l.message}</span>
              </p>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-[#4B5468]">
          {mode === "demo"
            ? "Running in demo mode \u2014 validation and shard routing happen locally in your browser."
            : `Live mode \u2014 posting to ${apiBase}/upload-orders`}
        </p>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="rounded-lg border border-[#232C3D] bg-[#121826] px-3 py-3 text-center">
      <p className="font-mono text-xl font-semibold" style={{ color }}>
        {value}
      </p>
      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-[#8A93A6]">
        {label}
      </p>
    </div>
  );
}
